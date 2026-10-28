import { defineConfig } from 'vitest/config'

// Unit tests for the Node-side database engine (PGN parsing, Polyglot hashing,
// SQLite store). These run in plain Node — no Electron, no DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
