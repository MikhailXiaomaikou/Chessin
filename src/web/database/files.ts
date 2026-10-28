import type { ByteSource } from '../../shared/chessbase/bytes'

/** Text lines from a stream of decoded chunks; a line may span chunks. */
export async function* streamLines(stream: ReadableStream<string>): AsyncGenerator<string> {
  const reader = stream.getReader()
  let rest = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const lines = (rest + value).split(/\r?\n/)
      rest = lines.pop() ?? ''
      yield* lines
    }
  } finally {
    reader.releaseLock()
  }
  if (rest) yield rest.replace(/\r$/, '')
}

/** The lines of a UTF-8 text file, read piece by piece. */
export function blobLines(blob: Blob): AsyncGenerator<string> {
  return streamLines(blob.stream().pipeThrough(new TextDecoderStream()))
}

// Workers can read a slice of a file synchronously, which the ChessBase reader needs.
declare const FileReaderSync: { new (): { readAsArrayBuffer(blob: Blob): ArrayBuffer } }

const CHUNK = 1 << 16

/**
 * A file read through a small read-ahead buffer (worker only), so a
 * multi-gigabyte ChessBase database is never loaded whole.
 */
export class BlobSource implements ByteSource {
  readonly size: number
  private readonly reader = new FileReaderSync()
  private buf: Uint8Array = new Uint8Array(0)
  private bufStart = 0

  constructor(private readonly blob: Blob) {
    this.size = blob.size
  }

  read(offset: number, length: number): Uint8Array {
    const end = Math.min(offset + length, this.size)
    if (offset >= end) return new Uint8Array(0)
    if (offset >= this.bufStart && end <= this.bufStart + this.buf.length) {
      return this.buf.subarray(offset - this.bufStart, end - this.bufStart)
    }
    if (end - offset > CHUNK) return this.slice(offset, end)
    // A fresh buffer each time: slices handed out earlier stay valid.
    this.buf = this.slice(offset, Math.min(offset + CHUNK, this.size))
    this.bufStart = offset
    return this.buf.subarray(0, end - offset)
  }

  private slice(start: number, end: number): Uint8Array {
    return new Uint8Array(this.reader.readAsArrayBuffer(this.blob.slice(start, end)))
  }
}
