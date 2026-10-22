import { ActionIcon, Box, Divider, Group, SimpleGrid, Stack, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowRight, IconFilter, IconTrash } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import type { DatabaseInfo } from "@/bindings";
import GenericCard from "@/components/common/GenericCard";
import { useActiveDatabaseViewStore } from "@/state/store/database";
import { setQueryChips } from "./chipsState";
import { describeChips } from "./describe";
import { findSmartCollectionDatabase, openSmartCollection } from "./openSmartCollection";
import { SMART_COLLECTIONS_SWR_KEY } from "./QueryBar";
import {
  deleteSmartCollection,
  listSmartCollections,
  type SmartCollection,
} from "./smartCollections";

/**
 * "智能棋谱集" cards under the database list on DatabasesPage. Double-click
 * (or the arrow) opens the games table of the collection's database with the
 * saved chips applied. Renders nothing while there are no collections.
 */
export function SmartCollectionCards({ databases }: { databases: DatabaseInfo[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setDatabase = useActiveDatabaseViewStore((s) => s.setDatabase);
  const { data, mutate } = useSWR(SMART_COLLECTIONS_SWR_KEY, () => listSmartCollections());
  const [selected, setSelected] = useState<string | null>(null);

  const collections = data ?? [];
  if (collections.length === 0) return null;

  function open(sc: SmartCollection) {
    const result = openSmartCollection(sc, databases, {
      setDatabase,
      setChips: setQueryChips,
      navigate: (opts) => navigate(opts),
    });
    if (result.status === "missing_db") {
      notifications.show({
        color: "yellow",
        message: t("Query.SmartCollection.MissingDb", { path: result.dbPath }),
      });
    }
  }

  async function remove(sc: SmartCollection) {
    await deleteSmartCollection(sc.id);
    await mutate();
  }

  return (
    <Stack gap="xs" p="xs" data-slot="smart-collections">
      <Divider
        label={
          <Tooltip label={t("Query.SmartCollections.Hint")} openDelay={400}>
            <span>{t("Query.SmartCollections")}</span>
          </Tooltip>
        }
        labelPosition="left"
      />
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing={{ base: "md", md: "sm" }}>
        {collections.map((sc) => {
          const db = findSmartCollectionDatabase(sc.dbPath, databases);
          return (
            <GenericCard
              key={sc.id}
              id={sc.id}
              isSelected={selected === sc.id}
              setSelected={setSelected}
              error={db ? "" : t("Query.SmartCollection.MissingDb", { path: sc.dbPath })}
              onDoubleClick={() => open(sc)}
              Header={
                <Group wrap="nowrap" justify="space-between" align="flex-start">
                  <Group wrap="nowrap" miw={0} align="flex-start">
                    <IconFilter size="1.5rem" />
                    <Box miw={0}>
                      <Text fw={500} fz="sm" truncate>
                        {sc.title}
                      </Text>
                      <Text size="xs" c="dimmed" style={{ wordWrap: "break-word" }}>
                        {describeChips(sc.chips, t)}
                      </Text>
                    </Box>
                  </Group>
                  <Group gap={4} wrap="nowrap">
                    <Tooltip label={t("Common.Open")} openDelay={400}>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label={t("Common.Open")}
                        disabled={!db}
                        onClick={(event) => {
                          event.stopPropagation();
                          open(sc);
                        }}
                      >
                        <IconArrowRight size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t("Common.Delete")} openDelay={400}>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label={t("Common.Delete")}
                        onClick={(event) => {
                          event.stopPropagation();
                          void remove(sc);
                        }}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Group>
              }
              stats={[
                {
                  label: t("Query.SmartCollection.Database"),
                  value: db ? db.title : t("Common.Unknown"),
                },
              ]}
            />
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}
