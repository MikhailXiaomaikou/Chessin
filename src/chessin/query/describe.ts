import { type Chip, rangeOf, resultLabelKey } from "./parse";

/**
 * `describeChips`: the natural-language preview under the bar
 * ("白方 Carlsen，等级分高于 2600，2020–2024 年，白胜") and the default name
 * of a saved smart collection. `suggestRemoval`: which chip to drop first when
 * the query matches nothing.
 */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

// Keys are assembled below; listed here for the extractor (removeUnusedKeys):
// t("Query.Describe.player") t("Query.Describe.white") t("Query.Describe.black")
// t("Query.Describe.elo") t("Query.Describe.elo.Above") t("Query.Describe.elo.Below")
// t("Query.Describe.elo.Range") t("Query.Describe.year") t("Query.Describe.year.Above")
// t("Query.Describe.year.Below") t("Query.Describe.year.Range") t("Query.Describe.eco")
// t("Query.Describe.event") t("Query.Describe.tc") t("Query.Describe.Empty")
// t("Query.Describe.Separator")

export function describeChip(chip: Chip, t: Translate): string {
    switch (chip.key) {
        case "text":
            return t("Query.Describe.player", { value: chip.value });
        case "result":
            return t(resultLabelKey(chip.value));
        case "elo":
        case "year": {
            const base = `Query.Describe.${chip.key}`;
            switch (chip.op) {
                case ">":
                    return t(`${base}.Above`, { value: chip.value });
                case "<":
                    return t(`${base}.Below`, { value: chip.value });
                case "..": {
                    const r = rangeOf(chip) ?? [chip.value, chip.value];
                    return t(`${base}.Range`, { lo: r[0], hi: r[1] });
                }
                default:
                    return t(base, { value: chip.value });
            }
        }
        default:
            return t(`Query.Describe.${chip.key}`, { value: chip.value });
    }
}

export function describeChips(chips: Chip[], t: Translate): string {
    if (chips.length === 0) return t("Query.Describe.Empty");
    return chips.map((chip) => describeChip(chip, t)).join(t("Query.Describe.Separator"));
}

/**
 * How much a chip narrows the result set (higher = more selective). Names
 * beat everything; an exact number beats a range beats a one-sided bound; a
 * result only splits the set in three. Unsupported keys are never applied, so
 * removing them changes nothing: 0.
 */
export function selectivity(chip: Chip): number {
    switch (chip.key) {
        case "white":
        case "black":
            return 100;
        case "player":
        case "text":
            return 90;
        case "elo":
            return chip.op === ":" ? 80 : chip.op === ".." ? 60 : 40;
        case "year":
            return chip.op === ":" ? 70 : chip.op === ".." ? 50 : 30;
        case "result":
            return 20;
        default:
            return 0;
    }
}

/**
 * The chip to remove first when there are zero results: an unresolved player
 * name (nobody matched it) before the most selective applied chip. `null`
 * when no chip is applied.
 */
export function suggestRemoval(chips: Chip[], unresolved: Chip[] = []): Chip | null {
    const missing = chips.find((chip) => unresolved.includes(chip));
    if (missing) return missing;
    let best: Chip | null = null;
    let bestScore = 0;
    for (const chip of chips) {
        const score = selectivity(chip);
        if (score > bestScore) {
            best = chip;
            bestScore = score;
        }
    }
    return best;
}
