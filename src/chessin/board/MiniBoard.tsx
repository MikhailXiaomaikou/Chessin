import type { DrawBrushes, DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { Box } from "@mantine/core";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { Chessground } from "@/chessground/Chessground";
import { showCoordinatesAtom } from "@/state/atoms";
import classes from "@/styles/Chessboard.module.css";
import { positionFromFen } from "@/utils/chessops";

/**
 * Small read-only board (review moments, notebook cards, explanation demos).
 *
 * It renders through the same `Chessground` wrapper as the main board, so the
 * board image (`boardImageAtom`), 2D/3D mode and the global piece-set CSS from
 * `App.tsx` apply unchanged. Nothing here touches a tree store.
 */

export type BoardArrow = { orig: string; dest: string; brush: string };

export type MiniBoardProps = {
  fen: string;
  /** UCI move (`"e2e4"`) or a `[from, to]` pair highlighted as the last move. */
  lastMove?: string | [string, string];
  arrows?: BoardArrow[];
  /** Number = pixels; string = any CSS width. Defaults to `"100%"`. */
  size?: number | string;
  orientation?: "white" | "black";
  /** Defaults to the user's coordinate setting. */
  coordinates?: boolean;
};

/** Arrow brushes shared by the review boards (chessground's defaults stay available too). */
export const REVIEW_BRUSHES = {
  best: { key: "rb", color: "#2f9e44", opacity: 0.85, lineWidth: 10 },
  played: { key: "rp", color: "#e03131", opacity: 0.8, lineWidth: 10 },
  alt: { key: "ra", color: "#1c7ed6", opacity: 0.6, lineWidth: 8 },
  hint: { key: "rh", color: "#f08c00", opacity: 0.8, lineWidth: 8 },
} as unknown as DrawBrushes;

export function toLastMove(lastMove?: string | [string, string]): Key[] | undefined {
  if (!lastMove) return undefined;
  if (Array.isArray(lastMove)) return [lastMove[0] as Key, lastMove[1] as Key];
  if (lastMove.length < 4) return undefined;
  return [lastMove.slice(0, 2) as Key, lastMove.slice(2, 4) as Key];
}

export function arrowsToShapes(arrows?: BoardArrow[]): DrawShape[] {
  return (arrows ?? []).map((a) => ({
    orig: a.orig as Key,
    dest: a.dest as Key,
    brush: a.brush,
  }));
}

export function cssSize(size: number | string | undefined): string {
  if (size === undefined) return "100%";
  return typeof size === "number" ? `${size}px` : size;
}

export default function MiniBoard({
  fen,
  lastMove,
  arrows,
  size,
  orientation = "white",
  coordinates,
}: MiniBoardProps) {
  const showCoordinates = useAtomValue(showCoordinatesAtom);
  const [pos] = positionFromFen(fen);
  const shapes = useMemo(() => arrowsToShapes(arrows), [arrows]);

  return (
    <Box
      className={classes.chessboard}
      style={{ width: cssSize(size), maxWidth: "100%", flex: "0 0 auto" }}
    >
      <Chessground
        fen={fen}
        orientation={orientation}
        viewOnly
        coordinates={coordinates ?? showCoordinates !== "no"}
        turnColor={pos?.turn ?? "white"}
        check={pos?.isCheck() ?? false}
        lastMove={toLastMove(lastMove)}
        animation={{ enabled: true, duration: 150 }}
        movable={{ free: false, color: undefined, dests: undefined, showDests: false }}
        premovable={{ enabled: false }}
        draggable={{ enabled: false }}
        selectable={{ enabled: false }}
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
