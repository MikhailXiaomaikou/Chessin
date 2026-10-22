import { type Color, type NormalMove, parseSquare, type SquareName } from "chessops";
import { useAtomValue } from "jotai";
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { keyMapAtom } from "@/state/keybinds";
import { positionFromFen } from "@/utils/chessops";
import { setBoardFocusHandler, subscribeAnnouncements } from "./announce";
import "./boardA11y.css";
import { registerA11yCommands } from "./commands";
import {
  type CursorContext,
  type CursorEffect,
  type CursorState,
  initialCursor,
  keyToInput,
  reduceCursor,
} from "./cursor";
import { langOf, pieceLabel, sanToSpeech, sideName, squareLabel } from "./speech";

registerA11yCommands();

/**
 * Screen-reader and keyboard layer of the main board (plan X-9).
 *
 * Rendered inside the board box, on top of chessground, with
 * `pointer-events: none`: the mouse still reaches chessground, and the layer
 * only reacts to keys while its grid has focus. It provides
 *  - an ARIA grid of 64 `gridcell`s labelled in the UI language
 *    ("e4，白马" / "e4, white knight");
 *  - a visually hidden `aria-live` region announcing every move of the tree
 *    store (forward: "马吃 e5，将军"; back: "回到 …") and the messages of the
 *    keyboard mode and of the `board.describe` command;
 *  - the keyboard focus mode: `F6` (key `BOARD_FOCUS`) or the `board.focus`
 *    command focus the grid, arrow keys move a square cursor drawn as a ring,
 *    `Enter` / `Space` pick up and drop (legality = the same `dests` chessground
 *    gets; the move goes through the board's own `makeMove`, so practice mode,
 *    clocks and engine games are unaffected), `Esc` puts the piece back or
 *    leaves the mode. Handled keys stop propagating so the global arrow-key
 *    hotkeys do not also step through the game.
 */
export type BoardA11yProps = {
  fen: string;
  orientation: Color;
  /** Exactly what chessground gets as `movable.dests`; `undefined` = no moves allowed. */
  dests: Map<SquareName, SquareName[]> | undefined;
  /** Exactly what chessground gets as `movable.color`. */
  movable: Color | "both" | undefined;
  autoPromote: boolean;
  onMove: (move: NormalMove) => void;
};

const FILES = [0, 1, 2, 3, 4, 5, 6, 7];

export default function BoardA11y({
  fen,
  orientation,
  dests,
  movable,
  autoPromote,
  onMove,
}: BoardA11yProps) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const store = useContext(TreeStateContext);
  const keyMap = useAtomValue(keyMapAtom);
  const gridRef = useRef<HTMLDivElement>(null);
  const gridId = useId();

  const [pos] = useMemo(() => positionFromFen(fen), [fen]);
  const [cursor, setCursor] = useState<CursorState>(() => initialCursor(orientation));
  const [active, setActive] = useState(false);
  const [live, setLive] = useState("");
  // Toggles a zero-width suffix so repeating the same text is announced again.
  const [tick, setTick] = useState(0);

  const say = useCallback((text: string) => {
    setLive(text);
    setTick((n) => n + 1);
  }, []);

  useEffect(() => subscribeAnnouncements(say), [say]);

  useEffect(() => {
    setBoardFocusHandler(() => gridRef.current?.focus());
    return () => setBoardFocusHandler(null);
  }, []);

  // Every change of the current node is spoken: the move played or stepped
  // to, "回到 …" when going back, "起始局面" at the root.
  useEffect(() => {
    if (!store) return;
    return store.subscribe((state, prev) => {
      const a = state.position;
      const b = prev.position;
      if (a === b || (a.length === b.length && a.every((v, i) => v === b[i]))) return;
      const node = state.currentNode();
      if (!node.san) {
        say(t("A11y.Announce.StartPosition"));
        return;
      }
      const speech = sanToSpeech(node.san, lang, t);
      say(a.length < b.length ? t("A11y.Announce.BackTo", { move: speech }) : speech);
    });
  }, [store, lang, t, say]);

  // F6 toggles the mode from anywhere, including text inputs (a function key).
  useHotkeys(
    keyMap.BOARD_FOCUS.keys,
    (e) => {
      e.preventDefault();
      const grid = gridRef.current;
      if (!grid) return;
      if (document.activeElement === grid) grid.blur();
      else grid.focus();
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  );

  const pieceAt = useCallback(
    (square: SquareName) => {
      const sq = parseSquare(square);
      return sq === undefined ? undefined : pos?.board.get(sq);
    },
    [pos],
  );

  const messageOf = (effect: Extract<CursorEffect, { type: "say" }>): string => {
    switch (effect.message) {
      case "cursor":
        return squareLabel(effect.square, pieceAt(effect.square), lang, t);
      case "pickedUp":
        return t("A11y.Announce.PickedUp", {
          square: effect.square,
          piece: pieceLabel(effect.piece, effect.color, lang, t),
          dests: effect.dests.join(lang === "zh" ? "、" : ", "),
        });
      case "noPiece":
        return t("A11y.Announce.NoPiece", { square: effect.square });
      case "illegal":
        return t("A11y.Announce.Illegal", { square: effect.square });
      case "cancelled":
        return t("A11y.Announce.Cancelled");
      case "locked":
        return t("A11y.Announce.Locked");
      case "promotion":
        return t("A11y.Announce.Promotion");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const input = keyToInput(e.key, cursor.phase);
    if (!input) return;
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    const ctx: CursorContext = {
      pos,
      dests: dests ?? null,
      movable,
      orientation,
      autoPromote,
    };
    const { state, effects } = reduceCursor(cursor, input, ctx);
    setCursor(state);
    for (const effect of effects) {
      switch (effect.type) {
        case "say":
          say(messageOf(effect));
          break;
        case "move":
          onMove(effect.move);
          break;
        case "exit":
          gridRef.current?.blur();
          break;
      }
    }
  };

  const onFocus = () => {
    setActive(true);
    say(
      `${t("A11y.Announce.FocusOn", { square: cursor.square })} ${squareLabel(
        cursor.square,
        pieceAt(cursor.square),
        lang,
        t,
      )}`,
    );
  };

  const onBlur = () => {
    setActive(false);
    setCursor((c) => (c.phase.kind === "idle" ? c : { square: c.square, phase: { kind: "idle" } }));
    say(t("A11y.Announce.FocusOff"));
  };

  const turn = pos?.turn ?? "white";
  const ranks = orientation === "white" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const files = orientation === "white" ? FILES : [...FILES].reverse();
  const picked = cursor.phase.kind === "picked" ? cursor.phase : null;
  const promotion = cursor.phase.kind === "promotion" ? cursor.phase : null;
  const cellId = (square: SquareName) => `${gridId}-${square}`;

  return (
    <>
      <div
        ref={gridRef}
        className="chessin-a11y-grid"
        data-chessin-board-grid
        data-active={active ? "true" : undefined}
        role="grid"
        tabIndex={0}
        aria-label={t("A11y.Grid.Label", {
          side: sideName(turn, t),
          key: keyMap.BOARD_FOCUS.keys.toUpperCase(),
        })}
        aria-rowcount={8}
        aria-colcount={8}
        aria-activedescendant={active ? cellId(cursor.square) : undefined}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {ranks.map((rank) => (
          <div key={rank} role="row" className="chessin-a11y-row" aria-rowindex={8 - rank}>
            {files.map((file) => {
              const square = `${"abcdefgh"[file]}${rank + 1}` as SquareName;
              const isCursor = active && cursor.square === square;
              return (
                <div
                  key={square}
                  id={cellId(square)}
                  role="gridcell"
                  className="chessin-a11y-cell"
                  aria-colindex={file + 1}
                  aria-label={squareLabel(square, pieceAt(square), lang, t)}
                  aria-selected={isCursor ? true : undefined}
                  data-cursor={isCursor ? "true" : undefined}
                  data-picked={
                    active && (picked?.from === square || promotion?.from === square)
                      ? "true"
                      : undefined
                  }
                  data-dest={active && picked?.dests.includes(square) ? "true" : undefined}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="chessin-a11y-live" aria-live="polite" aria-atomic="true" role="status">
        {live}
        {tick % 2 === 1 ? "​" : ""}
      </div>
    </>
  );
}
