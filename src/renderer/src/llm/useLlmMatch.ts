import { useEffect, useRef } from 'react'
import { useGameStore, type MoveTreeNode } from '@renderer/stores/gameStore'
import { useEngineStore } from '@renderer/stores/engineStore'
import { useLlmStore, seatFor, isLlmGameActive } from '@renderer/stores/llmStore'
import { useSounds } from '@renderer/board/hooks/useSounds'
import { replayGame, type PositionInput } from '@shared/llm/prompt'
import { detectOutcome, requestLlmMove } from '@shared/llm/turn'

// The moves leading to the current node, and whether that node is the tip of its line.
function currentLine(): { position: PositionInput; atTip: boolean; nodeId: string | null } {
  const { treeNodes, rootChildren, currentNodeId, startFen } = useGameStore.getState()
  const path: MoveTreeNode[] = []
  let cur = currentNodeId
  while (cur) {
    const n: MoveTreeNode | undefined = treeNodes[cur]
    if (!n) break
    path.unshift(n)
    cur = n.parentId
  }
  const children = currentNodeId === null ? rootChildren : treeNodes[currentNodeId]?.children ?? []
  return {
    position: { startFen, sanMoves: path.map((n) => n.san) },
    atTip: children.length === 0,
    nodeId: currentNodeId
  }
}

// Drives a game in which one or both sides are LLM players. Mounted once.
export function useLlmMatch(): void {
  const match = useLlmStore((s) => s.match)
  const players = useLlmStore((s) => s.players)
  const currentNodeId = useGameStore((s) => s.currentNodeId)
  const fen = useGameStore((s) => s.fen)
  const isAnalyzing = useEngineStore((s) => s.isAnalyzing)
  const playSound = useSounds()
  const inFlight = useRef<string | null>(null)

  // Engines stay off for the whole game. LLM players never see engine output
  // anyway (it is not part of the prompt), but this keeps the game clean.
  useEffect(() => {
    if (!isLlmGameActive(match) || !isAnalyzing) return
    const { engines, setAnalyzing } = useEngineStore.getState()
    for (const e of engines) window.electronAPI?.engine?.stopAnalysis(e.id)
    setAnalyzing(false)
  }, [match, isAnalyzing])

  useEffect(() => {
    if (!match || match.status !== 'running') return
    const { position, atTip, nodeId } = currentLine()
    if (!atTip) return // the user is looking at an earlier move; wait until they come back

    const llm = useLlmStore.getState()
    const chess = replayGame(position)
    const outcome = detectOutcome(chess, match.maxPlies)
    if (outcome) {
      llm.finishMatch(outcome)
      return
    }

    const seat = seatFor(match, chess.turn())
    if (seat.kind !== 'llm') return

    const key = `${match.id}:${nodeId ?? 'start'}`
    if (inFlight.current === key) return

    const player = players.find((p) => p.id === seat.playerId)
    if (!player) {
      llm.pauseMatch('This LLM player was deleted')
      return
    }

    inFlight.current = key
    const side = chess.turn() === 'w' ? 'white' : 'black'
    const ply = chess.history().length
    llm.setThinking(side)

    const stillOurs = () => {
      const m = useLlmStore.getState().match
      return !!m && m.id === match.id && m.status !== 'finished'
    }

    requestLlmMove({
      config: player,
      position,
      chat: (req) => window.electronAPI.llm.chat(req),
      isCancelled: () => !stillOurs()
    }).then((res) => {
      if (inFlight.current === key) inFlight.current = null
      if (!stillOurs()) return
      const store = useLlmStore.getState()
      store.addLog({
        id: `${key}:${Date.now()}`,
        ply,
        side,
        playerName: player.name,
        san: res.kind === 'move' ? res.move.san : undefined,
        attempts: res.attempts,
        error: res.kind === 'error' ? res.error : res.kind === 'forfeit' ? res.reason : undefined
      })

      if (res.kind === 'error') {
        store.pauseMatch(res.error)
        return
      }
      if (res.kind === 'forfeit') {
        store.finishMatch({
          result: side === 'white' ? '0-1' : '1-0',
          reason: 'forfeit',
          detail: `${player.name}: ${res.reason}`
        })
        return
      }

      // Play the move from the position it was asked about, even if the user
      // has been browsing other moves in the meantime.
      const game = useGameStore.getState()
      if (nodeId === null) game.goToStart()
      else if (game.treeNodes[nodeId]) game.goToNode(nodeId)
      else {
        store.pauseMatch('The position changed while the LLM was thinking')
        return
      }
      const played = game.makeMove(res.move.from, res.move.to, res.move.promotion)
      if (played) playSound(played)
      store.setThinking(null)
    })
  }, [match, players, currentNodeId, fen, playSound])
}
