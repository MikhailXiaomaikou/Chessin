import { Chess, type Move } from 'chess.js'

export type Side = 'white' | 'black'

export interface PositionInput {
  startFen: string
  sanMoves: string[] // moves played from startFen, in SAN
}

// Rebuild the game so threefold repetition and move numbers are known.
export function replayGame({ startFen, sanMoves }: PositionInput): Chess {
  const chess = new Chess(startFen)
  for (const san of sanMoves) chess.move(san)
  return chess
}

export function formatMoveList({ startFen, sanMoves }: PositionInput): string {
  if (sanMoves.length === 0) return '(no moves yet)'
  const parts = startFen.split(' ')
  let moveNo = parseInt(parts[5] || '1', 10)
  let white = parts[1] !== 'b'
  const out: string[] = []
  sanMoves.forEach((san, i) => {
    if (white) out.push(`${moveNo}. ${san}`)
    else out.push(i === 0 ? `${moveNo}... ${san}` : san)
    if (!white) moveNo++
    white = !white
  })
  return out.join(' ')
}

export function buildSystemPrompt(side: Side): string {
  const color = side === 'white' ? 'White' : 'Black'
  return [
    `You are playing a game of chess as ${color}.`,
    'Choose every move using only your own understanding of chess. You have no tools, no code execution and no internet access, and you must not consult, simulate or imitate a chess engine such as Stockfish or Leela.',
    'Think about the position as much as you like, then finish your reply with exactly one final line in this form:',
    'MOVE: <your move in Standard Algebraic Notation>',
    'Examples: "MOVE: Nf3", "MOVE: exd5", "MOVE: O-O", "MOVE: e8=Q+". The move must be legal in the current position.'
  ].join('\n')
}

export function buildPositionPrompt(input: PositionInput, opts: { showLegalMoves: boolean }): string {
  const chess = replayGame(input)
  const side: Side = chess.turn() === 'w' ? 'white' : 'black'
  const lines = [
    `Moves so far: ${formatMoveList(input)}`,
    `Current position (FEN): ${chess.fen()}`,
    '',
    'Board (White pieces are uppercase, Black lowercase, White plays up the board):',
    chess.ascii(),
    '',
    `You are ${side === 'white' ? 'White' : 'Black'} and it is your turn (move ${chess.moveNumber()}).`
  ]
  if (input.startFen !== new Chess().fen()) {
    lines.splice(1, 0, `Starting position (FEN): ${input.startFen}`)
  }
  if (chess.isCheck()) lines.push('You are in check.')
  if (opts.showLegalMoves) lines.push(`Legal moves: ${chess.moves().join(', ')}`)
  return lines.join('\n')
}

export function buildRetryPrompt(problem: string, chess: Chess, opts: { showLegalMoves: boolean }): string {
  const lines = [problem, 'Please choose again and finish with a line "MOVE: <move in SAN>".']
  if (opts.showLegalMoves) lines.push(`Legal moves: ${chess.moves().join(', ')}`)
  return lines.join('\n')
}

export type ParseResult =
  | { ok: true; move: Move; candidate: string }
  | { ok: false; candidate?: string; problem: string }

function normalize(candidate: string): string {
  return candidate
    .trim()
    .replace(/^[`*_"'“”]+|[`*_"'“”]+$/g, '')
    .replace(/^\d+\.+\s*/, '')
    .replace(/[!?.,;:]+$/g, '')
    .replace(/^0-0-0/, 'O-O-O')
    .replace(/^0-0/, 'O-O')
}

// Read the move from the model's reply. Accepts SAN or UCI (e2e4, e7e8q).
export function parseMoveReply(reply: string, chess: Chess): ParseResult {
  const matches = [...reply.matchAll(/MOVE\s*[:：]\s*[*`]*\s*(?:\d+\s*\.+\s*)?([^\s*`]+)/gi)]
  if (matches.length === 0) {
    return { ok: false, problem: 'Your reply did not contain a line of the form "MOVE: <move>".' }
  }
  const candidate = normalize(matches[matches.length - 1][1])
  const probe = new Chess(chess.fen())
  try {
    const move = probe.move(candidate)
    return { ok: true, move, candidate }
  } catch {
    return {
      ok: false,
      candidate,
      problem: `"${candidate}" is not a legal move in the current position (FEN ${chess.fen()}).`
    }
  }
}
