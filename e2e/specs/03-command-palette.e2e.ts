import {
    dismissFirstRunIfOpen,
    findByText,
    openPalette,
    PALETTE_OPTION,
    SETTINGS_LABEL,
    typeInto,
} from "../support/app";

describe("command palette", () => {
    it("opens with Ctrl+K and typing 设置 finds Settings", async () => {
        await dismissFirstRunIfOpen();

        const input = await openPalette();
        await expect(input).toBeFocused();

        // "设置" is an alias of the `app.settings` command, so it matches in either UI language.
        await typeInto(input, "设置");

        const option = await findByText(PALETTE_OPTION, SETTINGS_LABEL);
        await expect(option).toBeDisplayed();
        await expect(option).toHaveAttribute("aria-disabled", "false");
    });
});
