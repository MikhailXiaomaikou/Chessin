import { Button, Modal, SegmentedControl, Stack, Text, TextInput } from "@mantine/core";
import { useLoaderData } from "@tanstack/react-router";
import { INITIAL_FEN } from "chessops/fen";
import { useAtomValue, useStore } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  metaFromDraft,
  newRepertoireDraft,
  RepertoireMetaFields,
} from "@/chessin/repertoire/MetaFields";
import { saveRepertoireMeta } from "@/chessin/repertoire/model";
import { useOpenInWorkspace } from "@/chessin/workspace/openInWorkspace";
import { addRecentFileAtom, sessionsAtom, tabFamily } from "@/state/atoms";
import { headersToPGN } from "@/utils/chess";
import { createFile } from "@/utils/files";

export default function CreateRepertoireModal({
  opened,
  setOpened,
}: {
  opened: boolean;
  setOpened: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [color, setColor] = useState<"white" | "black">("white");
  const [error, setError] = useState("");
  // Chessin (S3-5): rating band / time control / coverage target, stored next to the file.
  const sessions = useAtomValue(sessionsAtom);
  const [meta, setMeta] = useState(() => newRepertoireDraft(sessions));
  const { documentDir } = useLoaderData({ from: "/" });

  const openInWorkspace = useOpenInWorkspace();
  const store = useStore();

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("Common.RequireName"));
      return;
    }

    const pgn = headersToPGN({
      id: 0,
      fen: INITIAL_FEN,
      black: "",
      white: "",
      result: "*",
      event: trimmedName,
      site: "",
      orientation: color,
    });

    const result = await createFile({
      filename: trimmedName,
      filetype: "repertoire",
      pgn,
      dir: documentDir,
    });

    if (result.isErr) {
      setError(result.error.message);
      return;
    }

    const fileInfo = result.value;
    await saveRepertoireMeta(
      fileInfo.path,
      trimmedName,
      metaFromDraft(meta, color, INITIAL_FEN),
    ).catch(() => undefined);
    const id = await openInWorkspace({
      tab: {
        name: trimmedName,
        type: "analysis",
      },
      pgn,
      gameOrigin: {
        kind: "file",
        file: fileInfo,
        gameNumber: 0,
      },
    });

    store.set(tabFamily(id), "practice");
    store.set(addRecentFileAtom, {
      name: trimmedName,
      path: fileInfo.path,
      type: "repertoire",
    });

    setName("");
    setColor("white");
    setMeta(newRepertoireDraft(sessions));
    setError("");
    setOpened(false);
  }

  return (
    <Modal
      opened={opened}
      onClose={() => setOpened(false)}
      title={t("Home.Card.NewRepertoire.Title")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleCreate();
        }}
      >
        <Stack>
          <TextInput
            label={t("Common.Name")}
            placeholder={t("Home.Card.NewRepertoire.NamePlaceholder")}
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
              if (error) setError("");
            }}
            error={error}
            data-autofocus
          />

          <div>
            <Text size="sm" fw={500} mb={4}>
              {t("Home.Card.NewRepertoire.Color")}
            </Text>
            <SegmentedControl
              fullWidth
              value={color}
              onChange={(v) => setColor(v as "white" | "black")}
              data={[
                { label: t("Common.WHITE"), value: "white" },
                { label: t("Common.BLACK"), value: "black" },
              ]}
            />
          </div>

          <RepertoireMetaFields value={meta} onChange={setMeta} />

          <Button type="submit">{t("Common.Create")}</Button>
        </Stack>
      </form>
    </Modal>
  );
}
