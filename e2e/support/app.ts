/**
 * Shared helpers for the Chessin smoke specs.
 *
 * The specs may not edit components, so they rely on what the UI exposes
 * today: translated labels (matched in both zh-CN and en-US because the UI
 * language follows the machine's locale until a spec changes it), ARIA roles
 * and the few `data-*` hooks the shell already has (`data-chessin-status-bar`).
 * `browser`, `$`, `$$` and `expect` are injected by the WebdriverIO runner.
 *
 * Text is matched on `textContent` read through `browser.execute`, not on
 * WebDriver's "Get Element Text": WebKitWebDriver reports an empty string for
 * the label inside Mantine `<Button>`s (overflow-hidden flex label).
 */

export const DEFAULT_TIMEOUT = 20_000;

/** WebDriver key code for the Control key (`Key.Ctrl` in webdriverio). */
export const CTRL = "";

export const FIRST_RUN_TITLE = /^(带入你的棋谱|Bring your games)$/;
export const FIRST_RUN_SKIP = /^(稍后再说|Skip for now)$/;
export const HOME_CARD_ANALYSIS = /^(分析棋盘|Analysis Board)$/;
export const SETTINGS_LABEL = /^(设置|Settings)$/;
export const SETTINGS_TAB_APPEARANCE = /^(外观|Appearance)$/;
export const SETTINGS_LANGUAGE_ROW = /^(语言|Language)$/;
export const STATUS_BAR_LABEL = /^(状态栏|Status bar)$/;
export const OFFLINE_LABEL = /^(离线|Offline)$/;

export const STATUS_BAR = "[data-chessin-status-bar]";
export const DIALOG = '[role="dialog"]';
export const PALETTE_INPUT = '[role="dialog"] input[role="combobox"]';
export const PALETTE_OPTION = '#chessin-palette-list [role="option"]';

/** `textContent` of an element (see the note at the top of the file). */
export async function textOf(element: WebdriverIO.Element): Promise<string> {
    const text = await browser.execute(
        (el: HTMLElement) => el.textContent ?? "",
        element as unknown as HTMLElement,
    );
    return text.trim();
}

/**
 * Index (document order) of the first element matching `selector` whose
 * `textContent` matches `pattern`, or -1. One round-trip for the whole list.
 */
async function indexByText(selector: string, pattern: RegExp): Promise<number> {
    const texts = await browser.execute(
        (sel: string) => Array.from(document.querySelectorAll(sel), (el) => el.textContent ?? ""),
        selector,
    );
    return texts.findIndex((text) => pattern.test(text.trim()));
}

/** First element matching `selector` whose text matches `pattern`; waits for it. */
export async function findByText(
    selector: string,
    pattern: RegExp,
    timeout = DEFAULT_TIMEOUT,
): Promise<WebdriverIO.Element> {
    let found: WebdriverIO.Element | undefined;
    await browser.waitUntil(
        async () => {
            const index = await indexByText(selector, pattern);
            if (index < 0) return false;
            found = (await $$(selector))[index];
            return found !== undefined;
        },
        {
            timeout,
            timeoutMsg: `No <${selector}> with text matching ${pattern} within ${timeout}ms`,
        },
    );
    if (!found) throw new Error(`No <${selector}> with text matching ${pattern}`);
    return found;
}

/**
 * Waits until the React shell has rendered. The status bar is placed by
 * `__root.tsx` in the AppShell footer, so once it exists the first-run modal,
 * the palette hotkey and the sidebar are mounted too.
 */
export async function waitForShell(): Promise<void> {
    await $(STATUS_BAR).waitForExist({
        timeout: 90_000,
        timeoutMsg: "The Chessin shell (status bar) did not render",
    });
}

/** Index of the open Mantine dialog whose `<h2>` title matches `pattern`, or -1. */
async function dialogIndex(title: RegExp): Promise<number> {
    const titles = await browser.execute(
        (sel: string) =>
            Array.from(
                document.querySelectorAll(sel),
                (dialog) => dialog.querySelector("h2")?.textContent ?? "",
            ),
        DIALOG,
    );
    return titles.findIndex((text) => title.test(text.trim()));
}

/** The open Mantine dialog whose `<h2>` title matches `pattern`, or `null`. */
export async function findDialog(title: RegExp): Promise<WebdriverIO.Element | null> {
    const index = await dialogIndex(title);
    if (index < 0) return null;
    return (await $$(DIALOG))[index] ?? null;
}

export async function waitForDialog(title: RegExp, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await browser.waitUntil(async () => (await dialogIndex(title)) >= 0, {
        timeout,
        timeoutMsg: `Dialog ${title} did not open`,
    });
}

export async function waitForDialogClosed(title: RegExp, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await browser.waitUntil(async () => (await dialogIndex(title)) < 0, {
        timeout,
        timeoutMsg: `Dialog ${title} did not close`,
    });
}

/**
 * Dismisses the first-run screen when it is showing (fresh profile, or an
 * earlier spec that left it open). Returns whether it had to.
 */
export async function dismissFirstRunIfOpen(): Promise<boolean> {
    await waitForShell();
    const skip = await findByText("button", FIRST_RUN_SKIP, 3_000).catch(() => null);
    if (!skip) return false;
    await skip.click();
    await waitForDialogClosed(FIRST_RUN_TITLE);
    return true;
}

/**
 * Types into an input. WebKitWebDriver synthesizes key events per character
 * and cannot always produce CJK text that way, so when the value did not land
 * the text is set the way React expects (native setter + `input` event).
 */
export async function typeInto(input: WebdriverIO.Element, text: string): Promise<void> {
    await input.click();
    await input.setValue(text);
    if ((await input.getValue()) === text) return;
    await browser.execute(
        (element: HTMLInputElement, value: string) => {
            const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value",
            )?.set;
            setter?.call(element, value);
            element.dispatchEvent(new Event("input", { bubbles: true }));
        },
        input as unknown as HTMLInputElement,
        text,
    );
    await browser.waitUntil(async () => (await input.getValue()) === text, {
        timeout: 5_000,
        timeoutMsg: `Could not type "${text}" into the input`,
    });
}

/** Opens the command palette with Ctrl+K and returns its search input. */
export async function openPalette(): Promise<WebdriverIO.Element> {
    await browser.keys([CTRL, "k"]);
    const input = $(PALETTE_INPUT);
    await input.waitForDisplayed({
        timeout: DEFAULT_TIMEOUT,
        timeoutMsg: "Ctrl+K did not open the command palette",
    });
    return input;
}

/** Opens the Settings page through the sidebar link (icon-only, named by aria-label). */
export async function openSettings(): Promise<void> {
    const link = $('a[aria-label="设置"], a[aria-label="Settings"]');
    await link.waitForClickable({ timeout: DEFAULT_TIMEOUT });
    await link.click();
    await waitForSettingsPage();
}

/** The Settings page is a vertical tab list; "外观 / Appearance" is one of its tabs. */
export async function waitForSettingsPage(): Promise<WebdriverIO.Element> {
    return findByText('[role="tablist"] [role="tab"]', SETTINGS_TAB_APPEARANCE);
}
