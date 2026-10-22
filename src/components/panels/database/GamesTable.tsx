import { Text } from "@mantine/core";
import { DataTable } from "mantine-datatable";
import { memo, useEffect, useState } from "react";
import type { NormalizedGame } from "@/bindings";
import { useOpenInWorkspace } from "@/chessin/workspace/openInWorkspace";

function GamesTable({
  games,
  loading,
  databasePath,
}: {
  games: NormalizedGame[];
  loading: boolean;
  databasePath?: string | null;
}) {
  const openInWorkspace = useOpenInWorkspace();
  const [page, setPage] = useState(1);
  const filteredGames = games.slice((page - 1) * 20, page * 20);

  useEffect(() => {
    setPage(1);
  }, [games]);

  return (
    <DataTable
      withTableBorder
      highlightOnHover
      records={filteredGames}
      fetching={loading}
      totalRecords={games.length}
      recordsPerPage={20}
      page={page}
      onPageChange={setPage}
      onRowClick={(e) => {
        const game = e.record;
        openInWorkspace({
          tab: {
            name: `${game.white} - ${game.black}`,
            type: "analysis",
          },
          pgn: game.moves,
          headers: game,
          gameOrigin: databasePath
            ? {
                kind: "database",
                database: databasePath,
                gameId: game.id,
              }
            : undefined,
        });
      }}
      columns={[
        {
          accessor: "white",
          render: ({ white, white_elo }) => (
            <div>
              <Text size="sm" fw={500}>
                {white}
              </Text>
              <Text size="xs" c="dimmed">
                {white_elo === 0 ? "Unrated" : white_elo}
              </Text>
            </div>
          ),
        },
        {
          accessor: "black",
          render: ({ black, black_elo }) => (
            <div>
              <Text size="sm" fw={500}>
                {black}
              </Text>
              <Text size="xs" c="dimmed">
                {black_elo === 0 ? "Unrated" : black_elo}
              </Text>
            </div>
          ),
        },
        { accessor: "date" },
        { accessor: "result" },
        { accessor: "ply_count" },
      ]}
      noRecordsText="No games found"
    />
  );
}

export default memo(GamesTable);
