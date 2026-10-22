import { ActionIcon, Tooltip } from "@mantine/core";
import { IconHistory } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { isLibraryOrigin } from "@/chessin/save/saveModel";
import { currentTabAtom } from "@/state/atoms";
// Side effects: the `history.open` command and the daily backup trigger load
// with the board bundle, whichever route the app starts on.
import "./backup";
import "./commands";
import { openHistoryDrawer } from "./drawerAtom";
import HistoryDrawer from "./HistoryDrawer";

/**
 * The "历史版本" entry of the board's save column (`BoardControls`): an icon
 * that opens the version drawer, plus the drawer itself. Rendered only for
 * library documents, which are the only tabs with a version history.
 */
export function HistoryControl() {
  const { t } = useTranslation();
  const tab = useAtomValue(currentTabAtom);
  if (!isLibraryOrigin(tab)) return null;
  return (
    <>
      <Tooltip position="right" label={t("History.Title")}>
        <ActionIcon
          aria-label={t("History.Title")}
          data-testid="history-open"
          onClick={() => openHistoryDrawer()}
        >
          <IconHistory size="1.2rem" />
        </ActionIcon>
      </Tooltip>
      <HistoryDrawer />
    </>
  );
}
