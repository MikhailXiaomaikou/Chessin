/**
 * Low-level helpers for reading ChessBase files. Byte order differs between
 * files (.cbh/.cbg/.cba are big-endian, the entity files little-endian), so the
 * readers name it explicitly.
 */

/** Random access to the bytes of one file. */
export interface ByteSource {
  readonly size: number
  /** Up to `length` bytes at `offset`; shorter at the end of the file. */
  read(offset: number, length: number): Uint8Array
}

/** A file held in memory (tests, the browser build). */
export class MemorySource implements ByteSource {
  constructor(private readonly data: Uint8Array) {}

  get size(): number {
    return this.data.byteLength
  }

  read(offset: number, length: number): Uint8Array {
    return this.data.subarray(offset, Math.min(offset + length, this.data.byteLength))
  }
}

export function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1]
}

export function u24be(b: Uint8Array, o: number): number {
  return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]
}

export function i24be(b: Uint8Array, o: number): number {
  const v = u24be(b, o)
  return v & 0x800000 ? v - 0x1000000 : v
}

export function u32be(b: Uint8Array, o: number): number {
  return b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])
}

export function i32le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
}

// WHATWG maps "latin1" to windows-1252, a superset for the printable range.
const singleByte = new TextDecoder('windows-1252')
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** A string in a fixed-size field: ISO 8859-1, zero-terminated when shorter. */
export function fixedString(b: Uint8Array, o: number, length: number): string {
  let end = o
  const limit = Math.min(o + length, b.length)
  while (end < limit && b[end] !== 0) end++
  return singleByte.decode(b.subarray(o, end)).trim()
}

const DIAGRAM_MARKER = 0x9e

/**
 * Free text in an annotation: UTF-8 or a single-byte code page, with nothing
 * saying which. Try UTF-8 first; otherwise decode as Windows-1252, where the
 * byte 0x9e is ChessBase's diagram marker, written as "#".
 */
export function annotationText(b: Uint8Array): string {
  try {
    return strictUtf8.decode(b)
  } catch {
    const parts: string[] = []
    let start = 0
    for (let i = 0; i <= b.length; i++) {
      if (i === b.length || b[i] === DIAGRAM_MARKER) {
        parts.push(singleByte.decode(b.subarray(start, i)))
        start = i + 1
      }
    }
    return parts.join('#')
  }
}

const FILES = 'abcdefgh'

/** ChessBase numbers squares file by file: a1 = 0, a2 = 1, … a8 = 7, b1 = 8. */
export function cbSquareName(sq: number): string {
  return FILES[(sq >> 3) & 7] + String((sq & 7) + 1)
}

export function cbSquareIndex(name: string): number {
  return (name.charCodeAt(0) - 97) * 8 + (name.charCodeAt(1) - 49)
}
