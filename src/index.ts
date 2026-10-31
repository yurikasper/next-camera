#!/usr/bin/env bun
import path from "node:path";
import { helpText, parseCli, resolveOptions, VERSION, type ParsedArgs } from "./cli";
import { compare } from "./compare";
import { findConfigFile, loadConfigFile, type FileConfig } from "./config";
import { findRepoRoot } from "./git";
import { installBrowser } from "./install-browser";
import { configureLog, log } from "./log";
import { exists, installSignalHandlers, isDirectory, runCleanups, UserError } from "./util";
import { cacheDir, removeWorktrees } from "./worktree";

// Config lives next to the app: look in the current directory (and up to the nearest package.json)
// and in the --app directory. Like everywhere else, --app is relative to the repository root, or to
// the head directory when comparing two directories.
async function configSearchDirs(args: ParsedArgs, cwd: string): Promise<string[]> {
    const dirs = [];
    for (let dir = cwd; ; dir = path.dirname(dir)) {
        dirs.push(dir);
        if (exists(path.join(dir, "package.json")) || exists(path.join(dir, ".git")) || path.dirname(dir) === dir) break;
    }
    const app = args.flags.app as string | undefined;
    const [base, head] = args.positionals.map((arg) => path.resolve(cwd, arg));
    if (base && head && isDirectory(base) && isDirectory(head)) {
        dirs.push(path.resolve(head, app ?? "."));
    } else if (app) {
        dirs.push(path.resolve((await findRepoRoot(cwd)) ?? cwd, app));
    }
    return dirs;
}

async function main(argv: string[]): Promise<number> {
    const args = parseCli(argv);
    if (args.command === "help") {
        process.stdout.write(helpText(args.positionals[0]));
        return 0;
    }
    if (args.command === "version") {
        process.stdout.write(`${VERSION}\n`);
        return 0;
    }

    const cwd = path.resolve((args.flags.C as string | undefined) ?? process.cwd());
    if (!isDirectory(cwd)) throw new UserError(`-C: ${cwd} is not a directory`);
    configureLog({ verbose: !!args.flags.verbose });

    if (args.command === "install-browser") {
        return await installBrowser(!!args.flags["with-deps"]);
    }

    if (args.command === "clean") {
        const repo = args.flags.all ? null : await findRepoRoot(cwd);
        if (!args.flags.all && !repo) throw new UserError("Not inside a git repository. Use `next-camera clean --all` to remove every cached worktree");
        const removed = await removeWorktrees(repo);
        process.stdout.write(
            removed.length ? `Removed ${removed.length} cached worktree(s):\n${removed.map((dir) => `  ${dir}\n`).join("")}` : `Nothing to clean (cache: ${cacheDir()})\n`
        );
        return 0;
    }

    const explicit = args.flags.config as string | undefined;
    const configPath = explicit ? path.resolve(cwd, explicit) : findConfigFile(await configSearchDirs(args, cwd));
    if (explicit && !exists(configPath!)) throw new UserError(`Config file not found: ${configPath}`);
    const config: FileConfig = configPath ? await loadConfigFile(configPath) : {};
    if (configPath) log.debug(`Using config ${configPath}`);

    const options = resolveOptions(args, config, configPath ?? undefined, cwd);
    installSignalHandlers();
    return await compare(options);
}

let code: number;
try {
    code = await main(process.argv.slice(2));
} catch (error) {
    if (error instanceof UserError) {
        log.error(error.message);
    } else {
        log.error((error as Error).stack ?? String(error));
    }
    code = 2;
} finally {
    await runCleanups();
}
process.exit(code!);
