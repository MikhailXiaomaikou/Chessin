import { useState } from 'react'
import { useLlmStore, seatFor, type LlmMatch, type Seat, type MatchResult } from '@renderer/stores/llmStore'
import { useGameStore } from '@renderer/stores/gameStore'
import { useT } from '@renderer/i18n/useI18n'
import type { TranslationKey } from '@renderer/i18n/locales'
import type { LlmPlayerConfig } from '@shared/llm/types'

function seatLabel(seat: Seat, players: LlmPlayerConfig[], human: string): string {
  if (seat.kind === 'human') return human
  const p = players.find((x) => x.id === seat.playerId)
  return p ? `${p.name} (${p.model})` : '?'
}

export function matchPgn(match: LlmMatch, players: LlmPlayerConfig[]): string {
  const result = match.result?.result ?? '*'
  const d = new Date()
  const date = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
  const headers = [
    ['Event', 'Chessin LLM game'],
    ['Date', date],
    ['White', seatLabel(match.white, players, 'Human')],
    ['Black', seatLabel(match.black, players, 'Human')],
    ['Result', result]
  ]
  if (match.result) headers.push(['Termination', match.result.detail ?? match.result.reason])
  const body = useGameStore.getState().getPgn().replace(/^\[FEN "[^"]*"\]\n\n/, '')
  if (match.startFen !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') {
    headers.push(['SetUp', '1'], ['FEN', match.startFen])
  }
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `${headers.map(([k, v]) => `[${k} "${esc(v)}"]`).join('\n')}\n\n${body} ${result}\n`
}

function resultText(r: MatchResult, t: (k: TranslationKey) => string): string {
  const head =
    r.result === '1-0' ? t('llm.whiteWins') : r.result === '0-1' ? t('llm.blackWins') : r.result === '*' ? t('llm.aborted') : t('llm.draw')
  return `${r.result} · ${head} (${t(`llm.reason.${r.reason}` as TranslationKey)})`
}

export default function LlmPanel() {
  const t = useT()
  const match = useLlmStore((s) => s.match)
  const players = useLlmStore((s) => s.players)
  const log = useLlmStore((s) => s.log)
  const { pauseMatch, resumeMatch, finishMatch, endMatch } = useLlmStore.getState()
  const turn = useGameStore((s) => s.turn)
  const currentNodeId = useGameStore((s) => s.currentNodeId)
  const treeNodes = useGameStore((s) => s.treeNodes)
  const rootChildren = useGameStore((s) => s.rootChildren)
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  if (!match) return null

  const human = t('newGame.human')
  const children = currentNodeId === null ? rootChildren : treeNodes[currentNodeId]?.children ?? []
  const atTip = children.length === 0
  const hasLlm = match.white.kind === 'llm' || match.black.kind === 'llm'
  const hasHuman = match.white.kind === 'human' || match.black.kind === 'human'
  const finished = match.status === 'finished'

  let status: { text: string; cls: string }
  if (finished && match.result) {
    status = { text: resultText(match.result, t), cls: 'text-accent font-medium' }
    if (match.result.detail) status.text += ` — ${match.result.detail}`
  } else if (match.status === 'paused') {
    status = { text: `${t('llm.paused')}${match.error ? `: ${match.error}` : ''}`, cls: 'text-yellow-400' }
  } else if (match.thinking) {
    const seat = match.thinking === 'white' ? match.white : match.black
    status = { text: `${seatLabel(seat, players, human)} ${t('llm.thinking')}`, cls: 'text-gray-300 animate-pulse' }
  } else if (!atTip) {
    status = { text: t('llm.backToGame'), cls: 'text-gray-400' }
  } else if (seatFor(match, turn).kind === 'human') {
    status = { text: t('llm.yourMove'), cls: 'text-gray-300' }
  } else {
    status = { text: '', cls: '' }
  }

  const copyPgn = () => {
    window.electronAPI.clipboard.writeText(matchPgn(match, players))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const resign = () => {
    const humanSide = match.white.kind === 'human' ? 'white' : 'black'
    finishMatch({ result: humanSide === 'white' ? '0-1' : '1-0', reason: 'resign' })
  }

  const btn = 'px-3 py-1 text-sm rounded bg-surface-tertiary hover:bg-surface-hover text-gray-300 transition-colors'

  return (
    <div className="bg-[var(--bg-secondary)] border-b border-[var(--border-color)] px-5 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-lg font-medium text-gray-300">{t('llm.game')}</span>
        <div className="flex gap-2">
          {!finished && hasLlm && match.status === 'running' && (
            <button className={btn} onClick={() => pauseMatch()}>{t('llm.pause')}</button>
          )}
          {!finished && match.status === 'paused' && (
            <button className={btn} onClick={resumeMatch}>{t('llm.resume')}</button>
          )}
          {!finished && hasHuman && <button className={btn} onClick={resign}>{t('llm.resign')}</button>}
          <button className={btn} onClick={copyPgn}>{copied ? '✓' : t('llm.copyPgn')}</button>
          <button className={btn} onClick={() => window.electronAPI.file.savePgn(matchPgn(match, players))}>
            {t('llm.savePgn')}
          </button>
          <button
            className="px-3 py-1 text-sm rounded text-gray-500 hover:text-gray-300 transition-colors"
            onClick={() => (finished ? endMatch() : finishMatch({ result: '*', reason: 'aborted' }))}
          >
            {finished ? t('llm.close') : t('llm.stop')}
          </button>
        </div>
      </div>

      <div className="text-sm text-gray-400 mb-1">
        <span className="inline-block w-3 h-3 rounded-sm bg-white border border-gray-500 mr-1 align-middle" />
        {seatLabel(match.white, players, human)}
        <span className="mx-2 text-gray-600">vs</span>
        <span className="inline-block w-3 h-3 rounded-sm bg-black border border-gray-500 mr-1 align-middle" />
        {seatLabel(match.black, players, human)}
      </div>
      {status.text && <div className={`text-sm mb-2 break-words ${status.cls}`}>{status.text}</div>}

      <div className="max-h-48 overflow-y-auto flex flex-col gap-1">
        {log.length === 0 && <div className="text-xs text-gray-600 italic">{t('llm.noLog')}</div>}
        {[...log].reverse().map((entry) => {
          const moveNo = Math.floor(entry.ply / 2) + 1
          const last = entry.attempts[entry.attempts.length - 1]
          const secs = entry.attempts.reduce((a, x) => a + x.ms, 0) / 1000
          const isOpen = open === entry.id
          return (
            <div key={entry.id} className="text-xs bg-surface-tertiary rounded px-2 py-1">
              <button className="w-full text-left flex justify-between gap-2" onClick={() => setOpen(isOpen ? null : entry.id)}>
                <span>
                  <span className="text-gray-500">{moveNo}{entry.side === 'white' ? '.' : '...'} </span>
                  <span className={entry.san ? 'text-gray-200 font-medium' : 'text-red-400'}>{entry.san ?? entry.error}</span>
                  <span className="text-gray-500"> · {entry.playerName}</span>
                  {entry.attempts.length > 1 && (
                    <span className="text-red-400"> · {entry.attempts.length - (entry.san ? 1 : 0)} {t('llm.illegal')}</span>
                  )}
                </span>
                <span className="text-gray-600 shrink-0">{secs.toFixed(1)}s {isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && (
                <div className="mt-1 flex flex-col gap-1">
                  {entry.attempts.map((a, i) => (
                    <div key={i} className="border-t border-[var(--border-color)] pt-1">
                      {entry.attempts.length > 1 && (
                        <div className={a.problem ? 'text-red-400' : 'text-gray-500'}>
                          {t('llm.attempt')} {i + 1}{a.problem ? `: ${a.problem}` : ''}
                        </div>
                      )}
                      <pre className="whitespace-pre-wrap font-sans text-gray-400 max-h-64 overflow-y-auto">{a.reply}</pre>
                    </div>
                  ))}
                  {!last && entry.error && <div className="text-red-400">{entry.error}</div>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
