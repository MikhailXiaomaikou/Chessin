import { describe, it, expect, beforeEach } from 'vitest'
import initSqlJs from 'sql.js'
import { WebDatabaseHost, type IndexCache } from './host'
import { streamLines } from './files'
import { MemorySource } from '../../shared/chessbase/bytes'
import { encodeDatabase } from '../../shared/chessbase/testkit'
import { PolyglotBook } from '../../shared/chess/polyglotBook'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const SAMPLE = `[White "Carlsen, M"]
[Black "Caruana, F"]
[Result "1-0"]

1. e4 e5 2. Nf3 1-0

[White "So, W"]
[Black "Nakamura, H"]
[Result "0-1"]

1. d4 d5 0-1`

const SQL = await initSqlJs()

/** IndexedDB stand-in that counts what it stores. */
class MemoryCache implements IndexCache {
  entries = new Map<string, Uint8Array>()
  saves = 0
  async load(key: string) {
    return this.entries.get(key) ?? null
  }
  async save(key: string, _name: string, bytes: Uint8Array) {
    this.saves++
    this.entries.set(key, bytes)
  }
}

// Workers read ChessBase files with FileReaderSync; tests hand over the bytes.
const contents = new Map<Blob, Uint8Array>()
function file(name: string, data: string | Uint8Array, lastModified = 1000): File {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const f = new File([new Uint8Array(bytes)], name, { lastModified })
  contents.set(f, bytes)
  return f
}
const openSource = (blob: Blob) => new MemorySource(contents.get(blob) ?? new Uint8Array(0))

describe('streamLines', () => {
  it('splits lines across chunk boundaries, including a split CRLF', async () => {
    const chunks = ['[White "A', '"]\r', '\n\r\n1. e4', ' e5 *\r\n', 'last']
    const stream = new ReadableStream<string>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c)
        controller.close()
      }
    })
    const lines: string[] = []
    for await (const line of streamLines(stream)) lines.push(line)
    expect(lines).toEqual(['[White "A"]', '', '1. e4 e5 *', 'last'])
  })
})

describe('WebDatabaseHost', () => {
  let cache: MemoryCache
  let host: WebDatabaseHost

  beforeEach(() => {
    cache = new MemoryCache()
    host = new WebDatabaseHost(SQL, cache, openSource)
  })

  it('imports a picked PGN and answers queries', async () => {
    const progress: number[] = []
    const result = await host.open([file('games.pgn', SAMPLE)], (n) => progress.push(n))
    expect(result).toEqual({ count: 2, name: 'games.pgn', dbPath: 'games.pgn', imported: true })
    expect(progress.at(-1)).toBe(2)
    expect(host.currentName).toBe('games.pgn')
    expect(host.search({ white: 'Carlsen' }).total).toBe(1)
    const stats = host.positionStats(START)
    expect(stats.total).toBe(2)
    expect(stats.moves.map((m) => m.move).sort()).toEqual(['d4', 'e4'])
    const id = host.search({ white: 'So' }).games[0].id
    expect(host.getGame(id)?.pgn).toContain('1. d4 d5')
  })

  it('reuses the stored index when the same file is opened again', async () => {
    await host.open([file('games.pgn', SAMPLE)])
    await host.flush()
    expect(cache.saves).toBe(1)

    const again = new WebDatabaseHost(SQL, cache, openSource)
    const result = await again.open([file('games.pgn', SAMPLE)])
    expect(result.imported).toBe(false)
    expect(result.count).toBe(2)
    expect(again.positionStats(START).total).toBe(2)
  })

  it('imports again when the file changed', async () => {
    await host.open([file('games.pgn', SAMPLE)])
    await host.flush()
    const edited = SAMPLE + '\n\n[White "Late"]\n[Black "Entry"]\n[Result "*"]\n\n1. c4 *\n'
    const result = await host.open([file('games.pgn', edited, 2000)])
    expect(result).toMatchObject({ imported: true, count: 3 })
  })

  it('keeps working after the index is saved, and saves edits', async () => {
    await host.open([file('games.pgn', SAMPLE)])
    await host.flush()
    // Saving exports the database, which closes every prepared statement.
    const id = host.addGame('[White "X"]\n[Black "Y"]\n[Result "1-0"]\n\n1. f4 e5 1-0')
    expect(id).toBeGreaterThan(0)
    expect(host.search({}).total).toBe(3)
    host.deleteGame(id)
    expect(host.search({}).total).toBe(2)
    await host.flush()
    expect(cache.saves).toBe(3)
  })

  it('imports a ChessBase database from its picked files', async () => {
    const db = encodeDatabase([
      { white: 'Morphy, Paul', black: 'Duke Karl', result: '1-0', movetext: '1. e4 e5 2. Nf3 d6' },
      { white: 'Anderssen, Adolf', black: 'Kieseritzky', result: '1-0', movetext: '1. e4 e5 2. f4' },
      { movetext: '1. d4', deleted: true }
    ])
    const names: Record<string, string> = { cbh: 'Mega.CBH', cbg: 'Mega.Cbg' }
    const files = Object.entries(db).map(([ext, bytes]) => file(names[ext] ?? `Mega.${ext}`, bytes))
    const result = await host.open(files)
    expect(result).toMatchObject({ name: 'Mega.CBH', count: 2, imported: true, skipped: { deleted: 1 } })
    expect(host.positionStats(START).moves[0]).toMatchObject({ move: 'e4', count: 2 })
    await host.flush()

    const again = new WebDatabaseHost(SQL, cache, openSource)
    expect(await again.open(files)).toMatchObject({ imported: false, skipped: { deleted: 1 } })
  })

  it('explains what is missing or unsupported', async () => {
    const { cbh } = encodeDatabase([{ movetext: '1. e4' }])
    await expect(host.open([file('lonely.cbh', cbh)])).rejects.toThrow(/lonely\.cbg is missing/)
    await expect(host.open([file('mega.cbv', 'zip')])).rejects.toThrow(/desktop app/)
    await expect(host.open([file('notes.txt', 'hi')])).rejects.toThrow(/Unsupported/)
    expect(host.currentName).toBe('')
  })

  it('exports an opening book from the open database', async () => {
    expect(host.exportBook()).toBeNull()
    await host.open([file('games.pgn', SAMPLE)])
    const book = new PolyglotBook(host.exportBook() as Uint8Array)
    expect(book.lookup(START).map((m) => m.san).sort()).toEqual(['d4', 'e4'])
  })
})
