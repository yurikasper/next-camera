import fs from "node:fs";
import path from "node:path";

export const isWindows = process.platform === "win32";

export class UserError extends Error {}

export function toPosix(p: string): string {
    return p.replace(/\\/g, "/");
}

// Stable key for comparing paths (Windows paths are case-insensitive)
export function pathKey(p: string): string {
    const resolved = path.resolve(p);
    return isWindows ? resolved.toLowerCase() : resolved;
}

export function relPosix(from: string, to: string): string {
    return toPosix(path.relative(from, to));
}

export function isInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function exists(p: string): boolean {
    return fs.existsSync(p);
}

export function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

export function readJson<T = any>(p: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
        return null;
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

export function plural(count: number, word: string, pluralWord = word + "s"): string {
    return `${count} ${count === 1 ? word : pluralWord}`;
}

// Turn a URL path into a filesystem-safe folder name: "/" -> "index", "/a/b?x=1" -> "a__b_x=1"
export function routeSlug(url: string): string {
    if (url === "/" || url === "") return "index";
    return url
        .replace(/^\//, "")
        .replace(/\/$/, "")
        .replace(/\//g, "__")
        .replace(/[<>:"\\|?*\x00-\x1f]/g, "_");
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

// Run fn over items with at most `limit` in flight, preserving order of results
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

// ---------- Cleanup registry (servers, browser, worktree locks) ----------

type Cleanup = () => unknown | Promise<unknown>;
const cleanups = new Set<Cleanup>();

export function onCleanup(fn: Cleanup): () => void {
    cleanups.add(fn);
    return () => cleanups.delete(fn);
}

export async function runCleanups() {
    const pending = [...cleanups].reverse();
    cleanups.clear();
    for (const fn of pending) {
        try {
            await fn();
        } catch {
            // best effort
        }
    }
}

let signalsInstalled = false;
export function installSignalHandlers() {
    if (signalsInstalled) return;
    signalsInstalled = true;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, async () => {
            process.stderr.write(`\nReceived ${signal}, cleaning up...\n`);
            await runCleanups();
            process.exit(130);
        });
    }
}
