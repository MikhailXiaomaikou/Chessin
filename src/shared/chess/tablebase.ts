/**
 * Endgame tablebase lookups via the Lichess tablebase (Syzygy, up to 7 pieces).
 *
 * The client only needs `fetch`, so Electron's main process and the web build
 * share it. Results are cached per position, and every category is reported
 * from the point of view of the side it describes: the position's category is
 * for the side to move, a move's category is for the side playing it (the API
 * itself reports moves from the opponent's side).
 */

export type TbCategory =
  | 'win'
  | 'syzygy-win'
  | 'maybe-win'
  | 'cursed-win'
  | 'draw'
  | 'blessed-loss'
  | 'maybe-loss'
  | 'syzygy-loss'
  | 'loss'
  | 'unknown'

export type TbOutcome = 'win' | 'draw' | 'loss' | 'unknown'

export interface TbMove {
  uci: string
  san: string
  /** Result for the side playing this move. */
  category: TbCategory
  /** Signed from the mover's point of view: positive when the mover wins. */
  dtz: number | null
  dtm: number | null
  zeroing: boolean
  checkmate: boolean
  stalemate: boolean
}

export interface TbResult {
  /** Result for the side to move. */
  category: TbCategory
  dtz: number | null
  dtm: number | null
  checkmate: boolean
  stalemate: boolean
  insufficientMaterial: boolean
  /** Legal moves, best first. */
  moves: TbMove[]
}

/** Probe outcome as a plain value, safe to send over IPC. */
export type TbProbeResponse =
  | { ok: true; result: TbResult | null }
  | { ok: false; error: 'network' | 'rate-limited' | 'http'; status?: number }

export const TB_ENDPOINT = 'https://tablebase.lichess.org/standard'
export const TB_MAX_PIECES = 7

const FLIP: Record<TbCategory, TbCategory> = {
  win: 'loss',
  'syzygy-win': 'syzygy-loss',
  'maybe-win': 'maybe-loss',
  'cursed-win': 'blessed-loss',
  draw: 'draw',
  'blessed-loss': 'cursed-win',
  'maybe-loss': 'maybe-win',
  'syzygy-loss': 'syzygy-win',
  loss: 'win',
  unknown: 'unknown'
}

/** The same result seen from the other side of the board. */
export function flipCategory(category: TbCategory): TbCategory {
  return FLIP[category]
}

/**
 * Practical outcome. Cursed wins and blessed losses are draws under the
 * 50-move rule, so they count as draws here.
 */
export function outcomeOf(category: TbCategory): TbOutcome {
  switch (category) {
    case 'win':
    case 'syzygy-win':
    case 'maybe-win':
      return 'win'
    case 'loss':
    case 'syzygy-loss':
    case 'maybe-loss':
      return 'loss'
    case 'draw':
    case 'cursed-win':
    case 'blessed-loss':
      return 'draw'
    default:
      return 'unknown'
  }
}

/** Number of pieces, kings included, in a FEN. */
export function pieceCount(fen: string): number {
  let n = 0
  for (const ch of fen.trim().split(/\s+/)[0] ?? '') if ('pnbrqkPNBRQK'.includes(ch)) n++
  return n
}

/** Positions the tablebase can answer: at most 7 pieces and no castling rights. */
export function isTablebasePosition(fen: string): boolean {
  const castling = fen.trim().split(/\s+/)[2] ?? '-'
  return pieceCount(fen) <= TB_MAX_PIECES && castling === '-'
}

interface RawMove {
  uci: string
  san: string
  category: string
  dtz?: number | null
  dtm?: number | null
  zeroing?: boolean
  checkmate?: boolean
  stalemate?: boolean
}

export interface RawTablebaseResponse {
  category: string
  dtz?: number | null
  dtm?: number | null
  checkmate?: boolean
  stalemate?: boolean
  insufficient_material?: boolean
  moves?: RawMove[]
}

function asCategory(value: unknown): TbCategory {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FLIP, value)
    ? (value as TbCategory)
    : 'unknown'
}

function negate(n: number | null | undefined): number | null {
  return n == null ? null : -n
}

/** Convert the API's JSON into our shape, flipping moves to the mover's view. */
export function parseTablebaseResponse(raw: RawTablebaseResponse): TbResult {
  return {
    category: asCategory(raw.category),
    dtz: raw.dtz ?? null,
    dtm: raw.dtm ?? null,
    checkmate: !!raw.checkmate,
    stalemate: !!raw.stalemate,
    insufficientMaterial: !!raw.insufficient_material,
    moves: (raw.moves ?? []).map((m) => ({
      uci: m.uci,
      san: m.san,
      category: flipCategory(asCategory(m.category)),
      dtz: negate(m.dtz),
      dtm: negate(m.dtm),
      zeroing: !!m.zeroing,
      checkmate: !!m.checkmate,
      stalemate: !!m.stalemate
    }))
  }
}

export class TablebaseError extends Error {
  constructor(
    readonly kind: 'network' | 'rate-limited' | 'http',
    readonly status?: number
  ) {
    super(kind === 'http' ? `Tablebase returned HTTP ${status}` : `Tablebase ${kind}`)
  }
}

export interface TablebaseClientOptions {
  endpoint?: string
  fetch?: typeof fetch
  /** Positions to remember (default 512). */
  cacheSize?: number
  timeoutMs?: number
}

export class TablebaseClient {
  private readonly endpoint: string
  private readonly fetchFn: typeof fetch
  private readonly cacheSize: number
  private readonly timeoutMs: number
  private readonly cache = new Map<string, TbResult>()
  private readonly inFlight = new Map<string, Promise<TbResult>>()

  constructor(opts: TablebaseClientOptions = {}) {
    this.endpoint = opts.endpoint ?? TB_ENDPOINT
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init))
    this.cacheSize = opts.cacheSize ?? 512
    this.timeoutMs = opts.timeoutMs ?? 8000
  }

  /**
   * Look a position up. Resolves to null when it isn't a tablebase position;
   * rejects with a {@link TablebaseError} when the service can't answer.
   */
  async probe(fen: string): Promise<TbResult | null> {
    if (!isTablebasePosition(fen)) return null
    const fields = fen.trim().split(/\s+/)
    // The full-move number doesn't affect the answer; everything else might.
    const key = fields.slice(0, 5).join(' ')

    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached) // mark as most recently used
      return cached
    }

    let pending = this.inFlight.get(key)
    if (!pending) {
      pending = this.request(fields.join('_'))
      this.inFlight.set(key, pending)
    }
    try {
      const result = await pending
      this.cache.set(key, result)
      if (this.cache.size > this.cacheSize) {
        const oldest = this.cache.keys().next().value
        if (oldest !== undefined) this.cache.delete(oldest)
      }
      return result
    } finally {
      this.inFlight.delete(key)
    }
  }

  /** Like {@link probe}, but reports failures as a value. */
  async probeSafe(fen: string): Promise<TbProbeResponse> {
    try {
      return { ok: true, result: await this.probe(fen) }
    } catch (err) {
      if (err instanceof TablebaseError) return { ok: false, error: err.kind, status: err.status }
      return { ok: false, error: 'network' }
    }
  }

  private async request(fenParam: string): Promise<TbResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchFn(`${this.endpoint}?fen=${encodeURIComponent(fenParam)}`, {
        signal: controller.signal
      })
    } catch {
      throw new TablebaseError('network')
    } finally {
      clearTimeout(timer)
    }
    if (res.status === 429) throw new TablebaseError('rate-limited', 429)
    if (!res.ok) throw new TablebaseError('http', res.status)
    try {
      return parseTablebaseResponse((await res.json()) as RawTablebaseResponse)
    } catch {
      throw new TablebaseError('http', res.status)
    }
  }
}
