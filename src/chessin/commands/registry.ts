import { useEffect, useSyncExternalStore } from "react";
import type { KeyMap } from "@/state/keybinds";

/**
 * Chessin command registry.
 *
 * A command is an app-wide action that can be invoked from the command
 * palette (mod+k). Modules register their own commands at import time or
 * from an effect; the palette reads the registry through `useCommands()`.
 *
 * Example:
 *   registerCommand({
 *       id: "sources.setDefault",
 *       title: () => t("Sources.SetDefault"),
 *       section: "sources",
 *       run: () => ...,
 *   });
 */

export type CommandSection =
    | "file"
    | "edit"
    | "view"
    | "board"
    | "sources"
    | "status"
    | "help"
    | "app"
    | (string & {});

export type Command = {
    /** Stable, unique id, e.g. "file.newTab". Re-registering the same id replaces it. */
    id: string;
    /** Translated title; called at render time so language switches work. */
    title: () => string;
    /** Grouping key for the palette. */
    section: CommandSection;
    /** Key of `KeyMap` so the palette can show the currently bound shortcut. */
    shortcutKey?: keyof KeyMap;
    /** Executes the command. */
    run: () => void | Promise<void>;
    /** When it returns false the command is shown greyed out. */
    enabled?: () => boolean;
    /** Optional reason shown as a tooltip when disabled. */
    disabledReason?: () => string;
    /** Extra search terms (English / Chinese / abbreviations). */
    aliases?: string[];
};

type Listener = () => void;

const commands = new Map<string, Command>();
const listeners = new Set<Listener>();
let snapshot: Command[] = [];
let version = 0;

function emit() {
    version += 1;
    snapshot = Array.from(commands.values());
    for (const l of listeners) l();
}

/** Registers (or replaces) a command. Returns an unregister function. */
export function registerCommand(cmd: Command): () => void {
    commands.set(cmd.id, cmd);
    emit();
    return () => unregisterCommand(cmd.id);
}

/** Registers several commands at once. Returns a function that unregisters all of them. */
export function registerCommands(cmds: Command[]): () => void {
    for (const cmd of cmds) commands.set(cmd.id, cmd);
    emit();
    return () => {
        for (const cmd of cmds) commands.delete(cmd.id);
        emit();
    };
}

export function unregisterCommand(id: string): void {
    if (commands.delete(id)) emit();
}

export function getCommand(id: string): Command | undefined {
    return commands.get(id);
}

export function getCommands(): Command[] {
    return snapshot;
}

/** Runs a command by id if it exists and is enabled. Returns true when it ran. */
export async function runCommand(id: string): Promise<boolean> {
    const cmd = commands.get(id);
    if (!cmd) return false;
    if (cmd.enabled && !cmd.enabled()) return false;
    await cmd.run();
    return true;
}

function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getSnapshot(): Command[] {
    return snapshot;
}

/** React hook returning the current list of registered commands (re-renders on changes). */
export function useCommands(): Command[] {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Registers `cmds` for the lifetime of the calling component. Pass a memoised
 * array (`useMemo`) so the effect only re-runs when the commands change.
 */
export function useRegisterCommands(cmds: Command[]): void {
    useEffect(() => registerCommands(cmds), [cmds]);
}

/** Monotonic counter bumped on every registry change; useful as a memo dependency. */
export function getRegistryVersion(): number {
    return version;
}

/** Test helper: removes every command. */
export function clearCommands(): void {
    commands.clear();
    emit();
}
