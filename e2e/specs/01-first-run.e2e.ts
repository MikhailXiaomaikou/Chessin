import {
    FIRST_RUN_SKIP,
    FIRST_RUN_TITLE,
    findByText,
    findDialog,
    textOf,
    waitForDialog,
    waitForShell,
} from "../support/app";

// Runs first, on a fresh profile (see wdio.conf.ts): the onboarding screen must
// come up on its own. It is left open on purpose; spec 02 dismisses it.
describe("first run", () => {
    it("launches and shows the first-run modal", async () => {
        await waitForShell();
        await waitForDialog(FIRST_RUN_TITLE);

        const dialog = await findDialog(FIRST_RUN_TITLE);
        expect(dialog).not.toBeNull();
        await expect(dialog as WebdriverIO.Element).toBeDisplayed();

        // Language toggle (中文 / English) and the Skip button are part of the screen.
        const languageToggle = (dialog as WebdriverIO.Element).$('[role="radiogroup"]');
        await expect(languageToggle).toBeDisplayed();
        const toggleText = await textOf(await languageToggle);
        expect(toggleText).toContain("中文");
        expect(toggleText).toContain("English");

        const skip = await findByText("button", FIRST_RUN_SKIP);
        await expect(skip).toBeDisplayed();
    });
});
