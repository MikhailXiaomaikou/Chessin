import { Button, Group, Tooltip } from "@mantine/core";
import { IconPencilQuestion, IconQuestionMark } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { annotateFirstFamily, toggleAnnotateFirst } from "@/chessin/annotateFirst/mode";
import type { Review } from "@/chessin/review/model";
import { startGuessForActiveTab } from "./commands";

/**
 * The two S4-6 entry points shown in the review panel's header: 猜着 (starts
 * a guess-the-move session for the tab's game) and 先自己注释 (toggles the
 * annotate-first mode). One line to mount; everything else lives here.
 */
export default function ReviewModeButtons({
  tabId,
  review,
}: {
  tabId: string;
  review: Review | null;
}) {
  const { t } = useTranslation();
  const annotateFirst = useAtomValue(annotateFirstFamily(tabId));
  return (
    <Group gap="xs" wrap="nowrap">
      <Tooltip label={t("Guess.Start.Desc")}>
        <Button
          size="compact-xs"
          variant="light"
          leftSection={<IconQuestionMark size="0.8rem" />}
          onClick={() => void startGuessForActiveTab({ review })}
          data-testid="guess-start"
        >
          {t("Guess.Start")}
        </Button>
      </Tooltip>
      <Tooltip label={t("AnnotateFirst.Desc")}>
        <Button
          size="compact-xs"
          variant={annotateFirst ? "filled" : "light"}
          leftSection={<IconPencilQuestion size="0.8rem" />}
          onClick={() => toggleAnnotateFirst(tabId)}
          data-testid="annotate-first-toggle"
        >
          {t("AnnotateFirst.Toggle")}
        </Button>
      </Tooltip>
    </Group>
  );
}
