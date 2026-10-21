import { getVersion } from "@tauri-apps/api/app";
import { arch, platform, type as osType, version as osVersion } from "@tauri-apps/plugin-os";
import i18n from "i18next";
import { useEffect, useState } from "react";

/**
 * App version + diagnostics helpers shared by the status bar and the error
 * page. `getVersion()` is an IPC round-trip, so the result is cached for the
 * lifetime of the window.
 */

let cachedVersion: string | null = null;
let pendingVersion: Promise<string> | null = null;

/** Resolves to the app version (from tauri.conf.json), "" when unavailable. */
export function getAppVersion(): Promise<string> {
    if (cachedVersion !== null) return Promise.resolve(cachedVersion);
    if (!pendingVersion) {
        pendingVersion = getVersion()
            .then((v) => {
                cachedVersion = v;
                return v;
            })
            .catch(() => {
                pendingVersion = null;
                return "";
            });
    }
    return pendingVersion;
}

/** Synchronous read of the cached version; `null` until `getAppVersion()` resolved once. */
export function getCachedAppVersion(): string | null {
    return cachedVersion;
}

/** React hook: the cached app version, "" until it is known. */
export function useAppVersion(): string {
    const [version, setVersion] = useState(cachedVersion ?? "");
    useEffect(() => {
        let cancelled = false;
        getAppVersion().then((v) => {
            if (!cancelled) setVersion(v);
        });
        return () => {
            cancelled = true;
        };
    }, []);
    return version;
}

/** "macos 14.5 (aarch64)"; "unknown" outside a Tauri window (tests, browser). */
export function describeOs(): string {
    try {
        return `${osType()} ${osVersion()} (${arch()}, ${platform()})`;
    } catch {
        return "unknown";
    }
}

export type ErrorDescription = {
    name: string;
    message: string;
    stack: string;
    cause: string;
};

function stringify(value: unknown): string {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

/** Normalises anything thrown (Error, string, object) into printable parts. */
export function describeError(error: unknown): ErrorDescription {
    if (error instanceof Error) {
        return {
            name: error.name || "Error",
            message: error.message,
            stack: error.stack ?? "",
            cause: error.cause === undefined ? "" : stringify(error.cause),
        };
    }
    return { name: "Error", message: stringify(error), stack: "", cause: "" };
}

/**
 * Plain-text diagnostics block for bug reports: app version, OS, language,
 * route, WebView UA and the error itself. Never includes paths or user data
 * beyond what the error message already carries.
 */
export function collectDiagnostics(error: unknown, version: string = cachedVersion ?? ""): string {
    const { name, message, stack, cause } = describeError(error);
    const location =
        typeof window === "undefined" ? "" : window.location.hash || window.location.pathname;
    const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
    const lines = [
        `Chessin ${version || "unknown"}`,
        `OS: ${describeOs()}`,
        `Language: ${i18n.language ?? "unknown"}`,
        `Route: ${location}`,
        `WebView: ${userAgent}`,
        `Time: ${new Date().toISOString()}`,
        "",
        `${name}: ${message}`,
    ];
    if (stack) lines.push("", stack);
    if (cause) lines.push("", `Cause: ${cause}`);
    return lines.join("\n");
}
