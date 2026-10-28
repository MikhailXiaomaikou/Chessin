/**
 * The handful of SQLite operations the game database needs. Desktop runs them
 * on better-sqlite3 (a native file database), the web build on sql.js (SQLite
 * compiled to WebAssembly), so one engine serves both.
 *
 * Parameters are positional (`run(a, b)` for `?`), or a single object for
 * `@name` placeholders (`run({ name: 1 })`).
 */

export interface SqlRunResult {
  /** Row ID of the inserted row. Read it before running another statement. */
  readonly lastInsertRowid: number
}

/** Rows are typed by the caller, who knows the query's columns. */
export interface SqlStatement {
  run(...params: unknown[]): SqlRunResult
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined
  all<T = Record<string, unknown>>(...params: unknown[]): T[]
}

export interface SqlDriver {
  /** Runs one or more statements that return nothing. */
  exec(sql: string): void
  /**
   * A reusable statement. With `bigInts`, integer columns come back as bigint —
   * needed for 64-bit position hashes, which a double cannot hold exactly.
   */
  prepare(sql: string, options?: { bigInts?: boolean }): SqlStatement
  close(): void
}

/** True for the `{ name: value }` form of statement parameters. */
export function isNamedParams(params: unknown[]): params is [Record<string, unknown>] {
  const [first] = params
  return (
    params.length === 1 &&
    typeof first === 'object' &&
    first !== null &&
    !Array.isArray(first) &&
    !(first instanceof Uint8Array)
  )
}
