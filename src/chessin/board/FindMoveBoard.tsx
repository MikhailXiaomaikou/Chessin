import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { Box } from "@mantine/core";
import {
  type Chess,
  type Move,
  makeSquare,
  makeUci,
  type NormalMove,
  parseSquare,
  parseUci,
  type Role,
  type SquareName,
} from "chessops";
import { normalizeMove } from "chessops/chess";
import { chessgroundDests } from "chessops/compat";
import { makeFen } from "chessops/fen";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { Chessground } from "@/chessground/Chessground";
import { showCoordinatesAtom, showDestsAtom } from "@/state/atoms";
import classes from "@/styles/Chessboard.module.css";
import { positionFromFen } from "@/utils/chessops";
import { cssSize, REVIEW_BRUSHES } from "./MiniBoard";

/**
 * "Find the move" board: the user plays one move from `fen`, the board tells
 * whether it is among `answers` (UCI) and reports it through `onAttempt`.
 *
 * Self-contained: no tree store, no tab. Same `Chessground` wrapper as the
 * main board, so board image, piece set, 2D/3D mode and the drag/click move
 * method follow the user's settings. Used by the review panel ("先自己试一次")
 * and the mistake notebook (S2-5).
 *
 * Behaviour
 * - A correct attempt is played on the board (the position after the move is
 *   shown with a last-move highlight) and the board locks.
 * - A wrong attempt snaps back to `fen`, is drawn as a red arrow, and the user
 *   may try again until `disabled` is set by the parent.
 * - Castling is accepted in both UCI spellings (`e1g1` and `e1h1`); promotions
 *   default to the promotion piece of a matching answer, else a queen.
 * - `showHint` circles the piece that has to move; `reveal` draws every
 *   accepted move as a green arrow.
 * - Changing `fen` resets the attempt state.
 */

export type FindMoveBoardProps = {
  fen: string;
  orientation: "white" | "black";
  /** Accepted moves, UCI (`"e2e4"`, `"e7e8q"`). */
  answers: string[];
  onAttempt: (uci: string, correct: boolean) => void;
  /** Circles the origin square of the first answer. */
  showHint?: boolean;
  /** Locks the board (no moves accepted). */
  disabled?: boolean;
  /** Number = pixels; string = any CSS width. Defaults to `"100%"`. */
  size?: number | string;
  /** Draws every accepted move as a green arrow (after "揭晓"). */
  reveal?: boolean;
  /** Defaults to the user's coordinate setting. */
  coordinates?: boolean;
};

export type FindMoveAttempt = {
  uci: string;
  correct: boolean;
  fenAfter: string;
  /** The exercise position the attempt was made on; a different `fen` resets the board. */
  fenBefore: string;
};

/** Castling-agnostic key for a move: king-takes-rook form, as chessops normalises it. */
export function canonicalUci(pos: Chess, uci: string): string | null {
  const move = parseUci(uci);
  if (!move || !("from" in move)) return null;
  return makeUci(normalizeMove(pos, move));
}

/** Standard UCI spelling (castling as a two-square king move), as engines print it. */
export function standardUci(pos: Chess, move: NormalMove): string {
  const normalized = normalizeMove(pos, move) as NormalMove;
  const king = pos.board.get(normalized.from);
  const target = pos.board.get(normalized.to);
  if (
    king?.role === "king" &&
    target?.role === "rook" &&
    target.color === king.color &&
    normalized.from !== normalized.to
  ) {
    const rank = normalized.from >> 3;
    const kingside = (normalized.to & 7) > (normalized.from & 7);
    const toFile = kingside ? 6 : 2;
    return makeUci({ from: normalized.from, to: rank * 8 + toFile });
  }
  return makeUci(move);
}

export function isCorrectAttempt(pos: Chess, uci: string, answers: string[]): boolean {
  const attempt = canonicalUci(pos, uci);
  if (!attempt) return false;
  return answers.some((a) => canonicalUci(pos, a.trim().toLowerCase()) === attempt);
}

function promotionFromAnswers(answers: string[], fromTo: string): Role | undefined {
  const match = answers.find((a) => a.toLowerCase().startsWith(fromTo) && a.length === 5);
  switch (match?.[4]) {
    case "q":
      return "queen";
    case "r":
      return "rook";
    case "b":
      return "bishop";
    case "n":
      return "knight";
    default:
      return undefined;
  }
}

export default function FindMoveBoard({
  fen,
  orientation,
  answers,
  onAttempt,
  showHint = false,
  disabled = false,
  size,
  reveal = false,
  coordinates,
}: FindMoveBoardProps) {
  const showCoordinates = useAtomValue(showCoordinatesAtom);
  const showDests = useAtomValue(showDestsAtom);
  const [lastAttempt, setAttempt] = useState<FindMoveAttempt | null>(null);
  // A new position means a new exercise: attempts made on another fen are ignored.
  const attempt = lastAttempt && lastAttempt.fenBefore === fen ? lastAttempt : null;

  const [pos] = positionFromFen(fen);
  const turn = pos?.turn ?? "white";
  const locked = disabled || !pos || attempt?.correct === true;

  const dests = useMemo<Map<SquareName, SquareName[]>>(
    () => (pos && !locked ? chessgroundDests(pos) : new Map()),
    [pos, locked],
  );

  const shapes = useMemo<DrawShape[]>(() => {
    const out: DrawShape[] = [];
    if (attempt?.correct) return out;
    const firstAnswer = answers[0] ? parseUci(answers[0]) : undefined;
    if (showHint && firstAnswer && "from" in firstAnswer) {
      out.push({ orig: makeSquare(firstAnswer.from) as Key, brush: "hint" });
    }
    if (attempt && !attempt.correct) {
      const m = parseUci(attempt.uci);
      if (m && "from" in m) {
        out.push({
          orig: makeSquare(m.from) as Key,
          dest: makeSquare(m.to) as Key,
          brush: "played",
        });
      }
    }
    if (reveal) {
      for (const a of answers) {
        const m = parseUci(a);
        if (m && "from" in m) {
          out.push({
            orig: makeSquare(m.from) as Key,
            dest: makeSquare(m.to) as Key,
            brush: "best",
          });
        }
      }
    }
    return out;
  }, [answers, attempt, reveal, showHint]);

  function handleMove(orig: SquareName, dest: SquareName) {
    if (!pos || locked) return;
    const from = parseSquare(orig);
    const to = parseSquare(dest);
    if (from === undefined || to === undefined) return;
    const piece = pos.board.get(from);
    let promotion: Role | undefined;
    if (
      piece?.role === "pawn" &&
      ((dest[1] === "8" && turn === "white") || (dest[1] === "1" && turn === "black"))
    ) {
      promotion = promotionFromAnswers(answers, `${orig}${dest}`) ?? "queen";
    }
    const move: Move = { from, to, promotion };
    if (!pos.isLegal(move)) return;

    const uci = standardUci(pos, move);
    const correct = isCorrectAttempt(pos, uci, answers);
    const after = pos.clone();
    after.play(move);
    const fenAfter = makeFen(after.toSetup());
    const matched = correct
      ? (answers.find(
          (a) => canonicalUci(pos, a.trim().toLowerCase()) === canonicalUci(pos, uci),
        ) ?? uci)
      : uci;
    setAttempt({ uci: matched, correct, fenAfter, fenBefore: fen });
    onAttempt(matched, correct);
  }

  const shownFen = attempt?.correct ? attempt.fenAfter : fen;
  const [shownPos] = positionFromFen(shownFen);
  const lastMove = useMemo<Key[] | undefined>(() => {
    if (!attempt?.correct) return undefined;
    const m = parseUci(attempt.uci);
    if (!m || !("from" in m)) return undefined;
    return [makeSquare(m.from) as Key, makeSquare(m.to) as Key];
  }, [attempt]);

  return (
    <Box
      className={classes.chessboard}
      style={{ width: cssSize(size), maxWidth: "100%", flex: "0 0 auto" }}
      data-find-move-state={attempt ? (attempt.correct ? "correct" : "wrong") : "waiting"}
    >
      <Chessground
        fen={shownFen}
        orientation={orientation}
        coordinates={coordinates ?? showCoordinates !== "no"}
        turnColor={shownPos?.turn ?? turn}
        check={shownPos?.isCheck() ?? false}
        lastMove={lastMove}
        animation={{ enabled: true, duration: 200 }}
        viewOnly={locked}
        movable={{
          free: false,
          color: locked ? undefined : turn,
          dests: locked ? undefined : dests,
          showDests,
          events: {
            after: (orig, dest) => handleMove(orig as SquareName, dest as SquareName),
          },
        }}
        premovable={{ enabled: false }}
        draggable={{ enabled: !locked }}
        drawable={{
          enabled: false,
          visible: true,
          autoShapes: shapes,
          brushes: REVIEW_BRUSHES,
        }}
      />
    </Box>
  );
}
