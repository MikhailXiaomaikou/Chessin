import { Alert, Group, Progress, Stack, Text } from "@mantine/core";
import { useAtomValue } from "jotai";
import { DataTable } from "mantine-datatable";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { useStore } from "zustand";
import { type BookMove, commands } from "@/chessin/bindings";
import { SourceChip } from "@/chessin/sources/SourceChip";
import type { BookSource } from "@/chessin/sources/sources";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { moveNotationTypeAtom } from "@/state/atoms";
import { addPieceSymbol } from "@/utils/annotation";
import { formatNumber } from "@/utils/format";
import { registerBookCommands } from "./commands";

// The explorer is part of the board's module graph, so the palette gets the
// book commands as soon as a board can show them.
registerBookCommands();

export async function fetchBookMoves(path: string, fen: string): Promise<BookMove[]> {
  const r = await commands.bookLookup(path, fen);
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

/** Share of a move: its weight over the position's total, in percent. */
export function sharePercent(weight: number, total: number): number {
  return total > 0 ? (weight / total) * 100 : 0;
}

/**
 * The explorer panel of a `book` source (S4-4): the Polyglot book's moves
 * for the current position with their share, raw weight and learn value.
 * A click plays the move.
 */
export function BookExplorer({
  tabId,
  source,
  fen,
}: {
  tabId: string;
  source: BookSource;
  fen: string;
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const makeMove = useStore(store, (s) => s.makeMove);
  const moveNotationType = useAtomValue(moveNotationTypeAtom);

  const { data: info } = useSWR(["book-info", source.path], ([, path]) => commands.bookInfo(path), {
    revalidateOnFocus: false,
  });
  const isCtg = info?.status === "ok" && info.data.format === "ctg";
  const { data, error, isLoading } = useSWR(
    isCtg ? null : ["book", source.path, fen],
    ([, path, fen]) => fetchBookMoves(path, fen),
    { revalidateOnFocus: false },
  );
  const moves = data ?? [];
  const total = moves.reduce((acc, m) => acc + m.weight, 0);
  const showLearn = moves.some((m) => m.learn !== 0);

  let body: React.ReactNode;
  if (isCtg) {
    body = (
      <Text c="dimmed" fz="sm">
        {t("Book.CtgUnsupported")}
      </Text>
    );
  } else if (error) {
    body = <Alert color="red">{t("Book.Error", { error: String(error) })}</Alert>;
  } else {
    body = (
      <DataTable
        withTableBorder
        highlightOnHover
        records={moves}
        fetching={isLoading}
        idAccessor="uci"
        emptyState={<Text c="dimmed">{t("Book.Empty")}</Text>}
        onRowClick={({ record }) => makeMove({ payload: record.san })}
        columns={[
          {
            accessor: "san",
            title: t("Book.Move"),
            width: 100,
            render: ({ san }) => (
              <Text fz="sm">{moveNotationType === "symbols" ? addPieceSymbol(san) : san}</Text>
            ),
          },
          {
            accessor: "share",
            title: t("Book.Share"),
            render: ({ weight }) => {
              const percent = sharePercent(weight, total);
              return (
                <Group gap="xs" wrap="nowrap">
                  <Text fz="sm" w={44} ta="right">
                    {percent.toFixed(0)}%
                  </Text>
                  <Progress value={percent} size="md" flex={1} />
                </Group>
              );
            },
          },
          {
            accessor: "weight",
            title: t("Book.Weight"),
            width: 90,
            textAlign: "right",
            render: ({ weight }) => <Text fz="sm">{formatNumber(weight)}</Text>,
          },
          {
            accessor: "learn",
            title: t("Book.Learn"),
            width: 90,
            textAlign: "right",
            hidden: !showLearn,
            render: ({ learn }) => (
              <Text fz="sm" c="dimmed">
                {formatNumber(learn)}
              </Text>
            ),
          },
        ]}
      />
    );
  }

  return (
    <Stack h="100%" gap="xs" py="xs" px="sm" style={{ overflow: "hidden" }}>
      <Group justify="space-between" wrap="nowrap">
        <SourceChip tabId={tabId} />
        {data && (
          <Text fz="sm" style={{ whiteSpace: "nowrap" }}>
            {t("Book.Moves", { count: data.length })}
          </Text>
        )}
      </Group>
      <Text c="dimmed" fz="xs">
        {t("Book.FromBook", { title: source.title })}
        {info?.status === "ok" &&
          info.data.entries !== null &&
          ` · ${t("Book.Entries", { count: Number(info.data.entries) })}`}
      </Text>
      {body}
    </Stack>
  );
}

export default BookExplorer;
