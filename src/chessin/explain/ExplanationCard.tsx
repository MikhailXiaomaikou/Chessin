/**
 * One explanation as a Mantine card: evidence badge, the rendered sentence and
 * an optional "演示" button that hands the demo (fen + line + arrows) to the
 * caller, which plays it on a board.
 */
import { Badge, Button, Card, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconPlayerPlay } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { evidenceKey, langOf, renderExplanation } from "./render";
import type { EvidenceLevel, Explanation, ExplanationDemo, Severity } from "./types";

export type ExplanationCardProps = {
  explanation: Explanation;
  onDemo?: (demo: ExplanationDemo) => void;
  /** tighter padding for lists */
  compact?: boolean;
};

const EVIDENCE_COLOR: Record<EvidenceLevel, string> = {
  certain: "teal",
  likely: "blue",
  heuristic: "gray",
};

const SEVERITY_COLOR: Record<Severity, string> = {
  3: "var(--mantine-color-red-6)",
  2: "var(--mantine-color-orange-6)",
  1: "var(--mantine-color-gray-5)",
};

export function ExplanationCard({ explanation, onDemo, compact }: ExplanationCardProps) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.resolvedLanguage ?? i18n.language);
  const text = renderExplanation(explanation, t, lang);
  const demo = explanation.demo;
  const canDemo = demo !== undefined && onDemo !== undefined;

  return (
    <Card
      withBorder
      padding={compact ? "xs" : "sm"}
      radius="md"
      style={{ borderLeft: `3px solid ${SEVERITY_COLOR[explanation.severity]}` }}
      data-explanation-id={explanation.id}
      data-evidence={explanation.evidence}
    >
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Tooltip label={t(evidenceKey(explanation.evidence))} withArrow>
            <Badge
              size="sm"
              variant="light"
              color={EVIDENCE_COLOR[explanation.evidence]}
              style={{ flexShrink: 0 }}
            >
              {t(evidenceKey(explanation.evidence))}
            </Badge>
          </Tooltip>
          {canDemo && (
            <Button
              size="compact-xs"
              variant="subtle"
              leftSection={<IconPlayerPlay size={14} aria-hidden="true" />}
              onClick={() => onDemo(demo)}
            >
              {t("Explain.Demo")}
            </Button>
          )}
        </Group>
        <Text size="sm">{text}</Text>
      </Stack>
    </Card>
  );
}
