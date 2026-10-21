import { Badge, Button, Menu } from "@mantine/core";
import {
  IconCheck,
  IconChevronDown,
  IconCloud,
  IconDatabase,
  IconSettings,
  IconStar,
  IconStarFilled,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { commands } from "@/bindings";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import { getDatabases } from "@/utils/db";
import { localSource, sameSource, type Source, sourceLabel, useResolvedSource } from "./sources";

const LICHESS_MASTERS: Source = { kind: "lichess-masters" };
const LICHESS: Source = { kind: "lichess" };

/**
 * The source chip (IA-3 v0): shows which source feeds the current tab's
 * explorer and lets the user switch between local collections and Lichess,
 * or make the choice the app-wide default. Replaces En Croissant's hidden
 * reference-database flag.
 */
export function SourceChip({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const offline = useAtomValue(offlineModeAtom);
  const { source, defaultSource, isDefault, setSource, setAsDefault } = useResolvedSource(tabId);
  // Same key as DatabasesPage so both share one cache entry.
  const { data: databases } = useSWR("databases", () => getDatabases());
  const localDbs = (databases ?? []).filter((d) => d.type === "success");

  // The user may have renamed the collection since the source was stored.
  const liveTitle =
    source.kind === "local" ? localDbs.find((d) => d.file === source.path)?.title : undefined;
  const label = liveTitle ?? sourceLabel(source, t);
  const isOnline = source.kind !== "local";

  async function choose(next: Source) {
    if (sameSource(next, source)) return;
    if (next.kind === "local") {
      // Drop the Rust-side cache of the previous local search.
      await commands.clearGames();
    }
    setSource(next);
  }

  const mark = (candidate: Source) => {
    const current = sameSource(candidate, source);
    const def = sameSource(candidate, defaultSource);
    if (!current && !def) return null;
    return (
      <>
        {def && <IconStarFilled size={12} opacity={0.6} />}
        {current && <IconCheck size={14} />}
      </>
    );
  };

  return (
    <Menu shadow="md" width={280} position="bottom-start" withinPortal>
      <Menu.Target>
        <Button
          variant="default"
          size="xs"
          leftSection={isOnline ? <IconCloud size={14} /> : <IconDatabase size={14} />}
          rightSection={
            <>
              {offline && isOnline && (
                <Badge size="xs" color="gray" variant="light" mr={4}>
                  {t("Sources.OfflineShort")}
                </Badge>
              )}
              <IconChevronDown size={14} />
            </>
          }
          aria-label={t("Sources.Source")}
          styles={{ label: { overflow: "hidden", textOverflow: "ellipsis" } }}
          maw={260}
        >
          {label}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t("Sources.LocalCollections")}</Menu.Label>
        {localDbs.length === 0 && <Menu.Item disabled>{t("Sources.NoLocalCollections")}</Menu.Item>}
        {localDbs.map((db) => {
          const candidate = localSource(db.file, db.title);
          return (
            <Menu.Item
              key={db.file}
              leftSection={<IconDatabase size={14} />}
              rightSection={mark(candidate)}
              onClick={() => choose(candidate)}
            >
              {db.title || db.filename}
            </Menu.Item>
          );
        })}
        <Menu.Item
          leftSection={<IconSettings size={14} />}
          onClick={() => navigate({ to: "/databases" })}
        >
          {t("Sources.ManageCollections")}
        </Menu.Item>

        <Menu.Divider />
        <Menu.Label>{t("Sources.Online")}</Menu.Label>
        <Menu.Item
          leftSection={<IconCloud size={14} />}
          rightSection={mark(LICHESS_MASTERS)}
          onClick={() => choose(LICHESS_MASTERS)}
        >
          {t("Sources.LichessMasters")}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconCloud size={14} />}
          rightSection={mark(LICHESS)}
          onClick={() => choose(LICHESS)}
        >
          {t("Sources.LichessMyLevel")}
        </Menu.Item>

        <Menu.Divider />
        <Menu.Item leftSection={<IconStar size={14} />} disabled={isDefault} onClick={setAsDefault}>
          {isDefault ? t("Sources.IsDefault") : t("Sources.SetAsDefault")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export default SourceChip;
