import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Unit tests for the database engine (PGN parsing, Polyglot hashing, SQLite
// store) and the renderer's stores. These run in plain Node — no Electron, no DOM.
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
