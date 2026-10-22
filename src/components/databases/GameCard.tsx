import {
  ActionIcon,
  Button,
  Divider,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Tooltip,
} from "@mantine/core";
import { IconTrash, IconZoomCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import { commands, type NormalizedGame } from "@/bindings";
import { useOpenInWorkspace } from "@/chessin/workspace/openInWorkspace";
import GamePreview from "./GamePreview";
import GameInfo from "../common/GameInfo";

function GameCard({
  game,
  file,
  mutate,
}: {
  game: NormalizedGame;
  file: string;
  mutate: () => void;
}) {
  const { t } = useTranslation();
  const openInWorkspace = useOpenInWorkspace();
  const { mutate: globalMutate } = useSWRConfig();

  return (
    <Paper shadow="sm" p="sm" withBorder h="100%">
      <ScrollArea h="100%">
        <Stack h="100%" gap="xs">
          <GameInfo key={game.id} headers={game} />
          <Group justify="space-between" gap="xs" px="xs" pb="xs">
            <Button
              variant="light"
              size="xs"
              leftSection={<IconZoomCheck size="1rem" stroke={1.5} />}
              onClick={() => {
                openInWorkspace({
                  tab: {
                    name: `${game.white} - ${game.black}`,
                    type: "analysis",
                  },
                  pgn: game.moves,
                  headers: game,
                  gameOrigin: {
                    kind: "database",
                    database: file,
                    gameId: game.id,
                  },
                });
              }}
            >
              {t("Board.Action.AnalyzeGame")}
            </Button>

            <Tooltip label={t("Databases.Game.Delete")}>
              <ActionIcon
                variant="subtle"
                color="red"
                onClick={() => {
                  commands.deleteDbGame(file, game.id).then(() => {
                    mutate();
                    globalMutate(
                      (key) =>
                        Array.isArray(key) && (key[0] === "players" || key[0] === "tournaments"),
                      undefined,
                      { revalidate: true },
                    );
                  });
                }}
              >
                <IconTrash size="1.2rem" stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <Divider />
          <GamePreview
            key={`preview-${game.id}`}
            pgn={game.moves}
            headers={game}
            showOpening
            startAtEnd
          />
        </Stack>
      </ScrollArea>
    </Paper>
  );
}

export default GameCard;
