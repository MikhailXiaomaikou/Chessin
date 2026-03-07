import { useState, useCallback } from 'react'
import { Chess } from 'chess.js'
import { useGameStore } from '@renderer/stores/gameStore'
import { useUIStore } from '@renderer/stores/uiStore'
import { useT } from '@renderer/i18n/useI18n'
import { DEFAULT_FEN } from '@shared/constants'

type PieceColor = 'w' | 'b'
type PieceType = 'k' | 'q' | 'r' | 'b' | 'n' | 'p'
type SelectedPiece = { color: PieceColor; type: PieceType } | 'trash' | null

const PIECE_UNICODE: Record<string, string> = {
  wk: '\u2654', wq: '\u2655', wr: '\u2656', wb: '\u2657', wn: '\u2658', wp: '\u2659',
  bk: '\u265A', bq: '\u265B', br: '\u265C', bb: '\u265D', bn: '\u265E', bp: '\u265F'
}

const PIECE_TYPES: PieceType[] = ['k', 'q', 'r', 'b', 'n', 'p']
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'] as const

interface BoardState {
  board: (({ color: PieceColor; type: PieceType }) | null)[][]
  turn: PieceColor
  castling: { K: boolean; Q: boolean; k: boolean; q: boolean }
  enPassant: string
}

function fenToBoard(fen: string): BoardState {
  const parts = fen.split(' ')
  const rows = parts[0].split('/')
  const board: (({ color: PieceColor; type: PieceType }) | null)[][] = []
  for (const row of rows) {
    const rank: (({ color: PieceColor; type: PieceType }) | null)[] = []
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < parseInt(ch); i++) rank.push(null)
      } else {
        const color: PieceColor = ch === ch.toUpperCase() ? 'w' : 'b'
        const type = ch.toLowerCase() as PieceType
        rank.push({ color, type })
      }
    }
    board.push(rank)
  }
  const turn = (parts[1] || 'w') as PieceColor
  const castlingStr = parts[2] || '-'
  const castling = { K: castlingStr.includes('K'), Q: castlingStr.includes('Q'), k: castlingStr.includes('k'), q: castlingStr.includes('q') }
  const enPassant = parts[3] || '-'
  return { board, turn, castling, enPassant }
}

function boardToFen(state: BoardState): string {
  let fen = ''
  for (let r = 0; r < 8; r++) {
    let empty = 0
    for (let f = 0; f < 8; f++) {
      const piece = state.board[r][f]
      if (!piece) { empty++ } else {
        if (empty > 0) { fen += empty; empty = 0 }
        fen += piece.color === 'w' ? piece.type.toUpperCase() : piece.type
      }
    }
    if (empty > 0) fen += empty
    if (r < 7) fen += '/'
  }
  let castling = ''
  if (state.castling.K) castling += 'K'
  if (state.castling.Q) castling += 'Q'
  if (state.castling.k) castling += 'k'
  if (state.castling.q) castling += 'q'
  if (!castling) castling = '-'
  return `${fen} ${state.turn} ${castling} ${state.enPassant} 0 1`
}

export default function BoardEditor() {
  const t = useT()
  const currentFen = useGameStore((s) => s.fen)
  const newGame = useGameStore((s) => s.newGame)
  const setBoardEditorMode = useUIStore((s) => s.setBoardEditorMode)

  const [boardState, setBoardState] = useState<BoardState>(() => fenToBoard(currentFen))
  const [selected, setSelected] = useState<SelectedPiece>(null)
  const [error, setError] = useState<string | null>(null)

  const generatedFen = boardToFen(boardState)

  const handleSquareClick = useCallback(
    (rankIdx: number, fileIdx: number) => {
      setBoardState((prev) => {
        const newBoard = prev.board.map((r) => [...r])
        if (selected === 'trash') {
          newBoard[rankIdx][fileIdx] = null
        } else if (selected) {
          newBoard[rankIdx][fileIdx] = { color: selected.color, type: selected.type }
        } else {
          newBoard[rankIdx][fileIdx] = null
        }
        return { ...prev, board: newBoard }
      })
    },
    [selected]
  )

  const handleClear = () => {
    const emptyBoard = Array.from({ length: 8 }, () => Array(8).fill(null))
    setBoardState((prev) => ({ ...prev, board: emptyBoard }))
  }

  const handleReset = () => { setBoardState(fenToBoard(DEFAULT_FEN)) }

  const handleApply = () => {
    const fen = generatedFen
    try {
      new Chess(fen)
      newGame(fen)
      setBoardEditorMode(false)
      setError(null)
    } catch (e) {
      setError(t('editor.invalidPosition') + (e instanceof Error ? e.message : String(e)))
    }
  }

  const handleCancel = () => { setBoardEditorMode(false) }

  const handleFenInput = (value: string) => {
    try {
      const parsed = fenToBoard(value.trim())
      setBoardState(parsed)
      setError(null)
    } catch {
      setError(t('editor.invalidFen'))
    }
  }

  const btnClass = (active: boolean) =>
    `w-9 h-9 flex items-center justify-center text-xl rounded border transition-colors cursor-pointer ${
      active
        ? 'border-accent bg-accent/20 text-white'
        : 'border-[var(--border-color)] bg-surface-secondary text-gray-300 hover:bg-surface-tertiary'
    }`

  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <div className="font-medium text-gray-200">{t('editor.title')}</div>

      <div className="flex flex-col gap-1">
        <div className="text-xs text-gray-400">{t('editor.whitePieces')}</div>
        <div className="flex gap-1">
          {PIECE_TYPES.map((tp) => (
            <button key={`w${tp}`}
              className={btnClass(selected !== null && selected !== 'trash' && selected.color === 'w' && selected.type === tp)}
              onClick={() => setSelected((prev) => prev !== null && prev !== 'trash' && prev.color === 'w' && prev.type === tp ? null : { color: 'w', type: tp })}
            >{PIECE_UNICODE[`w${tp}`]}</button>
          ))}
        </div>
        <div className="text-xs text-gray-400 mt-1">{t('editor.blackPieces')}</div>
        <div className="flex gap-1">
          {PIECE_TYPES.map((tp) => (
            <button key={`b${tp}`}
              className={btnClass(selected !== null && selected !== 'trash' && selected.color === 'b' && selected.type === tp)}
              onClick={() => setSelected((prev) => prev !== null && prev !== 'trash' && prev.color === 'b' && prev.type === tp ? null : { color: 'b', type: tp })}
            >{PIECE_UNICODE[`b${tp}`]}</button>
          ))}
        </div>
        <div className="flex gap-1 mt-1">
          <button className={btnClass(selected === 'trash')}
            onClick={() => setSelected((prev) => (prev === 'trash' ? null : 'trash'))} title={t('editor.removePiece')}>
            <span className="text-base">&#x1F5D1;</span>
          </button>
        </div>
      </div>

      <div className="flex flex-col">
        <div className="text-xs text-gray-400 mb-1">{t('editor.clickToPlace')}</div>
        <div className="grid gap-0 border border-[var(--border-color)]"
          style={{ gridTemplateColumns: 'repeat(8, 1fr)', width: '240px', height: '240px' }}>
          {RANKS.map((rank, ri) =>
            FILES.map((file, fi) => {
              const piece = boardState.board[ri][fi]
              const isLight = (ri + fi) % 2 === 0
              return (
                <button key={`${file}${rank}`}
                  className="flex items-center justify-center text-lg leading-none cursor-pointer"
                  style={{ backgroundColor: isLight ? '#f0d9b5' : '#b58863', color: piece?.color === 'b' ? '#333' : '#000', width: '30px', height: '30px' }}
                  onClick={() => handleSquareClick(ri, fi)} title={`${file}${rank}`}>
                  {piece ? PIECE_UNICODE[`${piece.color}${piece.type}`] : ''}
                </button>
              )
            })
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 w-16">{t('editor.sideToMove')}</span>
          <select value={boardState.turn}
            onChange={(e) => setBoardState((prev) => ({ ...prev, turn: e.target.value as PieceColor }))}
            className="bg-surface-secondary border border-[var(--border-color)] rounded px-2 py-0.5 text-xs text-gray-200">
            <option value="w">{t('editor.white')}</option>
            <option value="b">{t('editor.black')}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-400">{t('editor.castling')}</span>
          <div className="flex gap-3">
            {(['K', 'Q', 'k', 'q'] as const).map((c) => (
              <label key={c} className="flex items-center gap-1 text-xs text-gray-300">
                <input type="checkbox" checked={boardState.castling[c]}
                  onChange={(e) => setBoardState((prev) => ({ ...prev, castling: { ...prev.castling, [c]: e.target.checked } }))}
                  className="accent-accent" />
                {c === 'K' ? 'K (O-O)' : c === 'Q' ? 'Q (O-O-O)' : c === 'k' ? 'k (O-O)' : 'q (O-O-O)'}
              </label>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 w-16">{t('editor.enPassant')}</span>
          <input type="text" value={boardState.enPassant}
            onChange={(e) => setBoardState((prev) => ({ ...prev, enPassant: e.target.value || '-' }))}
            className="bg-surface-secondary border border-[var(--border-color)] rounded px-2 py-0.5 text-xs text-gray-200 w-16" placeholder="-" />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-400">{t('editor.fen')}</span>
        <input type="text" value={generatedFen} onChange={(e) => handleFenInput(e.target.value)}
          className="bg-surface-secondary border border-[var(--border-color)] rounded px-2 py-1 text-xs text-gray-200 font-mono w-full" />
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="flex gap-2 flex-wrap">
        <button onClick={handleClear} className="px-3 py-1 text-xs rounded bg-surface-secondary hover:bg-surface-tertiary text-gray-300 transition-colors">{t('editor.clear')}</button>
        <button onClick={handleReset} className="px-3 py-1 text-xs rounded bg-surface-secondary hover:bg-surface-tertiary text-gray-300 transition-colors">{t('editor.reset')}</button>
        <div className="flex-1" />
        <button onClick={handleCancel} className="px-3 py-1 text-xs rounded bg-surface-secondary hover:bg-surface-tertiary text-gray-300 transition-colors">{t('editor.cancel')}</button>
        <button onClick={handleApply} className="px-3 py-1 text-xs rounded bg-accent hover:bg-accent/80 text-white transition-colors">{t('editor.apply')}</button>
      </div>
    </div>
  )
}
