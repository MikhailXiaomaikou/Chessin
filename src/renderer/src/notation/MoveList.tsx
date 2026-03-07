import { useEffect, useRef, useMemo } from 'react'
import { useGameStore, type MoveTreeNode } from '@renderer/stores/gameStore'
import {
  useAnalysisStore,
  CLASSIFICATION_COLORS,
  CLASSIFICATION_SYMBOLS
} from '@renderer/stores/analysisStore'
import { useT } from '@renderer/i18n/useI18n'

// Token types for flat rendering of the move tree
interface MoveToken {
  type: 'move'
  node: MoveTreeNode
  isWhite: boolean
  moveNumber: number
  showNumber: boolean // whether to display the move number prefix
}

interface VarStartToken {
  type: 'varStart'
  depth: number
}

interface VarEndToken {
  type: 'varEnd'
  depth: number
}

type Token = MoveToken | VarStartToken | VarEndToken

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

// Tokenize the tree into a flat list for rendering
function tokenize(
  nodeIds: string[],
  nodes: Record<string, MoveTreeNode>,
  startFen: string,
  depth: number,
  forceNumber: boolean
): Token[] {
  if (nodeIds.length === 0) return []

  const tokens: Token[] = []
  const mainId = nodeIds[0]
  const variations = nodeIds.slice(1)
  const mainNode = nodes[mainId]
  if (!mainNode) return []

  const info = getMoveInfo(mainNode, nodes, startFen)

  tokens.push({
    type: 'move',
    node: mainNode,
    isWhite: info.isWhite,
    moveNumber: info.moveNumber,
    showNumber: info.isWhite || forceNumber
  })

  // Render variations (siblings)
  for (const varId of variations) {
    const varNode = nodes[varId]
    if (!varNode) continue
    tokens.push({ type: 'varStart', depth: depth + 1 })

    const varInfo = getMoveInfo(varNode, nodes, startFen)
    tokens.push({
      type: 'move',
      node: varNode,
      isWhite: varInfo.isWhite,
      moveNumber: varInfo.moveNumber,
      showNumber: true // always show number at start of variation
    })

    if (varNode.children.length > 0) {
      tokens.push(...tokenize(varNode.children, nodes, startFen, depth + 1, false))
    }

    tokens.push({ type: 'varEnd', depth: depth + 1 })
  }

  // Continue main line
  if (mainNode.children.length > 0) {
    tokens.push(
      ...tokenize(mainNode.children, nodes, startFen, depth, variations.length > 0)
    )
  }

  return tokens
}

export default function MoveList() {
  const t = useT()
  const treeNodes = useGameStore((s) => s.treeNodes)
  const rootChildren = useGameStore((s) => s.rootChildren)
  const startFen = useGameStore((s) => s.startFen)
  const currentNodeId = useGameStore((s) => s.currentNodeId)
  const goToNode = useGameStore((s) => s.goToNode)
  const promoteVariation = useGameStore((s) => s.promoteVariation)
  const deleteVariation = useGameStore((s) => s.deleteVariation)
  const moveEvals = useAnalysisStore((s) => s.moveEvals)
  const moveHistory = useGameStore((s) => s.moveHistory)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeMoveRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (activeMoveRef.current && scrollRef.current) {
      activeMoveRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [currentNodeId])

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

  const tokens = useMemo(
    () => tokenize(rootChildren, treeNodes, startFen, 0, true),
    [rootChildren, treeNodes, startFen]
  )

  if (rootChildren.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-gray-500 text-base">
        {t('moves.empty')}
      </div>
    )
  }

  const handleContextMenu = (e: React.MouseEvent, node: MoveTreeNode) => {
    e.preventDefault()
    // Check if this node is a variation (not the first child of its parent)
    const parentId = node.parentId
    const siblings = parentId === null ? rootChildren : treeNodes[parentId]?.children || []
    const idx = siblings.indexOf(node.id)
    if (idx <= 0) return // main line, no context menu

    // Simple context menu: promote or delete
    const menu = document.createElement('div')
    menu.className =
      'fixed bg-surface-secondary border border-[var(--border-color)] rounded shadow-xl py-1 z-[100] text-sm'
    menu.style.left = `${e.clientX}px`
    menu.style.top = `${e.clientY}px`

    const promoteBtn = document.createElement('button')
    promoteBtn.className =
      'block w-full text-left px-4 py-2 hover:bg-surface-tertiary text-gray-200'
    promoteBtn.textContent = t('variation.promote')
    promoteBtn.onclick = () => {
      promoteVariation(node.id)
      document.body.removeChild(menu)
    }

    const deleteBtn = document.createElement('button')
    deleteBtn.className =
      'block w-full text-left px-4 py-2 hover:bg-surface-tertiary text-red-400'
    deleteBtn.textContent = t('variation.delete')
    deleteBtn.onclick = () => {
      deleteVariation(node.id)
      document.body.removeChild(menu)
    }

    menu.appendChild(promoteBtn)
    menu.appendChild(deleteBtn)
    document.body.appendChild(menu)

    const removeMenu = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        if (document.body.contains(menu)) document.body.removeChild(menu)
        document.removeEventListener('mousedown', removeMenu)
      }
    }
    setTimeout(() => document.addEventListener('mousedown', removeMenu), 0)
  }

  return (
    <div
      ref={scrollRef}
      className="overflow-y-auto flex-1 p-3 text-base font-mono leading-relaxed"
    >
      <div className="flex flex-wrap items-baseline gap-y-0.5">
        {tokens.map((token, i) => {
          if (token.type === 'varStart') {
            return (
              <span
                key={`vs${i}`}
                className="text-gray-600 mx-0.5"
                style={{ marginLeft: token.depth > 1 ? `${(token.depth - 1) * 8}px` : undefined }}
              >
                {'( '}
              </span>
            )
          }

          if (token.type === 'varEnd') {
            return (
              <span key={`ve${i}`} className="text-gray-600 mx-0.5">
                {') '}
              </span>
            )
          }

          // Move token
          const { node, isWhite, moveNumber, showNumber } = token
          const isActive = node.id === currentNodeId

          // Look up eval for this node
          const lineIdx = moveHistoryNodeEvals.get(node.id)
          const ev = lineIdx !== undefined ? evalMap.get(lineIdx) : undefined
          const symbol = ev ? CLASSIFICATION_SYMBOLS[ev.classification] : ''
          const color = ev ? CLASSIFICATION_COLORS[ev.classification] : undefined

          // Is this a variation node? (not first child of parent)
          const parentId = node.parentId
          const siblings =
            parentId === null ? rootChildren : treeNodes[parentId]?.children || []
          const isVariation = siblings.indexOf(node.id) > 0

          return (
            <span key={node.id} className="inline-flex items-baseline">
              {showNumber && (
                <span className="text-gray-500 select-none mr-0.5">
                  {moveNumber}.{!isWhite && '..'}
                </span>
              )}
              <span
                ref={isActive ? activeMoveRef : undefined}
                onClick={() => goToNode(node.id)}
                onContextMenu={isVariation ? (e) => handleContextMenu(e, node) : undefined}
                className={`px-1 py-0.5 rounded cursor-pointer transition-colors ${
                  isActive
                    ? 'bg-accent text-white'
                    : isVariation
                      ? 'text-gray-400 hover:bg-surface-tertiary'
                      : 'text-gray-200 hover:bg-surface-tertiary'
                }`}
              >
                {node.san}
                {symbol && (
                  <span
                    className="text-xs font-bold ml-0.5"
                    style={{ color: isActive ? '#fff' : color }}
                  >
                    {symbol}
                  </span>
                )}
              </span>
              <span className="w-0.5" />
            </span>
          )
        })}
      </div>
    </div>
  )
}
