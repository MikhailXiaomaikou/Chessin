import Database from 'better-sqlite3'
import type { SqlDriver, SqlStatement } from '../../shared/database/sql'

/** A {@link SqlDriver} over a better-sqlite3 file database (or ':memory:'). */
export function openSqliteFile(path: string): SqlDriver {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')

  const cache = new Map<string, SqlStatement>()
  return {
    exec(sql) {
      db.exec(sql)
    },
    prepare(sql, options) {
      const key = `${options?.bigInts ? 'big' : 'num'}:${sql}`
      const cached = cache.get(key)
      if (cached) return cached
      const stmt = db.prepare(sql)
      if (options?.bigInts) stmt.safeIntegers(true)
      const wrapped: SqlStatement = {
        run: (...params) => ({ lastInsertRowid: Number(stmt.run(...params).lastInsertRowid) }),
        get: <T>(...params: unknown[]) => stmt.get(...params) as T | undefined,
        all: <T>(...params: unknown[]) => stmt.all(...params) as T[]
      }
      cache.set(key, wrapped)
      return wrapped
    },
    close() {
      cache.clear()
      db.close()
    }
  }
}
