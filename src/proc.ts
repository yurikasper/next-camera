import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { isWindows, sleep } from "./util";

export type Env = Record<string, string | undefined>;

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

interface RunOptions {
    cwd: string;
    env?: Env;
    shell?: boolean;
    onLine?: (line: string) => void;
}

function lineSplitter(onLine: (line: string) => void) {
    let buffer = "";
    return {
        push(chunk: string) {
            buffer += chunk;
            let index: number;
            while ((index = buffer.search(/\r?\n/)) !== -1) {
                onLine(buffer.slice(0, index));
                buffer = buffer.slice(buffer[index] === "\r" ? index + 2 : index + 1);
            }
        },
        flush() {
            if (buffer) onLine(buffer);
            buffer = "";
        },
    };
}

function collect(child: ChildProcess, onLine?: (line: string) => void): Promise<RunResult> {
    let stdout = "";
    let stderr = "";
    const lines = onLine ? lineSplitter(onLine) : null;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        lines?.push(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        lines?.push(chunk);
    });
    return new Promise((resolve) => {
        child.on("error", (error) => resolve({ code: -1, stdout, stderr: stderr + String(error) }));
        child.on("close", (code) => {
            lines?.flush();
            resolve({ code: code ?? -1, stdout, stderr });
        });
    });
}

// Run a program with arguments (no shell) and capture its output
export function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    return collect(child, options.onLine);
}

// Run a shell command line (needed for package manager shims like pnpm.cmd on Windows)
export function runShell(command: string, options: RunOptions): Promise<RunResult> {
    const child = spawn(command, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
        windowsHide: true,
    });
    return collect(child, options.onLine);
}

export interface LongProcess {
    child: ChildProcess;
    exited: Promise<number | null>;
    stop(): Promise<void>;
}

// Start a long-running shell command (e.g. a dev server) that can later be stopped with its whole process tree
export function startShell(command: string, options: RunOptions): LongProcess {
    const child = spawn(command, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
        // On POSIX this puts the shell in its own process group so we can kill everything it spawned
        detached: !isWindows,
        windowsHide: true,
    });
    const lines = options.onLine ? lineSplitter(options.onLine) : null;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => lines?.push(chunk));
    child.stderr?.on("data", (chunk: string) => lines?.push(chunk));
    const exited = new Promise<number | null>((resolve) => {
        child.on("error", () => resolve(-1));
        child.on("exit", (code) => {
            lines?.flush();
            resolve(code);
        });
    });
    let stopping: Promise<void> | null = null;
    return {
        child,
        exited,
        stop() {
            stopping ??= killTree(child, exited);
            return stopping;
        },
    };
}

export async function killTree(child: ChildProcess, exited: Promise<unknown>) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (isWindows) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
        signalGroup(child, "SIGTERM");
        const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
        if (!done) signalGroup(child, "SIGKILL");
    }
    await Promise.race([exited, sleep(5000)]);
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
    try {
        process.kill(-child.pid!, signal);
    } catch {
        try {
            child.kill(signal);
        } catch {
            // already gone
        }
    }
}

// Copy of the current environment with extra directories prepended to PATH.
// Windows env keys are case-insensitive, so reuse whichever spelling of PATH already exists.
export function envWithPath(binDirs: string[], extra: Env = {}): Env {
    const env: Env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = [...binDirs, env[pathKey] ?? ""].filter(Boolean).join(path.delimiter);
    return { ...env, ...extra };
}

export function tail(text: string, lines = 30): string {
    return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}
