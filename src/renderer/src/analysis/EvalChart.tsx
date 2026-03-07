import { useRef, useEffect, useCallback } from 'react'
import { useAnalysisStore, CLASSIFICATION_COLORS, type MoveEval } from '@renderer/stores/analysisStore'
import { useGameStore } from '@renderer/stores/gameStore'
import { useT } from '@renderer/i18n/useI18n'

const CHART_HEIGHT = 120
const CLAMP = 500 // clamp eval to +/- 5 pawns for display

function clampEval(cp: number): number {
  return Math.max(-CLAMP, Math.min(CLAMP, cp))
}

export default function EvalChart() {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const moveEvals = useAnalysisStore((s) => s.moveEvals)
  const isAnalyzingGame = useAnalysisStore((s) => s.isAnalyzingGame)
  const analysisProgress = useAnalysisStore((s) => s.analysisProgress)
  const analysisTotalMoves = useAnalysisStore((s) => s.analysisTotalMoves)
  const currentMoveIndex = useGameStore((s) => s.currentMoveIndex)
  const goToMove = useGameStore((s) => s.goToMove)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || moveEvals.length === 0) return

    const width = container.clientWidth
    canvas.width = width * window.devicePixelRatio
    canvas.height = CHART_HEIGHT * window.devicePixelRatio
    canvas.style.width = `${width}px`
    canvas.style.height = `${CHART_HEIGHT}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
    ctx.clearRect(0, 0, width, CHART_HEIGHT)

    const midY = CHART_HEIGHT / 2
    const n = moveEvals.length
    const stepX = width / Math.max(n, 1)

    // Background
    ctx.fillStyle = '#1e1e1e'
    ctx.fillRect(0, 0, width, CHART_HEIGHT)

    // Center line
    ctx.strokeStyle = '#555'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, midY)
    ctx.lineTo(width, midY)
    ctx.stroke()

    // Grid lines at +/- 1, 2, 3 pawns
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 0.5
    for (const pawn of [100, 200, 300]) {
      const y1 = midY - (pawn / CLAMP) * midY
      const y2 = midY + (pawn / CLAMP) * midY
      ctx.beginPath()
      ctx.moveTo(0, y1)
      ctx.lineTo(width, y1)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, y2)
      ctx.lineTo(width, y2)
      ctx.stroke()
    }

    // Fill area: white advantage (above midline) and black advantage (below)
    // White fill
    ctx.beginPath()
    ctx.moveTo(0, midY)
    for (let i = 0; i < n; i++) {
      const x = i * stepX + stepX / 2
      const cp = clampEval(moveEvals[i].scoreAfter)
      const y = midY - (cp / CLAMP) * midY
      if (cp > 0) {
        ctx.lineTo(x, y)
      } else {
        ctx.lineTo(x, midY)
      }
    }
    ctx.lineTo((n - 1) * stepX + stepX / 2, midY)
    ctx.closePath()
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.fill()

    // Black fill
    ctx.beginPath()
    ctx.moveTo(0, midY)
    for (let i = 0; i < n; i++) {
      const x = i * stepX + stepX / 2
      const cp = clampEval(moveEvals[i].scoreAfter)
      const y = midY - (cp / CLAMP) * midY
      if (cp < 0) {
        ctx.lineTo(x, y)
      } else {
        ctx.lineTo(x, midY)
      }
    }
    ctx.lineTo((n - 1) * stepX + stepX / 2, midY)
    ctx.closePath()
    ctx.fillStyle = 'rgba(100,100,100,0.25)'
    ctx.fill()

    // Eval line
    ctx.beginPath()
    ctx.strokeStyle = '#aaa'
    ctx.lineWidth = 1.5
    for (let i = 0; i < n; i++) {
      const x = i * stepX + stepX / 2
      const cp = clampEval(moveEvals[i].scoreAfter)
      const y = midY - (cp / CLAMP) * midY
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Classification dots for notable moves
    for (let i = 0; i < n; i++) {
      const ev = moveEvals[i]
      if (ev.classification === 'best' || ev.classification === 'good' || ev.classification === 'book') continue
      const x = i * stepX + stepX / 2
      const cp = clampEval(ev.scoreAfter)
      const y = midY - (cp / CLAMP) * midY
      const color = CLASSIFICATION_COLORS[ev.classification]

      ctx.beginPath()
      ctx.arc(x, y, 3.5, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    }

    // Current move indicator
    if (currentMoveIndex >= 0 && currentMoveIndex < n) {
      const x = currentMoveIndex * stepX + stepX / 2
      ctx.strokeStyle = '#769656'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, CHART_HEIGHT)
      ctx.stroke()
    }
  }, [moveEvals, currentMoveIndex])

  useEffect(() => {
    draw()
  }, [draw])

  // Redraw on resize
  useEffect(() => {
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  const handleClick = (e: React.MouseEvent) => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || moveEvals.length === 0) return

    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    const stepX = rect.width / moveEvals.length
    const idx = Math.floor(x / stepX)
    if (idx >= 0 && idx < moveEvals.length) {
      goToMove(idx)
    }
  }

  if (moveEvals.length === 0 && !isAnalyzingGame) return null

  return (
    <div className="border-b border-[var(--border-color)]">
      {isAnalyzingGame && (
        <div className="px-4 py-2 text-sm text-gray-400 flex items-center gap-2">
          <div className="animate-spin w-4 h-4 border-2 border-accent border-t-transparent rounded-full" />
          {t('analysis.analyzing')} ({analysisProgress}/{analysisTotalMoves})
          <div className="flex-1 bg-surface-tertiary rounded-full h-2 ml-2">
            <div
              className="bg-accent h-2 rounded-full transition-all"
              style={{ width: `${analysisTotalMoves ? (analysisProgress / analysisTotalMoves) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}
      {moveEvals.length > 0 && (
        <div ref={containerRef} className="cursor-pointer" onClick={handleClick}>
          <canvas ref={canvasRef} style={{ display: 'block' }} />
        </div>
      )}
    </div>
  )
}
