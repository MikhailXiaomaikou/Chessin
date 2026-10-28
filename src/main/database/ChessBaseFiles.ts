import { openSync, readSync, fstatSync, closeSync, readdirSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import type { ByteSource } from '../../shared/chessbase/bytes'
import type { ChessBaseFiles } from '../../shared/chessbase/reader'

const CHUNK = 1 << 16

/**
 * A file read positionally through a small read-ahead buffer, so walking a
 * multi-gigabyte database neither loads it into memory nor costs a system call
 * per 46-byte record.
 */
export class FileSource implements ByteSource {
  readonly size: number
  private readonly fd: number
  private buf = Buffer.alloc(0)
  private bufStart = 0

  constructor(path: string) {
    this.fd = openSync(path, 'r')
    this.size = fstatSync(this.fd).size
  }

  read(offset: number, length: number): Uint8Array {
    const end = Math.min(offset + length, this.size)
    if (offset >= end) return new Uint8Array(0)
    if (offset >= this.bufStart && end <= this.bufStart + this.buf.length) {
      return this.buf.subarray(offset - this.bufStart, end - this.bufStart)
    }
    if (end - offset > CHUNK) {
      const out = Buffer.alloc(end - offset)
      readSync(this.fd, out, 0, out.length, offset)
      return out
    }
    // A fresh buffer each time: slices handed out earlier stay valid.
    this.buf = Buffer.alloc(Math.min(CHUNK, this.size - offset))
    readSync(this.fd, this.buf, 0, this.buf.length, offset)
    this.bufStart = offset
    return this.buf.subarray(0, end - offset)
  }

  close(): void {
    closeSync(this.fd)
  }
}

const EXTENSIONS = ['cbh', 'cbg', 'cba', 'cbp', 'cbt', 'cbc', 'cbs'] as const

export interface OpenedChessBase {
  files: ChessBaseFiles
  /** The files that were found, for checking whether an index is up to date. */
  paths: string[]
  close(): void
}

/**
 * Open the files of the database whose header file is `cbhPath`. Sibling files
 * are matched case-insensitively, as databases made on Windows often carry
 * upper-case extensions.
 */
export function openChessBaseFiles(cbhPath: string): OpenedChessBase {
  const dir = dirname(cbhPath)
  const stem = basename(cbhPath, extname(cbhPath)).toLowerCase()
  const found = new Map<string, string>()
  for (const name of readdirSync(dir)) {
    const ext = extname(name)
    const key = ext.slice(1).toLowerCase()
    if (basename(name, ext).toLowerCase() === stem && (EXTENSIONS as readonly string[]).includes(key)) {
      found.set(key, join(dir, name))
    }
  }
  found.set('cbh', cbhPath)
  if (!found.has('cbg')) {
    throw new Error(`The moves file ${basename(cbhPath, extname(cbhPath))}.cbg is missing`)
  }

  const opened: FileSource[] = []
  const open = (ext: string): FileSource | undefined => {
    const path = found.get(ext)
    if (!path) return undefined
    const source = new FileSource(path)
    opened.push(source)
    return source
  }
  try {
    const files: ChessBaseFiles = {
      cbh: open('cbh') as FileSource,
      cbg: open('cbg') as FileSource,
      cba: open('cba'),
      cbp: open('cbp'),
      cbt: open('cbt'),
      cbc: open('cbc'),
      cbs: open('cbs')
    }
    return { files, paths: [...found.values()], close: () => opened.forEach((s) => s.close()) }
  } catch (err) {
    opened.forEach((s) => s.close())
    throw err
  }
}
