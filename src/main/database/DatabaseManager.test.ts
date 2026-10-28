import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DatabaseManager } from './DatabaseManager'

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

  it('re-imports when the PGN is newer than its cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chessin-mgr-'))
    const pgn = join(dir, 'games.pgn')
    writeFileSync(pgn, SAMPLE)

    const mgr = new DatabaseManager()
    mgr.setCacheDir(join(dir, 'cache'))

    const first = await mgr.openDatabase(pgn)
    expect(first.imported).toBe(true)

    // Make the cached index look stale relative to the PGN.
    const past = new Date(Date.now() - 60_000)
    utimesSync(first.dbPath, past, past)

    const second = await mgr.openDatabase(pgn)
    expect(second.imported).toBe(true)
    expect(second.count).toBe(2)

    mgr.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
