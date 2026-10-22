import { Button, Checkbox, Group, List, Progress, Stack, Text } from "@mantine/core";
import { IconAlertCircle, IconCircleCheck, IconPackageImport } from "@tabler/icons-react";
import { warn } from "@tauri-apps/plugin-log";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@/utils/format";
import {
  type EcInstall,
  migrateEnCroissant,
  type MigrationProgress,
  type MigrationReport,
} from "./ecMigrator";

/**
 * The "检测到 En Croissant 数据" card: summary line, one checkbox per
 * category, the 迁移 button with its progress bar, then the result line and
 * the list of files that failed. Used by the first-run step and by
 * `MigrateModal`.
 */

type Phase =
  | { phase: "idle" }
  | { phase: "running"; progress: MigrationProgress | null }
  | { phase: "done"; report: MigrationReport }
  | { phase: "error"; error: string };

type Category = "engines" | "databases" | "puzzles";
const CATEGORIES: Category[] = ["engines", "databases", "puzzles"];

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

export function sizeLabel(bytes: number): string {
  return bytes > 0 ? formatBytes(bytes, 1) : "0 KB";
}

function defaultSelection(install: EcInstall): Record<Category, boolean> {
  return {
    engines: install.engines.count > 0,
    databases: install.databases.count > 0,
    puzzles: install.puzzles.count > 0,
  };
}

export default function MigrateCard({
  install,
  disabled = false,
  onRunningChange,
  onDone,
}: {
  install: EcInstall;
  disabled?: boolean;
  /** Called with true when a migration starts and false when it settles. */
  onRunningChange?: (running: boolean) => void;
  onDone?: (report: MigrationReport) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Record<Category, boolean>>(() =>
    defaultSelection(install),
  );
  const [state, setState] = useState<Phase>({ phase: "idle" });
  const runningRef = useRef(false);

  const running = state.phase === "running";
  const totalBytes = install.engines.bytes + install.databases.bytes + install.puzzles.bytes;
  const nothingSelected = !CATEGORIES.some((c) => selected[c]);

  function optionLabel(category: Category): string {
    const key =
      category === "engines"
        ? "Migrate.Option.Engines"
        : category === "databases"
          ? "Migrate.Option.Databases"
          : "Migrate.Option.Puzzles";
    return t(key, { n: install[category].count, size: sizeLabel(install[category].bytes) });
  }

  async function run() {
    if (runningRef.current) return;
    runningRef.current = true;
    onRunningChange?.(true);
    setState({ phase: "running", progress: null });
    try {
      const report = await migrateEnCroissant({
        engines: selected.engines,
        databases: selected.databases,
        puzzles: selected.puzzles,
        onProgress: (progress) => setState({ phase: "running", progress }),
      });
      setState({ phase: "done", report });
      onDone?.(report);
    } catch (e) {
      warn(`migrate: failed: ${errorMessage(e)}`);
      setState({ phase: "error", error: errorMessage(e) });
    } finally {
      runningRef.current = false;
      onRunningChange?.(false);
    }
  }

  const progress = state.phase === "running" ? state.progress : null;
  const percent =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Stack gap="sm">
      <div>
        <Text fw={500}>
          {t("Migrate.Detected", {
            engines: install.engines.count,
            databases: install.databases.count,
            size: sizeLabel(totalBytes),
          })}
        </Text>
        <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
          {t("Migrate.Source", { path: install.dataDir })}
        </Text>
      </div>

      <Stack gap={6}>
        {CATEGORIES.map((category) => (
          <Checkbox
            key={category}
            label={optionLabel(category)}
            checked={selected[category]}
            disabled={disabled || running || install[category].count === 0}
            onChange={(e) => {
              const checked = e.currentTarget.checked;
              setSelected((prev) => ({ ...prev, [category]: checked }));
            }}
          />
        ))}
      </Stack>

      <Group gap="sm" wrap="nowrap" align="center">
        <Button
          leftSection={<IconPackageImport size="1rem" />}
          onClick={() => void run()}
          loading={running}
          disabled={disabled || nothingSelected}
          variant={state.phase === "done" ? "default" : "filled"}
        >
          {state.phase === "done" ? t("Migrate.Button.Again") : t("Migrate.Button")}
        </Button>
        {running && (
          <Text size="sm" c="dimmed" truncate role="status" style={{ flex: 1, minWidth: 0 }}>
            {progress && progress.file
              ? t("Migrate.Progress", {
                  file: progress.file,
                  done: progress.done + 1,
                  total: progress.total,
                })
              : t("Migrate.Preparing")}
          </Text>
        )}
      </Group>
      {running && <Progress value={percent} animated size="sm" aria-label={t("Migrate.Button")} />}

      {state.phase === "done" && (
        <Stack gap={4} role="status" aria-live="polite">
          <Group gap={6} wrap="nowrap">
            <IconCircleCheck size="1rem" color="var(--mantine-color-green-6)" />
            <Text size="sm" c="dimmed">
              {t("Migrate.Result", {
                copied: state.report.copied,
                skipped: state.report.skipped,
              })}
              {state.report.enginesAdded > 0 &&
                ` · ${t("Migrate.Result.Engines", { n: state.report.enginesAdded })}`}
            </Text>
          </Group>
          {state.report.failed.length > 0 && (
            <>
              <Group gap={6} wrap="nowrap">
                <IconAlertCircle size="1rem" color="var(--mantine-color-red-6)" />
                <Text size="sm" c="red">
                  {t("Migrate.Result.Failed", { n: state.report.failed.length })}
                </Text>
              </Group>
              <List size="xs" spacing={2} style={{ wordBreak: "break-all" }}>
                {state.report.failed.map((f) => (
                  <List.Item key={f.path}>
                    <Text size="xs" c="dimmed" component="span">
                      {f.path}
                    </Text>
                    <Text size="xs" c="red" component="span">
                      {" — "}
                      {f.error}
                    </Text>
                  </List.Item>
                ))}
              </List>
            </>
          )}
        </Stack>
      )}

      {state.phase === "error" && (
        <Group gap={6} wrap="nowrap" role="status">
          <IconAlertCircle size="1rem" color="var(--mantine-color-red-6)" />
          <Text size="sm" c="red">
            {t("Migrate.Failed", { error: state.error })}
          </Text>
        </Group>
      )}
    </Stack>
  );
}
