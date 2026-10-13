import type { Chess } from 'chess.js'
import type { LlmChatFn, LlmChatMessage, LlmPlayerConfig } from './types'
import {
  buildPositionPrompt,
  buildRetryPrompt,
  buildSystemPrompt,
  parseMoveReply,
  replayGame,
  type PositionInput
} from './prompt'

export interface LlmAttempt {
  reply: string
  candidate?: string
  problem?: string
  ms: number
  usage?: { inputTokens: number; outputTokens: number }
}

export interface PlayedMove {
  from: string
  to: string
  promotion?: string
  san: string
}

export type LlmTurnResult =
  // A legal move was chosen.
  | { kind: 'move'; move: PlayedMove; attempts: LlmAttempt[] }
  // Every attempt was illegal or unreadable: the player loses the game.
  | { kind: 'forfeit'; reason: string; attempts: LlmAttempt[] }
  // The API call itself failed (network, key, quota). Not the model's fault.
  | { kind: 'error'; error: string; attempts: LlmAttempt[] }

export async function requestLlmMove(args: {
  config: LlmPlayerConfig
  position: PositionInput
  chat: LlmChatFn
  isCancelled?: () => boolean
}): Promise<LlmTurnResult> {
  const { config, position, chat } = args
  const chess = replayGame(position)
  const side = chess.turn() === 'w' ? 'white' : 'black'
  const system = buildSystemPrompt(side)
  const messages: LlmChatMessage[] = [
    { role: 'user', content: buildPositionPrompt(position, { showLegalMoves: config.showLegalMoves }) }
  ]
  const attempts: LlmAttempt[] = []
  const maxAttempts = 1 + Math.max(0, config.maxRetries)

  for (let i = 0; i < maxAttempts; i++) {
    if (args.isCancelled?.()) return { kind: 'error', error: 'cancelled', attempts }
    const started = Date.now()
    const res = await chat({ config, system, messages })
    if (!res.ok) return { kind: 'error', error: res.error, attempts }

    const parsed = parseMoveReply(res.text, chess)
    const attempt: LlmAttempt = {
      reply: res.text,
      candidate: parsed.candidate,
      ms: Date.now() - started,
      usage: res.usage
    }
    attempts.push(attempt)

    if (parsed.ok) {
      const { from, to, promotion, san } = parsed.move
      return { kind: 'move', move: { from, to, promotion, san }, attempts }
    }

    attempt.problem = parsed.problem
    messages.push({ role: 'assistant', content: res.text })
    messages.push({
      role: 'user',
      content: buildRetryPrompt(parsed.problem, chess, { showLegalMoves: config.showLegalMoves })
    })
  }

  return {
    kind: 'forfeit',
    reason: `No legal move after ${maxAttempts} attempt(s)`,
    attempts
  }
}

export type GameResult = '1-0' | '0-1' | '1/2-1/2'

export interface GameOutcome {
  result: GameResult
  reason:
    | 'checkmate'
    | 'stalemate'
    | 'threefold'
    | 'fiftyMoves'
    | 'insufficientMaterial'
    | 'moveLimit'
}

// Call with a Chess instance that has the whole game replayed (see replayGame),
// otherwise threefold repetition cannot be detected.
export function detectOutcome(chess: Chess, maxPlies?: number): GameOutcome | null {
  if (chess.isCheckmate()) {
    return { result: chess.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' }
  }
  if (chess.isStalemate()) return { result: '1/2-1/2', reason: 'stalemate' }
  if (chess.isInsufficientMaterial()) return { result: '1/2-1/2', reason: 'insufficientMaterial' }
  if (chess.isThreefoldRepetition()) return { result: '1/2-1/2', reason: 'threefold' }
  if (chess.isDrawByFiftyMoves()) return { result: '1/2-1/2', reason: 'fiftyMoves' }
  if (maxPlies && chess.history().length >= maxPlies) return { result: '1/2-1/2', reason: 'moveLimit' }
  return null
}
