/**
 * 先自己注释 (annotate first, W3-4; S4-6).
 *
 * - `layers.ts`: the 【我的思考】 / 【教练】 / 【引擎】 comment layers (parse,
 *   filter, get / set one layer inside a node comment).
 * - `mode.ts`: per-tab mode / revealed-moment atoms and the layer visibility.
 * - `AnnotateFirstPanel`: rendered by the review panel while the mode is on.
 * - Palette command `annotateFirst.toggle` registers on import; `R` (keymap
 *   `REVEAL`) reveals inside the panel.
 */
export { default as AnnotateFirstPanel } from "./AnnotateFirstPanel";
export { registerAnnotateFirstCommands, toggleAnnotateFirstForActiveTab } from "./commands";
export * from "./layers";
export * from "./mode";
