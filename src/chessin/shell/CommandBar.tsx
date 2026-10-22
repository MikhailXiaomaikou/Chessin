import { ActionIcon, Box, Group, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconArrowLeft, IconArrowRight, IconChevronRight, IconSearch } from "@tabler/icons-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { openCommandPalette } from "@/chessin/commands/paletteAtom";
import ShortcutKbd from "@/chessin/keymap/ShortcutKbd";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import classes from "./CommandBar.module.css";
import { navIdForPath, navItemById } from "./navItems";
import { useShellHistory } from "./useShellHistory";

/** Height of the bar in px; `__root.tsx` reserves exactly this much in the AppShell header. */
export const COMMAND_BAR_HEIGHT = 36;

type Crumb = { label: string; to?: string };

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Chessin shell (S3-6): the slim command bar under the menu bar — back /
 * forward, a breadcrumb "page › tab" and a search-shaped button that opens the
 * palette ("搜索或命令  Ctrl/⌘+K"). Hidden below Mantine's `sm` breakpoint.
 * It also hosts the shell history binding (`useShellHistory`).
 */
export function CommandBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const keyMap = useAtomValue(keyMapAtom);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tabs = useAtomValue(tabsAtom);
  const activeTabId = useAtomValue(activeTabAtom);
  const { back, forward, canBack, canForward } = useShellHistory();

  const activeTab = tabs.find((tab) => tab.value === activeTabId) ?? null;
  const activeTabIsNew = !activeTab || activeTab.type === "new";
  const navId = navIdForPath(pathname, activeTabIsNew);
  const page = navId ? navItemById(navId) : null;

  const crumbs: Crumb[] = [];
  if (page) crumbs.push({ label: t(page.labelKey), to: page.to });
  if (navId === "board" && activeTab) {
    crumbs.push({ label: activeTab.name });
  } else if (page && page.to !== "/" && pathname.length > page.to.length + 1) {
    crumbs.push({ label: safeDecode(pathname.slice(page.to.length + 1)) });
  }

  const historyButton = (
    direction: "back" | "forward",
    enabled: boolean,
    onClick: () => void,
    keys: string,
  ) => {
    const label = direction === "back" ? t("Shell.Back") : t("Shell.Forward");
    const Icon = direction === "back" ? IconArrowLeft : IconArrowRight;
    return (
      <Tooltip
        label={
          <Group gap={6} wrap="nowrap">
            <span>{label}</span>
            <ShortcutKbd keys={keys} />
          </Group>
        }
        openDelay={400}
      >
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={label}
          data-nav={direction}
          disabled={!enabled}
          onClick={onClick}
        >
          <Icon size={16} aria-hidden="true" />
        </ActionIcon>
      </Tooltip>
    );
  };

  return (
    <Box
      role="toolbar"
      aria-label={t("Shell.CommandBar")}
      data-chessin-command-bar
      visibleFrom="sm"
      h={COMMAND_BAR_HEIGHT}
      px="xs"
      className={classes.bar}
    >
      <Group gap={2} wrap="nowrap" className={classes.left}>
        {historyButton("back", canBack, back, keyMap.NAV_BACK.keys)}
        {historyButton("forward", canForward, forward, keyMap.NAV_FORWARD.keys)}
        <nav aria-label={t("Shell.Breadcrumb")} className={classes.crumbs} data-chessin-breadcrumb>
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            return (
              <Fragment key={`${i}-${crumb.label}`}>
                {i > 0 && (
                  <IconChevronRight size={12} aria-hidden="true" className={classes.separator} />
                )}
                {last ? (
                  <Text span size="sm" className={classes.current} aria-current="page">
                    {crumb.label}
                  </Text>
                ) : (
                  <button
                    type="button"
                    className={classes.crumb}
                    onClick={() => crumb.to && navigate({ to: crumb.to })}
                  >
                    {crumb.label}
                  </button>
                )}
              </Fragment>
            );
          })}
        </nav>
      </Group>
      <UnstyledButton
        className={classes.search}
        onClick={() => openCommandPalette()}
        data-chessin-command-search
        aria-label={t("Shell.SearchOrCommand")}
      >
        <IconSearch size={14} aria-hidden="true" />
        <Text span size="xs" className={classes.searchLabel}>
          {t("Shell.SearchOrCommand")}
        </Text>
        <ShortcutKbd keys={keyMap.COMMAND_PALETTE.keys} />
      </UnstyledButton>
      <div />
    </Box>
  );
}
