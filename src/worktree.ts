import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commonGitDir, git, tryGit } from "./git";
import { log } from "./log";
import { isWindows, pathKey } from "./util";

// Worktrees live outside the repository so tools that walk up the tree (Next.js workspace root
// detection, Tailwind source scanning) never see them. They are reused between runs so
// node_modules and the .next cache survive.
export function cacheDir(): string {
    if (process.env.NEXT_CAMERA_CACHE_DIR) return path.resolve(process.env.NEXT_CAMERA_CACHE_DIR);
    if (isWindows) {
        // Keep this short: deep node_modules trees easily exceed MAX_PATH on Windows
        const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
        return path.join(base, "next-camera");
    }
    if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "next-camera");
    return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "next-camera");
}

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"];

function lockfileAbove(dir: string): string | null {
    for (let current = path.dirname(dir); ; current = path.dirname(current)) {
        for (const name of LOCKFILES) {
            const file = path.join(current, name);
            if (fs.existsSync(file)) return file;
        }
        if (path.dirname(current) === current) return null;
    }
}

// Kept short: package managers nest deep paths under node_modules and Windows tools still trip over MAX_PATH
function repoKey(repo: string): string {
    const name = path.basename(repo).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "repo";
    return `${name}-${Bun.hash(pathKey(repo)).toString(16).slice(0, 6)}`;
}

// Next.js picks the outermost lockfile above the app as its workspace root, so a stray lockfile in
// e.g. the home folder would change how the worktree builds. In that case keep the worktrees next to
// the repository instead, where they see exactly the same parent folders as the repo itself.
function candidateRoots(repo: string): string[] {
    const key = repoKey(repo);
    const roots = [path.join(cacheDir(), "wt", key)];
    if (!process.env.NEXT_CAMERA_CACHE_DIR) roots.push(path.join(path.dirname(repo), ".next-camera-wt", key));
    return roots;
}

export function repoCacheDir(repo: string): string {
    const [preferred, beside] = candidateRoots(repo);
    let chosen = preferred;
    const lockfile = beside ? lockfileAbove(preferred) : null;
    if (lockfile) {
        log.debug(`Not using ${preferred} for worktrees because of ${lockfile}; using ${beside}`);
        chosen = beside;
    }
    if (isWindows && chosen.length > 110) {
        log.warn(
            `Worktrees will be created in a deep folder (${chosen}). Tools like Turbopack can fail on paths longer ` +
                `than 260 characters inside node_modules; set NEXT_CAMERA_CACHE_DIR to a shorter folder if that happens.`
        );
    }
    return chosen;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function readLock(lockPath: string): number | null {
    try {
        return Number(fs.readFileSync(lockPath, "utf8").trim()) || null;
    } catch {
        return null;
    }
}

// Create the lock file atomically with our pid already in it, so other processes never see it empty
function createLock(lockPath: string): boolean {
    const temp = `${lockPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, String(process.pid));
    try {
        fs.linkSync(temp, lockPath);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return false;
        // Filesystems without hard links: fall back to exclusive create
        try {
            fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
            return true;
        } catch {
            return false;
        }
    } finally {
        fs.rmSync(temp, { force: true });
    }
}

// Take an exclusive lock on a worktree slot so two concurrent runs never share one
export function tryLock(lockPath: string): boolean {
    for (let attempt = 0; attempt < 3; attempt++) {
        if (createLock(lockPath)) return true;
        const owner = readLock(lockPath);
        if (owner === null) continue; // released in the meantime, try again
        if (owner === process.pid || isAlive(owner)) return false;
        // Stale lock from a dead process: move it aside, then check we moved the stale lock and not
        // one another process created after we read it
        const aside = `${lockPath}.${process.pid}.stale`;
        try {
            fs.renameSync(lockPath, aside);
        } catch {
            continue;
        }
        const moved = readLock(aside);
        if (moved !== owner) {
            try {
                fs.linkSync(aside, lockPath);
            } catch {
                // someone else locked it meanwhile; theirs stays
            }
            fs.rmSync(aside, { force: true });
            return false;
        }
        fs.rmSync(aside, { force: true });
    }
    return false;
}

export function releaseLock(lockPath: string) {
    if (readLock(lockPath) === process.pid) fs.rmSync(lockPath, { force: true });
}

export interface Worktree {
    dir: string;
    release(): void;
}

export async function checkoutWorktree(repo: string, slot: string, sha: string): Promise<Worktree> {
    const root = repoCacheDir(repo);
    fs.mkdirSync(root, { recursive: true });
    registerRoot(root);

    let dir = "";
    let lockPath = "";
    for (let attempt = 1; attempt <= 8; attempt++) {
        const name = attempt === 1 ? slot : `${slot}-${attempt}`;
        const candidateLock = path.join(root, `${name}.lock`);
        if (tryLock(candidateLock)) {
            dir = path.join(root, name);
            lockPath = candidateLock;
            break;
        }
    }
    if (!dir) throw new Error(`All worktree slots for "${slot}" are locked by other next-camera processes`);
    const release = () => releaseLock(lockPath);

    try {
        const repoGitDir = await commonGitDir(repo);
        const existingGitDir = fs.existsSync(path.join(dir, ".git")) ? await commonGitDir(dir) : null;
        if (existingGitDir && repoGitDir && pathKey(existingGitDir) === pathKey(repoGitDir)) {
            log.debug(`Reusing worktree ${dir}`);
            await git(dir, ["checkout", "--quiet", "--detach", "--force", sha]);
            await git(dir, ["reset", "--quiet", "--hard", sha]);
            // Remove stray untracked files but keep ignored ones (node_modules, .next cache)
            await git(dir, ["clean", "-fdq"]);
        } else {
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
            await tryGit(repo, ["worktree", "prune"]);
            log.debug(`Creating worktree ${dir}`);
            await git(repo, ["worktree", "add", "--detach", dir, sha]);
        }
    } catch (error) {
        release();
        throw error;
    }
    return { dir, release };
}

// Make a worktree that's checked out at HEAD look like the working tree (uncommitted + untracked files)
export function applyOverlay(repo: string, dir: string, changes: { modified: string[]; deleted: string[] }) {
    for (const file of changes.modified) {
        const source = path.join(repo, file);
        const target = path.join(dir, file);
        try {
            if (!fs.statSync(source).isFile()) continue;
        } catch {
            continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
    }
    for (const file of changes.deleted) {
        fs.rmSync(path.join(dir, file), { force: true });
    }
}

// .env files are usually gitignored, so copy them from the working tree into prepared worktrees
export function copyEnvFiles(fromDirs: string[], toDirs: string[]): string[] {
    const copied: string[] = [];
    fromDirs.forEach((from, i) => {
        const to = toDirs[i];
        if (!fs.existsSync(from) || !fs.existsSync(to)) return;
        for (const name of fs.readdirSync(from)) {
            if (!/^\.env(\..+)?$/.test(name)) continue;
            const source = path.join(from, name);
            if (!fs.statSync(source).isFile()) continue;
            fs.copyFileSync(source, path.join(to, name));
            copied.push(name);
        }
    });
    return copied;
}

export async function removeWorktrees(repo: string | null): Promise<string[]> {
    const removed: string[] = [];
    const roots = repo ? candidateRoots(repo) : listCacheRoots();
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        for (const entry of fs.readdirSync(root)) {
            const dir = path.join(root, entry);
            if (!fs.statSync(dir).isDirectory()) continue;
            const lock = path.join(root, `${entry}.lock`);
            const pid = readLock(lock);
            if (pid && isAlive(pid)) {
                log.warn(`Skipping ${dir}: in use by process ${pid}`);
                continue;
            }
            const owner = fs.existsSync(path.join(dir, ".git")) ? await commonGitDir(dir) : null;
            fs.rmSync(dir, { recursive: true, force: true });
            fs.rmSync(lock, { force: true });
            if (owner) await tryGit(path.dirname(owner), ["worktree", "prune"]);
            removed.push(dir);
        }
        if (fs.readdirSync(root).length === 0) fs.rmSync(root, { recursive: true, force: true });
        const parent = path.dirname(root);
        if (path.basename(parent) === ".next-camera-wt" && fs.readdirSync(parent).length === 0) fs.rmSync(parent, { recursive: true });
    }
    pruneRegistry();
    return removed;
}

// Worktree roots can live beside repositories (see repoCacheDir), so every root we create is recorded
// in the cache folder for `clean --all` to find
const registryFile = () => path.join(cacheDir(), "roots.txt");

function readRegistry(): string[] {
    try {
        return fs.readFileSync(registryFile(), "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
        return [];
    }
}

export function registerRoot(root: string) {
    const roots = readRegistry();
    if (roots.some((known) => pathKey(known) === pathKey(root))) return;
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.appendFileSync(registryFile(), root + "\n");
}

function pruneRegistry() {
    const remaining = readRegistry().filter((root) => fs.existsSync(root));
    if (remaining.length) fs.writeFileSync(registryFile(), remaining.join("\n") + "\n");
    else fs.rmSync(registryFile(), { force: true });
}

function listCacheRoots(): string[] {
    const wt = path.join(cacheDir(), "wt");
    const inCache = fs.existsSync(wt) ? fs.readdirSync(wt).map((name) => path.join(wt, name)) : [];
    const roots = new Map<string, string>();
    for (const root of [...inCache, ...readRegistry()]) roots.set(pathKey(root), root);
    return [...roots.values()];
}
