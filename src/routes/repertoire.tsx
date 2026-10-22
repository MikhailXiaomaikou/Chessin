import { createFileRoute } from "@tanstack/react-router";
import RepertoirePage from "@/chessin/shell/RepertoirePage";

// Chessin (S3-6): 开局体系 — the repertoire files of the document folder.
export const Route = createFileRoute("/repertoire")({
  component: RepertoirePage,
  loader: ({ context: { loadDirs } }) => loadDirs(),
});
