import { Button, Checkbox, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type ClearDataCategory, type ClearDataScope, clearSavedData } from "./clearData";

const DEFAULT_SCOPE: ClearDataScope = {
  settings: true,
  layout: true,
  training: false,
  login: false,
};

type Option = { key: ClearDataCategory; label: string; description: string };

/**
 * Help → Clear saved data. Replaces the blanket `localStorage.clear()` with a
 * scoped choice; library documents are never deleted and a backup of
 * localStorage is written to the library kv before anything is removed.
 */
export default function ClearDataDialog({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<ClearDataScope>(DEFAULT_SCOPE);
  const [busy, setBusy] = useState(false);
  // Static keys so `i18next-cli extract` sees them.
  const options: Option[] = [
    {
      key: "settings",
      label: t("Workspace.ClearData.Settings"),
      description: t("Workspace.ClearData.Settings.Desc"),
    },
    {
      key: "layout",
      label: t("Workspace.ClearData.Layout"),
      description: t("Workspace.ClearData.Layout.Desc"),
    },
    {
      key: "training",
      label: t("Workspace.ClearData.Training"),
      description: t("Workspace.ClearData.Training.Desc"),
    },
    {
      key: "login",
      label: t("Workspace.ClearData.Login"),
      description: t("Workspace.ClearData.Login.Desc"),
    },
  ];
  const anySelected = options.some((o) => scope[o.key]);

  const confirm = async () => {
    setBusy(true);
    try {
      await clearSavedData(scope);
      location.reload();
    } catch (e) {
      setBusy(false);
      notifications.show({
        color: "red",
        message: t("Workspace.ClearData.Failed", { error: String(e) }),
      });
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t("Workspace.ClearData.Title")} centered>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t("Workspace.ClearData.Desc")}
        </Text>
        {options.map((option) => (
          <Checkbox
            key={option.key}
            label={option.label}
            description={option.description}
            checked={scope[option.key]}
            onChange={(event) =>
              setScope((prev) => ({ ...prev, [option.key]: event.currentTarget.checked }))
            }
          />
        ))}
        <Group justify="flex-end" mt="xs">
          <Button variant="default" onClick={onClose} disabled={busy}>
            {t("Common.Cancel")}
          </Button>
          <Button color="red" onClick={confirm} loading={busy} disabled={!anySelected}>
            {t("Workspace.ClearData.Confirm")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
