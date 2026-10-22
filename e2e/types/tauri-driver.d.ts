// `tauri:options` is the vendor capability tauri-driver translates into the
// native driver's browser options (binary + args). Declared here so the typed
// `WebdriverIO.Config` in wdio.conf.ts accepts it.
declare namespace WebdriverIO {
    interface Capabilities {
        "tauri:options"?: {
            /** Absolute path of the app binary WebKitWebDriver should launch. */
            application: string;
            /** Extra command-line arguments for the app. */
            args?: string[];
        };
    }
}
