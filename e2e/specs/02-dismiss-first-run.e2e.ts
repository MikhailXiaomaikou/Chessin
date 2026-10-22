import {
    FIRST_RUN_SKIP,
    FIRST_RUN_TITLE,
    findByText,
    HOME_CARD_ANALYSIS,
    STATUS_BAR,
    waitForDialog,
    waitForDialogClosed,
    waitForShell,
} from "../support/app";

// Spec 01 left the onboarding open and the flag unset, so this launch shows it
// again. Dismissing persists `chessin.firstRunDone`; later launches start on
// the home screen directly.
describe("first run", () => {
    it("dismissing the modal shows the home screen", async () => {
        await waitForShell();
        await waitForDialog(FIRST_RUN_TITLE);

        const skip = await findByText("button", FIRST_RUN_SKIP);
        await skip.click();
        await waitForDialogClosed(FIRST_RUN_TITLE);

        // Home = the "new tab" page with its action cards, above the status bar.
        const analysisCard = await findByText("p", HOME_CARD_ANALYSIS);
        await expect(analysisCard).toBeDisplayed();
        await expect($(STATUS_BAR)).toBeDisplayed();
    });
});
