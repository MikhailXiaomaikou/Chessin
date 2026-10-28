import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { DatabaseManager } from './DatabaseManager'
import { encodeDatabase } from '../../shared/chessbase/testkit'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const SAMPLE = `[White "Carlsen, M"]
[Black "Caruana, F"]
[Result "1-0"]

1. e4 e5 2. Nf3 1-0

[White "So, W"]
[Black "Nakamura, H"]
[Result "0-1"]

1. d4 d5 0-1`

describe('DatabaseManager companion index', () => {
  it('imports a PGN, then reuses the cached index on reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chessin-mgr-'))
    const pgn = join(dir, 'games.pgn')
    writeFileSync(pgn, SAMPLE)

    const mgr = new DatabaseManager()
    mgr.setCacheDir(join(dir, 'cache'))

    const first = await mgr.openDatabase(pgn)
    expect(first.imported).toBe(true)
    expect(first.count).toBe(2)
    expect(mgr.search({ white: 'Carlsen' }).total).toBe(1)
    expect(mgr.positionStats(START).total).toBe(2)

    const second = await mgr.openDatabase(pgn)
    expect(second.imported).toBe(false)
    expect(second.count).toBe(2)

    mgr.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('re-imports a PGN that changed after it was indexed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chessin-mgr-'))
    const pgn = join(dir, 'games.pgn')
    writeFileSync(pgn, SAMPLE)

    const mgr = new DatabaseManager()
    mgr.setCacheDir(join(dir, 'cache'))

    const first = await mgr.openDatabase(pgn)
    expect(first.imported).toBe(true)

    // Edited while its index is still open. Closing that index rewrites the
    // file, so a file-time comparison would wrongly call it up to date.
    appendFileSync(pgn, '\n\n[White "Late"]\n[Black "Entry"]\n[Result "*"]\n\n1. c4 *\n')

    const second = await mgr.openDatabase(pgn)
    expect(second.imported).toBe(true)
    expect(second.count).toBe(3)

    mgr.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('imports a ChessBase database with moves, annotations and a reusable index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chessin-cb-'))
    const db = encodeDatabase([
      {
        white: 'Morphy, Paul',
        black: 'Duke Karl',
        event: 'Paris Opera',
        year: 1858,
        result: '1-0',
        movetext: '1. e4 e5 2. Nf3 d6 3. d4 Bg4',
        annotations: [{ pos: 0, type: 0x02, data: [0, 0, ...new TextEncoder().encode('Morphy at the opera')] }]
      },
      { white: 'Anderssen, Adolf', black: 'Kieseritzky', result: '1-0', movetext: '1. e4 e5 2. f4 exf4' },
      { movetext: '1. d4', deleted: true },
      { guidingText: true, rawMoves: [0x80, 0, 0, 4] }
    ])
    // Windows-made databases often have upper-case extensions.
    const names: Record<string, string> = { cbh: 'Mega.CBH', cbg: 'Mega.Cbg' }
    for (const [ext, bytes] of Object.entries(db)) writeFileSync(join(dir, names[ext] ?? `Mega.${ext}`), bytes)

    const mgr = new DatabaseManager()
    mgr.setCacheDir(join(dir, 'cache'))
    const first = await mgr.openDatabase(join(dir, 'Mega.CBH'))
    expect(first).toMatchObject({ count: 2, imported: true, skipped: { deleted: 1, 'guiding-text': 1 } })
    expect(mgr.search({ white: 'Morphy' }).total).toBe(1)
    // Real moves were decoded and indexed: the opening tree sees both games.
    const tree = mgr.positionStats(START)
    expect(tree.total).toBe(2)
    expect(tree.moves[0]).toMatchObject({ move: 'e4', count: 2, whiteWins: 2 })
    const id = mgr.search({ white: 'Morphy' }).games[0].id
    expect(mgr.getGamePgn(id)).toContain('{Morphy at the opera}')

    const again = await mgr.openDatabase(join(dir, 'Mega.CBH'))
    expect(again).toMatchObject({ count: 2, imported: false, skipped: { deleted: 1, 'guiding-text': 1 } })

    mgr.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports a ChessBase database without its moves file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chessin-cb-'))
    writeFileSync(join(dir, 'lonely.cbh'), encodeDatabase([{ movetext: '1. e4' }]).cbh)
    const mgr = new DatabaseManager()
    mgr.setCacheDir(join(dir, 'cache'))
    await expect(mgr.openDatabase(join(dir, 'lonely.cbh'))).rejects.toThrow(/lonely\.cbg is missing/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rebuilds a cached index written by an older schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chessin-mgr-'))
    const pgn = join(dir, 'games.pgn')
    writeFileSync(pgn, SAMPLE)

    const mgr = new DatabaseManager()
    mgr.setCacheDir(join(dir, 'cache'))
    const first = await mgr.openDatabase(pgn)
    mgr.close()

    // Pretend the cache predates the current encoding.
    const raw = new Database(first.dbPath)
    raw.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run()
    raw.close()

    const second = await mgr.openDatabase(pgn)
    expect(second.imported).toBe(true)
    expect(second.count).toBe(2)

    mgr.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
