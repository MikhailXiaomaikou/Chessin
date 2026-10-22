import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Drawer,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconBookmark, IconBookmarkPlus, IconRefresh, IconRestore } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import MiniBoard from "@/chessin/board/MiniBoard";
import { createCheckpoint, getDoc, listDocVersions } from "@/chessin/store/libraryStore";
import { flushDocWrites } from "@/chessin/store/treePersist";
import { closeHistoryDrawer, historyDrawerAtom } from "./drawerAtom";
import { restoreVersionAndReload, undoReload } from "./reload";
import {
  formatVersionTime,
  getCachedVersionData,
  loadVersionData,
  mapVersions,
  previewFromData,
  rememberVersionData,
  type VersionRow,
} from "./versions";

export const HISTORY_DRAWER_WIDTH = 440;
const PREVIEW_SIZE = 168;

/**
 * "历史版本" drawer for the active library document: the version list
 * (time, label, 当前), a preview of the hovered / selected version (final
 * main-line position + move count, when its payload is known — see
 * `versions.ts`), "恢复到此版本" and "命名检查点".
 */
export default function HistoryDrawer() {
  const { t } = useTranslation();
  const [state] = useAtom(historyDrawerAtom);
  return (
    <Drawer
      opened={state.open}
      onClose={() => closeHistoryDrawer()}
      position="right"
      size={HISTORY_DRAWER_WIDTH}
      title={t("History.Title")}
      padding="md"
      data-testid="history-drawer"
    >
      {state.open && state.tabId && <HistoryBody tabId={state.tabId} />}
    </Drawer>
  );
}

function versionName(row: VersionRow, fallback: string): string {
  return row.label ?? fallback;
}

/** The document's versions as drawer rows; seeds the newest one's payload for previews. */
async function loadVersions(tabId: string): Promise<VersionRow[]> {
  // A pending autosave would otherwise show up as a version a moment later.
  await flushDocWrites();
  const [doc, list] = await Promise.all([getDoc(tabId), listDocVersions(tabId)]);
  const mapped = mapVersions(list, doc?.data ?? null, (id) => getCachedVersionData(tabId, id));
  if (mapped[0] && doc?.data) rememberVersionData(tabId, mapped[0].id, doc.data);
  return mapped;
}

function HistoryBody({ tabId }: { tabId: string }) {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [busy, setBusy] = useState<"restore" | "checkpoint" | null>(null);
  const [label, setLabel] = useState("");

  // Bumped to reload the list (after a checkpoint, a restore or the refresh button).
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let cancelled = false;
    loadVersions(tabId).then(
      (mapped) => {
        if (cancelled) return;
        setRows(mapped);
        setError(null);
      },
      (e: unknown) => {
        if (cancelled) return;
        setError(String(e));
        setRows([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tabId, reloadKey]);

  const previewRow = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    const wanted = hoverId ?? selectedId;
    return rows.find((row) => row.id === wanted) ?? rows[0];
  }, [rows, hoverId, selectedId]);

  // Payloads not known yet are asked from the plugin (a no-op until the
  // `doc_version_get` command exists; see `loadVersionData`).
  const previewId = previewRow?.id ?? null;
  const previewKnown = previewRow?.data !== null;
  useEffect(() => {
    if (previewId === null || previewKnown) return;
    let cancelled = false;
    void loadVersionData(tabId, previewId).then((data) => {
      if (cancelled || data === null) return;
      setRows(
        (prev) => prev?.map((row) => (row.id === previewId ? { ...row, data } : row)) ?? prev,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [tabId, previewId, previewKnown]);

  const preview = useMemo(() => previewFromData(previewRow?.data), [previewRow?.data]);

  const restore = async (row: VersionRow) => {
    if (busy || row.current) return;
    setBusy("restore");
    try {
      const outcome = await restoreVersionAndReload(tabId, row.id, {
        beforeLabel: t("History.BeforeRestore"),
      });
      if (!outcome.ok) {
        notifications.show({
          id: "chessin-history",
          color: "red",
          title: t("Common.Error"),
          message: t("History.RestoreFailed", { error: outcome.reason }),
        });
        return;
      }
      const name = `${versionName(row, t("History.AutoLabel"))} · ${formatVersionTime(
        row.createdAt,
        i18n.language,
      )}`;
      notifications.show({
        id: "chessin-history",
        autoClose: 8000,
        message: (
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Text size="sm">{t("History.Restored", { label: name })}</Text>
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => {
                notifications.hide("chessin-history");
                undoReload(tabId);
                refresh();
              }}
            >
              {t("History.UndoRestore")}
            </Button>
          </Group>
        ),
      });
      refresh();
    } catch (e) {
      notifications.show({
        id: "chessin-history",
        color: "red",
        title: t("Common.Error"),
        message: t("History.RestoreFailed", { error: String(e) }),
      });
    } finally {
      setBusy(null);
    }
  };

  const checkpoint = async () => {
    if (busy) return;
    setBusy("checkpoint");
    try {
      const result = await createCheckpoint(tabId, label.trim() || undefined);
      if (!result) {
        notifications.show({
          id: "chessin-history",
          color: "gray",
          message: t("Workspace.Checkpoint.NoDocument"),
          autoClose: 3000,
        });
        return;
      }
      setLabel("");
      notifications.show({
        id: "chessin-history",
        message: t("History.Checkpoint.Created", { label: result.label }),
        autoClose: 2500,
      });
      refresh();
    } catch (e) {
      notifications.show({
        id: "chessin-history",
        color: "red",
        title: t("Common.Error"),
        message: t("Save.Failed", { error: String(e) }),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap="sm" h="100%" style={{ minHeight: 0 }}>
      <Group gap="xs" wrap="nowrap">
        <TextInput
          size="xs"
          flex={1}
          placeholder={t("History.Checkpoint.Placeholder")}
          aria-label={t("History.Checkpoint")}
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void checkpoint();
            }
          }}
        />
        <Button
          size="xs"
          variant="default"
          leftSection={<IconBookmarkPlus size="1rem" />}
          loading={busy === "checkpoint"}
          disabled={busy !== null && busy !== "checkpoint"}
          onClick={() => void checkpoint()}
        >
          {t("History.Checkpoint")}
        </Button>
        <Tooltip label={t("History.Refresh")}>
          <ActionIcon variant="subtle" aria-label={t("History.Refresh")} onClick={refresh}>
            <IconRefresh size="1rem" />
          </ActionIcon>
        </Tooltip>
      </Group>

      {previewRow && (
        <Card withBorder p="sm" data-testid="history-preview">
          <Group align="flex-start" wrap="nowrap" gap="sm">
            {preview ? (
              <MiniBoard
                fen={preview.fen}
                lastMove={preview.lastMove}
                size={PREVIEW_SIZE}
                coordinates={false}
              />
            ) : (
              <Box
                w={PREVIEW_SIZE}
                h={PREVIEW_SIZE}
                p="xs"
                style={{
                  flex: "0 0 auto",
                  borderRadius: "var(--mantine-radius-sm)",
                  background: "var(--mantine-color-default-hover)",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <Text size="xs" c="dimmed" ta="center">
                  {t("History.Preview.Unavailable")}
                </Text>
              </Box>
            )}
            <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
              <Group gap={6} wrap="nowrap">
                <Text fw={600} size="sm" truncate>
                  {versionName(previewRow, t("History.AutoLabel"))}
                </Text>
                {previewRow.current && (
                  <Badge size="xs" variant="light">
                    {t("History.Current")}
                  </Badge>
                )}
              </Group>
              <Text size="xs" c="dimmed">
                {formatVersionTime(previewRow.createdAt, i18n.language)}
              </Text>
              {preview && preview.title && (
                <Text size="xs" truncate>
                  {preview.title}
                </Text>
              )}
              {preview && (
                <Text size="xs" c="dimmed">
                  {preview.plies === 0
                    ? t("History.Preview.Empty")
                    : t("History.Moves", { count: preview.plies })}
                  {" · "}
                  {preview.result}
                </Text>
              )}
              <Button
                size="xs"
                variant="light"
                mt={4}
                leftSection={<IconRestore size="1rem" />}
                disabled={previewRow.current || busy !== null}
                loading={busy === "restore"}
                onClick={() => void restore(previewRow)}
              >
                {t("History.Restore")}
              </Button>
            </Stack>
          </Group>
        </Card>
      )}

      {error && (
        <Text size="xs" c="red">
          {t("History.Load.Failed", { error })}
        </Text>
      )}

      <ScrollArea style={{ flex: 1, minHeight: 0 }} onMouseLeave={() => setHoverId(null)}>
        {rows === null ? (
          <Group gap="xs" py="md" justify="center">
            <Loader size="xs" />
            <Text size="xs" c="dimmed">
              {t("History.Loading")}
            </Text>
          </Group>
        ) : rows.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="md">
            {t("History.Empty")}
          </Text>
        ) : (
          <Stack gap={2}>
            {rows.map((row) => {
              const active = row.id === (selectedId ?? rows[0].id);
              return (
                <UnstyledButton
                  key={row.id}
                  onClick={() => setSelectedId(row.id)}
                  onMouseEnter={() => setHoverId(row.id)}
                  data-version-id={row.id}
                  data-active={active || undefined}
                  px="xs"
                  py={6}
                  style={{
                    borderRadius: "var(--mantine-radius-sm)",
                    background: active ? "var(--mantine-color-default-hover)" : undefined,
                  }}
                >
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <div style={{ minWidth: 0 }}>
                      <Text size="sm" fw={row.label ? 600 : 400} truncate>
                        {versionName(row, t("History.AutoLabel"))}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {formatVersionTime(row.createdAt, i18n.language)}
                      </Text>
                    </div>
                    <Group gap={4} wrap="nowrap">
                      {row.current && (
                        <Badge size="xs" variant="light">
                          {t("History.Current")}
                        </Badge>
                      )}
                      {row.label && <IconBookmark size="0.9rem" opacity={0.6} />}
                    </Group>
                  </Group>
                </UnstyledButton>
              );
            })}
          </Stack>
        )}
      </ScrollArea>

      <Text size="xs" c="dimmed">
        {t("History.Hint")}
      </Text>
    </Stack>
  );
}
