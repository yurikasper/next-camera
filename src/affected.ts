import path from "node:path";
import { ImportGraph, isSourceFile, type Closure } from "./graph";
import { detectPageExtensions, enumerateRoutes, type RouteDef } from "./routes";
import { relPosix } from "./util";

export interface Reason {
    kind: "import" | "global" | "asset" | "all" | "requested";
    /** Changed file (relative to the root) */
    file?: string;
    /** Import chain from the route entry to the changed (or referencing) file, relative to the root */
    via?: string[];
}

export interface Target {
    url: string;
    pattern: string;
    router: "pages" | "app" | null;
    reasons: Reason[];
    inBase: boolean;
    inHead: boolean;
}

export interface Skipped {
    pattern: string;
    reason: string;
}

export interface Analysis {
    targets: Target[];
    skipped: Skipped[];
    globalFiles: string[];
    unmappedFiles: string[];
    ignoredFiles: string[];
    routeCount: number;
}

export interface AnalysisSide {
    name: "base" | "head";
    root: string;
    appDir: string;
}

export interface AnalysisOptions {
    pageExtensions: string[];
    globalFiles: string[];
    ignoreFiles: string[];
    ignoreRoutes: string[];
    routeSamples: Record<string, string[]>;
}

// Files that can change how every page renders. Paths are relative to the app directory.
const APP_GLOBALS = [
    "package.json",
    "next.config.*",
    "tailwind.config.*",
    "postcss.config.*",
    "tsconfig.json",
    "jsconfig.json",
    ".babelrc",
    ".babelrc.*",
    "babel.config.*",
    ".browserslistrc",
    "middleware.*",
    "src/middleware.*",
    "proxy.*",
    "src/proxy.*",
    "instrumentation*.*",
    "src/instrumentation*.*",
];
// Relative to the repository / directory root (monorepo-wide dependency changes)
const ROOT_GLOBALS = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "tsconfig*.json",
];

function matchesAny(file: string, patterns: string[]): boolean {
    return patterns.some((pattern) => new Bun.Glob(pattern).match(file));
}

interface SideState {
    side: AnalysisSide;
    graph: ImportGraph;
    routes: RouteDef[];
    closures: Closure[];
}

interface Impact {
    def: RouteDef;
    inBase: boolean;
    inHead: boolean;
    reasons: Map<string, Reason>;
}

function addReason(impact: Impact, reason: Reason) {
    const key = `${reason.kind}:${reason.file ?? ""}`;
    if (!impact.reasons.has(key)) impact.reasons.set(key, reason);
}

/**
 * Figure out which routes are affected by the changed files, looking at both checkouts: a file
 * can be imported by a page in base but not in head (or vice versa) and both cases matter.
 * Pass changed = null to select every route.
 */
export function analyze(sides: AnalysisSide[], changed: string[] | null, options: AnalysisOptions): Analysis {
    const states: SideState[] = sides.map((side) => {
        const extensions = detectPageExtensions(side.appDir) ?? options.pageExtensions;
        const routes = enumerateRoutes(side.appDir, extensions);
        const graph = new ImportGraph(side.root);
        return { side, graph, routes, closures: routes.map((route) => graph.closure(route.entries)) };
    });

    const impacts = new Map<string, Impact>();
    for (const state of states) {
        for (const def of state.routes) {
            const impact = impacts.get(def.pattern) ?? { def, inBase: false, inHead: false, reasons: new Map() };
            if (state.side.name === "head") {
                impact.def = def; // prefer the head definition
                impact.inHead = true;
            } else {
                impact.inBase = true;
            }
            impacts.set(def.pattern, impact);
        }
    }

    const globalFiles: string[] = [];
    const unmappedFiles: string[] = [];
    const ignoredFiles: string[] = [];

    if (changed === null) {
        for (const impact of impacts.values()) addReason(impact, { kind: "all" });
    } else {
        for (const file of changed) {
            if (matchesAny(file, options.ignoreFiles)) {
                ignoredFiles.push(file);
                continue;
            }
            let hit = false;

            for (const { side, graph, routes, closures } of states) {
                const key = graph.key(path.join(side.root, file));
                routes.forEach((route, i) => {
                    if (!closures[i].parents.has(key)) return;
                    const via = graph.chain(closures[i], key).map((p) => relPosix(side.root, p));
                    addReason(impacts.get(route.pattern)!, { kind: "import", file, via });
                    hit = true;
                });
            }
            if (hit) continue;

            if (isGlobalFile(file, states[0].side, options.globalFiles)) {
                globalFiles.push(file);
                for (const impact of impacts.values()) addReason(impact, { kind: "global", file });
                continue;
            }

            // Assets (images, fonts, public/ files) aren't imported, so look for source files mentioning them
            if (!isSourceFile(file)) {
                const name = path.basename(file);
                for (const { side, graph, routes, closures } of states) {
                    for (const key of graph.scannedKeys()) {
                        if (!graph.text(key)!.includes(name)) continue;
                        routes.forEach((route, i) => {
                            if (!closures[i].parents.has(key)) return;
                            const via = graph.chain(closures[i], key).map((p) => relPosix(side.root, p));
                            addReason(impacts.get(route.pattern)!, { kind: "asset", file, via });
                            hit = true;
                        });
                    }
                }
            }
            if (!hit) unmappedFiles.push(file);
        }
    }

    const targets: Target[] = [];
    const skipped: Skipped[] = [];
    for (const impact of impacts.values()) {
        if (impact.reasons.size === 0) continue;
        const { def } = impact;
        if (matchesAny(def.pattern, options.ignoreRoutes)) {
            skipped.push({ pattern: def.pattern, reason: "ignored by config (ignoreRoutes)" });
            continue;
        }
        const urls = options.routeSamples[def.pattern] ?? (def.defaultUrl ? [def.defaultUrl] : []);
        if (urls.length === 0) {
            skipped.push({
                pattern: def.pattern,
                reason: `dynamic route: pass --route with a concrete URL or add samples under "routes" in next-camera.config.json`,
            });
            continue;
        }
        for (const url of urls) {
            targets.push({
                url,
                pattern: def.pattern,
                router: def.router,
                reasons: [...impact.reasons.values()],
                inBase: impact.inBase,
                inHead: impact.inHead,
            });
        }
    }

    targets.sort((a, b) => a.url.localeCompare(b.url));
    skipped.sort((a, b) => a.pattern.localeCompare(b.pattern));
    return { targets, skipped, globalFiles, unmappedFiles, ignoredFiles, routeCount: impacts.size };
}

function isGlobalFile(file: string, side: AnalysisSide, extraGlobals: string[]): boolean {
    if (matchesAny(file, ROOT_GLOBALS)) return true;
    const appRel = relPosix(side.appDir, path.join(side.root, file));
    if (appRel.startsWith("..")) return false;
    return matchesAny(appRel, APP_GLOBALS) || matchesAny(appRel, extraGlobals);
}
