import { Group, NumberInput, SegmentedControl, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { Session } from "@/utils/session";
import {
  DEFAULT_COLD_THRESHOLD,
  DEFAULT_COVERAGE_TARGET,
  DEFAULT_DEPTH_MOVES,
  inferDefaults,
  type PlayerColor,
  type RatingSource,
  type RepertoireMeta,
  type TimeControl,
} from "./model";

/**
 * The repertoire settings a check depends on: rating source and band, time
 * control, coverage target and (optionally) depth. Shared by
 * `CreateRepertoireModal` and the check panel's settings popover.
 */

export type MetaDraft = Pick<
  RepertoireMeta,
  "eloRange" | "ratingSource" | "timeControl" | "coverageTarget"
> & { depth?: number };

export function draftFromMeta(meta: MetaDraft): MetaDraft {
  return {
    eloRange: [meta.eloRange[0], meta.eloRange[1]],
    ratingSource: meta.ratingSource,
    timeControl: meta.timeControl,
    coverageTarget: meta.coverageTarget,
    depth: meta.depth,
  };
}

/** Fields for a new repertoire, inferred from the linked accounts. */
export function newRepertoireDraft(sessions: readonly Session[]): MetaDraft {
  const inferred = inferDefaults(sessions);
  return {
    eloRange: inferred.eloRange,
    ratingSource: inferred.ratingSource,
    timeControl: inferred.timeControl,
    coverageTarget: DEFAULT_COVERAGE_TARGET,
    depth: DEFAULT_DEPTH_MOVES,
  };
}

export function metaFromDraft(
  draft: MetaDraft,
  color: PlayerColor,
  startFen: string,
): RepertoireMeta {
  return {
    color,
    startFen,
    eloRange: [draft.eloRange[0], draft.eloRange[1]],
    ratingSource: draft.ratingSource,
    timeControl: draft.timeControl,
    coverageTarget: draft.coverageTarget,
    coldThreshold: DEFAULT_COLD_THRESHOLD,
    depth: draft.depth ?? DEFAULT_DEPTH_MOVES,
  };
}

function toInt(value: string | number, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function RepertoireMetaFields({
  value,
  onChange,
  showDepth = false,
  size = "sm",
}: {
  value: MetaDraft;
  onChange: (next: MetaDraft) => void;
  showDepth?: boolean;
  size?: "xs" | "sm";
}) {
  const { t } = useTranslation();
  const masters = value.ratingSource === "fide";
  const [lo, hi] = value.eloRange;

  return (
    <Stack gap="xs">
      <div>
        <Text size={size} fw={500} mb={4}>
          {t("Repertoire.Settings.RatingSource")}
        </Text>
        <SegmentedControl
          fullWidth
          size={size}
          value={value.ratingSource}
          onChange={(v) => onChange({ ...value, ratingSource: v as RatingSource })}
          data={[
            { label: t("Repertoire.Settings.RatingSource.Lichess"), value: "lichess" },
            { label: t("Repertoire.Settings.RatingSource.Fide"), value: "fide" },
          ]}
        />
      </div>

      <div>
        <Text size={size} fw={500} mb={4}>
          {t("Repertoire.Settings.EloRange")}
        </Text>
        <Group gap="xs" grow>
          <NumberInput
            size={size}
            aria-label={t("Repertoire.Settings.EloFrom")}
            value={lo}
            min={0}
            max={3200}
            step={100}
            disabled={masters}
            onChange={(v) => onChange({ ...value, eloRange: [toInt(v, lo), hi] })}
          />
          <NumberInput
            size={size}
            aria-label={t("Repertoire.Settings.EloTo")}
            value={hi}
            min={0}
            max={3200}
            step={100}
            disabled={masters}
            onChange={(v) => onChange({ ...value, eloRange: [lo, toInt(v, hi)] })}
          />
        </Group>
      </div>

      <div>
        <Text size={size} fw={500} mb={4}>
          {t("Repertoire.Settings.TimeControl")}
        </Text>
        <SegmentedControl
          fullWidth
          size={size}
          disabled={masters}
          value={value.timeControl}
          onChange={(v) => onChange({ ...value, timeControl: v as TimeControl })}
          data={[
            { label: t("Repertoire.Settings.TimeControl.Classical"), value: "classical" },
            { label: t("Repertoire.Settings.TimeControl.Rapid"), value: "rapid" },
            { label: t("Repertoire.Settings.TimeControl.Blitz"), value: "blitz" },
          ]}
        />
      </div>

      <NumberInput
        size={size}
        label={t("Repertoire.Settings.CoverageTarget")}
        description={t("Repertoire.Settings.CoverageTargetDesc")}
        prefix="1/"
        value={value.coverageTarget}
        min={2}
        max={10000}
        step={10}
        onChange={(v) =>
          onChange({ ...value, coverageTarget: Math.max(2, toInt(v, value.coverageTarget)) })
        }
      />

      {showDepth && (
        <NumberInput
          size={size}
          label={t("Repertoire.Settings.Depth")}
          value={value.depth ?? DEFAULT_DEPTH_MOVES}
          min={1}
          max={30}
          onChange={(v) =>
            onChange({
              ...value,
              depth: Math.min(30, Math.max(1, toInt(v, value.depth ?? DEFAULT_DEPTH_MOVES))),
            })
          }
        />
      )}
    </Stack>
  );
}
