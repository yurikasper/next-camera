import fs from "node:fs";
import path from "node:path";
import type { Options } from "./cli";
import { changedFiles, findRepoRoot, resolveCommit, workingTreeChanges } from "./git";
import { log } from "./log";
import { ensureDependencies } from "./pm";
import { envWithPath, runShell, tail } from "./proc";
import { binDirs } from "./pm";
import { findRouterDirs } from "./routes";
import { isDirectory, isInside, onCleanup, pathKey, readJson, relPosix, toPosix, UserError } from "./util";
import { applyOverlay, checkoutWorktree, copyEnvFiles } from "./worktree";

export interface Side {
    name: "base" | "head";
    /** Human readable description, e.g. "main (1a2b3c4)", "working tree", "./checkout/base" */
    label: string;
    kind: "ref" | "working-tree" | "dir";
    /** Root of the checkout: the repository root (git) or the given directory */
    root: string;
    /** The Next.js app inside the root */
    appDir: string;
    ref?: string;
    sha?: string;
    /** A worktree we prepared ourselves (dependencies are installed/refreshed automatically) */
    managed: boolean;
    /** Already running server to use instead of starting one */
    url?: string;
}

export interface Sources {
    base: Side;
    head: Side;
    /** Changed files relative to the root, forward slashes */
    changedFiles: string[];
    repo: string | null;
    /** A foreign directory compared against a git checkout: roots are the app folders themselves */
    mixed: boolean;
}

type Spec = { type: "dir"; path: string } | { type: "ref"; ref: string } | { type: "working-tree"; path?: string };

function classify(arg: string | undefined, cwd: string): Spec | undefined {
    if (arg === undefined) return undefined;
    const resolved = path.resolve(cwd, arg);
    return isDirectory(resolved) ? { type: "dir", path: resolved } : { type: "ref", ref: arg };
}

function hasNextDependency(dir: string): boolean {
    const pkg = readJson(path.join(dir, "package.json"));
    return !!(pkg?.dependencies?.next || pkg?.devDependencies?.next);
}

// Nearest folder (from `start` up to the repo root) whose package.json depends on next
function detectAppRel(repo: string, start: string): string {
    for (let dir = start; isInside(dir, repo); dir = path.dirname(dir)) {
        if (hasNextDependency(dir)) return relPosix(repo, dir) || ".";
        if (pathKey(dir) === pathKey(repo)) break;
    }
    return ".";
}

const ALWAYS_IGNORED = new Set(["node_modules", ".git", ".next", ".turbo", ".vercel", ".swc", ".next-camera", ".cache"]);
const ROOT_IGNORED = new Set(["out", "dist", "build", "coverage", ".output"]);

function listFiles(root: string): Map<string, number> {
    const files = new Map<string, number>();
    const walk = (dir: string, depth: number) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (ALWAYS_IGNORED.has(entry.name) || (depth === 0 && ROOT_IGNORED.has(entry.name))) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, depth + 1);
            else if (entry.isFile()) files.set(toPosix(path.relative(root, full)), fs.statSync(full).size);
        }
    };
    walk(root, 0);
    return files;
}

// Changed files between two plain directories (no git needed, e.g. two CI checkouts)
export function compareDirectories(baseRoot: string, headRoot: string): string[] {
    const base = listFiles(baseRoot);
    const head = listFiles(headRoot);
    const changed: string[] = [];
    for (const file of new Set([...base.keys(), ...head.keys()])) {
        const a = base.get(file);
        const b = head.get(file);
        if (a === undefined || b === undefined || a !== b) {
            changed.push(file);
            continue;
        }
        const left = fs.readFileSync(path.join(baseRoot, file));
        const right = fs.readFileSync(path.join(headRoot, file));
        if (!left.equals(right)) changed.push(file);
    }
    return changed.sort();
}

async function readChangedList(source: string, cwd: string): Promise<string[]> {
    const text = source === "-" ? await Bun.stdin.text() : fs.readFileSync(path.resolve(cwd, source), "utf8");
    return text
        .split(/\r?\n/)
        .map((line) => toPosix(line.trim()).replace(/^\.\//, ""))
        .filter(Boolean);
}

function describeDir(dir: string, cwd: string): string {
    const rel = path.relative(cwd, dir);
    return !rel ? "." : rel.startsWith("..") && path.isAbsolute(dir) ? dir : `./${toPosix(rel)}`;
}

export async function resolveSources(options: Options): Promise<Sources> {
    const { cwd } = options;
    let baseSpec = classify(options.base, cwd);
    let headSpec = classify(options.head, cwd);

    // Two directories: no git involved
    if (baseSpec?.type === "dir" && headSpec?.type === "dir") {
        const app = options.app ?? ".";
        const base = dirSide("base", baseSpec.path, app, cwd);
        const head = dirSide("head", headSpec.path, app, cwd);
        const files = options.changed
            ? await readChangedList(options.changed, cwd)
            : compareDirectories(base.root, head.root);
        return { base, head, changedFiles: files, repo: null, mixed: false };
    }

    const repo = await findRepoRoot(cwd);
    if (!repo) {
        throw new UserError(
            `${cwd} is not inside a git repository.\nPass two directories instead: next-camera <base-dir> <head-dir>`
        );
    }

    baseSpec ??= { type: "ref", ref: "HEAD" };
    headSpec ??= { type: "working-tree" };
    // A directory inside this repository means "the working tree"
    const asWorkingTree = (spec: Spec): Spec =>
        spec.type === "dir" && isInside(spec.path, repo) ? { type: "working-tree", path: spec.path } : spec;
    baseSpec = asWorkingTree(baseSpec);
    headSpec = asWorkingTree(headSpec);

    const appStart =
        (headSpec.type === "working-tree" && headSpec.path) || (baseSpec.type === "working-tree" && baseSpec.path) || cwd;
    const appRel = options.app ?? detectAppRel(repo, isInside(appStart, repo) ? appStart : repo);

    const mixed = baseSpec.type === "dir" || headSpec.type === "dir";
    const sides = await Promise.all(
        ([["base", baseSpec], ["head", headSpec]] as const).map(async ([name, spec]): Promise<Side> => {
            if (spec.type === "dir") return dirSide(name, spec.path, options.app ?? ".", cwd);
            if (spec.type === "working-tree") {
                const sha = await resolveCommit(repo, "HEAD");
                return {
                    name,
                    label: "working tree",
                    kind: "working-tree",
                    root: repo,
                    appDir: path.resolve(repo, appRel),
                    sha: sha ?? undefined,
                    managed: false,
                };
            }
            const sha = await resolveCommit(repo, spec.ref);
            if (!sha) throw new UserError(`"${spec.ref}" is neither a directory nor a git ref in ${repo}`);
            const label = sha.startsWith(spec.ref) ? sha.slice(0, 7) : `${spec.ref} (${sha.slice(0, 7)})`;
            return { name, label, kind: "ref", ref: spec.ref, sha, root: repo, appDir: path.resolve(repo, appRel), managed: false };
        })
    );
    const [base, head] = sides;

    let files: string[];
    if (options.changed) {
        files = await readChangedList(options.changed, cwd);
    } else if (mixed) {
        // A foreign directory against a git checkout: compare the app folders directly
        files = compareDirectories(base.appDir, head.appDir);
    } else if (base.kind === "working-tree" && head.kind === "working-tree") {
        files = [];
    } else if (base.kind === "working-tree" || head.kind === "working-tree") {
        const ref = base.kind === "ref" ? base : head;
        files = await changedFiles(repo, ref.sha!, null);
    } else {
        files = await changedFiles(repo, base.sha!, head.sha!);
    }

    return { base, head, changedFiles: files, repo, mixed };
}

function dirSide(name: "base" | "head", root: string, app: string, cwd: string): Side {
    return {
        name,
        label: describeDir(root, cwd),
        kind: "dir",
        root,
        appDir: path.resolve(root, app),
        managed: false,
    };
}

/**
 * Turn resolved sides into runnable checkouts: create/refresh worktrees for refs, snapshot the
 * working tree (unless --in-place), copy .env files, install dependencies and run the setup command.
 */
export async function prepareSides(sources: Sources, options: Options, install: boolean): Promise<void> {
    const { repo } = sources;

    await Promise.all(
        [sources.base, sources.head].map(async (side) => {
            const appRel = path.relative(side.root, side.appDir);
            const url = side.name === "base" ? options.baseUrl : options.headUrl;
            if (url) side.url = url;

            if (side.kind === "ref" || (side.kind === "working-tree" && !options.inPlace && !url)) {
                if (!side.sha) throw new UserError("The repository has no commits yet; commit something first or use --in-place");
                log.step(`Preparing ${side.name} worktree (${side.label})`);
                const worktree = await checkoutWorktree(repo!, side.name, side.sha);
                onCleanup(worktree.release);
                if (side.kind === "working-tree") {
                    const changes = await workingTreeChanges(repo!);
                    applyOverlay(repo!, worktree.dir, changes);
                    log.debug(`Snapshot of working tree: ${changes.modified.length} modified, ${changes.deleted.length} deleted`);
                }
                side.root = worktree.dir;
                side.appDir = path.resolve(worktree.dir, appRel);
                side.managed = true;
                if (repo) {
                    const copied = copyEnvFiles([path.resolve(repo, appRel), repo], [side.appDir, side.root]);
                    if (copied.length) log.debug(`Copied ${copied.join(", ")} into the ${side.name} worktree`);
                }
            }
        })
    );

    // Changed files were computed relative to the app folders, so analysis must use them as roots
    if (sources.mixed) for (const side of [sources.base, sources.head]) side.root = side.appDir;

    for (const side of [sources.base, sources.head]) validateApp(side);
    if (!install) return;

    await Promise.all(
        [sources.base, sources.head].map(async (side) => {
            if (side.url) return;
            await ensureDependencies(side.appDir, side.root, side.managed ? "if-changed" : "if-missing", side.name);
            if (options.setup && side.managed) {
                log.step(`Running setup for ${side.name}: ${options.setup}`);
                const result = await runShell(options.setup, {
                    cwd: side.appDir,
                    env: envWithPath(binDirs(side.appDir, side.root)),
                    onLine: (line) => log.debug(`[${side.name} setup] ${line}`),
                });
                if (result.code !== 0) {
                    throw new UserError(`Setup command failed for ${side.name}:\n${tail(result.stdout + result.stderr)}`);
                }
            }
        })
    );
}

function validateApp(side: Side) {
    if (!isDirectory(side.appDir)) {
        throw new UserError(`${side.name}: app directory ${side.appDir} does not exist. Use --app <path> to point at the Next.js app`);
    }
    const { pagesDir, appDir } = findRouterDirs(side.appDir);
    if (!pagesDir && !appDir) {
        throw new UserError(
            `${side.name}: no pages/ or app/ directory found in ${side.appDir}. Use --app <path> to point at the Next.js app`
        );
    }
}
