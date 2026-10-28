import { i24be, u16be, annotationText, cbSquareName } from './bytes'

/**
 * The annotations of one game from the .cba file (format/v1/3-annotations.md).
 * Comments, symbols, coloured squares and arrows are kept; the rest (clocks,
 * media, training questions…) has no PGN form and is skipped by its size.
 */

export interface MoveAnnotations {
  textBefore: string[]
  textAfter: string[]
  /** Numeric annotation glyphs: move mark, evaluation, prefix. */
  nags: number[]
  /** [%csl] entries such as "Ga1". */
  squares: string[]
  /** [%cal] entries such as "Re2e4". */
  arrows: string[]
}

/** Size of the record header before the first annotation. */
export const CBA_RECORD_HEADER = 0x0e

const COLOURS: Record<number, string> = { 2: 'G', 3: 'Y', 4: 'R' }

/** Annotations keyed by move position; −1 is the game as a whole. */
export function parseAnnotations(rec: Uint8Array): Map<number, MoveAnnotations> {
  const out = new Map<number, MoveAnnotations>()
  const at = (pos: number): MoveAnnotations => {
    let a = out.get(pos)
    if (!a) out.set(pos, (a = { textBefore: [], textAfter: [], nags: [], squares: [], arrows: [] }))
    return a
  }

  let o = CBA_RECORD_HEADER
  while (o + 6 <= rec.length) {
    const pos = i24be(rec, o)
    const type = rec[o + 3]
    const size = u16be(rec, o + 4)
    if (size < 6 || o + size > rec.length) break
    const data = rec.subarray(o + 6, o + size)

    switch (type) {
      case 0x02:
      case 0x82: {
        // An unknown byte and a language byte precede the text.
        const text = annotationText(data.subarray(2)).trim()
        if (text) (type === 0x82 ? at(pos).textBefore : at(pos).textAfter).push(text)
        break
      }
      case 0x03:
        for (const nag of data) if (nag) at(pos).nags.push(nag)
        break
      case 0x04:
        // Here squares are numbered from 1.
        for (let i = 0; i + 1 < data.length; i += 2) {
          const colour = COLOURS[data[i]]
          const sq = data[i + 1]
          if (colour && sq >= 1 && sq <= 64) at(pos).squares.push(colour + cbSquareName(sq - 1))
        }
        break
      case 0x05:
        for (let i = 0; i + 2 < data.length; i += 3) {
          const colour = COLOURS[data[i]]
          const from = data[i + 1]
          const to = data[i + 2]
          if (colour && from >= 1 && from <= 64 && to >= 1 && to <= 64) {
            at(pos).arrows.push(colour + cbSquareName(from - 1) + cbSquareName(to - 1))
          }
        }
        break
      default:
        break
    }
    o += size
  }
  return out
}
