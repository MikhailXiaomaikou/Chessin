import { Button, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconBooks, IconDeviceFloppy } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { StoreApi } from "zustand";
import type { TreeStoreState } from "@/state/store/tree";
import { type Tab, saveToFile } from "@/utils/tabs";
import { copyTabToLibrary } from "./copyToLibrary";
import { describeSource } from "./saveModel";

export type SaveChoice = "source" | "library";

/**
 * Save dialog for tabs whose game comes from a read-only source (an external
 * PGN file or a .db3 game). Chessin never writes such sources on its own, so
 * Ctrl/Cmd+S asks: write back to the source (explicit, overwrites that game)
 * or copy the document into the Chessin library (autosaved, versioned, source
 * untouched).
 */
export function SaveDialog({
  opened,
  onClose,
  tab,
  store,
  setTab,
  documentDir,
  onDone,
}: {
  opened: boolean;
  onClose: () => void;
  tab: Tab | undefined;
  store: StoreApi<TreeStoreState>;
  setTab: React.Dispatch<React.SetStateAction<Tab>>;
  documentDir: string;
  /** Called after a successful save with the choice that was taken. */
  onDone?: (choice: SaveChoice) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<SaveChoice | null>(null);
  const source = describeSource(tab);

  const run = async (choice: SaveChoice) => {
    if (!tab || busy) return;
    setBusy(choice);
    try {
      if (choice === "source") {
        const written = await saveToFile({
          dir: documentDir,
          tab,
          setCurrentTab: setTab,
          store,
          isUserSave: true,
        });
        if (!written) return;
        notifications.show({
          id: "chessin-save",
          message: t("Save.SavedToSource"),
          autoClose: 2500,
        });
      } else {
        await copyTabToLibrary({ tab, store, setTab });
        notifications.show({
          id: "chessin-save",
          message: t("Save.CopiedToLibrary"),
          autoClose: 4000,
        });
      }
      onDone?.(choice);
      onClose();
    } catch (error) {
      notifications.show({
        id: "chessin-save",
        color: "red",
        title: t("Common.Error"),
        message: t("Save.Failed", { error: String(error) }),
      });
    } finally {
      setBusy(null);
    }
  };

  const sourceLine =
    source?.kind === "database"
      ? t("Save.Source.Database", { name: source.name, id: source.gameId })
      : source?.kind === "file"
        ? t("Save.Source.File", { name: source.name, number: source.gameNumber + 1 })
        : null;

  return (
    <Modal opened={opened} onClose={onClose} title={t("Save.Title")} centered size="sm">
      <Stack gap="sm">
        {sourceLine && (
          <Text size="sm" c="dimmed" title={source?.path}>
            {sourceLine}
          </Text>
        )}
        <Button
          variant="light"
          fullWidth
          h="auto"
          py="sm"
          justify="flex-start"
          leftSection={<IconBooks size="1.2rem" />}
          loading={busy === "library"}
          disabled={busy !== null && busy !== "library"}
          onClick={() => run("library")}
          styles={{ label: { whiteSpace: "normal", textAlign: "left" } }}
        >
          <div>
            <Text fw={600} size="sm">
              {t("Save.CopyToLibrary")}
            </Text>
            <Text size="xs" c="dimmed">
              {t("Save.CopyToLibrary.Desc")}
            </Text>
          </div>
        </Button>
        <Button
          variant="default"
          fullWidth
          h="auto"
          py="sm"
          justify="flex-start"
          leftSection={<IconDeviceFloppy size="1.2rem" />}
          loading={busy === "source"}
          disabled={busy !== null && busy !== "source"}
          onClick={() => run("source")}
          styles={{ label: { whiteSpace: "normal", textAlign: "left" } }}
        >
          <div>
            <Text fw={600} size="sm">
              {source?.kind === "database" ? t("Save.ToSource.Database") : t("Save.ToSource")}
            </Text>
            <Text size="xs" c="dimmed">
              {source?.kind === "database"
                ? t("Save.ToSource.Database.Desc")
                : t("Save.ToSource.Desc")}
            </Text>
          </div>
        </Button>
        <Button variant="subtle" size="xs" onClick={onClose} disabled={busy !== null}>
          {t("Common.Cancel")}
        </Button>
      </Stack>
    </Modal>
  );
}
