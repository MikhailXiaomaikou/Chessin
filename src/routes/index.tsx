import { createFileRoute } from "@tanstack/react-router";
import { withWorkspaceGate } from "@/chessin/store/WorkspaceGate";
import BoardsPage from "@/components/tabs/BoardsPage";

export const Route = createFileRoute("/")({
  component: withWorkspaceGate(BoardsPage),
  loader: ({ context: { loadDirs } }) => loadDirs(),
});
