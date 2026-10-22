import {
  ActionIcon,
  Button,
  Combobox,
  Group,
  Loader,
  Menu,
  Pill,
  PillsInput,
  Popover,
  Stack,
  Text,
  TextInput,
  Tooltip,
  useCombobox,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconBookmark,
  IconChevronDown,
  IconDeviceFloppy,
  IconHelp,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR, { useSWRConfig } from "swr";
import type { GameQuery } from "@/bindings";
import { query_games } from "@/utils/db";
import { formatNumber } from "@/utils/format";
import { queryChipsAtomFamily } from "./chipsState";
import { describeChips, suggestRemoval } from "./describe";
import { type MappedQuery, toGameQuery } from "./mapping";
import {
  CHIP_KEYS,
  type Chip,
  KEY_ALIASES,
  KEY_ZH,
  type ParseError,
  parseQuery,
  resultLabelKey,
  sameChip,
} from "./parse";
import { createPlayerResolver } from "./resolvePlayer";
import {
  deleteSmartCollection,
  listSmartCollections,
  orderForDatabase,
  saveSmartCollection,
  type SmartCollection,
} from "./smartCollections";

export const SMART_COLLECTIONS_SWR_KEY = "smart-collections";

const HIT_COUNT_DEBOUNCE_MS = 300;

// Dynamic keys, listed for the extractor (removeUnusedKeys):
// t("Query.Key.player") t("Query.Key.white") t("Query.Key.black") t("Query.Key.elo")
// t("Query.Key.year") t("Query.Key.result") t("Query.Key.eco") t("Query.Key.event")
// t("Query.Key.tc") t("Query.Example.player") t("Query.Example.white")
// t("Query.Example.black") t("Query.Example.elo") t("Query.Example.year")
// t("Query.Example.result") t("Query.Example.eco") t("Query.Example.event")
// t("Query.Example.tc") t("Query.Error.unknown_key") t("Query.Error.empty_value")
// t("Query.Error.bad_number") t("Query.Error.bad_range") t("Query.Error.bad_result")
// t("Query.Error.bad_op")

type Props = {
  file: string;
  query: GameQuery;
  setQuery: (query: GameQuery) => void;
};

/**
 * Chip query bar above the games table (S3-3): free text → chips, live hit
 * count, zero-result hint, save / load smart collections. Feeds the table's
 * existing `GameQuery` (player / elo / year / result fields); chips for keys
 * `get_games` cannot filter on are shown dimmed and never sent.
 */
export function QueryBar(props: Props) {
  // Keyed by file so text, errors and the first-run guard reset per database.
  return <QueryBarInner key={props.file} {...props} />;
}

const RESULT_OPTIONS = ["1-0", "0-1", "1/2-1/2"] as const;

function lastToken(text: string): { head: string; token: string } {
  const m = /^([\s\S]*?)(\S*)$/.exec(text);
  return { head: m?.[1] ?? "", token: m?.[2] ?? "" };
}

function QueryBarInner({ file, query, setQuery }: Props) {
  const { t } = useTranslation();
  const { mutate: globalMutate } = useSWRConfig();
  const [chips, setChips] = useAtom(queryChipsAtomFamily(file));
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<ParseError[]>([]);
  const [mapped, setMapped] = useState<MappedQuery | null>(null);
  const [resolving, setResolving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Latest table query for the chips effect, without re-running it per query change.
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  // Set once the bar has written the query; until then an empty chip list
  // leaves the table's own filters alone (also under StrictMode's double run).
  const applied = useRef(false);

  const resolver = useMemo(() => createPlayerResolver(file), [file]);

  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });

  // Chips → the table's query. With no chips and nothing applied yet nothing
  // is written, so filters set through the side panel survive a remount.
  useEffect(() => {
    if (!applied.current && chips.length === 0) return;
    applied.current = true;
    let cancelled = false;
    setResolving(true);
    toGameQuery(chips, resolver)
      .then((next) => {
        if (cancelled) return;
        setMapped(next);
        const current = queryRef.current;
        setQuery({
          ...current,
          ...next.query,
          options: {
            skipCount: false,
            sort: "date",
            direction: "desc",
            pageSize: 25,
            ...current.options,
            page: 1,
          },
        });
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chips, resolver, setQuery]);

  // Live hit count: the same query, one row, with the count.
  const [debouncedMapped] = useDebouncedValue(mapped, HIT_COUNT_DEBOUNCE_MS);
  const hitKey =
    chips.length > 0 && debouncedMapped
      ? (["query-hits", file, debouncedMapped.query] as const)
      : null;
  const {
    data: hits,
    isLoading: counting,
    error: hitError,
  } = useSWR(hitKey, ([, db, q]) =>
    query_games(db, {
      ...q,
      options: { skipCount: false, page: 1, pageSize: 1, sort: "id", direction: "desc" },
    }),
  );
  const count = hits?.count ?? null;

  const { data: saved, mutate: mutateSaved } = useSWR(SMART_COLLECTIONS_SWR_KEY, () =>
    listSmartCollections(),
  );
  const savedOrdered = useMemo(() => orderForDatabase(saved ?? [], file), [saved, file]);

  const unsupported = mapped?.unsupported ?? [];
  const unresolved = mapped?.unresolved ?? [];
  const zero = chips.length > 0 && !counting && count === 0;
  const suggestion = zero ? suggestRemoval(chips, unresolved) : null;

  function focusInput() {
    inputRef.current?.focus();
  }

  function addChips(next: Chip[]) {
    const merged = chips.slice();
    for (const chip of next) {
      if (!merged.some((c) => sameChip(c, chip))) merged.push(chip);
    }
    setChips(merged);
  }

  function removeChip(chip: Chip) {
    setChips(chips.filter((c) => c !== chip));
  }

  /** Enter: parse the text; tokens that fail stay in the input with a message. */
  function commit(input: string) {
    const parsed = parseQuery(input);
    if (parsed.chips.length > 0) addChips(parsed.chips);
    setErrors(parsed.errors);
    setText(parsed.errors.map((e) => e.raw).join(" "));
    combobox.closeDropdown();
  }

  function editChip(chip: Chip) {
    removeChip(chip);
    setText((prev) => (prev.trim() ? `${prev.trim()} ${chip.raw}` : chip.raw));
    setErrors([]);
    focusInput();
  }

  // Completion: keys while the last token has no operator yet, result values
  // after `result:`.
  const { head, token } = lastToken(text);
  const tokenLower = token.toLowerCase();
  const resultKey = /^(result|res|结果):$/i.test(token);
  const keyOptions =
    !resultKey && !/[:<>"]/.test(token)
      ? CHIP_KEYS.filter((key) => {
          if (!tokenLower) return true;
          if (key.startsWith(tokenLower) || KEY_ZH[key].startsWith(token)) return true;
          return Object.entries(KEY_ALIASES).some(
            ([alias, target]) => target === key && alias.startsWith(tokenLower),
          );
        })
      : [];
  const options = resultKey
    ? RESULT_OPTIONS.map((value) => (
        <Combobox.Option value={`value:${value}`} key={value}>
          <Group gap="xs" wrap="nowrap">
            <Text size="sm">{t(resultLabelKey(value))}</Text>
            <Text size="xs" c="dimmed">
              {value}
            </Text>
          </Group>
        </Combobox.Option>
      ))
    : keyOptions.map((key) => (
        <Combobox.Option value={`key:${key}`} key={key}>
          <Group gap="xs" wrap="nowrap" justify="space-between">
            <Group gap="xs" wrap="nowrap">
              <Text size="sm">{t(`Query.Key.${key}`)}</Text>
              <Text size="xs" c="dimmed">
                {key}: · {KEY_ZH[key]}:
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              {t(`Query.Example.${key}`)}
            </Text>
          </Group>
        </Combobox.Option>
      ));

  function onOptionSubmit(value: string) {
    if (value.startsWith("key:")) {
      const key = value.slice(4);
      setText(`${head}${key}:`);
      setErrors([]);
      combobox.closeDropdown();
      focusInput();
      return;
    }
    if (value.startsWith("value:")) {
      commit(`${head}result:${value.slice(6)}`);
      focusInput();
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter") {
      // The combobox submits a highlighted option itself.
      if (combobox.dropdownOpened && combobox.getSelectedOptionIndex() !== -1) return;
      event.preventDefault();
      if (text.trim()) commit(text);
      return;
    }
    if (event.key === "Backspace" && text.length === 0 && chips.length > 0) {
      event.preventDefault();
      editChip(chips[chips.length - 1]);
      return;
    }
    if (event.key === "Escape") {
      combobox.closeDropdown();
    }
  }

  function chipState(chip: Chip): { state: string; hint: string | null; color?: string } {
    const u = unsupported.find((x) => x.chip === chip);
    if (u) {
      // t("Query.Unsupported") t("Query.ExtraPlayer") t("Query.Duplicate")
      const key =
        u.reason === "key"
          ? "Query.Unsupported"
          : u.reason === "extra_player"
            ? "Query.ExtraPlayer"
            : "Query.Duplicate";
      return { state: "unsupported", hint: t(key) };
    }
    if (unresolved.includes(chip)) {
      return {
        state: "unresolved",
        hint: t("Query.PlayerNotFound", { name: chip.value }),
        color: "red",
      };
    }
    return { state: "active", hint: null };
  }

  async function loadCollection(sc: SmartCollection) {
    setChips(sc.chips);
    setErrors([]);
    setText("");
  }

  async function removeCollection(sc: SmartCollection) {
    await deleteSmartCollection(sc.id);
    await mutateSaved();
    await globalMutate(SMART_COLLECTIONS_SWR_KEY);
  }

  return (
    <Stack gap={4} mb="sm" data-slot="query-bar">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Combobox store={combobox} onOptionSubmit={onOptionSubmit} withinPortal>
          <Combobox.DropdownTarget>
            <PillsInput
              style={{ flex: 1, minWidth: 0 }}
              size="sm"
              onClick={() => combobox.openDropdown()}
              rightSection={
                chips.length > 0 ? (
                  <Tooltip label={t("Query.Clear")} openDelay={400}>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="gray"
                      aria-label={t("Query.Clear")}
                      onClick={(event) => {
                        event.stopPropagation();
                        setChips([]);
                        setErrors([]);
                        setText("");
                      }}
                    >
                      <IconX size={14} />
                    </ActionIcon>
                  </Tooltip>
                ) : undefined
              }
            >
              <Pill.Group>
                {chips.map((chip, index) => {
                  const { state, hint, color } = chipState(chip);
                  const pill = (
                    <Pill
                      key={`${chip.raw}-${index}`}
                      withRemoveButton
                      onRemove={() => removeChip(chip)}
                      onClick={() => editChip(chip)}
                      removeButtonProps={{ "aria-label": t("Common.Remove") }}
                      data-chip-key={chip.key}
                      data-chip-state={state}
                      c={color}
                      style={{
                        cursor: "pointer",
                        opacity: state === "unsupported" ? 0.45 : 1,
                        textDecoration: state === "unsupported" ? "line-through" : undefined,
                      }}
                    >
                      {chip.raw}
                    </Pill>
                  );
                  return hint ? (
                    <Tooltip key={`${chip.raw}-${index}`} label={hint} openDelay={300}>
                      {pill}
                    </Tooltip>
                  ) : (
                    pill
                  );
                })}
                <Combobox.EventsTarget>
                  <PillsInput.Field
                    ref={inputRef}
                    value={text}
                    placeholder={chips.length === 0 ? t("Query.Placeholder") : undefined}
                    aria-label={t("Query.Placeholder")}
                    onChange={(event) => {
                      setText(event.currentTarget.value);
                      if (errors.length > 0) setErrors([]);
                      combobox.openDropdown();
                      combobox.updateSelectedOptionIndex();
                    }}
                    onFocus={() => combobox.openDropdown()}
                    onBlur={() => combobox.closeDropdown()}
                    onKeyDown={onKeyDown}
                  />
                </Combobox.EventsTarget>
              </Pill.Group>
            </PillsInput>
          </Combobox.DropdownTarget>
          <Combobox.Dropdown hidden={options.length === 0}>
            <Combobox.Options>{options}</Combobox.Options>
          </Combobox.Dropdown>
        </Combobox>

        <Group gap="xs" wrap="nowrap" pt={4}>
          {chips.length > 0 && (
            <Text
              size="sm"
              c={zero ? "red" : "dimmed"}
              data-slot="query-hits"
              style={{ whiteSpace: "nowrap" }}
            >
              {counting || resolving ? (
                <Group gap={4} wrap="nowrap" component="span">
                  <Loader size={10} />
                  {t("Query.Counting")}
                </Group>
              ) : hitError ? (
                t("Common.Error")
              ) : count !== null ? (
                t("Query.Hits", { n: formatNumber(count) })
              ) : null}
            </Text>
          )}

          <SaveButton
            disabled={chips.length === 0}
            defaultTitle={describeChips(chips, t)}
            onSave={async (title) => {
              await saveSmartCollection({ title, chips, dbPath: file });
              await mutateSaved();
              await globalMutate(SMART_COLLECTIONS_SWR_KEY);
              notifications.show({ message: t("Query.Save.Done", { title }) });
            }}
          />

          <Menu shadow="md" width={320} position="bottom-end" withinPortal>
            <Menu.Target>
              <Button
                variant="default"
                size="xs"
                leftSection={<IconBookmark size={14} />}
                rightSection={<IconChevronDown size={14} />}
              >
                {t("Query.Saved")}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {savedOrdered.length === 0 && (
                <Menu.Item disabled>{t("Query.Saved.Empty")}</Menu.Item>
              )}
              {savedOrdered.map((sc, index) => {
                const foreign = sc.dbPath !== file;
                const firstForeign =
                  foreign && (index === 0 || savedOrdered[index - 1].dbPath === file);
                return (
                  <div key={sc.id}>
                    {firstForeign && <Menu.Label>{t("Query.Saved.OtherDatabases")}</Menu.Label>}
                    <Menu.Item
                      onClick={() => void loadCollection(sc)}
                      rightSection={
                        // A span: Menu.Item is already a <button>.
                        <ActionIcon
                          component="span"
                          role="button"
                          size="xs"
                          variant="subtle"
                          color="gray"
                          aria-label={t("Common.Delete")}
                          onClick={(event) => {
                            event.stopPropagation();
                            void removeCollection(sc);
                          }}
                        >
                          <IconTrash size={12} />
                        </ActionIcon>
                      }
                    >
                      <Text size="sm" truncate>
                        {sc.title}
                      </Text>
                      <Text size="xs" c="dimmed" truncate>
                        {describeChips(sc.chips, t)}
                      </Text>
                    </Menu.Item>
                  </div>
                );
              })}
            </Menu.Dropdown>
          </Menu>

          <Tooltip label={t("Query.Help")} multiline w={360} openDelay={300}>
            <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t("Query.Help")}>
              <IconHelp size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {errors.length > 0 && (
        <Text size="xs" c="red" data-slot="query-errors">
          {errors.map((e) => t(`Query.Error.${e.reason}`, { raw: e.raw })).join(" · ")}
        </Text>
      )}
      {chips.length > 0 && (
        <Text size="xs" c="dimmed" data-slot="query-description">
          {describeChips(chips, t)}
        </Text>
      )}
      {zero && (
        <Group gap="xs" data-slot="query-zero-hint">
          <Text size="xs" c="dimmed">
            {suggestion
              ? t("Query.ZeroHint", { chip: suggestion.raw })
              : t("Query.ZeroHint.NoSuggestion")}
          </Text>
          {suggestion && (
            <Button size="compact-xs" variant="subtle" onClick={() => removeChip(suggestion)}>
              {t("Query.RemoveChip")}
            </Button>
          )}
        </Group>
      )}
    </Stack>
  );
}

function SaveButton({
  disabled,
  defaultTitle,
  onSave,
}: {
  disabled: boolean;
  defaultTitle: string;
  onSave: (title: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    const name = title.trim() || defaultTitle;
    if (!name) return;
    setBusy(true);
    try {
      await onSave(name);
      setOpened(false);
      setTitle("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={320}
      withArrow
      shadow="md"
      withinPortal
      trapFocus
    >
      <Popover.Target>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconDeviceFloppy size={14} />}
          disabled={disabled}
          onClick={() => setOpened((prev) => !prev)}
        >
          {t("Query.Save")}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <TextInput
            size="xs"
            label={t("Common.Name")}
            placeholder={defaultTitle}
            value={title}
            data-autofocus
            onChange={(event) => setTitle(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void save();
              }
            }}
          />
          <Group justify="flex-end" gap="xs">
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => setOpened(false)}
            >
              {t("Common.Cancel")}
            </Button>
            <Button size="compact-xs" loading={busy} onClick={() => void save()}>
              {t("Common.Save")}
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
