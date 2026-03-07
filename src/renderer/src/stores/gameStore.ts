import { create } from 'zustand'
import { Chess, type Move, type Square } from 'chess.js'
import { DEFAULT_FEN } from '@shared/constants'

export interface MoveTreeNode {
  id: string
  san: string
  from: string
  to: string
  promotion?: string
  fen: string // FEN after this move
  parentId: string | null
  children: string[] // first = main continuation, rest = variations
  comment?: string
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
  loadPgn: (pgn: string) => boolean
  getPgn: () => string
  promoteVariation: (nodeId: string) => void
  deleteVariation: (nodeId: string) => void
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
  moveHistory: [],
  currentMoveIndex: -1,

  makeMove: (from: string, to: string, promotion?: string) => {
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
          lastMove: { from: child.from, to: child.to },
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
      lastMove: { from: targetNode.from, to: targetNode.to },
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
      lastMove: { from: node.from, to: node.to },
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

  loadPgn: (pgn: string) => {
    try {
      const chess = new Chess()
      chess.loadPgn(pgn)
      const history = chess.history({ verbose: true })
      const startFen = history.length > 0 ? history[0].before : DEFAULT_FEN

      // Build a linear tree from the move history
      const nodes: Record<string, MoveTreeNode> = {}
      const rootChildren: string[] = []
      let parentId: string | null = null

      for (const move of history) {
        const id = genNodeId()
        const node: MoveTreeNode = {
          id,
          san: move.san,
          from: move.from,
          to: move.to,
          promotion: move.promotion,
          fen: move.after,
          parentId,
          children: []
        }

        nodes[id] = node
        if (parentId === null) {
          rootChildren.push(id)
        } else {
          nodes[parentId].children.push(id)
        }
        parentId = id
      }

      const lastNodeId = parentId
      const derived = deriveFromTree(nodes, rootChildren, lastNodeId)

      set({
        chess,
        ...deriveState(chess),
        startFen,
        treeNodes: nodes,
        rootChildren,
        currentNodeId: lastNodeId,
        ...derived,
        lastMove:
          history.length > 0
            ? { from: history[history.length - 1].from, to: history[history.length - 1].to }
            : null
      })
      return true
    } catch {
      return false
    }
  },

  getPgn: () => {
    const { treeNodes, rootChildren, startFen } = get()
    if (rootChildren.length === 0) return ''

    function serializeLine(nodeIds: string[], forceNumber: boolean): string {
      if (nodeIds.length === 0) return ''

      const mainId = nodeIds[0]
      const variations = nodeIds.slice(1)
      const mainNode = treeNodes[mainId]
      if (!mainNode) return ''

      const parentFen = mainNode.parentId ? treeNodes[mainNode.parentId].fen : startFen
      const fenParts = parentFen.split(' ')
      const turn = fenParts[1]
      const moveNum = fenParts[5] || '1'

      const parts: string[] = []

      if (turn === 'w') {
        parts.push(`${moveNum}. ${mainNode.san}`)
      } else if (forceNumber) {
        parts.push(`${moveNum}... ${mainNode.san}`)
      } else {
        parts.push(mainNode.san)
      }

      // Variations
      for (const varId of variations) {
        const varNode = treeNodes[varId]
        if (!varNode) continue
        const vParentFen = varNode.parentId ? treeNodes[varNode.parentId].fen : startFen
        const vParts = vParentFen.split(' ')
        const vTurn = vParts[1]
        const vNum = vParts[5] || '1'

        let varStr = vTurn === 'w' ? `${vNum}. ${varNode.san}` : `${vNum}... ${varNode.san}`
        if (varNode.children.length > 0) {
          varStr += ' ' + serializeLine(varNode.children, false)
        }
        parts.push(`(${varStr})`)
      }

      // Continue main line
      if (mainNode.children.length > 0) {
        parts.push(serializeLine(mainNode.children, variations.length > 0))
      }

      return parts.join(' ')
    }

    let pgn = ''
    if (startFen !== DEFAULT_FEN) {
      pgn += `[FEN "${startFen}"]\n\n`
    }
    pgn += serializeLine(rootChildren, true)
    return pgn
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
    const lastMove = newCurrentNodeId
      ? { from: newNodes[newCurrentNodeId].from, to: newNodes[newCurrentNodeId].to }
      : null
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
