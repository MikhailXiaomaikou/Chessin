// Offline checks for the LLM player code. Starts a fake LLM server that answers
// with random legal moves (and sometimes an illegal one) on both the Anthropic
// and the OpenAI-compatible routes, then plays full games through it.
//
//   npm run test:llm
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { Chess } from 'chess.js'
import { playGame } from './llm-arena'
import { assertNoToolAccess } from '../src/shared/llm/client'
import { parseMoveReply, formatMoveList } from '../src/shared/llm/prompt'
import { detectOutcome } from '../src/shared/llm/turn'
import type { LlmPlayerConfig } from '../src/shared/llm/types'

const bodies: Record<string, unknown>[] = []
let calls = 0

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => resolve(s))
  })
}

function pickReply(promptText: string): string {
  calls++
  const fen = [...promptText.matchAll(/FEN\)?:? ?\(?FEN\)?: (.+)|Current position \(FEN\): (.+)/g)].pop()
  const chess = new Chess(fen?.[2] ?? fen?.[1])
  if (calls % 7 === 0) return 'I will march my king off the board.\nMOVE: Ke9'
  const moves = chess.moves({ verbose: true })
  const m = moves[Math.floor(Math.random() * moves.length)]
  // Alternate SAN and UCI answers to exercise the parser.
  return calls % 2 ? `Let me think... **MOVE: ${m.san}**` : `MOVE: ${m.from}${m.to}${m.promotion ?? ''}`
}

const server = createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req))
  bodies.push(body)
  const msgs = body.messages as { role: string; content: string }[]
  // Find the latest position given to the model.
  const firstUser = msgs.find((m) => m.role === 'user')!.content
  const text = pickReply(firstUser)
  res.setHeader('Content-Type', 'application/json')
  if (req.url?.endsWith('/v1/messages')) {
    res.end(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 }
      })
    )
  } else if (req.url?.endsWith('/chat/completions')) {
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  } else {
    res.statusCode = 404
    res.end('{}')
  }
})

async function main(): Promise<void> {
  // Parser
  const start = new Chess()
  assert.equal((parseMoveReply('blah\nMOVE: e4', start) as { ok: true; move: { san: string } }).move.san, 'e4')
  assert.equal((parseMoveReply('MOVE: g1f3', start) as { ok: true; move: { san: string } }).move.san, 'Nf3')
  assert.equal((parseMoveReply('MOVE: 1. d4!', start) as { ok: true; move: { san: string } }).move.san, 'd4')
  assert.equal((parseMoveReply('MOVE: e4\nactually\nMOVE: c4', start) as { ok: true; move: { san: string } }).move.san, 'c4')
  assert.equal(parseMoveReply('I like e4', start).ok, false)
  assert.equal(parseMoveReply('MOVE: Ke2', start).ok, false)
  const castle = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1')
  assert.equal((parseMoveReply('MOVE: 0-0-0', castle) as { ok: true; move: { san: string } }).move.san, 'O-O-O')
  assert.equal(formatMoveList({ startFen: start.fen(), sanMoves: ['e4', 'e5', 'Nf3'] }), '1. e4 e5 2. Nf3')
  assert.throws(() => assertNoToolAccess({ model: 'x', tools: [] }))

  // Threefold repetition is detected on a replayed game.
  const rep = new Chess()
  for (const m of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']) rep.move(m)
  assert.equal(detectOutcome(rep)?.reason, 'threefold')
  console.log('parser and rules checks passed')

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const common = { apiKey: 'test-key', showLegalMoves: true, maxRetries: 2 }
  const claude: LlmPlayerConfig = { id: 'a', name: 'FakeClaude', provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: base, effort: 'low', ...common }
  const gpt: LlmPlayerConfig = { id: 'b', name: 'FakeGPT', provider: 'openai', model: 'fake-gpt', baseUrl: `${base}/v1`, ...common }

  for (let g = 0; g < 3; g++) {
    const [w, b] = g % 2 ? [gpt, claude] : [claude, gpt]
    const r = await playGame(w, b, { maxPlies: 200 })
    console.log(`game ${g + 1}: ${w.name} vs ${b.name} → ${r.result} (${r.termination}), illegal attempts ${r.illegalAttempts}`)
    assert.notEqual(r.result, '*')
    assert.ok(r.illegalAttempts > 0, 'the fake server sends illegal moves, they should be retried')
    const check = new Chess()
    check.loadPgn(r.pgn)
    assert.ok(check.history().length > 0)
  }

  // Every request that reached the server was a plain chat request.
  assert.ok(bodies.length > 50)
  for (const body of bodies) {
    for (const key of ['tools', 'tool_choice', 'functions', 'mcp_servers', 'container']) {
      assert.ok(!(key in body), `request contained ${key}`)
    }
  }
  console.log(`${bodies.length} requests checked: none offered tools or engines`)
  server.close()
}

main().catch((e) => {
  console.error(e)
  server.close()
  process.exit(1)
})
