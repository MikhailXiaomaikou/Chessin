import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { createUnzip } from 'zlib'
import { Readable } from 'stream'

/**
 * ChessBase CBV format reader.
 *
 * CBV files are essentially ZIP archives containing the CBH database files
 * (.cbh, .cbg, .cba, .cbp, .cbt, etc.).
 *
 * We extract the CBV to a temporary directory and then read it as a CBH database.
 */

export async function extractCbv(
  cbvPath: string,
  outputDir: string
): Promise<string> {
  if (!existsSync(cbvPath)) {
    throw new Error(`CBV file not found: ${cbvPath}`)
  }

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true })

  const data = await readFile(cbvPath)

  // CBV is a ZIP-like format. Try to find and extract the files.
  // In practice, CBV files use standard ZIP compression.
  // We use a simple ZIP parser to extract the files.

  const files = parseZipEntries(data)

  let cbhPath = ''

  for (const file of files) {
    const outputPath = join(outputDir, file.name)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, file.data)

    if (file.name.toLowerCase().endsWith('.cbh')) {
      cbhPath = outputPath
    }
  }

  if (!cbhPath) {
    throw new Error('No .cbh file found in CBV archive')
  }

  return cbhPath
}

interface ZipEntry {
  name: string
  data: Buffer
}

function parseZipEntries(data: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = []
  let offset = 0

  while (offset + 30 < data.length) {
    // Local file header signature: 0x04034b50
    const sig = data.readUInt32LE(offset)
    if (sig !== 0x04034b50) break

    const compressionMethod = data.readUInt16LE(offset + 8)
    const compressedSize = data.readUInt32LE(offset + 18)
    const uncompressedSize = data.readUInt32LE(offset + 22)
    const nameLength = data.readUInt16LE(offset + 26)
    const extraLength = data.readUInt16LE(offset + 28)

    const name = data.subarray(offset + 30, offset + 30 + nameLength).toString('utf-8')
    const dataStart = offset + 30 + nameLength + extraLength
    const fileData = data.subarray(dataStart, dataStart + compressedSize)

    if (compressionMethod === 0) {
      // Stored (no compression)
      entries.push({ name, data: fileData })
    } else if (compressionMethod === 8) {
      // Deflate - we'd need to decompress
      // For simplicity, try to use raw deflate decompression
      try {
        const inflated = inflateSync(fileData)
        entries.push({ name, data: inflated })
      } catch {
        // Skip files that can't be decompressed
      }
    }

    offset = dataStart + compressedSize
  }

  return entries
}

function inflateSync(data: Buffer): Buffer {
  const { inflateRawSync } = require('zlib')
  return inflateRawSync(data)
}
