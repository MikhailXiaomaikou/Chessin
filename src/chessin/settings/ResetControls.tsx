import { ActionIcon, Button, Group, Modal, Stack, Text, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconFileExport, IconFileImport, IconRestore } from "@tabler/icons-react";
import equal from "fast-deep-equal";
import { useAtomValue, useStore } from "jotai";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { resetAllSettings, resetSetting, type SettingEntry, settingEntry } from "./defaults";
import { exportSettingsToFile, importSettingsFromFile } from "./exportImport";
import classes from "./ResetControls.module.css";

/**
 * SettingsPage pieces for "self-explaining settings" (plan X-10):
 *  - `ModifiedMarker`: a dot after a row's title when its atom differs from
 *    the registered default (`defaults.ts`), with the default in a tooltip;
 *  - `ResetRowButton`: the per-row 重置, shown only while modified;
 *  - `SettingsToolbar`: 重置全部 (with confirmation), 导出设置, 导入设置.
 * Rows without a registry entry render nothing here.
 */

function formatValue(value: unknown, t: TFunction): string {
  if (typeof value === "boolean") return value ? t("Common.On") : t("Common.Off");
  if (value === "" || value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function useModified(entry: SettingEntry): boolean {
  const value = useAtomValue(entry.atom);
  return !equal(value, entry.default);
}

function MarkerInner({ entry }: { entry: SettingEntry }) {
  const { t } = useTranslation();
  const modified = useModified(entry);
  if (!modified) return null;
  const label = t("Settings.Reset.Modified", { value: formatValue(entry.default, t) });
  return (
    <Tooltip label={label}>
      <span className={classes.dot} role="img" aria-label={label} data-chessin-modified />
    </Tooltip>
  );
}

/** The "已修改" dot; `null` for rows without a registry entry or at their default. */
export function ModifiedMarker({ id }: { id: string }) {
  const entry = settingEntry(id);
  if (!entry) return null;
  return <MarkerInner entry={entry} />;
}

function ResetInner({ entry }: { entry: SettingEntry }) {
  const { t } = useTranslation();
  const store = useStore();
  const modified = useModified(entry);
  if (!modified) return null;
  return (
    <Tooltip label={t("Settings.Reset.Row")}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={t("Settings.Reset.Row")}
        data-chessin-reset={entry.id}
        onClick={() => resetSetting(store, entry.id)}
      >
        <IconRestore size="0.9rem" />
      </ActionIcon>
    </Tooltip>
  );
}

/** Per-row 重置 button, visible only while the row's value differs from its default. */
export function ResetRowButton({ id }: { id: string }) {
  const entry = settingEntry(id);
  if (!entry) return null;
  return <ResetInner entry={entry} />;
}

/** 重置全部 / 导出设置 / 导入设置, next to the search box. */
export function SettingsToolbar() {
  const { t } = useTranslation();
  const store = useStore();
  const [confirmOpen, confirm] = useDisclosure(false);

  const exportSettings = async () => {
    try {
      const path = await exportSettingsToFile(store);
      if (path) {
        notifications.show({ message: t("Settings.Reset.Exported", { path }), color: "green" });
      }
    } catch (e) {
      notifications.show({ title: t("Common.Error"), message: String(e), color: "red" });
    }
  };

  const importSettings = async () => {
    try {
      const outcome = await importSettingsFromFile(store);
      if (outcome.status === "cancelled") return;
      if (outcome.status === "invalid") {
        notifications.show({ message: t("Settings.Reset.ImportInvalid"), color: "red" });
        return;
      }
      const lines = [t("Settings.Reset.Imported", { count: outcome.applied.length })];
      if (outcome.skipped.length > 0) {
        lines.push(t("Settings.Reset.ImportSkipped", { n: outcome.skipped.length }));
      }
      notifications.show({ message: lines.join(" "), color: "green" });
    } catch (e) {
      notifications.show({ title: t("Common.Error"), message: String(e), color: "red" });
    }
  };

  return (
    <Group gap="xs" wrap="nowrap">
      <Button
        size="xs"
        variant="default"
        leftSection={<IconRestore size="0.9rem" />}
        onClick={confirm.open}
      >
        {t("Settings.Reset.All")}
      </Button>
      <Button
        size="xs"
        variant="default"
        leftSection={<IconFileExport size="0.9rem" />}
        onClick={() => void exportSettings()}
      >
        {t("Settings.Reset.Export")}
      </Button>
      <Button
        size="xs"
        variant="default"
        leftSection={<IconFileImport size="0.9rem" />}
        onClick={() => void importSettings()}
      >
        {t("Settings.Reset.Import")}
      </Button>
      <Modal opened={confirmOpen} onClose={confirm.close} title={t("Settings.Reset.All")} centered>
        <Stack>
          <Text size="sm">{t("Settings.Reset.AllConfirm")}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={confirm.close}>
              {t("Common.Cancel")}
            </Button>
            <Button
              color="red"
              onClick={() => {
                resetAllSettings(store);
                confirm.close();
                notifications.show({ message: t("Settings.Reset.AllDone"), color: "green" });
              }}
            >
              {t("Settings.Reset.All")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Group>
  );
}
