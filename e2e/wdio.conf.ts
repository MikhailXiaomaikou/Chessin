/**
 * WebdriverIO configuration for the Chessin smoke tests (Tauri 2 WebDriver).
 *
 * Prerequisites (Linux):
 *   1. apt-get install -y webkit2gtk-driver xvfb      # WebKitWebDriver + a virtual display
 *   2. cargo install tauri-driver --locked            # ~/.cargo/bin/tauri-driver
 *   3. pnpm tauri build --debug --no-bundle --config src-tauri/tauri.chessin.conf.json
 *      -> src-tauri/target/debug/en-croissant (the Cargo package / `mainBinaryName`;
 *         the Chessin config only overrides the product name and identifier)
 *   4. xvfb-run pnpm e2e
 *
 * `tauri-driver` is spawned once in `onPrepare` and proxies the WebDriver
 * protocol to WebKitWebDriver, which launches the binary named by
 * `tauri:options.application` for every session (one per spec file). The app
 * runs against a throw-away XDG profile so the first launch is a real first run.
 *
 * Overrides: CHESSIN_E2E_APP (binary path), TAURI_DRIVER (driver path),
 * TAURI_DRIVER_PORT / TAURI_DRIVER_NATIVE_PORT (defaults 4444 / 4445).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const e2eDir = import.meta.dirname;
const repoRoot = path.resolve(e2eDir, "..");

const APP_BINARY =
    process.env.CHESSIN_E2E_APP ??
    path.join(repoRoot, "src-tauri", "target", "debug", "en-croissant");
const TAURI_DRIVER =
    process.env.TAURI_DRIVER ?? path.join(os.homedir(), ".cargo", "bin", "tauri-driver");
const PORT = Number(process.env.TAURI_DRIVER_PORT ?? 4444);
const NATIVE_PORT = Number(process.env.TAURI_DRIVER_NATIVE_PORT ?? 4445);

const BUILD_COMMAND =
    "pnpm tauri build --debug --no-bundle --config src-tauri/tauri.chessin.conf.json";

let tauriDriver: ChildProcess | undefined;
let profileDir: string | undefined;

function waitForPort(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const socket = net.connect({ host: "127.0.0.1", port });
            socket.once("connect", () => {
                socket.destroy();
                resolve();
            });
            socket.once("error", () => {
                socket.destroy();
                if (tauriDriver?.exitCode !== null && tauriDriver?.exitCode !== undefined) {
                    reject(new Error(`tauri-driver exited with code ${tauriDriver.exitCode}`));
                } else if (Date.now() > deadline) {
                    reject(
                        new Error(
                            `tauri-driver did not listen on 127.0.0.1:${port} within ${timeoutMs}ms`,
                        ),
                    );
                } else {
                    setTimeout(attempt, 200);
                }
            });
        };
        attempt();
    });
}

function stopTauriDriver(): void {
    if (!tauriDriver || tauriDriver.exitCode !== null || tauriDriver.pid === undefined) return;
    // tauri-driver spawns WebKitWebDriver (which spawns the app); the driver is
    // started detached so the whole process group can be terminated together.
    try {
        process.kill(-tauriDriver.pid, "SIGTERM");
    } catch {
        tauriDriver.kill("SIGTERM");
    }
}

export const config: WebdriverIO.Config = {
    runner: "local",
    hostname: "127.0.0.1",
    port: PORT,
    path: "/",

    // Listed explicitly: the order matters. The first two specs exercise the
    // fresh-profile first run; later ones expect it to have been dismissed and
    // dismiss it themselves if it is still showing.
    specs: [
        "./specs/01-first-run.e2e.ts",
        "./specs/02-dismiss-first-run.e2e.ts",
        "./specs/03-command-palette.e2e.ts",
        "./specs/04-open-settings.e2e.ts",
        "./specs/05-language-switch.e2e.ts",
        "./specs/06-status-bar.e2e.ts",
    ],
    // One app instance at a time: tauri-driver proxies a single WebKitWebDriver.
    maxInstances: 1,
    capabilities: [
        {
            "wdio:maxInstances": 1,
            "tauri:options": {
                application: APP_BINARY,
            },
            // WebKitWebDriver has no BiDi; stop WebdriverIO from asking for a websocket.
            "wdio:enforceWebDriverClassic": true,
        },
    ],

    logLevel: "warn",
    bail: 0,
    waitforTimeout: 20_000,
    connectionRetryTimeout: 180_000,
    connectionRetryCount: 2,
    // The display comes from `xvfb-run` (or a real X session); do not let the
    // runner start a second display server of its own.
    displayServerEnabled: false,

    framework: "mocha",
    reporters: ["spec"],
    mochaOpts: {
        ui: "bdd",
        timeout: 180_000,
    },

    onPrepare: async () => {
        if (!existsSync(APP_BINARY)) {
            throw new Error(
                `Chessin debug binary not found at ${APP_BINARY}. Build it with: ${BUILD_COMMAND}`,
            );
        }
        if (!existsSync(TAURI_DRIVER)) {
            throw new Error(
                `tauri-driver not found at ${TAURI_DRIVER}. Install it with: cargo install tauri-driver --locked`,
            );
        }
        if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
            throw new Error(
                "No display: run the smoke tests under `xvfb-run pnpm e2e` (apt-get install xvfb).",
            );
        }

        profileDir = mkdtempSync(path.join(os.tmpdir(), "chessin-e2e-"));
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            // Fresh profile: localStorage (first-run flag, language, offline switch),
            // app data and window state all live under the XDG directories.
            XDG_DATA_HOME: path.join(profileDir, "data"),
            XDG_CONFIG_HOME: path.join(profileDir, "config"),
            XDG_CACHE_HOME: path.join(profileDir, "cache"),
            // WebKitGTK on a GPU-less virtual display.
            WEBKIT_DISABLE_DMABUF_RENDERER: "1",
            WEBKIT_DISABLE_COMPOSITING_MODE: "1",
            LIBGL_ALWAYS_SOFTWARE: "1",
        };

        tauriDriver = spawn(
            TAURI_DRIVER,
            ["--port", String(PORT), "--native-port", String(NATIVE_PORT)],
            { env, stdio: ["ignore", "inherit", "inherit"], detached: true },
        );
        tauriDriver.on("exit", (code, signal) => {
            if (code !== 0 && code !== null) {
                console.error(`tauri-driver exited (code ${code}, signal ${signal})`);
            }
        });
        await waitForPort(PORT, 15_000);
    },

    onComplete: () => {
        stopTauriDriver();
        if (profileDir && !process.env.CHESSIN_E2E_KEEP_PROFILE) {
            rmSync(profileDir, { recursive: true, force: true });
        }
    },
};
