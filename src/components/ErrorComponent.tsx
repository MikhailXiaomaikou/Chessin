import { Anchor, Button, Code, CopyButton, Group, Stack, Text, Title } from "@mantine/core";
import { IconBrandGithub, IconClipboardCopy, IconReload } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MouseEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ISSUES_URL } from "@/chessin/config";
import { collectDiagnostics, describeError, useAppVersion } from "@/chessin/shell/diagnostics";

function openIssues(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  openUrl(ISSUES_URL).catch(() => window.open(ISSUES_URL, "_blank", "noopener"));
}

export default function ErrorComponent({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const version = useAppVersion();
  const { name, message, stack } = describeError(error);
  const diagnostics = collectDiagnostics(error, version);

  return (
    <Stack p="md" maw="48rem" data-chessin-selectable>
      <Title order={2}>{t("Error.Title")}</Title>
      <Text>{t("Errors.Page.Message")}</Text>

      <Group>
        <CopyButton value={diagnostics}>
          {({ copied, copy }) => (
            <Button
              leftSection={<IconClipboardCopy size={16} aria-hidden="true" />}
              color={copied ? "teal" : undefined}
              onClick={copy}
            >
              {copied ? t("Common.Copied") : t("Errors.Page.CopyDiagnostics")}
            </Button>
          )}
        </CopyButton>
        <Button
          variant="default"
          leftSection={<IconReload size={16} aria-hidden="true" />}
          onClick={() => navigate({ to: "/" }).then(() => window.location.reload())}
        >
          {t("Menu.View.Reload")}
        </Button>
      </Group>

      <Text size="sm">
        <IconBrandGithub size={14} aria-hidden="true" style={{ verticalAlign: "-2px" }} />{" "}
        <Trans
          i18nKey="Errors.Page.Report"
          components={{
            github: <Anchor href={ISSUES_URL} onClick={openIssues} />,
          }}
        />
      </Text>

      <Text size="sm" c="dimmed" mt="md">
        {t("Errors.Page.Details")}
      </Text>
      <Text size="sm" fw={600}>
        {name}: {message}
      </Text>
      {stack && (
        <Code block style={{ whiteSpace: "pre-wrap", maxHeight: "16rem", overflow: "auto" }}>
          {stack}
        </Code>
      )}
    </Stack>
  );
}
