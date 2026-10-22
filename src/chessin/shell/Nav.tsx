import { Stack, Text, Tooltip } from "@mantine/core";
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from "@tabler/icons-react";
import { Link, useRouterState } from "@tanstack/react-router";
import cx from "clsx";
import { useAtom, useAtomValue, useStore } from "jotai";
import { type MouseEvent, type ReactNode, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { focusWorkspace, useOpenInWorkspace } from "@/chessin/workspace/openInWorkspace";
import { activeTabAtom, showSidebarAtom, tabsAtom } from "@/state/atoms";
import classes from "./Nav.module.css";
import { NAV_ITEMS, NAV_PINNED, type NavItem, navIdForPath } from "./navItems";

const TOOLTIP_EVENTS = { hover: true, focus: true, touch: false } as const;

function RowTooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip label={label} position="right" events={TOOLTIP_EVENTS} multiline maw={260}>
      {children}
    </Tooltip>
  );
}

function NavRow({
  item,
  active,
  collapsed,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { t } = useTranslation();
  const Icon = item.icon;
  const label = t(item.labelKey);
  const hints = item.chessBaseKeys?.map((key) => t(key)) ?? [];

  const link = (
    <Link
      to={item.to}
      data-nav={item.id}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cx(classes.row, {
        [classes.active]: active,
        [classes.collapsed]: collapsed,
        [classes.child]: item.child,
      })}
      onClick={onClick}
    >
      <Icon size="1.25rem" stroke={1.5} aria-hidden="true" className={classes.icon} />
      {!collapsed && <span className={classes.label}>{label}</span>}
    </Link>
  );

  if (!collapsed && hints.length === 0) return link;
  return (
    <RowTooltip
      label={
        <Stack gap={2}>
          {collapsed && <Text size="sm">{label}</Text>}
          {hints.map((line) => (
            <Text key={line} size="xs" className={classes.hint}>
              {line}
            </Text>
          ))}
        </Stack>
      }
    >
      {link}
    </RowTooltip>
  );
}

/**
 * Chessin shell (S3-6): the left navigation. Six positions with text labels
 * (主页 / 棋谱库 + 文件 / 棋盘 / 开局体系 / 训练 / 棋手), 引擎 and 设置
 * pinned at the bottom, and a toggle that collapses the rows to icons — the
 * same `showSidebarAtom` the View menu and `mod+shift+b` flip.
 *
 * Rows carry `data-nav="<id>"` and a stable `aria-label` (the visible label).
 */
export default function Nav() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useAtom(showSidebarAtom);
  const collapsed = !expanded;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tabs = useAtomValue(tabsAtom);
  const activeTabId = useAtomValue(activeTabAtom);
  const store = useStore();
  const openInWorkspace = useOpenInWorkspace();

  const activeTab = tabs.find((tab) => tab.value === activeTabId);
  const activeTabIsNew = !activeTab || activeTab.type === "new";
  const activeId = navIdForPath(pathname, activeTabIsNew);

  // 主页: the new-tab home. Reuse an open "new" tab, otherwise open one.
  const openHome = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      const existing = store.get(tabsAtom).find((tab) => tab.type === "new");
      if (existing) {
        store.set(activeTabAtom, existing.value);
        focusWorkspace();
      } else {
        void openInWorkspace({ tab: { name: t("Tab.NewTab"), type: "new" } });
      }
    },
    [openInWorkspace, store, t],
  );

  // 棋盘: the current board, the most recent board, or a fresh analysis board.
  const openBoard = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      const open = store.get(tabsAtom);
      const current = open.find((tab) => tab.value === store.get(activeTabAtom));
      if (current && current.type !== "new") {
        focusWorkspace();
        return;
      }
      const last = [...open].reverse().find((tab) => tab.type !== "new");
      if (last) {
        store.set(activeTabAtom, last.value);
        focusWorkspace();
        return;
      }
      void openInWorkspace({ tab: { name: t("Home.Card.AnalysisBoard.Title"), type: "analysis" } });
    },
    [openInWorkspace, store, t],
  );

  const handlerFor = (item: NavItem) => {
    if (item.id === "home") return openHome;
    if (item.id === "board") return openBoard;
    return undefined;
  };

  const toggleLabel = expanded ? t("Nav.Collapse") : t("Nav.Expand");
  const ToggleIcon = expanded ? IconLayoutSidebarLeftCollapse : IconLayoutSidebarLeftExpand;
  const toggle = (
    <button
      type="button"
      data-nav="toggle"
      aria-label={toggleLabel}
      aria-expanded={expanded}
      className={cx(classes.row, { [classes.collapsed]: collapsed })}
      onClick={() => setExpanded((prev) => !prev)}
    >
      <ToggleIcon size="1.25rem" stroke={1.5} aria-hidden="true" className={classes.icon} />
      {!collapsed && <span className={classes.label}>{toggleLabel}</span>}
    </button>
  );

  return (
    <div className={classes.nav} data-chessin-nav data-collapsed={collapsed || undefined}>
      <div className={classes.main}>
        {NAV_ITEMS.map((item) => (
          <NavRow
            key={item.id}
            item={item}
            active={activeId === item.id}
            collapsed={collapsed}
            onClick={handlerFor(item)}
          />
        ))}
      </div>
      <div className={classes.bottom}>
        {NAV_PINNED.map((item) => (
          <NavRow key={item.id} item={item} active={activeId === item.id} collapsed={collapsed} />
        ))}
        {collapsed ? <RowTooltip label={toggleLabel}>{toggle}</RowTooltip> : toggle}
      </div>
    </div>
  );
}
