/**
 * Spaced repetition for repertoire positions, after SM-2: a move answered
 * right comes back after 1 day, then 3, then ever longer (interval × ease);
 * a mistake brings it back at once and makes it come back sooner from then on.
 */

export interface CardState {
  /** Correct answers in a row since the last mistake (0 while learning). */
  reps: number
  lapses: number
  /** Interval growth factor, 1.3–2.5. */
  ease: number
  /** Days until the next review. */
  interval: number
  /** When the card is next due (ms since epoch). */
  due: number
}

export const DAY_MS = 86_400_000
const START_EASE = 2.5
const MIN_EASE = 1.3
const MAX_INTERVAL = 365

/** A card just shown to the learner: it is asked again in the same session. */
export function learningCard(now: number): CardState {
  return { reps: 0, lapses: 0, ease: START_EASE, interval: 0, due: now }
}

/** The card after an answer. */
export function review(card: CardState, correct: boolean, now: number): CardState {
  if (!correct) {
    return {
      reps: 0,
      lapses: card.lapses + 1,
      ease: Math.max(MIN_EASE, card.ease - 0.2),
      interval: 0,
      due: now
    }
  }
  const reps = card.reps + 1
  const interval =
    reps === 1 ? 1 : reps === 2 ? 3 : Math.min(MAX_INTERVAL, Math.round(card.interval * card.ease))
  return { ...card, reps, interval, due: now + interval * DAY_MS }
}

export function isDue(card: CardState, now: number): boolean {
  return card.due <= now
}
