import { Button, Group, Modal, NumberInput, SimpleGrid, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { sourceLabel } from "./format";
import {
  CATCH_UP_FACTOR_MAX,
  CATCH_UP_FACTOR_MIN,
  DEFAULT_QUEUE_SETTINGS,
  MINUTES_CAP_MAX,
  MINUTES_CAP_MIN,
  NEW_PER_DAY_MAX,
  QUEUE_SOURCES,
  type QueueSettings,
  type QueueSource,
  WEIGHT_MAX,
} from "./model";
import {
  loadQueueSettings,
  queueSettingsAtom,
  queueSettingsOpenAtom,
  registerQueueSettingsMount,
  saveQueueSettings,
} from "./settings";

/**
 * `queue.settings`: minutes per session (5–60), new cards per day, one
 * weight per source and the catch-up threshold. Mounted by the Today card
 * and the notebook page; opened through `queueSettingsOpenAtom`.
 */
export default function QueueSettingsModal() {
  const { t } = useTranslation();
  const [opened, setOpened] = useAtom(queueSettingsOpenAtom);
  const settings = useAtomValue(queueSettingsAtom);
  const [draft, setDraft] = useState<QueueSettings>(settings);
  const [busy, setBusy] = useState(false);

  useEffect(() => registerQueueSettingsMount(), []);

  useEffect(() => {
    if (!opened) return;
    let alive = true;
    loadQueueSettings()
      .then((loaded) => {
        if (alive) setDraft(loaded);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [opened]);

  const num = (value: string | number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;

  async function save() {
    setBusy(true);
    try {
      await saveQueueSettings(draft);
      notifications.show({ message: t("Queue.Settings.Saved") });
      setOpened(false);
    } catch (e) {
      notifications.show({
        color: "red",
        message: t("Queue.Settings.SaveFailed", { error: String(e) }),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={() => setOpened(false)}
      title={t("Queue.Settings.Title")}
      centered
    >
      <Stack gap="sm">
        <NumberInput
          label={t("Queue.Settings.MinutesCap")}
          description={t("Queue.Settings.MinutesCap.Desc")}
          min={MINUTES_CAP_MIN}
          max={MINUTES_CAP_MAX}
          step={5}
          value={draft.minutesCap}
          onChange={(v) =>
            setDraft((d) => ({ ...d, minutesCap: num(v, DEFAULT_QUEUE_SETTINGS.minutesCap) }))
          }
          data-testid="queue-settings-cap"
        />
        <NumberInput
          label={t("Queue.Settings.NewPerDay")}
          description={t("Queue.Settings.NewPerDay.Desc")}
          min={0}
          max={NEW_PER_DAY_MAX}
          value={draft.newPerDay}
          onChange={(v) =>
            setDraft((d) => ({ ...d, newPerDay: num(v, DEFAULT_QUEUE_SETTINGS.newPerDay) }))
          }
        />
        <div>
          <Text size="sm" fw={500}>
            {t("Queue.Settings.Weights")}
          </Text>
          <Text size="xs" c="dimmed">
            {t("Queue.Settings.Weights.Desc")}
          </Text>
          <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs" mt={4}>
            {QUEUE_SOURCES.map((source: QueueSource) => (
              <NumberInput
                key={source}
                label={sourceLabel(source, t)}
                size="xs"
                min={0}
                max={WEIGHT_MAX}
                step={0.5}
                decimalScale={1}
                value={draft.weights[source]}
                onChange={(v) =>
                  setDraft((d) => ({
                    ...d,
                    weights: { ...d.weights, [source]: num(v, 1) },
                  }))
                }
              />
            ))}
          </SimpleGrid>
        </div>
        <NumberInput
          label={t("Queue.Settings.CatchUpFactor")}
          description={t("Queue.Settings.CatchUpFactor.Desc")}
          min={CATCH_UP_FACTOR_MIN}
          max={CATCH_UP_FACTOR_MAX}
          step={0.5}
          decimalScale={1}
          value={draft.catchUpFactor}
          onChange={(v) =>
            setDraft((d) => ({
              ...d,
              catchUpFactor: num(v, DEFAULT_QUEUE_SETTINGS.catchUpFactor),
            }))
          }
        />
        <Group justify="space-between" mt="xs">
          <Button variant="subtle" size="xs" onClick={() => setDraft(DEFAULT_QUEUE_SETTINGS)}>
            {t("Common.Reset")}
          </Button>
          <Group gap="xs">
            <Button variant="default" onClick={() => setOpened(false)} disabled={busy}>
              {t("Common.Cancel")}
            </Button>
            <Button onClick={() => void save()} loading={busy}>
              {t("Common.Save")}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
