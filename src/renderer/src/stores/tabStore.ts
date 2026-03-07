import { create } from 'zustand'
import { useGameStore, type MoveTreeNode } from './gameStore'
import { Chess } from 'chess.js'
import { DEFAULT_FEN } from '@shared/constants'

export interface TabData {
  id: string
  name: string
  orientation: 'white' | 'black'
  startFen: string
  treeNodes: Record<string, MoveTreeNode>
  rootChildren: string[]
  currentNodeId: string | null
  lastMove: { from: string; to: string } | null
}

export interface TabState {
  tabs: TabData[]
  activeTabId: string

  addTab: (name?: string) => void
  closeTab: (id: string) => void
  switchTab: (id: string) => void
  renameTab: (id: string, name: string) => void
  updateActiveTabFromGame: () => void
}

let tabCounter = 1

function snapshotGame(): Omit<TabData, 'id' | 'name'> {
  const s = useGameStore.getState()
  return {
    orientation: s.orientation,
    startFen: s.startFen,
    treeNodes: s.treeNodes,
    rootChildren: s.rootChildren,
    currentNodeId: s.currentNodeId,
    lastMove: s.lastMove
  }
}

function loadGameFromTab(tab: TabData): void {
  const fen = tab.currentNodeId
    ? tab.treeNodes[tab.currentNodeId]?.fen || tab.startFen
    : tab.startFen
  const chess = new Chess(fen)

  // Derive moveHistory and currentMoveIndex from tree
  // (inline the derivation logic to avoid importing private helpers)
  function getPath(nodeId: string | null): MoveTreeNode[] {
    if (!nodeId) return []
    const path: MoveTreeNode[] = []
    let cur: string | null = nodeId
    while (cur) {
      const n: MoveTreeNode | undefined = tab.treeNodes[cur]
      if (!n) break
      path.unshift(n)
      cur = n.parentId
    }
    return path
  }

  function getCont(startChildId: string | undefined): MoveTreeNode[] {
    const result: MoveTreeNode[] = []
    let nextId: string | undefined = startChildId
    while (nextId) {
      const n = tab.treeNodes[nextId]
      if (!n) break
      result.push(n)
      nextId = n.children[0]
    }
    return result
  }

  let moveHistory: MoveTreeNode[]
  let currentMoveIndex: number

  if (tab.currentNodeId === null) {
    moveHistory = getCont(tab.rootChildren[0])
    currentMoveIndex = -1
  } else {
    const path = getPath(tab.currentNodeId)
    const cont = getCont(tab.treeNodes[tab.currentNodeId]?.children[0])
    moveHistory = [...path, ...cont]
    currentMoveIndex = path.length - 1
  }

  useGameStore.setState({
    chess,
    fen: chess.fen(),
    turn: chess.turn(),
    isCheck: chess.isCheck(),
    isCheckmate: chess.isCheckmate(),
    isStalemate: chess.isStalemate(),
    isDraw: chess.isDraw(),
    isGameOver: chess.isGameOver(),
    orientation: tab.orientation,
    startFen: tab.startFen,
    treeNodes: tab.treeNodes,
    rootChildren: tab.rootChildren,
    currentNodeId: tab.currentNodeId,
    moveHistory,
    currentMoveIndex,
    lastMove: tab.lastMove
  })
}

const initialTabId = `tab_${Date.now()}`

export const useTabStore = create<TabState>((set, get) => ({
  tabs: [
    {
      id: initialTabId,
      name: '1',
      orientation: 'white' as const,
      startFen: DEFAULT_FEN,
      treeNodes: {},
      rootChildren: [],
      currentNodeId: null,
      lastMove: null
    }
  ],
  activeTabId: initialTabId,

  addTab: (name?: string) => {
    const { tabs, activeTabId } = get()
    const snapshot = snapshotGame()
    const updatedTabs = tabs.map((t) =>
      t.id === activeTabId ? { ...t, ...snapshot } : t
    )

    tabCounter++
    const newTab: TabData = {
      id: `tab_${Date.now()}`,
      name: name || `${tabCounter}`,
      orientation: 'white',
      startFen: DEFAULT_FEN,
      treeNodes: {},
      rootChildren: [],
      currentNodeId: null,
      lastMove: null
    }

    set({ tabs: [...updatedTabs, newTab], activeTabId: newTab.id })
    useGameStore.getState().newGame()
  },

  closeTab: (id: string) => {
    const { tabs, activeTabId } = get()
    if (tabs.length <= 1) return

    const newTabs = tabs.filter((t) => t.id !== id)

    if (activeTabId === id) {
      const closedIndex = tabs.findIndex((t) => t.id === id)
      const newActive = newTabs[Math.min(closedIndex, newTabs.length - 1)]
      set({ tabs: newTabs, activeTabId: newActive.id })
      loadGameFromTab(newActive)
    } else {
      set({ tabs: newTabs })
    }
  },

  switchTab: (id: string) => {
    const { tabs, activeTabId } = get()
    if (id === activeTabId) return

    const snapshot = snapshotGame()
    const updatedTabs = tabs.map((t) =>
      t.id === activeTabId ? { ...t, ...snapshot } : t
    )

    set({ tabs: updatedTabs, activeTabId: id })

    const targetTab = updatedTabs.find((t) => t.id === id)
    if (targetTab) {
      loadGameFromTab(targetTab)
    }
  },

  renameTab: (id: string, name: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, name } : t))
    }))
  },

  updateActiveTabFromGame: () => {
    const { tabs, activeTabId } = get()
    const snapshot = snapshotGame()
    set({
      tabs: tabs.map((t) =>
        t.id === activeTabId ? { ...t, ...snapshot } : t
      )
    })
  }
}))
