import { notifications } from "@mantine/notifications";
import { error } from "@tauri-apps/plugin-log";
import i18n from "i18next";
import { parsePGN } from "./chess";
import { openFile } from "./files";
import { getGameFromUrl } from "./import";
import { createTab, type Tab } from "./tabs";
import { getGameName } from "./treeReducer";

export async function openCommandLineFile(
    file: string,
    setTabs: React.Dispatch<React.SetStateAction<Tab[]>>,
    setActiveTab: React.Dispatch<React.SetStateAction<string | null>>,
    navigateToBoard: () => Promise<unknown>,
) {
    if (/^chessin:/i.test(file)) return;
    try {
        await openFile(file, setTabs, setActiveTab);
        await navigateToBoard();
    } catch (e) {
        error(`Failed to open command-line file: ${file} - ${e}`);
        notifications.show({
            title: i18n.t("Launch.OpenFileFailed"),
            message: e instanceof Error ? e.message : String(e),
            color: "red",
        });
    }
}

export const handleDeepLink = async (
    urlStr: string,
    setTabs: React.Dispatch<React.SetStateAction<Tab[]>>,
    setActiveTab: React.Dispatch<React.SetStateAction<string | null>>,
    navigateToBoard: () => Promise<unknown>,
) => {
    let notificationShown = false;
    try {
        const url = new URL(urlStr);
        if (url.protocol !== "chessin:") return;

        if (url.host === "import") {
            const gameUrl = url.searchParams.get("url");
            if (!gameUrl) {
                throw new Error(i18n.t("Launch.Import.NoUrl"));
            }

            notifications.show({
                title: i18n.t("Launch.Import.Importing"),
                message: i18n.t("Launch.Import.Loading", { url: gameUrl }),
                loading: true,
                autoClose: false,
                id: "importing-game-link",
            });
            notificationShown = true;

            const pgn = await getGameFromUrl(gameUrl);
            if (!pgn) {
                throw new Error(i18n.t("Launch.Import.NoPGN"));
            }

            const tree = await parsePGN(pgn);
            const name = getGameName(tree.headers);

            await createTab({
                tab: {
                    name,
                    type: "analysis",
                },
                setTabs,
                setActiveTab,
                pgn,
            });

            await navigateToBoard();

            notifications.update({
                id: "importing-game-link",
                title: i18n.t("Launch.Import.Success"),
                message: i18n.t("Launch.Import.SuccessMessage"),
                color: "green",
                autoClose: 3000,
                loading: false,
            });
        }
    } catch (e) {
        error(`Failed to handle deep link URL: ${urlStr} - ${e}`);
        const errorMessage = e instanceof Error ? e.message : String(e);
        if (notificationShown) {
            notifications.update({
                id: "importing-game-link",
                title: i18n.t("Launch.Import.Failed"),
                message: errorMessage,
                color: "red",
                autoClose: 5000,
                loading: false,
            });
        } else {
            notifications.show({
                title: i18n.t("Launch.Import.Error"),
                message: errorMessage,
                color: "red",
            });
        }
    }
};
