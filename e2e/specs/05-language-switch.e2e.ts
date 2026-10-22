import {
    DEFAULT_TIMEOUT,
    dismissFirstRunIfOpen,
    findByText,
    openSettings,
    SETTINGS_LANGUAGE_ROW,
    STATUS_BAR,
    waitForSettingsPage,
} from "../support/app";

const CHINESE = "Chinese (Simplified)";
const ENGLISH = "English (US)";

/** The language `Select` input in Settings → Appearance (found through its row title). */
async function languageSelect(): Promise<WebdriverIO.Element> {
    const title = await findByText("p", SETTINGS_LANGUAGE_ROW);
    const row = await title.parentElement().parentElement();
    // The visible combobox input; Mantine also renders a hidden `<input>` holding the value.
    return row.$('input[aria-haspopup="listbox"]');
}

/** Picks an option of the Mantine Select by its label (options render in a portal). */
async function chooseLanguage(label: string): Promise<void> {
    const select = await languageSelect();
    if ((await select.getValue()) === label) return;
    await select.click();
    const option = await findByText(
        '[role="listbox"] [role="option"]',
        new RegExp(`^${label.replace(/[()]/g, "\\$&")}$`),
    );
    await option.click();
    await browser.waitUntil(
        async () => (await languageSelect().then((el) => el.getValue())) === label,
        {
            timeout: DEFAULT_TIMEOUT,
            timeoutMsg: `Language select did not switch to ${label}`,
        },
    );
}

async function expectStatusBarLabel(label: string): Promise<void> {
    await browser.waitUntil(
        async () => (await $(STATUS_BAR).getAttribute("aria-label")) === label,
        {
            timeout: DEFAULT_TIMEOUT,
            timeoutMsg: `Status bar aria-label did not become "${label}"`,
        },
    );
}

describe("language", () => {
    it("switches to English and back to Chinese", async () => {
        await dismissFirstRunIfOpen();
        await openSettings();
        const appearanceTab = await waitForSettingsPage();
        await appearanceTab.click();

        // Chessin is Chinese-first; start from Chinese whatever the machine locale is.
        await chooseLanguage(CHINESE);
        await expectStatusBarLabel("状态栏");
        await expect(await findByText('[role="tab"]', /^外观$/)).toBeDisplayed();

        await chooseLanguage(ENGLISH);
        await expectStatusBarLabel("Status bar");
        await expect(await findByText('[role="tab"]', /^Appearance$/)).toBeDisplayed();

        await chooseLanguage(CHINESE);
        await expectStatusBarLabel("状态栏");
        await expect(await findByText('[role="tab"]', /^外观$/)).toBeDisplayed();
    });
});
