import { Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { IconPackageImport } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getKv } from "@/chessin/store/libraryStore";
import {
  detectEnCroissant,
  type EcInstall,
  hasMigratableData,
  MIGRATE_DONE_KEY,
} from "./ecMigrator";
import MigrateCard from "./MigrateCard";
import { closeMigrateModal, openMigrateModal, useMigrateModalOpen } from "./migrateModalState";

/**
 * "迁移 En Croissant 数据" as a Mantine modal: detection runs every time it
 * opens, then the same `MigrateCard` as the first-run step. Opened from the
 * settings button below and from the `migrate.enCroissant` command.
 */

type DetectState =
  | { phase: "checking" }
  | { phase: "ready"; install: EcInstall | null }
  | { phase: "error"; error: string };

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

function formatDone(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return date.toLocaleString(locale);
  } catch {
    return date.toLocaleString();
  }
}

/** Mounted while the modal is open, so each opening starts a fresh detection. */
function MigrateModalBody() {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<DetectState>({ phase: "checking" });
  const [lastDone, setLastDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([detectEnCroissant(), getKv(MIGRATE_DONE_KEY)])
      .then(([install, done]) => {
        if (cancelled) return;
        setLastDone(done);
        setState({ phase: "ready", install });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ phase: "error", error: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function body() {
    switch (state.phase) {
      case "checking":
        return (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed" role="status">
              {t("Migrate.Checking")}
            </Text>
          </Group>
        );
      case "error":
        return (
          <Text size="sm" c="red" role="status">
            {t("Migrate.Failed", { error: state.error })}
          </Text>
        );
      case "ready":
        if (!state.install) {
          return (
            <Text size="sm" c="dimmed">
              {t("Migrate.NotFound")}
            </Text>
          );
        }
        if (!hasMigratableData(state.install)) {
          return (
            <Text size="sm" c="dimmed" style={{ wordBreak: "break-all" }}>
              {t("Migrate.Empty", { path: state.install.dataDir })}
            </Text>
          );
        }
        return (
          <MigrateCard
            install={state.install}
            onDone={() => setLastDone(new Date().toISOString())}
          />
        );
    }
  }

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t("Migrate.Desc")}
      </Text>
      {body()}
      {lastDone && (
        <Text size="xs" c="dimmed">
          {t("Migrate.LastDone", { date: formatDone(lastDone, i18n.language) })}
        </Text>
      )}
    </Stack>
  );
}

export default function MigrateModal() {
  const { t } = useTranslation();
  const opened = useMigrateModalOpen();
  return (
    <Modal
      opened={opened}
      onClose={closeMigrateModal}
      title={t("Migrate.Action")}
      size="lg"
      closeOnClickOutside={false}
    >
      {opened && <MigrateModalBody />}
    </Modal>
  );
}

/** Settings row control: the button plus the modal it opens (hosted here). */
export function MigrateSettingsButton() {
  const { t } = useTranslation();
  return (
    <>
      <Button
        variant="default"
        leftSection={<IconPackageImport size="1rem" />}
        onClick={openMigrateModal}
      >
        {t("Migrate.Action")}
      </Button>
      <MigrateModal />
    </>
  );
}
