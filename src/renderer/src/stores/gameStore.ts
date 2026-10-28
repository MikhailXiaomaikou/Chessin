import { create } from 'zustand'
import { Chess, type Move, type Square } from 'chess.js'
import { DEFAULT_FEN } from '@shared/constants'
import { parsePgnTree, type PgnTreeNode } from '@shared/chess/pgnTree'
import {
  withCommentShapes,
  withCommentText,
  type CommentShape
} from '@shared/chess/commentShapes'

/** SAN of a null move (a pass), as used in analysis. It has no from/to squares. */
export const NULL_MOVE = '--'

export interface MoveTreeNode {
  id: string
  san: string
  from: string
  to: string
  promotion?: string
  fen: string // FEN after this move
  parentId: string | null
  children: string[] // first = main continuation, rest = variations
  /** Comment after the move. May carry [%csl]/[%cal] shape commands. */
  comment?: string
  /** Comment before the move, e.g. at the start of a variation. */
  commentBefore?: string
  nags?: number[]
}

export interface GameState {
  chess: Chess
  fen: string
  turn: 'w' | 'b'
  isCheck: boolean
  isCheckmate: boolean
  isStalemate: boolean
  isDraw: boolean
  isGameOver: boolean
  lastMove: { from: string; to: string } | null
  orientation: 'white' | 'black'

  // Move tree
  startFen: string
  treeNodes: Record<string, MoveTreeNode>
  rootChildren: string[] // IDs of first moves (first = main line)
  currentNodeId: string | null // null = start position
  /** PGN tags of a loaded game (without SetUp/FEN, which follow startFen). */
  headers: Record<string, string>
  /** Comment before the first move. */
  gameComment: string

  // Derived from tree (backward compat)
  moveHistory: MoveTreeNode[]
  currentMoveIndex: number

  // Actions
  makeMove: (from: string, to: string, promotion?: string) => Move | null
  newGame: (fen?: string) => void
  flipBoard: () => void
  goToMove: (index: number) => void
  goToNode: (nodeId: string) => void
  goForward: () => void
  goBack: () => void
  goToStart: () => void
  goToEnd: () => void
  getLegalMoves: (square: string) => string[]
  getAllLegalDests: () => Map<string, string[]>
  /**
   * Loads a game with its variations, comments and NAGs. Opens at `goToFen`
   * if the main line reaches that position, else at the end of the main line.
   * Returns false, leaving the current game alone, if nothing could be read.
   */
  loadPgn: (pgn: string, options?: { goToFen?: string }) => boolean
  getPgn: () => string
  promoteVariation: (nodeId: string) => void
  deleteVariation: (nodeId: string) => void
  /** Sets the text of a move's comment (null = the game comment), keeping its shapes. */
  setComment: (nodeId: string | null, text: string) => void
  /** Sets the coloured squares and arrows drawn for a move (null = the start position). */
  setShapes: (nodeId: string | null, shapes: CommentShape[]) => void
  /** Adds or removes a NAG. Move marks ($1–$9) exclude each other, as do evaluations ($10–$19). */
  toggleNag: (nodeId: string, nag: number) => void
}

let nodeIdCounter = 0
function genNodeId(): string {
  return `n${++nodeIdCounter}`
}

function deriveState(chess: Chess) {
  return {
    fen: chess.fen(),
    turn: chess.turn(),
    isCheck: chess.isCheck(),
    isCheckmate: chess.isCheckmate(),
    isStalemate: chess.isStalemate(),
    isDraw: chess.isDraw(),
    isGameOver: chess.isGameOver()
  }
}

// Get path from root to a node (ancestors + node itself)
function getPathToNode(nodes: Record<string, MoveTreeNode>, nodeId: string): MoveTreeNode[] {
  const path: MoveTreeNode[] = []
  let cur: string | null = nodeId
  while (cur) {
    const n: MoveTreeNode | undefined = nodes[cur]
    if (!n) break
    path.unshift(n)
    cur = n.parentId
  }
  return path
}

// Follow first children from a starting child ID
function getContinuation(nodes: Record<string, MoveTreeNode>, startChildId: string | undefined): MoveTreeNode[] {
  const result: MoveTreeNode[] = []
  let nextId: string | undefined = startChildId
  while (nextId) {
    const n = nodes[nextId]
    if (!n) break
    result.push(n)
    nextId = n.children[0]
  }
  return result
}

// Derive moveHistory and currentMoveIndex from tree state.
// moveHistory = full line through the current position (ancestors + current + main continuation)
// currentMoveIndex = index of current node in moveHistory (-1 if at start)
function deriveFromTree(
  nodes: Record<string, MoveTreeNode>,
  rootChildren: string[],
  currentNodeId: string | null
) {
  if (currentNodeId === null) {
    const continuation = getContinuation(nodes, rootChildren[0])
    return { moveHistory: continuation, currentMoveIndex: -1 }
  }

  const path = getPathToNode(nodes, currentNodeId)
  const continuation = getContinuation(nodes, nodes[currentNodeId]?.children[0])
  return {
    moveHistory: [...path, ...continuation],
    currentMoveIndex: path.length - 1
  }
}

// The squares to highlight for a node; a null move has none.
function lastMoveOf(node: MoveTreeNode | null | undefined): { from: string; to: string } | null {
  return node?.from ? { from: node.from, to: node.to } : null
}

// Board, side to move, castling and en passant: what makes two positions the same.
function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ')
}

// The position after the side to move passes.
function nullMoveFen(fen: string): string {
  const [board, turn, castling, , half = '0', full = '1'] = fen.split(' ')
  const fullmove = turn === 'b' ? Number(full) + 1 : Number(full)
  return `${board} ${turn === 'w' ? 'b' : 'w'} ${castling} - ${Number(half) + 1} ${fullmove}`
}

type PlayedMove = Pick<MoveTreeNode, 'san' | 'from' | 'to' | 'promotion' | 'fen'>

function playSan(fen: string, san: string): PlayedMove | null {
  try {
    const chess = new Chess(fen)
    if (san === NULL_MOVE) {
      // Passing while in check would leave a king en prise.
      return chess.isCheck() ? null : { san, from: '', to: '', fen: nullMoveFen(fen) }
    }
    const move = chess.move(san)
    return {
      san: move.san,
      from: move.from,
      to: move.to,
      promotion: move.promotion,
      fen: chess.fen()
    }
  } catch {
    return null
  }
}

// Adds a PGN line and its variations under parentId; returns the new child IDs.
// An illegal move drops the rest of its line but not the lines around it.
function buildLine(
  line: PgnTreeNode[],
  parentFen: string,
  parentId: string | null,
  nodes: Record<string, MoveTreeNode>
): string[] {
  const ids: string[] = []
  for (const pgnNode of line) {
    const played = playSan(parentFen, pgnNode.san)
    if (!played) continue
    const node: MoveTreeNode = { id: genNodeId(), ...played, parentId, children: [] }
    if (!node.promotion) delete node.promotion
    if (pgnNode.comment) node.comment = pgnNode.comment
    if (pgnNode.commentBefore) node.commentBefore = pgnNode.commentBefore
    if (pgnNode.nags.length) node.nags = [...pgnNode.nags]
    nodes[node.id] = node
    ids.push(node.id)
    node.children = buildLine(pgnNode.children, node.fen, node.id, nodes)
  }
  return ids
}

// NAG groups whose members exclude each other: 1 = move marks, 2 = evaluations.
function nagGroup(nag: number): number {
  if (nag >= 1 && nag <= 9) return 1
  if (nag >= 10 && nag <= 19) return 2
  return 0
}

// State update that replaces a node's comment (or the game comment).
function withComment(
  state: GameState,
  nodeId: string | null,
  comment: string
): Partial<GameState> {
  if (nodeId === null) return { gameComment: comment }
  return withNode(state, nodeId, (node) => {
    if (comment) node.comment = comment
    else delete node.comment
  })
}

// State update that edits a copy of one node.
function withNode(
  state: GameState,
  nodeId: string,
  edit: (node: MoveTreeNode) => void
): Partial<GameState> {
  const node = state.treeNodes[nodeId]
  if (!node) return {}
  const updated = { ...node }
  edit(updated)
  const treeNodes = { ...state.treeNodes, [nodeId]: updated }
  return { treeNodes, ...deriveFromTree(treeNodes, state.rootChildren, state.currentNodeId) }
}

const SEVEN_TAG_ROSTER = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result']

function pgnComment(text: string): string {
  return `{${text.replace(/\{/g, '(').replace(/\}/g, ')')}}`
}

function serializePgn(state: GameState): string {
  const { treeNodes, rootChildren, startFen, headers, gameComment } = state
  const tags: Record<string, string> = { ...headers }
  if (startFen !== DEFAULT_FEN) {
    tags.SetUp = '1'
    tags.FEN = startFen
  }
  const tagOrder = [
    ...SEVEN_TAG_ROSTER.filter((k) => k in tags),
    ...Object.keys(tags).filter((k) => !SEVEN_TAG_ROSTER.includes(k))
  ]
  const tagLines = tagOrder.map(
    (k) => `[${k} "${tags[k].replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
  )

  const moveText = (node: MoveTreeNode, forceNumber: boolean): string => {
    const parentFen = node.parentId ? treeNodes[node.parentId].fen : startFen
    const [, turn, , , , fullmove = '1'] = parentFen.split(' ')
    const out: string[] = []
    if (node.commentBefore) out.push(pgnComment(node.commentBefore))
    const number =
      turn === 'w' ? `${fullmove}. ` : forceNumber || node.commentBefore ? `${fullmove}... ` : ''
    out.push(number + node.san)
    for (const nag of node.nags ?? []) out.push(`$${nag}`)
    if (node.comment) out.push(pgnComment(node.comment))
    return out.join(' ')
  }

  // A line from a set of alternatives: the first, its variations, then on.
  const line = (alternatives: string[], forceNumber: boolean): string => {
    const out: string[] = []
    let siblings = alternatives
    let force = forceNumber
    while (siblings.length > 0) {
      const main = treeNodes[siblings[0]]
      if (!main) break
      out.push(moveText(main, force))
      const variations = siblings.slice(1)
      for (const id of variations) out.push(`(${line([id], true)})`)
      // Black's move needs its number again after a comment or a variation.
      force = variations.length > 0 || !!main.comment
      siblings = main.children
    }
    return out.join(' ')
  }

  const movetext = [
    gameComment ? pgnComment(gameComment) : '',
    line(rootChildren, true),
    tags.Result || '*'
  ]
    .filter(Boolean)
    .join(' ')
  return tagLines.length ? `${tagLines.join('\n')}\n\n${movetext}` : movetext
}

export const useGameStore = create<GameState>((set, get) => ({
  chess: new Chess(),
  fen: DEFAULT_FEN,
  turn: 'w',
  isCheck: false,
  isCheckmate: false,
  isStalemate: false,
  isDraw: false,
  isGameOver: false,
  lastMove: null,
  orientation: 'white',

  startFen: DEFAULT_FEN,
  treeNodes: {},
  rootChildren: [],
  currentNodeId: null,
  headers: {},
  gameComment: '',
  moveHistory: [],
  currentMoveIndex: -1,

  makeMove:(from: string, to: string, promotion?: string) => {
    const { treeNodes, rootChildren, currentNodeId, startFen } = get()

    // Check if this move already exists as a child
    const childIds =
      currentNodeId === null ? rootChildren : treeNodes[currentNodeId]?.children || []

    for (const childId of childIds) {
      const child = treeNodes[childId]
      if (
        child &&
        child.from === from &&
        child.to === to &&
        (child.promotion || undefined) === (promotion || undefined)
      ) {
        // Move already exists — navigate to it
        const chess = new Chess(child.fen)
        const derived = deriveFromTree(treeNodes, rootChildren, childId)
        set({
          chess,
          ...deriveState(chess),
          lastMove: lastMoveOf(child),
          currentNodeId: childId,
          ...derived
        })
        // Return a Move object for sound effects
        try {
          const parentFen = currentNodeId ? treeNodes[currentNodeId].fen : startFen
          const tmp = new Chess(parentFen)
          return tmp.move({ from: from as Square, to: to as Square, promotion })
        } catch {
          return null
        }
      }
    }

    // New move — create a tree node
    try {
      const parentFen = currentNodeId ? treeNodes[currentNodeId].fen : startFen
      const tempChess = new Chess(parentFen)
      const result = tempChess.move({ from: from as Square, to: to as Square, promotion })

      const newId = genNodeId()
      const newNode: MoveTreeNode = {
        id: newId,
        san: result.san,
        from: result.from,
        to: result.to,
        promotion: result.promotion,
        fen: tempChess.fen(),
        parentId: currentNodeId,
        children: []
      }

      const newNodes = { ...treeNodes, [newId]: newNode }
      let newRootChildren = rootChildren

      if (currentNodeId === null) {
        newRootChildren = [...rootChildren, newId]
      } else {
        const parent = treeNodes[currentNodeId]
        newNodes[currentNodeId] = {
          ...parent,
          children: [...parent.children, newId]
        }
      }

      const chess = new Chess(newNode.fen)
      const derived = deriveFromTree(newNodes, newRootChildren, newId)

      set({
        chess,
        ...deriveState(chess),
        lastMove: { from: result.from, to: result.to },
        treeNodes: newNodes,
        rootChildren: newRootChildren,
        currentNodeId: newId,
        ...derived
      })

      return result
    } catch {
      return null
    }
  },

  newGame: (fen?: string) => {
    const startFen = fen || DEFAULT_FEN
    const chess = new Chess(startFen)
    set({
      chess,
      ...deriveState(chess),
      lastMove: null,
      startFen,
      treeNodes: {},
      rootChildren: [],
      currentNodeId: null,
      headers: {},
      gameComment: '',
      moveHistory: [],
      currentMoveIndex: -1
    })
  },

  flipBoard: () => {
    set((state) => ({
      orientation: state.orientation === 'white' ? 'black' : 'white'
    }))
  },

  goToMove: (index: number) => {
    const { moveHistory, treeNodes, rootChildren, startFen } = get()
    if (index < -1 || index >= moveHistory.length) return

    if (index < 0) {
      const chess = new Chess(startFen)
      const derived = deriveFromTree(treeNodes, rootChildren, null)
      set({
        chess,
        ...deriveState(chess),
        lastMove: null,
        currentNodeId: null,
        ...derived
      })
      return
    }

    const targetNode = moveHistory[index]
    if (!targetNode) return

    const chess = new Chess(targetNode.fen)
    const derived = deriveFromTree(treeNodes, rootChildren, targetNode.id)
    set({
      chess,
      ...deriveState(chess),
      lastMove: lastMoveOf(targetNode),
      currentNodeId: targetNode.id,
      ...derived
    })
  },

  goToNode: (nodeId: string) => {
    const { treeNodes, rootChildren } = get()
    const node = treeNodes[nodeId]
    if (!node) return

    const chess = new Chess(node.fen)
    const derived = deriveFromTree(treeNodes, rootChildren, nodeId)
    set({
      chess,
      ...deriveState(chess),
      lastMove: lastMoveOf(node),
      currentNodeId: nodeId,
      ...derived
    })
  },

  goForward: () => {
    const { currentNodeId, treeNodes, rootChildren } = get()
    const nextId =
      currentNodeId === null ? rootChildren[0] : treeNodes[currentNodeId]?.children[0]
    if (nextId) {
      get().goToNode(nextId)
    }
  },

  goBack: () => {
    const { currentNodeId, treeNodes, rootChildren, startFen } = get()
    if (currentNodeId === null) return

    const node = treeNodes[currentNodeId]
    if (!node) return

    if (node.parentId === null) {
      // Go to start position
      const chess = new Chess(startFen)
      const derived = deriveFromTree(treeNodes, rootChildren, null)
      set({
        chess,
        ...deriveState(chess),
        lastMove: null,
        currentNodeId: null,
        ...derived
      })
    } else {
      get().goToNode(node.parentId)
    }
  },

  goToStart: () => {
    const { treeNodes, rootChildren, startFen } = get()
    const chess = new Chess(startFen)
    const derived = deriveFromTree(treeNodes, rootChildren, null)
    set({
      chess,
      ...deriveState(chess),
      lastMove: null,
      currentNodeId: null,
      ...derived
    })
  },

  goToEnd: () => {
    const { currentNodeId, treeNodes, rootChildren } = get()
    // Follow first children from current position to the end
    let nodeId = currentNodeId
    let nextId: string | undefined =
      nodeId === null ? rootChildren[0] : treeNodes[nodeId]?.children[0]
    while (nextId) {
      nodeId = nextId
      nextId = treeNodes[nodeId]?.children[0]
    }
    if (nodeId && nodeId !== currentNodeId) {
      get().goToNode(nodeId)
    }
  },

  getLegalMoves: (square: string) => {
    const { chess } = get()
    const moves = chess.moves({ square: square as Square, verbose: true })
    return moves.map((m) => m.to)
  },

  getAllLegalDests: () => {
    const { chess } = get()
    const dests = new Map<string, string[]>()
    const moves = chess.moves({ verbose: true })
    for (const move of moves) {
      const existing = dests.get(move.from) || []
      existing.push(move.to)
      dests.set(move.from, existing)
    }
    return dests
  },

  loadPgn: (pgn: string, options?: { goToFen?: string }) => {
    const tree = parsePgnTree(pgn)
    if (tree.roots.length === 0 && Object.keys(tree.headers).length === 0) return false
    // The start position is kept as startFen; getPgn writes SetUp/FEN back from it.
    const headers = { ...tree.headers }
    const fenTag = headers.FEN
    delete headers.FEN
    delete headers.SetUp

    let startFen: string
    try {
      startFen = new Chess(fenTag?.trim() || DEFAULT_FEN).fen()
    } catch {
      return false
    }
    const nodes: Record<string, MoveTreeNode> = {}
    const rootChildren = buildLine(tree.roots, startFen, null, nodes)
    if (tree.roots.length > 0 && rootChildren.length === 0) return false

    const mainLine = getContinuation(nodes, rootChildren[0])
    let current: MoveTreeNode | null = mainLine[mainLine.length - 1] ?? null
    if (options?.goToFen) {
      const target = positionKey(options.goToFen)
      if (positionKey(startFen) === target) current = null
      else current = mainLine.find((n) => positionKey(n.fen) === target) ?? current
    }

    const chess = new Chess(current ? current.fen : startFen)
    const currentNodeId = current?.id ?? null
    set({
      chess,
      ...deriveState(chess),
      lastMove: lastMoveOf(current),
      startFen,
      treeNodes: nodes,
      rootChildren,
      currentNodeId,
      headers,
      gameComment: tree.comment ?? '',
      ...deriveFromTree(nodes, rootChildren, currentNodeId)
    })
    return true
  },

  getPgn: () => {
    const state = get()
    const empty =
      state.rootChildren.length === 0 &&
      Object.keys(state.headers).length === 0 &&
      !state.gameComment &&
      state.startFen === DEFAULT_FEN
    return empty ? '' : serializePgn(state)
  },

  setComment: (nodeId: string | null, text: string) => {
    set((s) => {
      const old = nodeId === null ? s.gameComment : s.treeNodes[nodeId]?.comment
      return withComment(s, nodeId, withCommentText(old, text))
    })
  },

  setShapes: (nodeId: string | null, shapes: CommentShape[]) => {
    set((s) => {
      const old = nodeId === null ? s.gameComment : s.treeNodes[nodeId]?.comment
      return withComment(s, nodeId, withCommentShapes(old, shapes))
    })
  },

  toggleNag: (nodeId: string, nag: number) => {
    set((s) =>
      withNode(s, nodeId, (node) => {
        const nags = node.nags ?? []
        const group = nagGroup(nag)
        const next = nags.includes(nag)
          ? nags.filter((n) => n !== nag)
          : [...nags.filter((n) => group === 0 || nagGroup(n) !== group), nag].sort((a, b) => a - b)
        if (next.length > 0) node.nags = next
        else delete node.nags
      })
    )
  },

  promoteVariation: (nodeId: string) => {
    const { treeNodes, rootChildren, currentNodeId } = get()
    const node = treeNodes[nodeId]
    if (!node) return

    const newNodes = { ...treeNodes }
    let newRootChildren = [...rootChildren]

    if (node.parentId === null) {
      const idx = newRootChildren.indexOf(nodeId)
      if (idx <= 0) return
      newRootChildren.splice(idx, 1)
      newRootChildren.unshift(nodeId)
    } else {
      const parent = newNodes[node.parentId]
      const idx = parent.children.indexOf(nodeId)
      if (idx <= 0) return
      const newChildren = [...parent.children]
      newChildren.splice(idx, 1)
      newChildren.unshift(nodeId)
      newNodes[node.parentId] = { ...parent, children: newChildren }
    }

    const derived = deriveFromTree(newNodes, newRootChildren, currentNodeId)
    set({ treeNodes: newNodes, rootChildren: newRootChildren, ...derived })
  },

  deleteVariation: (nodeId: string) => {
    const { treeNodes, rootChildren, currentNodeId, startFen } = get()
    const node = treeNodes[nodeId]
    if (!node) return

    // Collect all descendants
    function collectIds(id: string): string[] {
      const n = treeNodes[id]
      if (!n) return [id]
      const result = [id]
      for (const childId of n.children) {
        result.push(...collectIds(childId))
      }
      return result
    }

    const toDelete = new Set(collectIds(nodeId))
    const newNodes = { ...treeNodes }
    for (const id of toDelete) {
      delete newNodes[id]
    }

    let newRootChildren = rootChildren
    if (node.parentId === null) {
      newRootChildren = rootChildren.filter((id) => !toDelete.has(id))
    } else {
      const parent = newNodes[node.parentId]
      newNodes[node.parentId] = {
        ...parent,
        children: parent.children.filter((id) => !toDelete.has(id))
      }
    }

    // If current node was deleted, go to parent
    let newCurrentNodeId = currentNodeId
    if (currentNodeId && toDelete.has(currentNodeId)) {
      newCurrentNodeId = node.parentId
    }

    const chess = new Chess(
      newCurrentNodeId ? newNodes[newCurrentNodeId]?.fen || startFen : startFen
    )
    const lastMove = newCurrentNodeId ? lastMoveOf(newNodes[newCurrentNodeId]) : null
    const derived = deriveFromTree(newNodes, newRootChildren, newCurrentNodeId)

    set({
      chess,
      ...deriveState(chess),
      lastMove,
      treeNodes: newNodes,
      rootChildren: newRootChildren,
      currentNodeId: newCurrentNodeId,
      ...derived
    })
  }
}))
