import { describe, it, expect } from 'vitest'
import { parsePgnTree, type PgnTreeNode } from './pgnTree'

const mainline = (roots: PgnTreeNode[]): string[] => {
  const out: string[] = []
  for (let n: PgnTreeNode | undefined = roots[0]; n; n = n.children[0]) out.push(n.san)
  return out
}

describe('parsePgnTree', () => {
  it('reads headers and the main line', () => {
    const t = parsePgnTree('[White "A \\"B\\""]\n[Black "C"]\n\n1. e4 e5 2. Nf3 *')
    expect(t.headers).toEqual({ White: 'A "B"', Black: 'C' })
    expect(mainline(t.roots)).toEqual(['e4', 'e5', 'Nf3'])
  })

  it('builds variations as alternatives to the move before them', () => {
    const t = parsePgnTree('1. e4 c5 (1... c6 2. d4) (1... Nf6) 2. Nf3 (2. c3 d5) 2... d6 *')
    const [e4] = t.roots
    expect(e4.children.map((n) => n.san)).toEqual(['c5', 'c6', 'Nf6'])
    expect(e4.children[1].children[0].san).toBe('d4')
    const c5 = e4.children[0]
    expect(c5.children.map((n) => n.san)).toEqual(['Nf3', 'c3'])
    expect(c5.children[0].children[0].san).toBe('d6')
    expect(c5.children[1].children[0].san).toBe('d5')
  })

  it('handles a variation on the first move', () => {
    const t = parsePgnTree('1. e4 (1. d4 d5) 1... e5 *')
    expect(t.roots.map((n) => n.san)).toEqual(['e4', 'd4'])
    expect(mainline(t.roots)).toEqual(['e4', 'e5'])
  })

  it('keeps comments in the right places', () => {
    const t = parsePgnTree('{Intro} 1. e4 {Best by test} e5 ({Also} 1... c5 {Sicilian}) 2. Nf3 ; line comment\n *')
    expect(t.comment).toBe('Intro')
    const [e4] = t.roots
    expect(e4.comment).toBe('Best by test')
    const c5 = e4.children[1]
    expect(c5.commentBefore).toBe('Also')
    expect(c5.comment).toBe('Sicilian')
    expect(e4.children[0].children[0].comment).toBe('line comment')
  })

  it('reads NAGs and glyphs, including glyphs stuck to the move', () => {
    const t = parsePgnTree('1. e4! $14 e5?! 2. Nf3 !! *')
    const [e4] = t.roots
    expect(e4.nags).toEqual([1, 14])
    expect(e4.children[0].nags).toEqual([6])
    expect(e4.children[0].children[0].nags).toEqual([3])
  })

  it('normalises castling with zeros and keeps null moves', () => {
    const t = parsePgnTree('1. e4 -- 2. Nf3 Z0 3. Bc4 Nf6 4. 0-0 0-0-0 *')
    expect(mainline(t.roots)).toEqual(['e4', '--', 'Nf3', '--', 'Bc4', 'Nf6', 'O-O', 'O-O-O'])
  })

  it('stops at the result', () => {
    const t = parsePgnTree('1. e4 e5 1-0 2. d4')
    expect(mainline(t.roots)).toEqual(['e4', 'e5'])
  })
})
