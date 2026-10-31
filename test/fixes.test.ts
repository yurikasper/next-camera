import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze } from "../src/affected";
import { issueDelta, normalizeIssue } from "../src/compare";
import { registerRoot, releaseLock, removeWorktrees, tryLock } from "../src/worktree";
import pkg from "../package.json";

const temp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const cleanup: string[] = [];
afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>) {
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), content);
    }
}

describe("page error comparison", () => {
    test("ignores origins, moved stack frames and build hashes", () => {
        const base = { kind: "exception" as const, message: "TypeError: x is undefined\n    at Page (http://127.0.0.1:5001/_next/static/chunks/page-1a2b3c4d5e.js:12:5)" };
        const head = { kind: "exception" as const, message: "TypeError: x is undefined\n    at Page (http://127.0.0.1:5002/_next/static/chunks/page-9f8e7d6c5b.js:13:5)" };
        expect(normalizeIssue(base)).toBe(normalizeIssue(head));
        expect(issueDelta([base], [head])).toEqual([]);
    });

    test("a different error is still new", () => {
        const base = { kind: "console" as const, message: "Failed to load http://localhost:5001/api/a.json:1:1" };
        const head = { kind: "console" as const, message: "Hydration failed" };
        expect(issueDelta([base], [head])).toEqual([head]);
    });
});

describe("global code", () => {
    test("files imported by middleware affect every page", () => {
        const root = temp("next-camera-mw-");
        cleanup.push(root);
        write(root, {
            "pages/index.tsx": `export default () => <main />;`,
            "pages/about.tsx": `export default () => <main />;`,
            "middleware.ts": `import { check } from "./lib/auth"; export function middleware() { check(); }`,
            "lib/auth.ts": `export function check() {}`,
            "lib/unused.ts": `export const x = 1;`,
        });
        const sides = [
            { name: "base" as const, root, appDir: root },
            { name: "head" as const, root, appDir: root },
        ];
        const options = { pageExtensions: ["tsx", "ts"], globalFiles: [], ignoreFiles: [], ignoreRoutes: [], routeSamples: {} };
        const result = analyze(sides, ["lib/auth.ts", "lib/unused.ts"], options);
        expect(result.globalFiles).toEqual(["lib/auth.ts"]);
        expect(result.targets.map((target) => target.url)).toEqual(["/", "/about"]);
        expect(result.targets[0].reasons[0]).toEqual({ kind: "global", file: "lib/auth.ts", via: ["middleware.ts", "lib/auth.ts"] });
        expect(result.unmappedFiles).toEqual(["lib/unused.ts"]);
    });
});

describe("worktree locks", () => {
    const dir = temp("next-camera-lock-");
    cleanup.push(dir);

    test("a live lock can't be taken twice", () => {
        const lock = path.join(dir, "a.lock");
        expect(tryLock(lock)).toBe(true);
        expect(fs.readFileSync(lock, "utf8")).toBe(String(process.pid));
        // Pretend another live process holds it: our parent is alive
        fs.writeFileSync(lock, String(process.ppid));
        expect(tryLock(lock)).toBe(false);
        // Releasing only removes our own lock
        releaseLock(lock);
        expect(fs.existsSync(lock)).toBe(true);
    });

    test("a lock left by a dead process is taken over", () => {
        const lock = path.join(dir, "b.lock");
        fs.writeFileSync(lock, "999999");
        expect(tryLock(lock)).toBe(true);
        expect(fs.readFileSync(lock, "utf8")).toBe(String(process.pid));
        releaseLock(lock);
        expect(fs.existsSync(lock)).toBe(false);
        expect(fs.readdirSync(dir).filter((name) => name.startsWith("b."))).toEqual([]);
    });

    test("clean --all also finds worktree roots outside the cache folder", async () => {
        const cache = temp("next-camera-cache-");
        const beside = temp("next-camera-beside-");
        cleanup.push(cache, beside);
        const previous = process.env.NEXT_CAMERA_CACHE_DIR;
        process.env.NEXT_CAMERA_CACHE_DIR = cache;
        try {
            const root = path.join(beside, ".next-camera-wt", "repo-123456");
            fs.mkdirSync(path.join(root, "base"), { recursive: true });
            registerRoot(root);
            const removed = await removeWorktrees(null);
            expect(removed).toEqual([path.join(root, "base")]);
            expect(fs.existsSync(path.join(beside, ".next-camera-wt"))).toBe(false);
        } finally {
            if (previous === undefined) delete process.env.NEXT_CAMERA_CACHE_DIR;
            else process.env.NEXT_CAMERA_CACHE_DIR = previous;
        }
    });
});

describe("cli", () => {
    const cliRoot = path.resolve(import.meta.dir, "..");
    const cache = temp("next-camera-cli-cache-");
    const repo = temp("next-camera-cli-repo-");
    cleanup.push(cache, repo);
    fs.cpSync(path.join(import.meta.dir, "fixtures", "pages-router"), repo, { recursive: true });
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "initial");

    const run = (...args: string[]) => {
        const result = spawnSync(process.execPath, [path.join(cliRoot, "src", "index.ts"), ...args], {
            cwd: repo,
            env: { ...process.env, NEXT_CAMERA_CACHE_DIR: cache, NO_COLOR: "1" },
            encoding: "utf8",
        });
        return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    };

    test("--version comes from package.json", () => {
        expect(run("--version").stdout.trim()).toBe(pkg.version);
    });

    test("--dry-run --json has the same shape with and without changes", () => {
        const clean = run("--dry-run", "--json");
        expect(clean.code).toBe(0);
        expect(JSON.parse(clean.stdout)).toMatchObject({ changedFiles: [], targets: [], skipped: [] });

        const button = path.join(repo, "src", "components", "Button", "Button.tsx");
        fs.writeFileSync(button, fs.readFileSync(button, "utf8").replace("rounded-xl", "rounded-none"));
        const changed = run("--dry-run", "--json");
        expect(changed.code).toBe(0);
        const plan = JSON.parse(changed.stdout);
        expect(plan.changedFiles).toEqual(["src/components/Button/Button.tsx"]);
        expect(plan.targets).toHaveLength(6);
        git("checkout", "--", ".");
    }, 60_000);

    test("a directory against a ref compares with the ref's files, not the working tree", () => {
        // The working tree has an uncommitted change that's NOT in HEAD and NOT in the other directory
        const other = temp("next-camera-cli-other-");
        cleanup.push(other);
        fs.cpSync(path.join(import.meta.dir, "fixtures", "pages-router"), other, { recursive: true });
        fs.appendFileSync(path.join(repo, "src", "pages", "notindex.tsx"), "\n// uncommitted\n");
        try {
            const result = run(other, "HEAD", "--dry-run", "--json");
            expect(result.code).toBe(0);
            expect(JSON.parse(result.stdout).changedFiles).toEqual([]);
        } finally {
            git("checkout", "--", ".");
        }
    }, 60_000);
});
