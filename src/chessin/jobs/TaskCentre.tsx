import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Loader,
  Popover,
  Progress,
  ScrollArea,
  Stack,
  Switch,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { IconListCheck, IconRefresh, IconTrash, IconX } from "@tabler/icons-react";
import { useAtom, useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import {
  cancelJob,
  clearFinishedJobs,
  countActiveJobs,
  isFinishedStatus,
  type Job,
  jobsAtom,
  pauseJobsAtom,
  removeJob,
  retryJob,
} from "./queue";
import { taskCentreOpenAtom } from "./taskCentre";

const STATUS_KEY: Record<Job["status"], string> = {
  // Keys are built from the status below; the comment keeps them for the
  // extractor (removeUnusedKeys):
  // t("Jobs.Status.Queued") t("Jobs.Status.Running") t("Jobs.Status.Done")
  // t("Jobs.Status.Failed") t("Jobs.Status.Cancelled") t("Jobs.NoHandler")
  queued: "Jobs.Status.Queued",
  running: "Jobs.Status.Running",
  done: "Jobs.Status.Done",
  failed: "Jobs.Status.Failed",
  cancelled: "Jobs.Status.Cancelled",
};

function statusColor(status: Job["status"]): string {
  switch (status) {
    case "running":
      return "blue";
    case "done":
      return "green";
    case "failed":
      return "red";
    case "cancelled":
      return "gray";
    default:
      return "gray";
  }
}

function JobRow({ job, offline }: { job: Job; offline: boolean }) {
  const { t, i18n } = useTranslation();
  const active = job.status === "queued" || job.status === "running";
  const waitingOffline = job.status === "queued" && job.kind === "sync" && offline;
  const error =
    job.error && job.error.startsWith("Jobs.") && i18n.exists(job.error) ? t(job.error) : job.error;
  const percent = Math.round(job.progress * 100);

  return (
    <Stack gap={2} data-job-id={job.id} data-job-status={job.status}>
      <Group gap={6} wrap="nowrap" justify="space-between">
        <Text size="xs" truncate style={{ flex: 1, minWidth: 0 }} title={job.title}>
          {job.title}
        </Text>
        <Badge variant="light" size="xs" radius="sm" tt="none" color={statusColor(job.status)}>
          {waitingOffline ? t("Jobs.WaitingOffline") : t(STATUS_KEY[job.status])}
        </Badge>
        {active && (
          <Tooltip label={t("Jobs.Cancel")} openDelay={400}>
            <ActionIcon
              size="xs"
              variant="subtle"
              color="gray"
              aria-label={t("Jobs.Cancel")}
              onClick={() => void cancelJob(job.id)}
            >
              <IconX size={12} />
            </ActionIcon>
          </Tooltip>
        )}
        {(job.status === "failed" || job.status === "cancelled") && (
          <Tooltip label={t("Jobs.Retry")} openDelay={400}>
            <ActionIcon
              size="xs"
              variant="subtle"
              color="gray"
              aria-label={t("Jobs.Retry")}
              onClick={() => void retryJob(job.id)}
            >
              <IconRefresh size={12} />
            </ActionIcon>
          </Tooltip>
        )}
        {isFinishedStatus(job.status) && (
          <Tooltip label={t("Jobs.Remove")} openDelay={400}>
            <ActionIcon
              size="xs"
              variant="subtle"
              color="gray"
              aria-label={t("Jobs.Remove")}
              onClick={() => void removeJob(job.id)}
            >
              <IconTrash size={12} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      {active && (
        <Progress
          size="xs"
          value={job.status === "running" ? percent : 0}
          animated={job.status === "running"}
          aria-label={`${job.title} ${percent}%`}
        />
      )}
      {job.status === "failed" && error && (
        <Text size="xs" c="red" lineClamp={2}>
          {error}
        </Text>
      )}
    </Stack>
  );
}

/**
 * Status-bar chip "后台任务 N" with the task-centre popover: running / queued /
 * recent jobs, cancel / retry, "清除已完成" and the pause switch. Renders
 * nothing while there are no jobs (unless opened through `jobs.open`).
 */
export function TaskCentreChip() {
  const { t } = useTranslation();
  const jobs = useAtomValue(jobsAtom);
  const [open, setOpen] = useAtom(taskCentreOpenAtom);
  const [paused, setPaused] = useAtom(pauseJobsAtom);
  const offline = useAtomValue(offlineModeAtom);

  if (jobs.length === 0 && !open) return null;

  const active = countActiveJobs(jobs);
  const running = jobs.some((job) => job.status === "running");
  const failed = jobs.some((job) => job.status === "failed");
  const hasFinished = jobs.some((job) => isFinishedStatus(job.status));
  const color = paused ? "yellow" : failed && active === 0 ? "red" : running ? "blue" : "gray";
  const label = active > 0 ? t("Jobs.Chip", { count: active }) : t("Jobs.Chip.Idle");

  return (
    <Popover
      opened={open}
      onChange={setOpen}
      position="top"
      width={360}
      withArrow
      shadow="md"
      withinPortal
      trapFocus
    >
      <Popover.Target>
        <Tooltip label={t("Jobs.Chip.Hint")} openDelay={400} disabled={open}>
          <UnstyledButton
            data-slot="task-centre"
            data-active={active}
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((prev) => !prev)}
            style={{ display: "inline-flex", lineHeight: 1 }}
          >
            <Badge
              variant="light"
              size="xs"
              radius="sm"
              tt="none"
              color={color}
              style={{ cursor: "pointer" }}
              leftSection={
                running && !paused ? (
                  <Loader size={8} color={color} />
                ) : (
                  <IconListCheck size={10} aria-hidden="true" />
                )
              }
            >
              {label}
            </Badge>
          </UnstyledButton>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown p="xs" role="dialog" aria-label={t("Jobs.Title")}>
        <Stack gap="xs">
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" fw={500}>
              {t("Jobs.Title")}
            </Text>
            <Tooltip label={t("Jobs.Paused.Hint")} openDelay={400}>
              <Switch
                size="xs"
                labelPosition="left"
                label={t("Jobs.Paused")}
                checked={paused}
                onChange={(event) => setPaused(event.currentTarget.checked)}
              />
            </Tooltip>
          </Group>
          {jobs.length === 0 ? (
            <Text size="xs" c="dimmed">
              {t("Jobs.Empty")}
            </Text>
          ) : (
            <ScrollArea.Autosize mah={320} type="auto" offsetScrollbars>
              <Stack gap={8}>
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} offline={offline} />
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
          <Group justify="flex-end">
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              disabled={!hasFinished}
              onClick={() => void clearFinishedJobs()}
            >
              {t("Jobs.ClearFinished")}
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
