import { Fragment, useEffect, useRef, useMemo, useState, type ReactNode } from 'react'
import { useGameStore, type MoveTreeNode } from '@renderer/stores/gameStore'
import {
  useAnalysisStore,
  CLASSIFICATION_COLORS,
  CLASSIFICATION_SYMBOLS
} from '@renderer/stores/analysisStore'
import { useT } from '@renderer/i18n/useI18n'
import { NAG_SYMBOLS } from '@shared/constants'
import { commentText } from '@shared/chess/commentShapes'
import CommentEditor from './CommentEditor'

// Quick annotations offered in the context menu: move marks, then evaluations.
const MOVE_MARKS = [1, 2, 3, 4, 5, 6]
const EVALUATIONS = [10, 13, 14, 15, 16, 17, 18, 19]

const nagText = (nag: number): string => NAG_SYMBOLS[nag] ?? `$${nag}`

// Get move info (color, number) from a node's parent FEN
function getMoveInfo(
  node: MoveTreeNode,
  nodes: Record<string, MoveTreeNode>,
  startFen: string
): { isWhite: boolean; moveNumber: number } {
  const parentFen = node.parentId ? nodes[node.parentId].fen : startFen
  const parts = parentFen.split(' ')
  const turn = parts[1] // who is about to play (before this move)
  const fullmove = parseInt(parts[5] || '1')
  return { isWhite: turn === 'w', moveNumber: fullmove }
}

interface MenuState {
  x: number
  y: number
  nodeId: string
}

// undefined = not editing; null = the game comment; else a node ID.
type EditTarget = string | null | undefined

export default function MoveList() {
  const t = useT()
  const treeNodes = useGameStore((s) => s.treeNodes)
  const rootChildren = useGameStore((s) => s.rootChildren)
  const startFen = useGameStore((s) => s.startFen)
  const currentNodeId = useGameStore((s) => s.currentNodeId)
  const gameComment = useGameStore((s) => s.gameComment)
  const goToNode = useGameStore((s) => s.goToNode)
  const promoteVariation = useGameStore((s) => s.promoteVariation)
  const deleteVariation = useGameStore((s) => s.deleteVariation)
  const setComment = useGameStore((s) => s.setComment)
  const toggleNag = useGameStore((s) => s.toggleNag)
  const moveEvals = useAnalysisStore((s) => s.moveEvals)
  const moveHistory = useGameStore((s) => s.moveHistory)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeMoveRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editing, setEditing] = useState<EditTarget>(undefined)

  useEffect(() => {
    if (activeMoveRef.current && scrollRef.current) {
      activeMoveRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [currentNodeId])

  // Close the context menu on a click elsewhere or Escape.
  useEffect(() => {
    if (!menu) return
    const onMouseDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menu])

  // A different game: drop any open editor or menu.
  useEffect(() => {
    setMenu(null)
    setEditing(undefined)
  }, [rootChildren])

  // Build eval map: moveIndex in current line -> eval data
  const evalMap = useMemo(
    () => new Map(moveEvals.map((e) => [e.moveIndex, e])),
    [moveEvals]
  )

  // Build a set of node IDs in the current moveHistory for eval matching
  const moveHistoryNodeEvals = useMemo(() => {
    const map = new Map<string, number>()
    moveHistory.forEach((node, idx) => {
      map.set(node.id, idx)
    })
    return map
  }, [moveHistory])

  const isVariation = (node: MoveTreeNode): boolean => {
    const siblings = node.parentId === null ? rootChildren : treeNodes[node.parentId]?.children || []
    return siblings.indexOf(node.id) > 0
  }

  const editor = (target: string | null, comment: string | undefined): ReactNode => (
    <CommentEditor
      comment={commentText(comment)}
      onSave={(text) => {
        setComment(target, text)
        setEditing(undefined)
      }}
      onCancel={() => setEditing(undefined)}
    />
  )

  const commentSpan = (text: string, onEdit?: () => void): ReactNode => (
    <span
      onDoubleClick={onEdit}
      className="font-sans text-[0.9em] text-[#8fb3d9] mr-1.5 break-words"
      title={onEdit ? t('comment.edit') : undefined}
    >
      {text}
    </span>
  )

  const renderMove = (node: MoveTreeNode, forceNumber: boolean, inVariation: boolean): ReactNode => {
    const { isWhite, moveNumber } = getMoveInfo(node, treeNodes, startFen)
    const showNumber = isWhite || forceNumber || !!node.commentBefore
    const isActive = node.id === currentNodeId

    // Look up eval for this node
    const lineIdx = moveHistoryNodeEvals.get(node.id)
    const ev = lineIdx !== undefined ? evalMap.get(lineIdx) : undefined
    const symbol = ev ? CLASSIFICATION_SYMBOLS[ev.classification] : ''
    const color = ev ? CLASSIFICATION_COLORS[ev.classification] : undefined

    const nags = node.nags ?? []
    const marks = nags.filter((n) => n < 10).map(nagText).join('')
    const others = nags.filter((n) => n >= 10).map(nagText).join(' ')
    const before = commentText(node.commentBefore)
    const after = commentText(node.comment)

    return (
      <Fragment key={node.id}>
        {before && commentSpan(before)}
        <span className="whitespace-nowrap">
          {showNumber && (
            <span className="text-gray-500 select-none mr-0.5">
              {moveNumber}.{!isWhite && '..'}
            </span>
          )}
          <span
            ref={isActive ? activeMoveRef : undefined}
            onClick={() => goToNode(node.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
            }}
            className={`px-1 py-0.5 rounded cursor-pointer transition-colors ${
              isActive
                ? 'bg-accent text-white'
                : inVariation
                  ? 'text-gray-400 hover:bg-surface-tertiary'
                  : 'text-gray-200 hover:bg-surface-tertiary'
            }`}
          >
            {node.san}
            {marks && (
              <span className={isActive ? 'text-white' : 'text-yellow-400'}>{marks}</span>
            )}
            {symbol && (
              <span
                className="text-xs font-bold ml-0.5"
                style={{ color: isActive ? '#fff' : color }}
              >
                {symbol}
              </span>
            )}
          </span>
          {others && <span className="text-gray-400 ml-0.5">{others}</span>}
        </span>{' '}
        {editing === node.id
          ? editor(node.id, node.comment)
          : after && commentSpan(after, () => setEditing(node.id))}
      </Fragment>
    )
  }

  // Main line moves stay inline; a variation of the main line gets its own
  // indented block, and deeper ones go in parentheses within it.
  const renderLine = (ids: string[], depth: number, forceNumber: boolean, out: ReactNode[]) => {
    let siblings = ids
    let force = forceNumber
    while (siblings.length > 0) {
      const main = treeNodes[siblings[0]]
      if (!main) break
      out.push(renderMove(main, force, depth > 0))
      const variations = siblings.slice(1)
      for (const id of variations) {
        const inner: ReactNode[] = []
        renderLine([id], depth + 1, true, inner)
        out.push(
          depth === 0 ? (
            <div
              key={`v${id}`}
              className="pl-3 my-1 border-l-2 border-[var(--border-color)] text-[0.92em]"
            >
              {inner}
            </div>
          ) : (
            <span key={`v${id}`} className="text-gray-500">
              ( {inner}){' '}
            </span>
          )
        )
      }
      force = variations.length > 0 || !!commentText(main.comment) || editing === main.id
      siblings = main.children
    }
  }

  if (rootChildren.length === 0 && !commentText(gameComment) && editing !== null) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-gray-500 text-base">
        {t('moves.empty')}
      </div>
    )
  }

  const content: ReactNode[] = []
  renderLine(rootChildren, 0, true, content)
  const intro = commentText(gameComment)

  const menuNode = menu ? treeNodes[menu.nodeId] : undefined
  const menuIsVariation = menuNode ? isVariation(menuNode) : false
  const closeMenu = () => setMenu(null)

  return (
    <div ref={scrollRef} className="overflow-y-auto flex-1 p-3 text-base font-mono leading-7">
      {editing === null ? (
        editor(null, gameComment)
      ) : (
        intro && <div className="mb-1">{commentSpan(intro, () => setEditing(null))}</div>
      )}
      <div>{content}</div>

      {menu && menuNode && (
        <div
          ref={menuRef}
          className="fixed bg-surface-secondary border border-[var(--border-color)] rounded shadow-xl py-1 z-[100] text-sm w-56 font-sans"
          style={{
            left: Math.min(menu.x, window.innerWidth - 232),
            top: Math.min(menu.y, window.innerHeight - 240)
          }}
        >
          {[MOVE_MARKS, EVALUATIONS].map((group, i) => (
            <div key={i} className="flex flex-wrap gap-0.5 px-2 py-1">
              {group.map((nag) => {
                const active = menuNode.nags?.includes(nag)
                return (
                  <button
                    key={nag}
                    onClick={() => {
                      toggleNag(menuNode.id, nag)
                      closeMenu()
                    }}
                    className={`min-w-[1.75rem] h-7 px-1 rounded font-mono transition-colors ${
                      active ? 'bg-accent text-white' : 'text-gray-200 hover:bg-surface-tertiary'
                    }`}
                  >
                    {nagText(nag)}
                  </button>
                )
              })}
            </div>
          ))}
          <div className="border-t border-[var(--border-color)] my-1" />
          <button
            className="block w-full text-left px-4 py-2 hover:bg-surface-tertiary text-gray-200"
            onClick={() => {
              setEditing(menuNode.id)
              closeMenu()
            }}
          >
            {commentText(menuNode.comment) ? t('comment.edit') : t('comment.add')}
          </button>
          {menuIsVariation && (
            <button
              className="block w-full text-left px-4 py-2 hover:bg-surface-tertiary text-gray-200"
              onClick={() => {
                promoteVariation(menuNode.id)
                closeMenu()
              }}
            >
              {t('variation.promote')}
            </button>
          )}
          <button
            className="block w-full text-left px-4 py-2 hover:bg-surface-tertiary text-red-400"
            onClick={() => {
              deleteVariation(menuNode.id)
              closeMenu()
            }}
          >
            {menuIsVariation ? t('variation.delete') : t('variation.deleteFromHere')}
          </button>
        </div>
      )}
    </div>
  )
}
