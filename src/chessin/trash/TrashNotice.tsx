/**
 * Shared UI for the trash flow (Files page + Databases page):
 *
 * - `showTrashNotice(result)`: the "已移到系统回收站" notification listing what
 *   moved (or "已永久删除" when the build has no recycle bin support).
 * - `TrashConfirmModal`: confirm dialog for batch deletes (>1 item) and for
 *   every delete when only permanent deletion is available.
 * - `useTrash`: the decision logic both pages share.
 */
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconTrash } from "@tabler/icons-react";
import i18n from "i18next";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { buildTrashNotices, capLines, type TrashMode, type TrashResult } from "./notice";
import type { TrashItem } from "./paths";
import { currentTrashMode, trashItems } from "./trash";

export type { TrashItem, TrashItemKind } from "./paths";
export type { TrashMode, TrashResult } from "./notice";

/** Shows one notification per `buildTrashNotices` entry. */
export function showTrashNotice(result: TrashResult) {
  const notices = buildTrashNotices(result, (key, options) => i18n.t(key, options));
  for (const notice of notices) {
    notifications.show({
      title: notice.title,
      color: notice.color,
      icon:
        notice.color === "red" ? (
          <IconAlertTriangle aria-hidden="true" size={18} />
        ) : (
          <IconTrash aria-hidden="true" size={18} />
        ),
      message: (
        <Stack gap={2}>
          {notice.lines.map((line) => (
            <Text key={line} size="sm" lineClamp={1}>
              {line}
            </Text>
          ))}
        </Stack>
      ),
    });
  }
}

/** Label for a delete button / menu item: says where the item will go. */
export function useTrashActionLabel(): string {
  const { t } = useTranslation();
  return currentTrashMode() === "trash" ? t("Trash.MoveToTrash") : t("Common.Delete");
}

export function TrashConfirmModal({
  items,
  mode,
  opened,
  onClose,
  onConfirm,
}: {
  items: TrashItem[];
  mode: TrashMode;
  opened: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const permanent = mode === "permanent";
  const lines = capLines(
    items.map((item) => item.name),
    (key, options) => t(key, options),
  );

  return (
    <Modal withCloseButton={false} opened={opened} onClose={onClose}>
      <Stack>
        <div>
          <Text fz="lg" fw="bold" mb={10}>
            {permanent ? t("Trash.Confirm.PermanentTitle") : t("Trash.Confirm.Title")}
          </Text>
          <Text>
            {permanent
              ? t("Trash.Confirm.PermanentMessage", { number: items.length })
              : t("Trash.Confirm.Message", { number: items.length })}
          </Text>
          <Stack gap={2} mt="xs">
            {lines.map((line) => (
              <Text key={line} size="sm" c="dimmed" lineClamp={1}>
                {line}
              </Text>
            ))}
          </Stack>
          {permanent && <Text mt="xs">{t("Common.CannotUndo")}</Text>}
        </div>

        <Group justify="right">
          <Button variant="default" onClick={() => onClose()}>
            {t("Common.Cancel")}
          </Button>
          <Button color="red" onClick={() => onConfirm()}>
            {permanent ? t("Trash.Confirm.DeletePermanently") : t("Trash.MoveToTrash")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * Decides between "straight to the trash" and "ask first":
 * - a single item goes straight to the OS recycle bin, then a notice;
 * - batches (>1 item) are confirmed first;
 * - when the build cannot use the recycle bin, every delete is confirmed
 *   because it is permanent.
 *
 * `onDone` runs after the operation (refresh lists, clear selection).
 */
export function useTrash(onDone?: (result: TrashResult) => void | Promise<void>) {
  const [pending, setPending] = useState<TrashItem[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (items: TrashItem[]) => {
      setBusy(true);
      try {
        const result = await trashItems(items);
        showTrashNotice(result);
        await onDone?.(result);
        return result;
      } finally {
        setBusy(false);
      }
    },
    [onDone],
  );

  const requestTrash = useCallback(
    (items: TrashItem[]) => {
      if (items.length === 0 || busy) return;
      if (items.length > 1 || currentTrashMode() === "permanent") {
        setPending(items);
        return;
      }
      void run(items);
    },
    [busy, run],
  );

  const closeConfirm = useCallback(() => setPending(null), []);
  const confirm = useCallback(() => {
    if (!pending) return;
    const items = pending;
    setPending(null);
    void run(items);
  }, [pending, run]);

  const modal = (
    <TrashConfirmModal
      items={pending ?? []}
      mode={currentTrashMode()}
      opened={pending !== null}
      onClose={closeConfirm}
      onConfirm={confirm}
    />
  );

  return { requestTrash, modal, busy, confirming: pending !== null };
}
