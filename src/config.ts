import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "./log";
import { UserError } from "./util";

export type ColorScheme = "light" | "dark";

export interface Viewport {
    name: string;
    width: number;
    height: number;
    mobile: boolean;
}

export interface FileConfig {
    /** Path of the Next.js app relative to the repository / directory root (monorepos) */
    app?: string;
    /** "dev" runs `next dev` (default), "prod" runs `next build` + `next start` */
    mode?: "dev" | "prod";
    /** Command that starts the server. `{port}` is replaced with the port; PORT is also set */
    command?: string;
    /** Build command used in prod mode */
    buildCommand?: string;
    /** Command run in each prepared worktree after installing dependencies (e.g. codegen) */
    setup?: string;
    /** "desktop" | "tablet" | "mobile" | "WIDTHxHEIGHT" | { name, width, height, mobile } */
    viewports?: (string | { name?: string; width: number; height: number; mobile?: boolean })[];
    colorSchemes?: ColorScheme[];
    /** Sample URLs per route pattern, e.g. { "/posts/[id]": ["/posts/1"] } (also overrides static routes) */
    routes?: Record<string, string[]>;
    /** Route patterns to never capture (glob syntax, e.g. "/admin/**") */
    ignoreRoutes?: string[];
    /** Extra files (globs, relative to the app) that should mark every route as affected */
    globalFiles?: string[];
    /** Changed files (globs, relative to the root) to ignore entirely */
    ignoreFiles?: string[];
    /** CSS selectors hidden before taking screenshots */
    hide?: string[];
    /** CSS selectors covered with a solid box before taking screenshots (dynamic content) */
    mask?: string[];
    /** Extra CSS injected before taking screenshots */
    css?: string;
    /** Per-pixel color difference threshold, 0-1 (default 0.1) */
    threshold?: number;
    /** Extra milliseconds to wait after the page settles */
    wait?: number;
    /** Seconds to wait for a server to accept connections (default 180) */
    serverTimeout?: number;
    /** Seconds to wait for a page to load (default 60) */
    navigationTimeout?: number;
    /** Page file extensions (default tsx, ts, jsx, js) */
    pageExtensions?: string[];
    /** Capture the full scrollable page (default true) */
    fullPage?: boolean;
    /** Path to a Chrome/Chromium/Edge executable */
    browser?: string;
    /** Output directory (default .next-camera) */
    out?: string;
}

const CONFIG_NAMES = [
    "next-camera.config.ts",
    "next-camera.config.mts",
    "next-camera.config.js",
    "next-camera.config.mjs",
    "next-camera.config.json",
];

const KNOWN_KEYS = new Set<string>([
    "app", "mode", "command", "buildCommand", "setup", "viewports", "colorSchemes", "routes", "ignoreRoutes",
    "globalFiles", "ignoreFiles", "hide", "mask", "css", "threshold", "wait", "serverTimeout",
    "navigationTimeout", "pageExtensions", "fullPage", "browser", "out", "$schema",
]);

export function findConfigFile(dirs: string[]): string | null {
    for (const dir of dirs) {
        for (const name of CONFIG_NAMES) {
            const file = path.join(dir, name);
            if (fs.existsSync(file)) return file;
        }
    }
    return null;
}

export async function loadConfigFile(file: string): Promise<FileConfig> {
    let config: FileConfig;
    try {
        if (file.endsWith(".json")) {
            config = JSON.parse(fs.readFileSync(file, "utf8"));
        } else {
            const mod = await import(pathToFileURL(file).href);
            config = mod.default ?? mod;
        }
    } catch (error) {
        throw new UserError(`Could not load config ${file}: ${(error as Error).message}`);
    }
    if (!config || typeof config !== "object") throw new UserError(`Config ${file} must export an object`);
    for (const key of Object.keys(config)) {
        if (!KNOWN_KEYS.has(key)) log.warn(`Unknown option "${key}" in ${path.basename(file)}`);
    }
    return config;
}

export const VIEWPORT_PRESETS: Record<string, Viewport> = {
    desktop: { name: "desktop", width: 1280, height: 800, mobile: false },
    laptop: { name: "laptop", width: 1440, height: 900, mobile: false },
    tablet: { name: "tablet", width: 768, height: 1024, mobile: true },
    mobile: { name: "mobile", width: 390, height: 844, mobile: true },
};

export function parseViewport(spec: FileConfig["viewports"] extends (infer T)[] | undefined ? T : never): Viewport {
    if (typeof spec === "object") {
        if (!(spec.width > 0 && spec.height > 0)) throw new UserError(`Invalid viewport ${JSON.stringify(spec)}`);
        return {
            name: spec.name ?? `${spec.width}x${spec.height}`,
            width: Math.round(spec.width),
            height: Math.round(spec.height),
            mobile: !!spec.mobile,
        };
    }
    const preset = VIEWPORT_PRESETS[spec.toLowerCase()];
    if (preset) return preset;
    const match = spec.match(/^(\d+)x(\d+)$/i);
    if (!match) throw new UserError(`Invalid viewport "${spec}". Use desktop, laptop, tablet, mobile or WIDTHxHEIGHT`);
    return { name: spec.toLowerCase(), width: Number(match[1]), height: Number(match[2]), mobile: false };
}
