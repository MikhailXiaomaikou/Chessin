import {
  Badge,
  Button,
  Checkbox,
  Container,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconCircleCheck,
  IconCpu,
  IconDatabaseSearch,
  IconFileUpload,
  IconLoader2,
  IconPackageImport,
  IconWorld,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { TauriEvent } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { warn } from "@tauri-apps/plugin-log";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import MigrateCard from "@/chessin/migrate/MigrateCard";
import { useEnCroissantInstall } from "@/chessin/migrate/useEnCroissantInstall";
import { useProgress } from "@/hooks/useProgress";
import {
  activeTabAtom,
  databaseConversionStateAtom,
  enginesAtom,
  sessionsAtom,
  tabsAtom,
} from "@/state/atoms";
import { formatBytes } from "@/utils/format";
import { createTab } from "@/utils/tabs";
import classes from "./FirstRun.module.css";
import {
  closeFirstRun,
  firstRunDoneAtom,
  setFirstRunVisible,
  useFirstRunManuallyOpen,
} from "./firstRunState";
import {
  type AccountKind,
  addAccount,
  CbhUnavailableError,
  type ChessBaseDb,
  classifyImportFile,
  getNewestGame,
  importAccountGames,
  type ImportedDatabase,
  importLocalFile,
  isImportableChessBaseDb,
  scanChessBaseDatabases,
} from "./importers";

/**
 * Chessin first-run onboarding ("带入你的棋谱 / Bring your games").
 *
 * One screen, shown as a full-screen modal until it is dismissed once
 * (`firstRunDoneAtom`); re-openable from the NewTabHome card or the
 * `firstRun.open` command. Imports run one at a time through a small queue so
 * the shared `databaseConversionStateAtom` always describes a single job.
 */

type AccountStatus =
  | { phase: "idle" }
  | { phase: "queued" }
  | { phase: "lookup" }
  | { phase: "download" }
  | { phase: "convert" }
  | { phase: "done"; games: number | null }
  | { phase: "error"; error: string };

type FileRow = {
  path: string;
  name: string;
  phase: "queued" | "importing" | "done" | "error";
  games?: number | null;
  error?: string;
};

/** The "find ChessBase databases" step; it only runs on an explicit click. */
type ScanState =
  | { phase: "idle" }
  | { phase: "scanning" }
  | { phase: "unavailable" }
  | { phase: "done"; results: ChessBaseDb[] }
  | { phase: "error"; error: string };

const IDLE: AccountStatus = { phase: "idle" };
const SCAN_IDLE: ScanState = { phase: "idle" };
const IMPORT_EXTENSIONS = ["pgn", "pgn.zst", "pgn.bz2", "cbh"];

/** `modified` comes as unix seconds; tolerate milliseconds from a future binding. */
function formatModified(modified: number | null, locale: string): string | null {
  if (modified === null || !Number.isFinite(modified) || modified <= 0) return null;
  const ms = modified > 1e12 ? modified : modified * 1000;
  try {
    return new Date(ms).toLocaleDateString(locale);
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function StatusIcon({ phase }: { phase: AccountStatus["phase"] | FileRow["phase"] }) {
  if (phase === "done") return <IconCircleCheck size="1rem" color="var(--mantine-color-green-6)" />;
  if (phase === "error") return <IconAlertCircle size="1rem" color="var(--mantine-color-red-6)" />;
  if (phase === "idle") return null;
  return <IconLoader2 size="1rem" className={classes.spin} />;
}

function AccountRow({
  kind,
  label,
  value,
  onChange,
  onImport,
  status,
  statusText,
  disabled,
  autoFocus,
}: {
  kind: AccountKind;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onImport: () => void;
  status: AccountStatus;
  statusText: string | null;
  disabled: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const busy = status.phase !== "idle" && status.phase !== "done" && status.phase !== "error";
  const inputId = `firstrun-${kind}-username`;
  const statusId = `firstrun-${kind}-status`;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onImport();
  }

  return (
    <form onSubmit={submit}>
      <Group align="flex-end" wrap="nowrap">
        <TextInput
          id={inputId}
          label={label}
          aria-describedby={statusText ? statusId : undefined}
          placeholder={t("FirstRun.Account.Placeholder")}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={busy}
          data-autofocus={autoFocus || undefined}
          style={{ flex: 1 }}
        />
        <Button type="submit" loading={busy} disabled={disabled || value.trim() === ""}>
          {t("FirstRun.Account.Import")}
        </Button>
      </Group>
      <Group gap={6} mt={4} mih="1.25rem" wrap="nowrap">
        <StatusIcon phase={status.phase} />
        <Text id={statusId} size="sm" c={status.phase === "error" ? "red" : "dimmed"} role="status">
          {statusText}
        </Text>
      </Group>
    </form>
  );
}

export default function FirstRun() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [done, setDone] = useAtom(firstRunDoneAtom);
  const manuallyOpen = useFirstRunManuallyOpen();
  const opened = !done || manuallyOpen;

  useEffect(() => {
    setFirstRunVisible(opened);
    return () => setFirstRunVisible(false);
  }, [opened]);

  const setSessions = useSetAtom(sessionsAtom);
  const [conversion, setConversionState] = useAtom(databaseConversionStateAtom);
  const engines = useAtomValue(enginesAtom);
  const engineCount = engines?.length ?? 0;
  const setTabs = useSetAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);

  const [lichessUser, setLichessUser] = useState("");
  const [chesscomUser, setChesscomUser] = useState("");
  const [accounts, setAccounts] = useState<Record<AccountKind, AccountStatus>>({
    lichess: IDLE,
    chesscom: IDLE,
  });
  const [jobIds, setJobIds] = useState<Record<AccountKind, string>>({
    lichess: "firstrun:lichess",
    chesscom: "firstrun:chesscom",
  });
  const lichessDownload = useProgress(jobIds.lichess);
  const chesscomDownload = useProgress(jobIds.chesscom);

  const [files, setFiles] = useState<FileRow[]>([]);
  const [scan, setScan] = useState<ScanState>(SCAN_IDLE);
  const [scanSelected, setScanSelected] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [importedDbs, setImportedDbs] = useState<ImportedDatabase[]>([]);
  const [busy, setBusy] = useState(0);
  const [starting, setStarting] = useState(false);

  // "从 En Croissant 迁移" step: only offered while an EC data dir with
  // something to copy exists and no migration has been recorded yet.
  const ecInstall = useEnCroissantInstall(opened);

  // Imports run strictly one after another (shared conversion state, and the
  // Lichess API prefers a single request at a time).
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueue = useCallback((task: () => Promise<void>) => {
    const run = queueRef.current.then(task, task);
    queueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  function setAccountStatus(kind: AccountKind, status: AccountStatus) {
    setAccounts((prev) => ({ ...prev, [kind]: status }));
  }

  function upsertFile(row: FileRow) {
    setFiles((prev) => {
      const index = prev.findIndex((f) => f.path === row.path);
      if (index === -1) return [...prev, row];
      const next = prev.slice();
      next[index] = row;
      return next;
    });
  }

  async function importAccount(kind: AccountKind) {
    const typed = (kind === "lichess" ? lichessUser : chesscomUser).trim();
    if (!typed) return;
    setAccountStatus(kind, { phase: "queued" });
    setBusy((b) => b + 1);
    try {
      await enqueue(async () => {
        setAccountStatus(kind, { phase: "lookup" });
        const account = await addAccount(kind, typed, setSessions);
        if (!account) {
          setAccountStatus(kind, { phase: "error", error: t("FirstRun.Status.NotFound") });
          return;
        }
        setJobIds((prev) => ({ ...prev, [kind]: `${kind}_${account.username}` }));
        setAccountStatus(kind, { phase: "download" });
        const result = await importAccountGames(account, {
          setConversionState,
          onConvertStart: () => setAccountStatus(kind, { phase: "convert" }),
        });
        setImportedDbs((prev) => [...prev, result]);
        setAccountStatus(kind, { phase: "done", games: result.games });
      });
    } catch (e) {
      warn(`first run: ${kind} import failed: ${errorMessage(e)}`);
      setAccountStatus(kind, { phase: "error", error: errorMessage(e) });
    } finally {
      setBusy((b) => b - 1);
    }
  }

  const importFiles = useCallback(
    (paths: string[]) => {
      const unique = paths.filter((p, i) => paths.indexOf(p) === i);
      for (const path of unique) {
        const name = fileNameOf(path);
        if (!classifyImportFile(path)) {
          upsertFile({ path, name, phase: "error", error: t("FirstRun.Files.Unsupported") });
          continue;
        }
        upsertFile({ path, name, phase: "queued" });
        setBusy((b) => b + 1);
        enqueue(async () => {
          upsertFile({ path, name, phase: "importing" });
          const result = await importLocalFile(path, setConversionState);
          setImportedDbs((prev) => [...prev, result]);
          upsertFile({ path, name, phase: "done", games: result.games });
        })
          .catch((e: unknown) => {
            const error =
              e instanceof CbhUnavailableError
                ? t("FirstRun.Files.CbhUnavailable")
                : errorMessage(e);
            warn(`first run: import of ${path} failed: ${errorMessage(e)}`);
            upsertFile({ path, name, phase: "error", error });
          })
          .finally(() => setBusy((b) => b - 1));
      }
    },
    [enqueue, setConversionState, t],
  );

  // --- ChessBase scan step -------------------------------------------------

  const scanResults = scan.phase === "done" ? scan.results : [];
  const scanPaths = new Set(scanResults.map((db) => db.path));
  const fileRowByPath = new Map(files.map((row) => [row.path, row]));
  // The files list keeps the rows that were not picked from the scan list.
  const looseFiles = files.filter((row) => !scanPaths.has(row.path));

  /** A scan entry is still selectable while nothing has been started for it. */
  function scanRowSelectable(db: ChessBaseDb): boolean {
    if (!isImportableChessBaseDb(db)) return false;
    const row = fileRowByPath.get(db.path);
    return row === undefined || row.phase === "error";
  }

  const selectableScanPaths = scanResults.filter(scanRowSelectable).map((db) => db.path);
  const scanSelection = scanSelected.filter((path) => selectableScanPaths.includes(path));

  async function runScan() {
    setScan({ phase: "scanning" });
    try {
      const results = await scanChessBaseDatabases();
      if (results === null) {
        setScan({ phase: "unavailable" });
        return;
      }
      setScan({ phase: "done", results });
      // Preselect everything importable, like the teardown's "☑ Mega Database 2026" mock-up.
      setScanSelected(
        results
          .filter((db) => isImportableChessBaseDb(db) && fileRowByPath.get(db.path) === undefined)
          .map((db) => db.path),
      );
    } catch (e) {
      warn(`first run: ChessBase scan failed: ${errorMessage(e)}`);
      setScan({ phase: "error", error: errorMessage(e) });
    }
  }

  function toggleScanRow(path: string, checked: boolean) {
    setScanSelected((prev) =>
      checked ? (prev.includes(path) ? prev : [...prev, path]) : prev.filter((p) => p !== path),
    );
  }

  function importScanSelection() {
    const paths = scanResults
      .map((db) => db.path)
      .filter((path) => scanSelection.includes(path) && selectableScanPaths.includes(path));
    if (paths.length === 0) return;
    setScanSelected([]);
    // Same sequential queue (and the same `importCbhFile` path) as dropped files.
    importFiles(paths);
  }

  function scanStatusText(): string | null {
    switch (scan.phase) {
      case "idle":
        return null;
      case "scanning":
        return t("FirstRun.Scan.Scanning");
      case "unavailable":
        return t("FirstRun.Scan.Unavailable");
      case "error":
        return t("FirstRun.Scan.Failed", { error: scan.error });
      case "done":
        return scan.results.length === 0
          ? t("FirstRun.Scan.None")
          : t("FirstRun.Scan.Found", { n: scan.results.length });
    }
  }

  function scanRowDetails(db: ChessBaseDb): string {
    const parts = [
      db.games === null
        ? t("FirstRun.Scan.GamesUnknown")
        : t("FirstRun.Scan.Games", { n: db.games.toLocaleString(i18n.language) }),
      db.size_bytes > 0 ? formatBytes(db.size_bytes, 1) : null,
    ];
    const modified = formatModified(db.modified, i18n.language);
    if (modified) parts.push(t("FirstRun.Scan.Modified", { date: modified }));
    return parts.filter((p): p is string => !!p).join(" · ");
  }

  async function pickFiles() {
    const selected = await open({
      multiple: true,
      filters: [{ name: t("FirstRun.Files.FilterName"), extensions: IMPORT_EXTENSIONS }],
    });
    if (!selected) return;
    importFiles(Array.isArray(selected) ? selected : [selected]);
  }

  // Native file drops (Tauri delivers them as window events, not DOM drop events).
  useEffect(() => {
    if (!opened) return;
    const win = getCurrentWindow();
    const subscriptions = [
      win.listen(TauriEvent.DRAG_ENTER, () => setDragging(true)),
      win.listen(TauriEvent.DRAG_LEAVE, () => setDragging(false)),
      win.listen<{ paths?: string[] }>(TauriEvent.DRAG_DROP, (event) => {
        setDragging(false);
        const paths = event.payload?.paths ?? [];
        if (paths.length > 0) importFiles(paths);
      }),
    ];
    return () => {
      setDragging(false);
      for (const sub of subscriptions) sub.then((unlisten) => unlisten());
    };
  }, [opened, importFiles]);

  function dismiss() {
    setDone(true);
    closeFirstRun();
  }

  async function start() {
    const latest = importedDbs[importedDbs.length - 1];
    if (!latest) {
      dismiss();
      return;
    }
    setStarting(true);
    try {
      const game = await getNewestGame(latest.dbPath);
      dismiss();
      if (!game) return;
      // Same tab shape as GameTable's double-click.
      await createTab({
        tab: { name: `${game.white} - ${game.black}`, type: "analysis" },
        setTabs,
        setActiveTab,
        pgn: game.moves,
        headers: game,
        gameOrigin: { kind: "database", database: latest.dbPath, gameId: game.id },
      });
      navigate({ to: "/" });
    } catch (e) {
      warn(`first run: could not open the newest game: ${errorMessage(e)}`);
      dismiss();
    } finally {
      setStarting(false);
    }
  }

  function goToEngines() {
    dismiss();
    navigate({ to: "/engines" });
  }

  function accountStatusText(kind: AccountKind): string | null {
    const status = accounts[kind];
    const download = kind === "lichess" ? lichessDownload : chesscomDownload;
    switch (status.phase) {
      case "idle":
        return null;
      case "queued":
        return t("FirstRun.Status.Queued");
      case "lookup":
        return t("FirstRun.Status.Lookup");
      case "download":
        return t("FirstRun.Status.Downloading", {
          percent: Math.min(100, Math.max(0, Math.round(download.progress))),
        });
      case "convert":
        return t("FirstRun.Status.Converting", { n: conversion.totalGames });
      case "done":
        return status.games === null
          ? t("FirstRun.Status.DoneNoCount")
          : t("FirstRun.Status.Done", { n: status.games });
      case "error":
        return t("FirstRun.Status.Failed", { error: status.error });
    }
  }

  function fileStatusText(row: FileRow): string {
    switch (row.phase) {
      case "queued":
        return t("FirstRun.Files.Queued", { name: row.name });
      case "importing": {
        const base = t("FirstRun.Files.Importing", { name: row.name });
        return conversion.inProgress && conversion.sourceFileName === row.name
          ? `${base} ${t("FirstRun.Status.Converting", { n: conversion.totalGames })}`
          : base;
      }
      case "done":
        return row.games === null || row.games === undefined
          ? t("FirstRun.Files.DoneNoCount", { name: row.name })
          : t("FirstRun.Files.Done", { name: row.name, n: row.games });
      case "error":
        return t("FirstRun.Files.Failed", { name: row.name, error: row.error ?? "" });
    }
  }

  const language = (i18n.resolvedLanguage ?? i18n.language ?? "en-US").toLowerCase();
  const languageValue = language.startsWith("zh") ? "zh-CN" : "en-US";

  return (
    <Modal
      opened={opened}
      onClose={dismiss}
      fullScreen
      title={t("FirstRun.Title")}
      padding="xl"
      transitionProps={{ transition: "fade", duration: 150 }}
      styles={{
        header: { maxWidth: 760, marginInline: "auto" },
        title: { fontSize: "1.75rem", fontWeight: 700 },
      }}
    >
      <Container size={760} px={0}>
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Text c="dimmed" maw={520}>
              {t("FirstRun.Subtitle")}
            </Text>
            <SegmentedControl
              aria-label={t("FirstRun.Language")}
              value={languageValue}
              onChange={(value) => void i18n.changeLanguage(value)}
              data={[
                { value: "zh-CN", label: "中文" },
                { value: "en-US", label: "English" },
              ]}
            />
          </Group>

          <Paper withBorder radius="md" p="md" component="section">
            <Group gap="xs" mb={4}>
              <IconWorld size="1.25rem" />
              <Title order={3} size="h4">
                {t("FirstRun.Accounts.Title")}
              </Title>
            </Group>
            <Text size="sm" c="dimmed" mb="md">
              {t("FirstRun.Accounts.Desc")}
            </Text>
            <Stack gap="sm">
              <AccountRow
                kind="lichess"
                label={t("FirstRun.Lichess.Label")}
                value={lichessUser}
                onChange={setLichessUser}
                onImport={() => void importAccount("lichess")}
                status={accounts.lichess}
                statusText={accountStatusText("lichess")}
                disabled={starting}
                autoFocus
              />
              <AccountRow
                kind="chesscom"
                label={t("FirstRun.ChessCom.Label")}
                value={chesscomUser}
                onChange={setChesscomUser}
                onImport={() => void importAccount("chesscom")}
                status={accounts.chesscom}
                statusText={accountStatusText("chesscom")}
                disabled={starting}
              />
            </Stack>
          </Paper>

          <Paper withBorder radius="md" p="md" component="section">
            <Group gap="xs" mb={4}>
              <IconFileUpload size="1.25rem" />
              <Title order={3} size="h4">
                {t("FirstRun.Files.Title")}
              </Title>
            </Group>
            <Text size="sm" c="dimmed" mb="md">
              {t("FirstRun.Files.Desc")}
            </Text>
            <UnstyledButton
              className={classes.dropzone}
              data-dragging={dragging || undefined}
              onClick={() => void pickFiles()}
              disabled={starting}
            >
              <Stack align="center" gap={4}>
                <IconFileUpload size={32} />
                <Text fw={500}>
                  {dragging ? t("FirstRun.Files.DropActive") : t("FirstRun.Files.Drop")}
                </Text>
                <Text size="xs" c="dimmed">
                  .pgn · .pgn.zst · .pgn.bz2 · .cbh
                </Text>
              </Stack>
            </UnstyledButton>
            {looseFiles.length > 0 && (
              <Stack gap={4} mt="sm" role="status" aria-live="polite">
                {looseFiles.map((row) => (
                  <Group key={row.path} gap={6} wrap="nowrap">
                    <StatusIcon phase={row.phase} />
                    <Text size="sm" c={row.phase === "error" ? "red" : "dimmed"} truncate>
                      {fileStatusText(row)}
                    </Text>
                  </Group>
                ))}
              </Stack>
            )}
          </Paper>

          <Paper withBorder radius="md" p="md" component="section">
            <Group gap="xs" mb={4}>
              <IconDatabaseSearch size="1.25rem" />
              <Title order={3} size="h4">
                {t("FirstRun.Scan.Title")}
              </Title>
            </Group>
            <Text size="sm" c="dimmed" mb="md">
              {t("FirstRun.Scan.Desc")}
            </Text>
            <Group gap="sm" wrap="wrap">
              <Button
                variant={scan.phase === "done" ? "default" : "light"}
                leftSection={<IconDatabaseSearch size="1rem" />}
                onClick={() => void runScan()}
                loading={scan.phase === "scanning"}
                disabled={starting || scan.phase === "unavailable"}
              >
                {scan.phase === "done" ? t("FirstRun.Scan.Rescan") : t("FirstRun.Scan.Button")}
              </Button>
              {scan.phase === "done" && selectableScanPaths.length > 0 && (
                <>
                  <Button
                    variant="subtle"
                    size="compact-sm"
                    onClick={() => setScanSelected(selectableScanPaths)}
                    disabled={scanSelection.length === selectableScanPaths.length}
                  >
                    {t("FirstRun.Scan.SelectAll")}
                  </Button>
                  <Button
                    onClick={importScanSelection}
                    disabled={starting || scanSelection.length === 0}
                  >
                    {t("FirstRun.Scan.Import", { n: scanSelection.length })}
                  </Button>
                </>
              )}
            </Group>
            <Group gap={6} mt={4} mih="1.25rem" wrap="nowrap">
              <StatusIcon
                phase={
                  scan.phase === "scanning" ? "queued" : scan.phase === "error" ? "error" : "idle"
                }
              />
              <Text
                size="sm"
                c={scan.phase === "error" || scan.phase === "unavailable" ? "red" : "dimmed"}
                role="status"
              >
                {scanStatusText()}
              </Text>
            </Group>
            {scanResults.length > 0 && (
              <Stack gap="xs" mt="sm">
                {scanResults.map((db) => {
                  const importable = isImportableChessBaseDb(db);
                  const row = fileRowByPath.get(db.path);
                  const selectable = scanRowSelectable(db);
                  return (
                    <Group key={db.path} align="flex-start" wrap="nowrap" gap="sm">
                      <Checkbox
                        checked={scanSelection.includes(db.path)}
                        disabled={!selectable || starting}
                        onChange={(e) => toggleScanRow(db.path, e.currentTarget.checked)}
                        label={
                          <Group gap={6} wrap="nowrap">
                            <Text fw={500} truncate>
                              {db.name}
                            </Text>
                            <Badge
                              size="xs"
                              variant="light"
                              color={importable ? "blue" : "gray"}
                              style={{ flexShrink: 0 }}
                            >
                              {db.format.toUpperCase()}
                            </Badge>
                          </Group>
                        }
                        description={
                          <>
                            <Text size="xs" c="dimmed" component="span">
                              {scanRowDetails(db)}
                            </Text>
                            {!importable && (
                              <Text size="xs" c="dimmed" fs="italic">
                                {db.format === "2cbh"
                                  ? t("FirstRun.Scan.NotYet2cbh")
                                  : t("FirstRun.Files.Unsupported")}
                              </Text>
                            )}
                            {row && (
                              <Group gap={6} wrap="nowrap" mt={2}>
                                <StatusIcon phase={row.phase} />
                                <Text
                                  size="xs"
                                  c={row.phase === "error" ? "red" : "dimmed"}
                                  truncate
                                  role="status"
                                >
                                  {fileStatusText(row)}
                                </Text>
                              </Group>
                            )}
                          </>
                        }
                        style={{ flex: 1, minWidth: 0 }}
                      />
                    </Group>
                  );
                })}
              </Stack>
            )}
          </Paper>

          {ecInstall && (
            <Paper withBorder radius="md" p="md" component="section">
              <Group gap="xs" mb={4}>
                <IconPackageImport size="1.25rem" />
                <Title order={3} size="h4">
                  {t("Migrate.Title")}
                </Title>
              </Group>
              <Text size="sm" c="dimmed" mb="md">
                {t("Migrate.Desc")}
              </Text>
              <MigrateCard
                install={ecInstall}
                disabled={starting}
                onRunningChange={(running) => setBusy((b) => b + (running ? 1 : -1))}
              />
            </Paper>
          )}

          <Paper withBorder radius="md" p="md" component="section">
            <Group justify="space-between" align="center" wrap="nowrap">
              <div>
                <Group gap="xs" mb={4}>
                  <IconCpu size="1.25rem" />
                  <Title order={3} size="h4">
                    {t("FirstRun.Engines.Title")}
                  </Title>
                </Group>
                <Text size="sm" c="dimmed">
                  {engineCount > 0
                    ? t("FirstRun.Engines.Installed", { n: engineCount })
                    : t("FirstRun.Engines.Note")}
                </Text>
              </div>
              <Button variant={engineCount > 0 ? "default" : "light"} onClick={goToEngines}>
                {t("FirstRun.Engines.Button")}
              </Button>
            </Group>
          </Paper>

          <Group justify="space-between" align="center" wrap="wrap">
            <Text size="xs" c="dimmed">
              {t("FirstRun.Footer.Hint")}
            </Text>
            <Group gap="sm">
              <Button variant="subtle" color="gray" onClick={dismiss}>
                {t("FirstRun.Skip")}
              </Button>
              <Button onClick={() => void start()} loading={starting} disabled={busy > 0}>
                {t("FirstRun.Start")}
              </Button>
            </Group>
          </Group>
        </Stack>
      </Container>
    </Modal>
  );
}
