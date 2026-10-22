import { Badge, Button, Loader, Menu, Tooltip } from "@mantine/core";
import { IconBolt, IconDatabaseImport, IconRefresh, IconTrash } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { jobsAtom } from "@/chessin/jobs/queue";
import {
  ensureIndex,
  findActiveIndexJob,
  indexDelete,
  isIndexAvailable,
  rebuildIndex,
  useIndexState,
} from "./index";
import { type IndexFallbackReason, MAX_INDEX_PLY } from "./mapping";

/**
 * The small index chip next to the source chip of the explorer (local
 * sources only): "未建索引 · 建索引（后台）" / "索引中 42%" / "索引 ✓ 12 ms".
 * Hidden while the build does not have the index commands (S3-1).
 */
export function IndexChip({
  dbPath,
  used,
  reason,
  ms,
}: {
  dbPath: string;
  /** The last explorer query was answered by the index. */
  used: boolean;
  /** Why it was not, when `used` is false. */
  reason: IndexFallbackReason | null;
  /** Lookup time of the last index query. */
  ms?: number;
}) {
  const { t } = useTranslation();
  const { state, progress } = useIndexState(dbPath);
  const jobs = useAtomValue(jobsAtom);
  const job = useMemo(() => findActiveIndexJob(jobs, dbPath), [jobs, dbPath]);

  if (!isIndexAvailable() || state === "unknown") return null;

  if (state === "none") {
    return (
      <Tooltip label={t("Explorer.Index.Tooltip.None")} multiline w={280} openDelay={400}>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          leftSection={<IconBolt size={12} />}
          onClick={() => void ensureIndex(dbPath)}
          data-index-state="none"
        >
          {t("Explorer.Index.None")} · {t("Explorer.Index.Build")}
        </Button>
      </Tooltip>
    );
  }

  if (state === "building") {
    const pct = Math.round(Math.max(job?.progress ?? 0, progress) * 100);
    const queued = job?.status === "queued";
    return (
      <Badge
        variant="light"
        color="blue"
        size="sm"
        tt="none"
        leftSection={<Loader size={10} />}
        data-index-state="building"
      >
        {queued ? t("Explorer.Index.Queued") : t("Explorer.Index.Building", { percent: pct })}
      </Badge>
    );
  }

  // Keys built below, kept for the extractor (removeUnusedKeys):
  // t("Explorer.Index.Reason.Partial") t("Explorer.Index.Reason.Ply")
  // t("Explorer.Index.Reason.Player") t("Explorer.Index.Reason.Dates")
  const reasonKey =
    reason === "partial"
      ? "Explorer.Index.Reason.Partial"
      : reason === "ply"
        ? "Explorer.Index.Reason.Ply"
        : reason === "player"
          ? "Explorer.Index.Reason.Player"
          : reason === "dates"
            ? "Explorer.Index.Reason.Dates"
            : null;

  return (
    <Menu shadow="md" width={220} position="bottom-start" withinPortal>
      <Menu.Target>
        <Button
          size="compact-xs"
          variant="light"
          color={used ? "green" : "gray"}
          leftSection={<IconDatabaseImport size={12} />}
          data-index-state="ready"
          data-index-used={used ? "1" : "0"}
        >
          {used && ms !== undefined
            ? t("Explorer.Index.Ready", { ms })
            : t("Explorer.Index.ReadyShort")}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {!used && reasonKey && (
          <Menu.Label style={{ whiteSpace: "normal" }}>
            {t("Explorer.Index.NotUsed", { reason: t(reasonKey, { plies: MAX_INDEX_PLY }) })}
          </Menu.Label>
        )}
        <Menu.Item
          leftSection={<IconRefresh size={14} />}
          onClick={() => void rebuildIndex(dbPath)}
        >
          {t("Explorer.Index.Rebuild")}
        </Menu.Item>
        <Menu.Item
          color="red"
          leftSection={<IconTrash size={14} />}
          onClick={() => void indexDelete(dbPath)}
        >
          {t("Explorer.Index.Delete")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export default IndexChip;
