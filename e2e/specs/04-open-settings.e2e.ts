import {
    dismissFirstRunIfOpen,
    findByText,
    openSettings,
    SETTINGS_LANGUAGE_ROW,
    waitForSettingsPage,
} from "../support/app";

describe("settings", () => {
    it("opens the Settings page", async () => {
        await dismissFirstRunIfOpen();

        await openSettings();

        const appearanceTab = await waitForSettingsPage();
        await expect(appearanceTab).toBeDisplayed();

        // The vertical tab list has one tab per settings category.
        const tabs = await $$('[role="tablist"] [role="tab"]');
        expect(tabs.length).toBeGreaterThanOrEqual(5);

        // The Appearance panel holds the language setting used by the next spec.
        await appearanceTab.click();
        await expect(await findByText("p", SETTINGS_LANGUAGE_ROW)).toBeDisplayed();
    });
});
