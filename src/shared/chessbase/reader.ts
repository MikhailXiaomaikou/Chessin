import { type ByteSource, u24be, u32be } from './bytes'
import {
  readCbhRecord,
  cbhRecordCount,
  EntityFile,
  playerName,
  tournamentText,
  annotatorName,
  sourceTitle,
  formatCbDate,
  formatCbEco,
  formatCbResult,
  type CbhRecord
} from './records'
import { parseAnnotations, CBA_RECORD_HEADER, type MoveAnnotations } from './annotations'
import { decodeMoves, CbgFormatError, UnsupportedEncodingError } from './moves'
import { buildMovetext, mainlineOf, formatPgn } from './pgn'

/**
 * Reads a ChessBase (.cbh family) database game by game and produces PGN.
 *
 * Files are reached through {@link ByteSource}s, so the desktop app can read a
 * multi-gigabyte database positionally while tests and the browser use memory.
 */

export interface ChessBaseFiles {
  cbh: ByteSource
  cbg: ByteSource
  cba?: ByteSource
  cbp?: ByteSource
  cbt?: ByteSource
  cbc?: ByteSource
  cbs?: ByteSource
}

export interface CbGame {
  id: number
  headers: Record<string, string>
  /** Main-line moves in SAN (up to any null move), for position indexing. */
  moves: string[]
  movetext: string
  pgn: string
}

export type CbSkipReason = 'deleted' | 'guiding-text' | 'unsupported-encoding' | 'corrupt'

export type CbEntry =
  | { kind: 'game'; game: CbGame }
  | { kind: 'skipped'; id: number; reason: CbSkipReason; detail?: string }

export class ChessBaseReader {
  /** Number of records in the .cbh file (games, texts and deleted games). */
  readonly count: number
  private readonly players: EntityFile
  private readonly tournaments: EntityFile
  private readonly annotators: EntityFile
  private readonly sources: EntityFile

  constructor(private readonly files: ChessBaseFiles) {
    this.count = cbhRecordCount(files.cbh)
    this.players = new EntityFile(files.cbp, playerName)
    this.tournaments = new EntityFile(files.cbt, tournamentText)
    this.annotators = new EntityFile(files.cbc, annotatorName)
    this.sources = new EntityFile(files.cbs, sourceTitle)
  }

  *entries(): Generator<CbEntry> {
    for (let id = 1; id <= this.count; id++) {
      const entry = this.read(id)
      if (entry) yield entry
    }
  }

  /** Game `id` (1-based), a reason it was skipped, or null past the end. */
  read(id: number): CbEntry | null {
    const rec = readCbhRecord(this.files.cbh, id)
    if (!rec) return null
    if (rec.guidingText) return { kind: 'skipped', id, reason: 'guiding-text' }
    if (rec.deleted) return { kind: 'skipped', id, reason: 'deleted' }
    try {
      const head = this.files.cbg.read(rec.movesOffset, 4)
      if (head.length < 4) throw new CbgFormatError('moves lie past the end of the .cbg file')
      const decoded = decodeMoves(this.files.cbg.read(rec.movesOffset, u24be(head, 1)))
      const annotations = this.annotations(rec)
      const headers = this.headers(rec, decoded.startFen)
      const movetext = buildMovetext(decoded, annotations, headers.Result)
      return {
        kind: 'game',
        game: { id, headers, moves: mainlineOf(decoded), movetext, pgn: formatPgn(headers, movetext) }
      }
    } catch (err) {
      if (err instanceof UnsupportedEncodingError) {
        return { kind: 'skipped', id, reason: 'unsupported-encoding', detail: err.message }
      }
      return { kind: 'skipped', id, reason: 'corrupt', detail: (err as Error).message }
    }
  }

  private annotations(rec: CbhRecord): Map<number, MoveAnnotations> {
    const cba = this.files.cba
    if (!rec.annotationsOffset || !cba) return new Map()
    const head = cba.read(rec.annotationsOffset, CBA_RECORD_HEADER)
    if (head.length < CBA_RECORD_HEADER) return new Map()
    return parseAnnotations(cba.read(rec.annotationsOffset, u32be(head, 0x0a)))
  }

  private headers(rec: CbhRecord, startFen?: string): Record<string, string> {
    const [event, site] = this.tournaments.text(rec.tournament).split('\t')
    const round = rec.round ? (rec.subround ? `${rec.round}.${rec.subround}` : String(rec.round)) : '?'
    const h: Record<string, string> = {
      Event: event || '?',
      Site: site || '?',
      Date: formatCbDate(rec.date),
      Round: round,
      White: this.players.text(rec.white) || '?',
      Black: this.players.text(rec.black) || '?',
      Result: formatCbResult(rec.result)
    }
    if (rec.whiteElo) h.WhiteElo = String(rec.whiteElo)
    if (rec.blackElo) h.BlackElo = String(rec.blackElo)
    const eco = formatCbEco(rec.eco)
    if (eco) h.ECO = eco
    const annotator = this.annotators.text(rec.annotator)
    if (annotator) h.Annotator = annotator
    const source = this.sources.text(rec.source)
    if (source) h.Source = source
    if (startFen) {
      h.SetUp = '1'
      h.FEN = startFen
    }
    return h
  }
}
