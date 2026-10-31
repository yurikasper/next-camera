import path from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { parseViewport, type ColorScheme, type FileConfig, type Viewport } from "./config";
import { UserError } from "./util";

// Read from package.json so the release workflow's tag check also covers --version and report.json
export const VERSION: string = pkg.version;

export const HELP = `next-camera ${VERSION}
Screenshot the pages of a Next.js app before and after a change, and diff them.
Only routes whose code (transitively) depends on the changed files are captured.

USAGE
  next-camera [base] [head] [options]
  next-camera install-browser [--with-deps]
  next-camera clean [--all]

  base and head are git refs or directories:
    next-camera                     HEAD vs your working tree (uncommitted changes included)
    next-camera main                main vs your working tree
    next-camera main feature        two refs, each checked out in a cached git worktree
    next-camera ./base ./head       two directories (e.g. two CI checkouts)

WHAT TO CAPTURE
  --route <url>            Capture this URL (repeatable or comma separated). Skips dependency analysis
  --all                    Capture every route instead of only the affected ones
  --changed <file|->       Read the changed file list (one path per line, relative to the root)
                           from a file or stdin instead of computing it
  --viewport <name>        desktop (1280x800, default), laptop, tablet, mobile or WIDTHxHEIGHT.
                           Repeatable or comma separated
  --dark                   Also capture with prefers-color-scheme: dark
  --app <path>             Next.js app directory relative to the repo/dir root (monorepos).
                           Default: nearest folder with a "next" dependency from the current directory

SERVERS
  --mode <dev|prod>        dev: next dev (default). prod: next build + next start (slower, closer to prod)
  --command <cmd>          Start command, {port} is replaced (PORT is also set). Default: next dev --port {port}
  --base-url <url>         Use an already running server for base instead of starting one
  --head-url <url>         Use an already running server for head (e.g. your own dev server)
  --in-place               Run the working tree in place instead of a cached snapshot worktree.
                           Faster, but don't use it while your own dev server is running

OUTPUT
  -o, --out <dir>          Output directory (default: .next-camera). Replaced on every run
  --json                   Print the JSON report to stdout instead of the text summary
  --dry-run                Only print the affected routes, don't start anything
  --fail-on-diff           Exit with code 1 if anything changed visually or new page errors appeared
  --threshold <0-1>        Per-pixel color difference threshold (default 0.1)

OTHER
  -C <dir>                 Run as if started in <dir>
  -c, --config <file>      Config file (default: next-camera.config.{ts,js,mjs,json} in the app)
  --browser <path>         Chrome / Chromium / Edge executable (default: auto-detect)
  -v, --verbose            Show server and install output
  -h, --help               Show this help
  --version                Show the version

COMMANDS
  install-browser          Download Chromium headless shell with Playwright's installer (needs npx).
                           Only needed when no Chrome, Chromium or Edge is installed.
                           --with-deps also installs the system libraries it needs (Linux, may need sudo)
  clean                    Delete the cached worktrees for this repo (--all: for every repo)

OUTPUT FILES
  <out>/report.md          Human/agent readable report with images
  <out>/report.json        Machine readable report (also printed by --json)
  <out>/routes/<route>/<viewport>/
      base.png, head.png   Full-page screenshots
      diff.png             Head screenshot faded, changed pixels in red, numbered region boxes
      region-N.png         Cropped BEFORE / AFTER / DIFF panels for each changed region

EXIT CODES
  0 success (also when differences were found, unless --fail-on-diff)
  1 differences or new page errors found with --fail-on-diff
  2 error

Docs: see README.md (config file, dynamic routes, CI setup, using it from coding agents)
`;

export interface Options {
    cwd: string;
    base?: string;
    head?: string;
    app?: string;
    routes: string[];
    all: boolean;
    changed?: string;
    viewports: Viewport[];
    colorSchemes: ColorScheme[];
    mode: "dev" | "prod";
    command?: string;
    buildCommand?: string;
    setup?: string;
    baseUrl?: string;
    headUrl?: string;
    inPlace: boolean;
    out: string;
    json: boolean;
    dryRun: boolean;
    failOnDiff: boolean;
    threshold: number;
    browser?: string;
    verbose: boolean;
    configPath?: string;
    routeSamples: Record<string, string[]>;
    ignoreRoutes: string[];
    globalFiles: string[];
    ignoreFiles: string[];
    hide: string[];
    mask: string[];
    css: string;
    waitMs: number;
    serverTimeoutMs: number;
    navigationTimeoutMs: number;
    pageExtensions: string[];
    fullPage: boolean;
    maxRegions: number;
}

export interface ParsedArgs {
    command: "compare" | "clean" | "install-browser" | "help" | "version";
    positionals: string[];
    flags: Record<string, string | boolean | string[] | undefined>;
}

export function parseCli(argv: string[]): ParsedArgs {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            strict: true,
            options: {
                route: { type: "string", multiple: true },
                all: { type: "boolean" },
                changed: { type: "string" },
                viewport: { type: "string", multiple: true },
                dark: { type: "boolean" },
                app: { type: "string" },
                mode: { type: "string" },
                command: { type: "string" },
                "base-url": { type: "string" },
                "head-url": { type: "string" },
                "in-place": { type: "boolean" },
                out: { type: "string", short: "o" },
                json: { type: "boolean" },
                "dry-run": { type: "boolean" },
                "fail-on-diff": { type: "boolean" },
                threshold: { type: "string" },
                C: { type: "string", short: "C" },
                config: { type: "string", short: "c" },
                browser: { type: "string" },
                "with-deps": { type: "boolean" },
                verbose: { type: "boolean", short: "v" },
                help: { type: "boolean", short: "h" },
                version: { type: "boolean" },
            },
        });
    } catch (error) {
        throw new UserError(`${(error as Error).message}\nRun next-camera --help for usage.`);
    }
    const { values, positionals } = parsed;
    if (values.help || positionals[0] === "help") return { command: "help", positionals, flags: values };
    if (values.version) return { command: "version", positionals, flags: values };
    if (positionals[0] === "clean") return { command: "clean", positionals: positionals.slice(1), flags: values };
    if (positionals[0] === "install-browser") {
        return { command: "install-browser", positionals: positionals.slice(1), flags: values };
    }
    if (positionals.length > 2) throw new UserError(`Expected at most two arguments (base and head), got ${positionals.length}`);
    return { command: "compare", positionals, flags: values };
}

function list(values: unknown): string[] {
    if (!values) return [];
    const items = Array.isArray(values) ? values : [values];
    return items.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}

export function resolveOptions(args: ParsedArgs, config: FileConfig, configPath: string | undefined, cwd: string): Options {
    const f = args.flags;
    const mode = (f.mode as string | undefined) ?? config.mode ?? "dev";
    if (mode !== "dev" && mode !== "prod") throw new UserError(`--mode must be "dev" or "prod"`);

    const thresholdRaw = f.threshold !== undefined ? Number(f.threshold) : config.threshold ?? 0.1;
    if (!(thresholdRaw >= 0 && thresholdRaw <= 1)) throw new UserError(`--threshold must be between 0 and 1`);

    const viewportSpecs = list(f.viewport).length ? list(f.viewport) : config.viewports ?? ["desktop"];
    const viewports = viewportSpecs.map((spec) => parseViewport(spec as any));
    const colorSchemes: ColorScheme[] = f.dark ? ["light", "dark"] : config.colorSchemes ?? ["light"];

    const routes = list(f.route).map((route) => (route.startsWith("/") ? route : `/${route}`));

    return {
        cwd,
        base: args.positionals[0],
        head: args.positionals[1],
        app: (f.app as string | undefined) ?? config.app,
        routes,
        all: !!f.all,
        changed: f.changed as string | undefined,
        viewports,
        colorSchemes,
        mode,
        command: (f.command as string | undefined) ?? config.command,
        buildCommand: config.buildCommand,
        setup: config.setup,
        baseUrl: (f["base-url"] as string | undefined)?.replace(/\/$/, ""),
        headUrl: (f["head-url"] as string | undefined)?.replace(/\/$/, ""),
        inPlace: !!f["in-place"],
        out: path.resolve(cwd, (f.out as string | undefined) ?? config.out ?? ".next-camera"),
        json: !!f.json,
        dryRun: !!f["dry-run"],
        failOnDiff: !!f["fail-on-diff"],
        threshold: thresholdRaw,
        browser: (f.browser as string | undefined) ?? config.browser,
        verbose: !!f.verbose,
        configPath,
        routeSamples: config.routes ?? {},
        ignoreRoutes: config.ignoreRoutes ?? [],
        globalFiles: config.globalFiles ?? [],
        ignoreFiles: config.ignoreFiles ?? [],
        hide: config.hide ?? [],
        mask: config.mask ?? [],
        css: config.css ?? "",
        waitMs: config.wait ?? 0,
        serverTimeoutMs: (config.serverTimeout ?? 180) * 1000,
        navigationTimeoutMs: (config.navigationTimeout ?? 60) * 1000,
        pageExtensions: config.pageExtensions ?? ["tsx", "ts", "jsx", "js"],
        fullPage: config.fullPage ?? true,
        maxRegions: 8,
    };
}
