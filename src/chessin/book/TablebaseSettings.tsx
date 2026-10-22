import { Button, Group, Stack, Switch, Text } from "@mantine/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useAtom, useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { commands } from "@/chessin/bindings";
import FileInput from "@/components/common/FileInput";
import { enginesAtom } from "@/state/atoms";
import { registerBookCommands } from "./commands";
import { applySyzygyPath, engineSyzygyAtom, tablebaseDirAtom } from "./tablebase";

// The settings page is another route the palette can be opened from.
registerBookCommands();

/**
 * The "残局库目录（Syzygy）" settings row (S4-4): directory picker, a status
 * line from `tablebase_status` ("找到 N 个文件，最多 M 子") and the
 * "引擎使用本地残局库" toggle, which writes `SyzygyPath` into every local
 * engine's UCI settings (see `applySyzygyPath`).
 */
export function TablebaseSettings() {
  const { t } = useTranslation();
  const [dir, setDir] = useAtom(tablebaseDirAtom);
  const [engineSyzygy, setEngineSyzygy] = useAtom(engineSyzygyAtom);
  const setEngines = useSetAtom(enginesAtom);
  const { data: status } = useSWR(
    dir ? ["tablebase-status", dir] : null,
    ([, d]) => commands.tablebaseStatus(d),
    { revalidateOnFocus: false },
  );

  const applyToEngines = (enabled: boolean, nextDir: string | null) => {
    setEngineSyzygy(enabled);
    setEngines(async (prev) => applySyzygyPath(await prev, enabled ? nextDir : null));
  };

  const choose = async () => {
    const selected = await open({ multiple: false, directory: true });
    if (!selected || typeof selected !== "string") return;
    setDir(selected);
    if (engineSyzygy) applyToEngines(true, selected);
  };

  const clear = () => {
    setDir(null);
    if (engineSyzygy) applyToEngines(false, null);
  };

  let statusLine: React.ReactNode = null;
  if (dir && status) {
    if (status.status === "error") {
      statusLine = (
        <Text c="red" fz="xs">
          {t("Tablebase.StatusError", { error: status.error })}
        </Text>
      );
    } else if (status.data.files === 0) {
      statusLine = (
        <Text c="dimmed" fz="xs">
          {t("Tablebase.StatusNone")}
        </Text>
      );
    } else {
      statusLine = (
        <Text c="dimmed" fz="xs">
          {t("Tablebase.Status", { files: status.data.files, pieces: status.data.pieces })}
        </Text>
      );
    }
  }

  return (
    <Stack gap="xs" miw={260}>
      <Group gap="xs" wrap="nowrap" align="flex-end">
        <FileInput onClick={choose} filename={dir ?? t("Tablebase.NotSet")} style={{ flex: 1 }} />
        {dir && (
          <Button variant="subtle" size="xs" onClick={clear}>
            {t("Tablebase.Clear")}
          </Button>
        )}
      </Group>
      {statusLine}
      <Switch
        label={t("Tablebase.EngineToggle")}
        description={t("Tablebase.EngineToggle.Desc")}
        checked={engineSyzygy && dir !== null}
        disabled={dir === null}
        onChange={(e) => applyToEngines(e.currentTarget.checked, dir)}
      />
    </Stack>
  );
}

export default TablebaseSettings;
