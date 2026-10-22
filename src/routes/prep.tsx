import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { bootstrapPrep } from "@/chessin/prep";
import PrepPage from "@/chessin/prep/PrepPage";

// Chessin (S4-2): 备战 — opponent briefing and prep pack. The route module is
// imported by the generated route tree at startup, so the palette command and
// the post-game assessment listener are registered here.
bootstrapPrep();

const searchSchema = z.object({
  /** Search right away (`prep.open` with a name). */
  q: z.string().optional(),
});

export const Route = createFileRoute("/prep")({
  component: PrepPage,
  validateSearch: searchSchema,
  loader: ({ context: { loadDirs } }) => loadDirs(),
});
