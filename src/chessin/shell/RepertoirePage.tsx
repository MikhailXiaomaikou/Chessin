import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Modal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconBook, IconPlus, IconRefresh } from "@tabler/icons-react";
import { useLoaderData } from "@tanstack/react-router";
import { readDir } from "@tauri-apps/plugin-fs";
import { INITIAL_FEN } from "chessops/fen";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useStore } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { useOpenInWorkspace } from "@/chessin/workspace/openInWorkspace";
import OpenFolderButton from "@/components/common/OpenFolderButton";
import { type FileMetadata, processEntriesRecursively } from "@/components/files/file";
import { addRecentFileAtom, tabFamily } from "@/state/atoms";
import { headersToPGN } from "@/utils/chess";
import { createFile } from "@/utils/files";
import { collectRepertoires } from "./repertoireFiles";

dayjs.extend(relativeTime);

async function listRepertoires(dir: string): Promise<FileMetadata[]> {
  const entries = await readDir(dir);
  return collectRepertoires(await processEntriesRecursively(dir, entries));
}

/**
 * "新建" on this page. Same file + tab + recent-files flow as
 * `src/components/tabs/CreateRepertoireModal.tsx`, which cannot be mounted
 * here: it reads `documentDir` with `useLoaderData({ from: "/" })`, and that
 * throws outside the board route ("Could not find an active match"). Once the
 * shared modal takes the folder from its caller (or falls back to
 * `storedDocumentDirAtom`), this page can open it instead.
 */
function NewRepertoireModal({
  opened,
  onClose,
  documentDir,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  documentDir: string;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [color, setColor] = useState<"white" | "black">("white");
  const [error, setError] = useState("");
  const openInWorkspace = useOpenInWorkspace();
  const store = useStore();

  const close = () => {
    setName("");
    setColor("white");
    setError("");
    onClose();
  };

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("Common.RequireName"));
      return;
    }
    const pgn = headersToPGN({
      id: 0,
      fen: INITIAL_FEN,
      black: "",
      white: "",
      result: "*",
      event: trimmedName,
      site: "",
      orientation: color,
    });
    const result = await createFile({
      filename: trimmedName,
      filetype: "repertoire",
      pgn,
      dir: documentDir,
    });
    if (result.isErr) {
      setError(result.error.message);
      return;
    }
    const fileInfo = result.value;
    const id = await openInWorkspace({
      tab: { name: trimmedName, type: "analysis" },
      pgn,
      gameOrigin: { kind: "file", file: fileInfo, gameNumber: 0 },
    });
    store.set(tabFamily(id), "practice");
    store.set(addRecentFileAtom, { name: trimmedName, path: fileInfo.path, type: "repertoire" });
    onCreated();
    close();
  }

  return (
    <Modal opened={opened} onClose={close} title={t("Home.Card.NewRepertoire.Title")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <Stack>
          <TextInput
            label={t("Common.Name")}
            placeholder={t("Home.Card.NewRepertoire.NamePlaceholder")}
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
              if (error) setError("");
            }}
            error={error}
            data-autofocus
          />
          <div>
            <Text size="sm" fw={500} mb={4}>
              {t("Home.Card.NewRepertoire.Color")}
            </Text>
            <SegmentedControl
              fullWidth
              value={color}
              onChange={(v) => setColor(v as "white" | "black")}
              data={[
                { label: t("Common.WHITE"), value: "white" },
                { label: t("Common.BLACK"), value: "black" },
              ]}
            />
          </div>
          <Button type="submit">{t("Common.Create")}</Button>
        </Stack>
      </form>
    </Modal>
  );
}

function RepertoireRow({ file, onOpen }: { file: FileMetadata; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <Card withBorder radius="md" p="sm" data-chessin-repertoire={file.path} onDoubleClick={onOpen}>
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <IconBook size="1.4rem" stroke={1.5} aria-hidden="true" />
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text fw={500} truncate>
              {file.name}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {t("Shell.Repertoire.Updated", { time: dayjs.unix(file.lastModified).fromNow() })}
              {" · "}
              {file.path}
            </Text>
          </Stack>
        </Group>
        <Button size="xs" variant="default" onClick={onOpen} style={{ flex: "none" }}>
          {t("Common.Open")}
        </Button>
      </Group>
    </Card>
  );
}

/**
 * `/repertoire` (S3-6): the repertoire files of the document folder with
 * 新建 / 打开. Opening goes through `openInWorkspace({ file })`, which puts
 * the tab in practice mode the way the files page does.
 */
export default function RepertoirePage() {
  const { t } = useTranslation();
  const { documentDir } = useLoaderData({ from: "/repertoire" });
  const { data, error, isLoading, mutate } = useSWR(["chessin-repertoires", documentDir], () =>
    listRepertoires(documentDir),
  );
  const openInWorkspace = useOpenInWorkspace();
  const [createOpened, setCreateOpened] = useState(false);

  const open = useCallback(
    (file: FileMetadata) => {
      void openInWorkspace({ file });
    },
    [openInWorkspace],
  );

  const files = data ?? [];

  return (
    <Stack h="100%" p="md" gap="sm" style={{ overflow: "hidden" }}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <IconBook size="1.6rem" stroke={1.5} aria-hidden="true" />
          <Title order={3}>{t("Shell.Repertoire.Title")}</Title>
          {data && (
            <Text size="sm" c="dimmed">
              {t("Shell.Repertoire.Count", { count: files.length })}
            </Text>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Tooltip label={t("Files.Reload")}>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label={t("Files.Reload")}
              onClick={() => void mutate()}
            >
              <IconRefresh size="1.1rem" />
            </ActionIcon>
          </Tooltip>
          <OpenFolderButton folder={documentDir} />
          <Button
            leftSection={<IconPlus size="1rem" />}
            onClick={() => setCreateOpened(true)}
            data-chessin-repertoire-new
          >
            {t("Shell.Repertoire.New")}
          </Button>
        </Group>
      </Group>
      <Text size="sm" c="dimmed">
        {t("Shell.Repertoire.Desc")} {t("Nav.ChessBase.Repertoire")}
      </Text>

      {error ? (
        <Alert color="red" title={t("Shell.Repertoire.LoadError")}>
          {String(error)}
        </Alert>
      ) : isLoading && !data ? (
        <Center flex={1}>
          <Loader />
        </Center>
      ) : files.length === 0 ? (
        <Center flex={1}>
          <Stack align="center" gap="xs">
            <IconBook size="3rem" stroke={1} aria-hidden="true" />
            <Text fw={500}>{t("Shell.Repertoire.Empty")}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={360}>
              {t("Shell.Repertoire.EmptyHint")}
            </Text>
            <Button
              variant="light"
              leftSection={<IconPlus size="1rem" />}
              onClick={() => setCreateOpened(true)}
            >
              {t("Shell.Repertoire.New")}
            </Button>
          </Stack>
        </Center>
      ) : (
        <ScrollArea flex={1} type="auto" offsetScrollbars>
          <Stack gap="xs">
            {files.map((file) => (
              <RepertoireRow key={file.path} file={file} onOpen={() => open(file)} />
            ))}
          </Stack>
        </ScrollArea>
      )}

      <NewRepertoireModal
        opened={createOpened}
        onClose={() => setCreateOpened(false)}
        documentDir={documentDir}
        onCreated={() => void mutate()}
      />
    </Stack>
  );
}
