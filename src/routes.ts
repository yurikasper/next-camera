import fs from "node:fs";
import path from "node:path";
import { toPosix } from "./util";

export interface RouteDef {
    /** Route pattern, e.g. "/", "/blog/[slug]" */
    pattern: string;
    router: "pages" | "app";
    /** Files that define the route: the page plus files that wrap it (_app, _document, layouts, ...) */
    entries: string[];
    /** True when the route has dynamic segments */
    dynamic: boolean;
    /** URL to visit without extra configuration, or null when params are required */
    defaultUrl: string | null;
}

export interface RouterDirs {
    pagesDir: string | null;
    appDir: string | null;
}

// Next.js uses <root>/pages and <root>/app, or src/pages and src/app when neither exists at the root
export function findRouterDirs(projectDir: string): RouterDirs {
    const rootPages = path.join(projectDir, "pages");
    const rootApp = path.join(projectDir, "app");
    const useRoot = isDir(rootPages) || isDir(rootApp);
    const base = useRoot ? projectDir : path.join(projectDir, "src");
    const pagesDir = path.join(base, "pages");
    const appDir = path.join(base, "app");
    return {
        pagesDir: isDir(pagesDir) ? pagesDir : null,
        appDir: isDir(appDir) ? appDir : null,
    };
}

function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function walk(dir: string, files: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return files;
    }
    for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, files);
        else if (entry.isFile()) files.push(full);
    }
    return files;
}

function stripExtension(file: string, extensions: string[]): string | null {
    if (file.endsWith(".d.ts")) return null;
    for (const ext of extensions) {
        if (file.endsWith(`.${ext}`)) return file.slice(0, -(ext.length + 1));
    }
    return null;
}

function isTestFile(rel: string): boolean {
    return /(^|\/)__tests__\//.test(rel) || /\.(test|spec)$/.test(rel);
}

// URL to visit for a pattern: static routes map to themselves, an optional catch-all at the end can be
// visited without params, anything else needs sample params.
export function defaultUrlFor(segments: string[]): string | null {
    const out: string[] = [];
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (i === segments.length - 1 && /^\[\[\.\.\..+\]\]$/.test(segment)) break;
        if (segment.includes("[")) return null;
        out.push(segment);
    }
    return "/" + out.join("/");
}

function pagesRoutes(pagesDir: string, extensions: string[]): RouteDef[] {
    const files = walk(pagesDir);
    const special = (name: string) =>
        files.find((file) => stripExtension(toPosix(path.relative(pagesDir, file)), extensions) === name);
    const wrappers = [special("_app"), special("_document")].filter((file): file is string => !!file);

    const routes: RouteDef[] = [];
    for (const file of files) {
        const rel = stripExtension(toPosix(path.relative(pagesDir, file)), extensions);
        if (rel === null || isTestFile(rel)) continue;
        if (rel === "api" || rel.startsWith("api/")) continue;
        if (["_app", "_document", "_error", "500"].includes(rel)) continue;

        const segments = rel.split("/");
        if (segments[segments.length - 1] === "index") segments.pop();
        const pattern = "/" + segments.join("/");
        routes.push({
            pattern,
            router: "pages",
            entries: [file, ...wrappers],
            dynamic: segments.some((segment) => segment.includes("[")),
            defaultUrl: defaultUrlFor(segments),
        });
    }
    return routes;
}

const APP_WRAPPERS = ["layout", "template", "loading", "error", "not-found", "global-error", "default"];

function appRoutes(appDir: string, extensions: string[]): RouteDef[] {
    const files = walk(appDir);
    const byDir = new Map<string, Map<string, string>>();
    for (const file of files) {
        const name = stripExtension(path.basename(file), extensions);
        if (!name) continue;
        const dir = path.dirname(file);
        if (!byDir.has(dir)) byDir.set(dir, new Map());
        byDir.get(dir)!.set(name, file);
    }

    const routes = new Map<string, RouteDef>();
    for (const [dir, specialFiles] of byDir) {
        const page = specialFiles.get("page");
        if (!page) continue;
        const dirSegments = toPosix(path.relative(appDir, dir)).split("/").filter(Boolean);
        // Private folders and intercepting routes aren't standalone pages
        if (dirSegments.some((segment) => segment.startsWith("_") || /^\(\.{1,3}\)/.test(segment))) continue;

        const entries = [page];
        let current = appDir;
        for (const segment of ["", ...dirSegments]) {
            current = segment ? path.join(current, segment) : current;
            const wrappers = byDir.get(current);
            if (!wrappers) continue;
            for (const name of APP_WRAPPERS) {
                const file = wrappers.get(name);
                if (file) entries.push(file);
            }
        }

        // Route groups "(marketing)" and parallel route slots "@modal" don't appear in the URL
        const segments = dirSegments.filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));
        const pattern = "/" + segments.join("/");
        const existing = routes.get(pattern);
        if (existing) {
            existing.entries = [...new Set([...existing.entries, ...entries])];
            continue;
        }
        routes.set(pattern, {
            pattern,
            router: "app",
            entries,
            dynamic: segments.some((segment) => segment.includes("[")),
            defaultUrl: defaultUrlFor(segments),
        });
    }
    return [...routes.values()];
}

export function enumerateRoutes(projectDir: string, extensions: string[]): RouteDef[] {
    const { pagesDir, appDir } = findRouterDirs(projectDir);
    const routes = [
        ...(appDir ? appRoutes(appDir, extensions) : []),
        ...(pagesDir ? pagesRoutes(pagesDir, extensions) : []),
    ];
    return routes.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

// Read pageExtensions from next.config.* when it's a simple literal array
export function detectPageExtensions(projectDir: string): string[] | null {
    for (const name of ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs", "next.config.mts"]) {
        const file = path.join(projectDir, name);
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, "utf8").match(/pageExtensions\s*:\s*\[([^\]]*)\]/);
        if (!match) return null;
        const extensions = [...match[1].matchAll(/["'`]([\w.]+)["'`]/g)].map((m) => m[1].replace(/^\./, ""));
        return extensions.length ? extensions : null;
    }
    return null;
}
