/**
 * Guess-the-move for any game (S4-6).
 *
 * - `createGuessSession` / `answerGuess` / `revealCurrent` / `nextTarget`:
 *   pure session stepping over the main line (`session.ts`).
 * - `gradeGuess` / `acceptedMoves`: the 3 / 2 / 1 / 0 scoring (`scoring.ts`).
 * - `GuessPanel`: rendered by the review panel while a session runs;
 *   `ReviewModeButtons`: the 猜着 / 先自己注释 header buttons.
 * - Palette commands `guess.start`, `guess.reveal`, `guess.stop` register on import.
 */
export { getGuessSession, guessSessionFamily, setGuessSession } from "./atoms";
export {
    advanceGuess,
    guessSummaryText,
    inferGuessColor,
    registerGuessCommands,
    revealGuess,
    type StartGuessOptions,
    startGuess,
    startGuessForActiveTab,
    startPlyFor,
    stopGuess,
} from "./commands";
export { default as GuessPanel } from "./GuessPanel";
export { default as ReviewModeButtons } from "./ModeButtons";
export * from "./scoring";
export * from "./session";
