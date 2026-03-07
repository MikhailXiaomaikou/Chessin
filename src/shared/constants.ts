export const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export const PIECE_NAMES = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king'
} as const

export const NAG_SYMBOLS: Record<number, string> = {
  1: '!',
  2: '?',
  3: '!!',
  4: '??',
  5: '!?',
  6: '?!',
  7: '□', // forced move
  10: '=', // equal
  13: '∞', // unclear
  14: '⩲', // slight advantage white
  15: '⩱', // slight advantage black
  16: '±', // moderate advantage white
  17: '∓', // moderate advantage black
  18: '+-', // decisive advantage white
  19: '-+', // decisive advantage black
  22: '⨀', // zugzwang
  32: '⟳', // development advantage
  36: '→', // initiative
  40: '↑', // attack
  132: '⇆', // counterplay
  138: '⨁' // time trouble
}

export const BOARD_THEMES = {
  brown: { light: '#f0d9b5', dark: '#b58863' },
  green: { light: '#ffffdd', dark: '#86a666' },
  blue: { light: '#dee3e6', dark: '#8ca2ad' },
  gray: { light: '#e8e8e8', dark: '#b0b0b0' },
  purple: { light: '#e8dff5', dark: '#9c7cb0' }
} as const
