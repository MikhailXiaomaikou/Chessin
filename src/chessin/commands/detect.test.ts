import { expect, test } from "vitest";
import { detectIntent, looksLikeFen, looksLikeGameUrl, looksLikePgn } from "./detect";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

test("FEN detection validates with chessops and normalises", () => {
    expect(looksLikeFen(START)).toBe(START);
    expect(looksLikeFen(`  ${START}  `)).toBe(START);
    // board-only FEN is accepted and completed by chessops (no castling rights known)
    expect(looksLikeFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR")).toBe(
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1",
    );
    expect(looksLikeFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w - - 0 1")).toBeNull();
    expect(looksLikeFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNX w - - 0 1")).toBeNull();
    expect(looksLikeFen("copy pgn")).toBeNull();
    expect(looksLikeFen("")).toBeNull();
});

test("PGN detection needs a move number followed by a move or headers", () => {
    expect(looksLikePgn("1. e4 e5 2. Nf3 Nc6")).toBe(true);
    expect(looksLikePgn("1.e4 c5 2.Nf3")).toBe(true);
    expect(looksLikePgn("1... c5 2. Nf3")).toBe(true);
    expect(looksLikePgn('[Event "Casual game"]\n[Site "?"]\n\n*')).toBe(true);
    expect(looksLikePgn("1. 2. 3.")).toBe(false);
    expect(looksLikePgn("new tab")).toBe(false);
    expect(looksLikePgn("version 1.2")).toBe(false);
});

test("game URL detection covers lichess.org and chess.com", () => {
    expect(looksLikeGameUrl("https://lichess.org/abcdefgh")?.site).toBe("lichess");
    expect(looksLikeGameUrl("https://lichess.org/abcdefghIJKL/black")?.site).toBe("lichess");
    expect(looksLikeGameUrl("lichess.org/game/export/abcdefgh")?.site).toBe("lichess");
    expect(looksLikeGameUrl("https://lichess.org/")).toBeNull();
    expect(looksLikeGameUrl("https://lichess.org/@/DrNykterstein")).toBeNull();
    expect(looksLikeGameUrl("https://www.chess.com/game/live/123456789")?.site).toBe("chesscom");
    expect(looksLikeGameUrl("https://www.chess.com/game/daily/123456789")?.site).toBe("chesscom");
    expect(looksLikeGameUrl("https://www.chess.com/analysis/game/live/123456789")?.site).toBe(
        "chesscom",
    );
    expect(looksLikeGameUrl("https://www.chess.com/member/hikaru")).toBeNull();
    expect(looksLikeGameUrl("https://example.com/abcdefgh")).toBeNull();
    expect(looksLikeGameUrl("not a url")).toBeNull();
});

test("detectIntent routes prefixes, pastes and plain searches", () => {
    expect(detectIntent("> copy")).toEqual({ kind: "commands", query: "copy" });
    expect(detectIntent(">")).toEqual({ kind: "commands", query: "" });
    expect(detectIntent(":23")).toEqual({ kind: "goToMove", move: 23 });
    expect(detectIntent(START)).toEqual({ kind: "fen", fen: START });
    expect(detectIntent("1. e4 e5 2. Nf3").kind).toBe("pgn");
    expect(detectIntent("https://lichess.org/abcdefgh").kind).toBe("gameUrl");
    expect(detectIntent("mlmb")).toEqual({ kind: "search", query: "mlmb" });
    expect(detectIntent("")).toEqual({ kind: "search", query: "" });
});
