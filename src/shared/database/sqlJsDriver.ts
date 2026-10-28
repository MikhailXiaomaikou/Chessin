import { isNamedParams, type SqlDriver, type SqlStatement } from './sql'

/** The part of sql.js's statement API used here (its typings predate BigInt support). */
interface SqlJsStatement {
  bind(values?: unknown[] | Record<string, unknown> | null): boolean
  step(): boolean
  get(): unknown[]
  getAsObject(params: null, config?: { useBigInt: boolean }): Record<string, unknown>
  reset(): void
}

/** The part of a sql.js `Database` used here. */
export interface SqlJsDatabase {
  exec(sql: string): unknown
  prepare(sql: string): SqlJsStatement
  close(): void
}

const toSql = (v: unknown): unknown =>
  v === undefined ? null : typeof v === 'boolean' ? Number(v) : v

/**
 * A {@link SqlDriver} over a sql.js database (SQLite in WebAssembly). Statements
 * are cached by their SQL: sql.js only frees a statement explicitly, so preparing
 * one per query would leak memory on every board move.
 */
export function sqlJsDriver(db: SqlJsDatabase): SqlDriver {
  const cache = new Map<string, SqlStatement>()
  let rowidStmt: SqlJsStatement | null = null

  const lastInsertRowid = (): number => {
    rowidStmt ??= db.prepare('SELECT last_insert_rowid()')
    try {
      rowidStmt.step()
      return Number(rowidStmt.get()[0])
    } finally {
      rowidStmt.reset()
    }
  }

  return {
    exec(sql) {
      db.exec(sql)
    },

    prepare(sql, options) {
      const key = `${options?.bigInts ? 'big' : 'num'}:${sql}`
      const cached = cache.get(key)
      if (cached) return cached

      const stmt = db.prepare(sql)
      const config = options?.bigInts ? { useBigInt: true } : undefined
      const bind = (params: unknown[]): void => {
        if (isNamedParams(params)) {
          const named: Record<string, unknown> = {}
          for (const [name, value] of Object.entries(params[0])) named[`@${name}`] = toSql(value)
          stmt.bind(named)
        } else {
          stmt.bind(params.map(toSql))
        }
      }

      const wrapped: SqlStatement = {
        run(...params) {
          bind(params)
          try {
            stmt.step()
          } finally {
            stmt.reset()
          }
          // Looked up only when asked for: position rows never need it.
          return {
            get lastInsertRowid() {
              return lastInsertRowid()
            }
          }
        },
        get<T>(...params: unknown[]) {
          bind(params)
          try {
            return stmt.step() ? (stmt.getAsObject(null, config) as T) : undefined
          } finally {
            stmt.reset()
          }
        },
        all<T>(...params: unknown[]) {
          bind(params)
          const rows: T[] = []
          try {
            while (stmt.step()) rows.push(stmt.getAsObject(null, config) as T)
          } finally {
            stmt.reset()
          }
          return rows
        }
      }
      cache.set(key, wrapped)
      return wrapped
    },

    close() {
      cache.clear()
      db.close() // frees every statement it prepared
    }
  }
}
