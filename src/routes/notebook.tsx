import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { bootstrapNotebook } from "@/chessin/notebook";
import NotebookPage from "@/chessin/notebook/NotebookPage";

// The route module is imported by the generated route tree at startup, so the
// notebook's palette commands and review listener are registered here.
bootstrapNotebook();

const searchSchema = z.object({
  /** Start a review session right away (Today card, `notebook.review`). */
  review: z.boolean().optional(),
});

export const Route = createFileRoute("/notebook")({
  component: NotebookPage,
  validateSearch: searchSchema,
});
