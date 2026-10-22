import {
    DEFAULT_TIMEOUT,
    dismissFirstRunIfOpen,
    findByText,
    OFFLINE_LABEL,
    STATUS_BAR,
    STATUS_BAR_LABEL,
} from "../support/app";

/**
 * The yellow "离线 / Offline" badge in the centre of the bar. Badges are the
 * only `[data-variant]` elements in the bar; the switch's own text label is a
 * `<span>` inside a `<label>` and must not count.
 */
async function offlineBadgeShown(): Promise<boolean> {
    const labels = await browser.execute(
        (sel: string) =>
            Array.from(document.querySelectorAll(sel), (el) => el.textContent?.trim() ?? ""),
        `${STATUS_BAR} [data-variant]`,
    );
    return labels.some((label) => OFFLINE_LABEL.test(label));
}

describe("status bar", () => {
    it("renders with the offline switch", async () => {
        await dismissFirstRunIfOpen();

        const bar = $(STATUS_BAR);
        await expect(bar).toBeDisplayed();
        expect(await bar.getAttribute("role")).toBe("region");
        expect(await bar.getAttribute("aria-label")).toMatch(STATUS_BAR_LABEL);

        const toggle = bar.$('input[role="switch"]');
        await expect(toggle).toExist();
        const initiallyOffline = await toggle.isSelected();
        expect(await offlineBadgeShown()).toBe(initiallyOffline);

        // The checkbox itself is visually hidden; its label toggles it.
        const label = await findByText(`${STATUS_BAR} label`, OFFLINE_LABEL);
        await label.click();
        await browser.waitUntil(async () => (await toggle.isSelected()) === !initiallyOffline, {
            timeout: DEFAULT_TIMEOUT,
            timeoutMsg: "Offline switch did not toggle",
        });
        await browser.waitUntil(async () => (await offlineBadgeShown()) === !initiallyOffline, {
            timeout: DEFAULT_TIMEOUT,
            timeoutMsg: "Offline badge did not follow the switch",
        });

        // Restore: the switch is persisted in localStorage for the next launch.
        await label.click();
        await browser.waitUntil(async () => (await toggle.isSelected()) === initiallyOffline, {
            timeout: DEFAULT_TIMEOUT,
            timeoutMsg: "Offline switch did not toggle back",
        });
    });
});
