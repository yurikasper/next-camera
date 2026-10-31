import path from "node:path";
import { run } from "./proc";

export async function git(cwd: string, args: string[]): Promise<string> {
    const result = await run("git", args, { cwd });
    if (result.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout;
}

export async function tryGit(cwd: string, args: string[]): Promise<string | null> {
    const result = await run("git", args, { cwd });
    return result.code === 0 ? result.stdout : null;
}

export async function findRepoRoot(cwd: string): Promise<string | null> {
    const out = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
    return out ? path.resolve(out.trim()) : null;
}

export async function commonGitDir(cwd: string): Promise<string | null> {
    const out = await tryGit(cwd, ["rev-parse", "--git-common-dir"]);
    return out ? path.resolve(cwd, out.trim()) : null;
}

export async function resolveCommit(repo: string, ref: string): Promise<string | null> {
    const out = await tryGit(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return out ? out.trim() : null;
}

function splitZ(out: string): string[] {
    return out.split("\0").filter(Boolean);
}

async function untrackedFiles(repo: string): Promise<string[]> {
    return splitZ(await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]));
}

// Files that differ between two commits, or between a commit and the working tree (head = null).
// Paths are relative to the repo root with forward slashes. Renames are listed as delete + add.
export async function changedFiles(repo: string, base: string, head: string | null): Promise<string[]> {
    const args = ["diff", "--name-only", "--no-renames", "-z", base];
    if (head) args.push(head);
    const files = new Set(splitZ(await git(repo, args)));
    if (!head) {
        for (const file of await untrackedFiles(repo)) files.add(file);
    }
    return [...files].sort();
}

// Uncommitted changes relative to HEAD, split into files to copy and files that were deleted
export async function workingTreeChanges(repo: string): Promise<{ modified: string[]; deleted: string[] }> {
    const entries = splitZ(await git(repo, ["diff", "--name-status", "--no-renames", "-z", "HEAD"]));
    const modified: string[] = [];
    const deleted: string[] = [];
    for (let i = 0; i + 1 < entries.length; i += 2) {
        const status = entries[i];
        const file = entries[i + 1];
        (status.startsWith("D") ? deleted : modified).push(file);
    }
    modified.push(...(await untrackedFiles(repo)));
    return { modified, deleted };
}

export async function describeRef(repo: string, sha: string): Promise<string> {
    const subject = await tryGit(repo, ["log", "-1", "--format=%s", sha]);
    return subject?.trim() ?? "";
}
