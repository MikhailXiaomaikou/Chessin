import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useLoaderData } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { getTreeStore } from "@/chessin/keymap/treeStores";
import { copyTabToLibrary } from "@/chessin/save/copyToLibrary";
import { isLibraryOrigin, isReadOnlySource } from "@/chessin/save/saveModel";
import { readTabTreeState } from "@/chessin/save/tabTreeState";
import { createCheckpoint } from "@/chessin/store/libraryStore";
import { currentTabAtom, tabsAtom } from "@/state/atoms";
import { createTreeStore } from "@/state/store/tree";
import { saveToFile, type Tab } from "@/utils/tabs";
import { TreeStateContext } from "../common/TreeStateContext";

type Action = "source" | "library" | "checkpoint";

type TabProps = {
  /** The tab being closed; `undefined` hides the modal. */
  tab: Tab | undefined;
  onCancel: () => void;
  /** Closes `tab` for good (the caller skips the dirty check). */
  onCloseTab: (tab: Tab) => void;
};

/**
 * Legacy shape used inside a `TreeStateProvider` for the *active* tab
 * (InfoPanel: switching to another game of the same file). `closeTab` is
 * the "continue" action there, so the library option is not offered: the
 * tab keeps its file origin and the next game replaces the tree.
 */
type ActiveTabProps = {
  opened: boolean;
  toggle: () => void;
  closeTab: () => void;
};

/**
 * "Unsaved changes" prompt shown when a dirty tab is closed.
 *
 * The modal is bound to the tab being closed (`tab`), which is not
 * necessarily the active tab: a background tab can be closed from its tab
 * strip button or context menu. Its tree is read from the live store when
 * the tab is mounted, otherwise from the session mirror, so exactly that
 * tab is saved and closed.
 */
function ConfirmChangesModal(props: TabProps | ActiveTabProps) {
  const { t } = useTranslation();
  const setTabs = useSetAtom(tabsAtom);
  const currentTab = useAtomValue(currentTabAtom);
  const contextStore = useContext(TreeStateContext);
  const { documentDir } = useLoaderData({ from: "/" });
  const [busy, setBusy] = useState<Action | null>(null);

  const legacy = "opened" in props;
  const tab: Tab | undefined = legacy ? (props.opened ? currentTab : undefined) : props.tab;
  const onCancel = legacy ? props.toggle : props.onCancel;
  const onContinue = (target: Tab) => {
    if (legacy) {
      props.closeTab();
      props.toggle();
    } else {
      props.onCloseTab(target);
    }
  };

  const resolveStore = (target: Tab) => {
    if (legacy && contextStore) return contextStore;
    const live = getTreeStore(target.value);
    if (live) return live;
    const state = readTabTreeState(target.value);
    return createTreeStore(undefined, state ?? undefined);
  };

  const setTab = (target: Tab): React.Dispatch<React.SetStateAction<Tab>> => {
    return (value) =>
      setTabs((prev) =>
        prev.map((item) => {
          if (item.value !== target.value) return item;
          return typeof value === "function" ? value(item) : value;
        }),
      );
  };

  const save = async (target: Tab, action: Action): Promise<boolean> => {
    const store = resolveStore(target);
    if (action === "checkpoint") {
      await createCheckpoint(target.value);
      store.getState().save();
      return true;
    }
    if (action === "library") {
      await copyTabToLibrary({ tab: target, store, setTab: setTab(target) });
      return true;
    }
    return saveToFile({
      dir: documentDir,
      tab: target,
      setCurrentTab: setTab(target),
      store,
      isUserSave: true,
    });
  };

  const saveAndContinue = async (action: Action) => {
    if (!tab || busy) return;
    setBusy(action);
    try {
      const saved = await save(tab, action);
      if (saved) onContinue(tab);
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

  const readOnly = isReadOnlySource(tab);
  const library = isLibraryOrigin(tab);
  const database = tab?.gameOrigin.kind === "database";
  const primaryLabel = readOnly
    ? database
      ? t("Save.ToSource.Database")
      : t("Save.ToSource")
    : legacy
      ? t("Save.SaveAndContinue")
      : t("Save.SaveAndClose");

  return (
    <Modal
      withCloseButton={false}
      opened={tab !== undefined}
      onClose={onCancel}
      title={t("Save.UnsavedChanges.Title")}
      centered
    >
      <Stack>
        <Text>{t("Save.UnsavedChanges.Message", { name: tab?.name ?? "" })}</Text>

        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" onClick={onCancel} disabled={busy !== null}>
            {t("Common.Cancel")}
          </Button>
          <Button
            variant="default"
            disabled={busy !== null}
            onClick={() => {
              if (tab) onContinue(tab);
            }}
          >
            {legacy ? t("Save.DiscardAndContinue") : t("Save.CloseWithoutSaving")}
          </Button>
          {readOnly && !legacy && (
            <Button
              variant="light"
              loading={busy === "library"}
              disabled={busy !== null && busy !== "library"}
              onClick={() => saveAndContinue("library")}
            >
              {t("Save.CopyToLibrary")}
            </Button>
          )}
          <Button
            loading={busy === "source" || busy === "checkpoint"}
            disabled={busy === "library"}
            onClick={() => saveAndContinue(library ? "checkpoint" : "source")}
          >
            {primaryLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export default ConfirmChangesModal;
