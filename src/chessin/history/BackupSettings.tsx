import { Box, Button, Group, Stack, Switch, Text, Tooltip } from "@mantine/core";
import { IconDatabaseExport } from "@tabler/icons-react";
import { useAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { isActiveStatus, jobsAtom } from "@/chessin/jobs/queue";
import {
  BACKUP_JOB_KIND,
  backupDailyAtom,
  backupLastAtom,
  backupNow,
  isBackupAvailable,
  loadBackupLast,
} from "./backup";
import { formatVersionTime } from "./versions";

/**
 * Settings row "数据备份": last backup time (`backup.last`), "立即备份"
 * (disabled with a hint until the Rust `backup_library` command exists) and
 * the daily auto-backup toggle.
 */
export default function BackupSettings() {
  const { t, i18n } = useTranslation();
  const [daily, setDaily] = useAtom(backupDailyAtom);
  const last = useAtomValue(backupLastAtom);
  const jobs = useAtomValue(jobsAtom);
  const running = jobs.some((job) => job.kind === BACKUP_JOB_KIND && isActiveStatus(job.status));
  const available = isBackupAvailable();

  useEffect(() => {
    void loadBackupLast();
  }, []);

  return (
    <Stack gap={6} align="flex-end" data-testid="backup-settings">
      <Group gap="sm" wrap="nowrap">
        <Text size="xs" c="dimmed" data-slot="backup-last">
          {last === null
            ? t("Backup.Never")
            : t("Backup.Last", { time: formatVersionTime(last, i18n.language) })}
        </Text>
        <Tooltip label={t("Backup.Unavailable")} disabled={available} multiline w={260}>
          {/* A disabled button fires no pointer events; the box carries the tooltip. */}
          <Box>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconDatabaseExport size="1rem" />}
              disabled={!available}
              loading={running}
              onClick={() => void backupNow({ reason: "manual" })}
            >
              {t("Backup.Now")}
            </Button>
          </Box>
        </Tooltip>
      </Group>
      <Switch
        size="sm"
        labelPosition="left"
        label={t("Backup.Daily")}
        checked={daily}
        onChange={(event) => setDaily(event.currentTarget.checked)}
      />
    </Stack>
  );
}
