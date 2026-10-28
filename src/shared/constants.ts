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
  7: '□', // only move
  8: '□', // singular move
  10: '=', // equal
  11: '=', // equal, quiet position
  12: '=', // equal, active position
  13: '∞', // unclear
  14: '⩲', // slight advantage white
  15: '⩱', // slight advantage black
  16: '±', // moderate advantage white
  17: '∓', // moderate advantage black
  18: '+-', // decisive advantage white
  19: '-+', // decisive advantage black
  22: '⨀', // zugzwang (white)
  23: '⨀', // zugzwang (black)
  32: '⟳', // development advantage (white)
  33: '⟳', // development advantage (black)
  36: '↑', // initiative (white)
  37: '↑', // initiative (black)
  40: '→', // attack (white)
  41: '→', // attack (black)
  44: '=∞', // compensation (white)
  45: '=∞', // compensation (black)
  132: '⇆', // counterplay (white)
  133: '⇆', // counterplay (black)
  138: '⨁', // time trouble (white)
  139: '⨁', // time trouble (black)
  140: '∆', // with the idea
  141: '∇', // aimed against
  142: '⌓', // better is
  143: '≤', // worse is
  144: '=', // equivalent is
  145: 'RR', // editorial comment
  146: 'N' // novelty
}

export const BOARD_THEMES = {
  brown: { light: '#f0d9b5', dark: '#b58863' },
  green: { light: '#ffffdd', dark: '#86a666' },
  blue: { light: '#dee3e6', dark: '#8ca2ad' },
  gray: { light: '#e8e8e8', dark: '#b0b0b0' },
  purple: { light: '#e8dff5', dark: '#9c7cb0' }
} as const
