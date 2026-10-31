import fs from "node:fs";
import path from "node:path";
import { log } from "./log";
import { envWithPath, runShell, tail } from "./proc";
import { isInside, readJson, UserError } from "./util";

export type PackageManagerName = "pnpm" | "npm" | "yarn" | "bun";

export interface PackageManager {
    name: PackageManagerName;
    // Directory holding the lockfile (the workspace root in monorepos)
    dir: string;
    lockfile: string | null;
}

const LOCKFILES: [string, PackageManagerName][] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
];

export function detectPackageManager(appDir: string, root: string): PackageManager {
    for (let dir = appDir; isInside(dir, root); dir = path.dirname(dir)) {
        for (const [file, name] of LOCKFILES) {
            if (fs.existsSync(path.join(dir, file))) return { name, dir, lockfile: path.join(dir, file) };
        }
        if (dir === root || path.dirname(dir) === dir) break;
    }
    for (const dir of [appDir, root]) {
        const declared = readJson(path.join(dir, "package.json"))?.packageManager as string | undefined;
        const name = declared?.split("@")[0] as PackageManagerName | undefined;
        if (name && ["pnpm", "npm", "yarn", "bun"].includes(name)) return { name, dir, lockfile: null };
    }
    return { name: "npm", dir: appDir, lockfile: null };
}

function installCommand(pm: PackageManager): string {
    switch (pm.name) {
        case "pnpm":
            return pm.lockfile ? "pnpm install --frozen-lockfile" : "pnpm install";
        case "bun":
            return pm.lockfile ? "bun install --frozen-lockfile" : "bun install";
        case "yarn":
            if (fs.existsSync(path.join(pm.dir, ".yarnrc.yml"))) return pm.lockfile ? "yarn install --immutable" : "yarn install";
            return pm.lockfile ? "yarn install --frozen-lockfile" : "yarn install";
        case "npm":
            return pm.lockfile ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund";
    }
}

function installHash(pm: PackageManager, appDir: string): string {
    const parts = [pm.lockfile, path.join(pm.dir, "package.json"), path.join(appDir, "package.json")]
        .filter((file): file is string => !!file && fs.existsSync(file))
        .map((file) => fs.readFileSync(file, "utf8"));
    return Bun.hash(parts.join("\0")).toString(16);
}

const MARKER = ".next-camera-install";

/**
 * Make sure dependencies are installed.
 * - "if-changed": used for worktrees we manage; reinstalls whenever the lockfile/package.json change
 * - "if-missing": used for directories we don't own; only installs when node_modules is absent
 */
export async function ensureDependencies(
    appDir: string,
    root: string,
    policy: "if-changed" | "if-missing",
    label: string
): Promise<void> {
    const pm = detectPackageManager(appDir, root);
    const nodeModules = path.join(pm.dir, "node_modules");
    const marker = path.join(nodeModules, MARKER);
    const hash = installHash(pm, appDir);

    if (policy === "if-missing") {
        if (fs.existsSync(nodeModules) || fs.existsSync(path.join(appDir, "node_modules"))) return;
    } else if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === hash) {
        log.debug(`${label}: dependencies up to date`);
        return;
    }

    const command = installCommand(pm);
    log.step(`Installing dependencies for ${label} (${command})`);
    const started = Date.now();
    const result = await runShell(command, {
        cwd: pm.dir,
        env: envWithPath([], { CI: "1", NEXT_TELEMETRY_DISABLED: "1" }),
        onLine: (line) => log.debug(`[${label} install] ${line}`),
    });
    if (result.code !== 0) {
        throw new UserError(
            `Installing dependencies for ${label} failed (${command} in ${pm.dir}):\n${tail(result.stdout + result.stderr)}`
        );
    }
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(marker, hash);
    log.debug(`${label}: installed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

// node_modules/.bin directories from the app up to the root, so `next` resolves like in npm scripts
export function binDirs(appDir: string, root: string): string[] {
    const dirs: string[] = [];
    for (let dir = appDir; isInside(dir, root); dir = path.dirname(dir)) {
        const bin = path.join(dir, "node_modules", ".bin");
        if (fs.existsSync(bin)) dirs.push(bin);
        if (dir === root || path.dirname(dir) === dir) break;
    }
    return dirs;
}
