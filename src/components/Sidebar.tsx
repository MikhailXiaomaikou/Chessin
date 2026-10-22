"use no memo";
import { AppShellSection, Stack, Tooltip } from "@mantine/core";
import {
  type Icon,
  IconChess,
  IconCpu,
  IconDatabase,
  IconFiles,
  IconNotebook,
  IconSettings,
  IconUser,
} from "@tabler/icons-react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import cx from "clsx";
import { useTranslation } from "react-i18next";
import classes from "./Sidebar.module.css";

interface NavbarLinkProps {
  icon: Icon;
  label: string;
  url: string;
  active?: boolean;
}

function NavbarLink({ url, icon: Icon, label }: NavbarLinkProps) {
  const match = useMatchRoute();
  const active = match({ to: url, fuzzy: true }) !== false;
  return (
    // Icon-only link: the translated name is the accessible name, and the
    // tooltip also opens on keyboard focus so sighted keyboard users see it.
    <Tooltip label={label} position="right" events={{ hover: true, focus: true, touch: false }}>
      <Link
        to={url}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cx(classes.link, { [classes.active]: active })}
      >
        <Icon size="1.5rem" stroke={1.5} aria-hidden="true" />
      </Link>
    </Tooltip>
  );
}

const linksdata: { icon: Icon; label: string; url: string; i18nKey?: string }[] = [
  { icon: IconChess, label: "Board", url: "/" },
  { icon: IconUser, label: "User", url: "/accounts" },
  { icon: IconFiles, label: "Files", url: "/files" },
  {
    icon: IconDatabase,
    label: "Databases",
    url: "/databases",
  },
  { icon: IconCpu, label: "Engines", url: "/engines" },
  // Chessin: mistake notebook (S2-5); its name lives under `Notebook.Title`.
  { icon: IconNotebook, label: "Notebook", url: "/notebook", i18nKey: "Notebook.Title" },
];

export function SideBar() {
  const { t } = useTranslation();

  const links = linksdata.map((link) => (
    <NavbarLink
      icon={link.icon}
      url={link.url}
      label={t(link.i18nKey ?? `SideBar.${link.label}`)}
      key={link.label}
    />
  ));

  return (
    <>
      <AppShellSection grow>
        <Stack justify="center" gap={0}>
          {links}
        </Stack>
      </AppShellSection>
      <AppShellSection>
        <Stack justify="center" gap={0}>
          <NavbarLink icon={IconSettings} label={t("SideBar.Settings")} url="/settings" />
        </Stack>
      </AppShellSection>
    </>
  );
}
