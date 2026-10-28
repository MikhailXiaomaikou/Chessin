import { describe, it, expect } from 'vitest'
import {
  parseCommentShapes,
  commentText,
  withCommentShapes,
  withCommentText
} from './commentShapes'

describe('comment shapes', () => {
  it('reads squares and arrows', () => {
    expect(parseCommentShapes('Strong [%csl Ga4, Rb5] idea [%cal Ge2e4,Yd1h5]')).toEqual([
      { color: 'G', orig: 'a4' },
      { color: 'R', orig: 'b5' },
      { color: 'G', orig: 'e2', dest: 'e4' },
      { color: 'Y', orig: 'd1', dest: 'h5' }
    ])
    expect(parseCommentShapes('[%csl Xa9,Gz1] [%clk 0:01:00]')).toEqual([])
    expect(parseCommentShapes(undefined)).toEqual([])
  })

  it('strips commands from the text shown to the reader', () => {
    expect(commentText('[%clk 0:05:00] Good move [%cal Ge2e4]')).toBe('Good move')
    expect(commentText('[%csl Ga4]')).toBe('')
  })

  it('replaces shapes and keeps the text and other commands', () => {
    const c = withCommentShapes('Nice [%clk 0:05:00] [%cal Ra1a8]', [
      { color: 'B', orig: 'c3' },
      { color: 'G', orig: 'e2', dest: 'e4' }
    ])
    expect(c).toBe('[%csl Bc3] [%cal Ge2e4] Nice [%clk 0:05:00]')
    expect(parseCommentShapes(c)).toHaveLength(2)
    expect(withCommentShapes(c, [])).toBe('Nice [%clk 0:05:00]')
    expect(withCommentShapes('[%cal Ge2e4]', [])).toBe('')
  })

  it('replaces the text and keeps the commands', () => {
    expect(withCommentText('Old [%cal Ge2e4] text', '  New\n idea ')).toBe('[%cal Ge2e4] New idea')
    expect(withCommentText(undefined, 'Hi')).toBe('Hi')
    expect(withCommentText('Old', '')).toBe('')
  })
})
