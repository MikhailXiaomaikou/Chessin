import { Accordion, Badge, Group, Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import { parseUci } from "chessops";
import { useAtomValue } from "jotai";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import { match, P } from "ts-pattern";
import { useStore } from "zustand";
import { probeTablebase, tablebaseDirAtom } from "@/chessin/book/tablebase";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { getTablebaseInfo, type TablebaseCategory } from "@/utils/lichess/api";
import classes from "./TablebaseInfo.module.css";

function TablebaseInfo({ fen, turn }: { fen: string; turn: "white" | "black" }) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const makeMove = useStore(store, (s) => s.makeMove);
  // S4-4: local Syzygy tables first when a directory is set (only them when offline), else Lichess.
  const tablebaseDir = useAtomValue(tablebaseDirAtom);
  const offline = useAtomValue(offlineModeAtom);
  const { data, error, isLoading } = useSWRImmutable(
    ["tablebase", fen, tablebaseDir, offline],
    async ([, fen, dir, offline]) =>
      await probeTablebase(fen, { dir, offline, remote: getTablebaseInfo }),
  );

  const sortedMoves = data?.moves.sort((a, b) => {
    if (a.category === "win" && b.category !== "win") {
      return 1;
    }
    if (a.category !== "win" && b.category === "win") {
      return -1;
    }
    if (a.category === "loss" && b.category !== "loss") {
      return -1;
    }
    if (a.category !== "loss" && b.category === "loss") {
      return 1;
    }
    return 0;
  });

  return (
    <Paper withBorder>
      <Accordion
        styles={{
          label: {
            padding: "0.5rem",
          },
        }}
      >
        <Accordion.Item value="tablebase">
          <Accordion.Control>
            <Group>
              <Text fw="bold">{t("Board.Analysis.Tablebase")}</Text>
              {data?.local && (
                <Badge size="xs" variant="light">
                  {t("Tablebase.Local")}
                </Badge>
              )}
              {isLoading && (
                <Group p="xs">
                  <Badge variant="transparent">{t("Common.Loading")}</Badge>
                </Group>
              )}
              {error && (
                <Text>
                  {t("Common.Error")}: {String(error)}
                </Text>
              )}
              {data && <OutcomeBadge category={data.category} turn={turn} wins />}
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            {data && (
              <Stack gap="xs">
                <SimpleGrid cols={3}>
                  {sortedMoves!.map((m) => (
                    <Paper
                      withBorder
                      key={m.san}
                      px="xs"
                      onClick={() => {
                        makeMove({ payload: parseUci(m.uci)! });
                      }}
                      className={classes.info}
                    >
                      <Group gap="xs" justify="space-between" wrap="nowrap">
                        <Text fz="0.9rem" fw={600} ta="center">
                          {m.san}
                        </Text>
                        <OutcomeBadge
                          category={m.category}
                          dtz={Math.abs(m.dtz)}
                          dtm={m.dtm}
                          turn={turn === "white" ? "black" : "white"}
                        />
                      </Group>
                    </Paper>
                  ))}
                </SimpleGrid>
              </Stack>
            )}
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Paper>
  );
}

function OutcomeBadge({
  category,
  turn,
  wins,
  dtz,
  dtm,
}: {
  category: TablebaseCategory;
  turn: "white" | "black";
  wins?: boolean;
  dtz?: number;
  dtm?: number;
}) {
  const { t } = useTranslation();
  const normalizedCategory = match(category)
    .with("win", () =>
      turn === "white"
        ? t("Board.Analysis.Tablebase.WhiteWins")
        : t("Board.Analysis.Tablebase.BlackWins"),
    )
    .with("loss", () =>
      turn === "white"
        ? t("Board.Analysis.Tablebase.BlackWins")
        : t("Board.Analysis.Tablebase.WhiteWins"),
    )
    .with(P.union("draw", "blessed-loss", "cursed-win"), () => t("Board.Analysis.Tablebase.Draw"))
    .with(P.union("unknown", "maybe-win", "maybe-loss"), () => t("Common.Unknown"))
    .exhaustive();

  const color = match(category)
    .with("win", () => (turn === "white" ? "white" : "black"))
    .with("loss", () => (turn === "white" ? "black" : "white"))
    .otherwise(() => "gray");

  const label = wins
    ? normalizedCategory
    : match(category)
        .with("draw", () => t("Board.Analysis.Tablebase.Draw"))
        .with("unknown", () => t("Common.Unknown"))
        .otherwise(() => (dtm ? `DTM ${Math.abs(dtm)}` : `DTZ ${dtz}`));

  return (
    <Group p="xs">
      <Badge autoContrast color={color}>
        {label}
      </Badge>
      {["blessed-loss", "cursed-win", "maybe-win", "maybe-loss"].includes(category) && wins && (
        <Text c="dimmed" fz="xs">
          {t("Board.Analysis.Tablebase.FiftyMoveRule")}
        </Text>
      )}
    </Group>
  );
}

export default TablebaseInfo;
