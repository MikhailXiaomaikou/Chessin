import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { bootstrapDeviation } from "@/chessin/deviation";
import { bootstrapEvents } from "@/chessin/events";
import EventsPage from "@/chessin/events/EventsPage";

// Chessin (S4-3): 赛事复盘 — the user's games by event. The route module is
// imported by the generated route tree at startup, so the deviation
// detection (onReviewSaved) and the palette commands are registered here.
bootstrapDeviation();
bootstrapEvents();

const searchSchema = z.object({
  /** Selected event group id (`year|site|event`), from the review panel badge or `events.open`. */
  event: z.string().optional(),
});

export const Route = createFileRoute("/events")({
  component: EventsPage,
  validateSearch: searchSchema,
});
