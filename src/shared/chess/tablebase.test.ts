import { describe, it, expect, vi } from 'vitest'
import {
  TablebaseClient,
  parseTablebaseResponse,
  flipCategory,
  outcomeOf,
  pieceCount,
  isTablebasePosition,
  type TbCategory,
  type RawTablebaseResponse
} from './tablebase'

// The example response from the lila-tablebase README (KQ-ish race position).
const README_FEN = '4k3/6KP/8/8/8/8/7p/8 w - - 0 1'
const README_RESPONSE: RawTablebaseResponse = {
  dtz: 1,
  dtm: 17,
  checkmate: false,
  stalemate: false,
  insufficient_material: false,
  category: 'win',
  moves: [
    {
      uci: 'h7h8q',
      san: 'h8=Q+',
      dtz: -2,
      dtm: -16,
      zeroing: true,
      checkmate: false,
      stalemate: false,
      category: 'loss'
    },
    { uci: 'g7g6', san: 'Kg6', dtz: 0, dtm: null, category: 'draw' }
  ]
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('tablebase helpers', () => {
  it('counts pieces and recognises tablebase positions', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    expect(pieceCount(start)).toBe(32)
    expect(isTablebasePosition(start)).toBe(false)
    expect(pieceCount(README_FEN)).toBe(4)
    expect(isTablebasePosition(README_FEN)).toBe(true)
    // Syzygy has no castling: a rook endgame with rights is not answerable.
    expect(isTablebasePosition('4k3/8/8/8/8/8/8/4K2R w K - 0 1')).toBe(false)
  })

  it('flips categories symmetrically', () => {
    const all: TbCategory[] = [
      'win', 'syzygy-win', 'maybe-win', 'cursed-win', 'draw',
      'blessed-loss', 'maybe-loss', 'syzygy-loss', 'loss', 'unknown'
    ]
    for (const c of all) expect(flipCategory(flipCategory(c))).toBe(c)
    expect(flipCategory('win')).toBe('loss')
    expect(flipCategory('cursed-win')).toBe('blessed-loss')
    expect(flipCategory('draw')).toBe('draw')
  })

  it('treats 50-move-rule results as practical draws', () => {
    expect(outcomeOf('maybe-win')).toBe('win')
    expect(outcomeOf('syzygy-loss')).toBe('loss')
    expect(outcomeOf('cursed-win')).toBe('draw')
    expect(outcomeOf('blessed-loss')).toBe('draw')
    expect(outcomeOf('unknown')).toBe('unknown')
  })
})

describe('parseTablebaseResponse', () => {
  it('reports moves from the mover’s point of view', () => {
    const r = parseTablebaseResponse(README_RESPONSE)
    expect(r.category).toBe('win')
    expect(r.dtm).toBe(17)
    expect(r.moves[0]).toMatchObject({
      uci: 'h7h8q',
      san: 'h8=Q+',
      category: 'win', // API said "loss" — that's Black's view
      dtz: 2,
      dtm: 16,
      zeroing: true
    })
    expect(r.moves[1]).toMatchObject({ category: 'draw', dtm: null })
  })

  it('maps unexpected categories to unknown', () => {
    const r = parseTablebaseResponse({ category: 'mystery', moves: [{ uci: 'a', san: 'b', category: 'toString' }] })
    expect(r.category).toBe('unknown')
    expect(r.moves[0].category).toBe('unknown')
  })
})

describe('TablebaseClient', () => {
  it('requests the position with underscores and parses the answer', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(README_RESPONSE))
    const client = new TablebaseClient({ fetch: fetchMock as unknown as typeof fetch, endpoint: 'https://tb.test/standard' })
    const r = await client.probe(README_FEN)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0]
    expect(url).toBe('https://tb.test/standard?fen=' + encodeURIComponent('4k3/6KP/8/8/8/8/7p/8_w_-_-_0_1'))
    expect(r?.moves[0].san).toBe('h8=Q+')
  })

  it('does not query positions with too many pieces', async () => {
    const fetchMock = vi.fn()
    const client = new TablebaseClient({ fetch: fetchMock as unknown as typeof fetch })
    expect(await client.probe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caches by position, ignoring the full-move number', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(README_RESPONSE))
    const client = new TablebaseClient({ fetch: fetchMock as unknown as typeof fetch })
    await client.probe(README_FEN)
    await client.probe('4k3/6KP/8/8/8/8/7p/8 w - - 0 57')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares one request between concurrent probes of a position', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(README_RESPONSE))
    const client = new TablebaseClient({ fetch: fetchMock as unknown as typeof fetch })
    await Promise.all([client.probe(README_FEN), client.probe(README_FEN)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports rate limiting and does not cache failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(README_RESPONSE))
    const client = new TablebaseClient({ fetch: fetchMock as unknown as typeof fetch })
    expect(await client.probeSafe(README_FEN)).toEqual({ ok: false, error: 'rate-limited', status: 429 })
    const second = await client.probeSafe(README_FEN)
    expect(second.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports network failures and HTTP errors', async () => {
    const offline = new TablebaseClient({
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch
    })
    expect(await offline.probeSafe(README_FEN)).toEqual({ ok: false, error: 'network' })

    const broken = new TablebaseClient({
      fetch: (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch
    })
    expect(await broken.probeSafe(README_FEN)).toEqual({ ok: false, error: 'http', status: 500 })
  })

  it('gives up after the timeout', async () => {
    const hanging = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    const client = new TablebaseClient({ fetch: hanging, timeoutMs: 20 })
    expect(await client.probeSafe(README_FEN)).toEqual({ ok: false, error: 'network' })
  })
})
