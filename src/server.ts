import net from "node:net";
import type { Options } from "./cli";
import { log } from "./log";
import { binDirs } from "./pm";
import { envWithPath, runShell, startShell, tail, type LongProcess } from "./proc";
import type { Side } from "./sources";
import { onCleanup, sleep, UserError } from "./util";

export interface Server {
    url: string;
    /** Error lines printed by the server (compile errors, SSR exceptions) */
    errors: string[];
    stop(): Promise<void>;
}

const handedOut = new Set<number>();

// Ask the OS for a free port. Never hand out the same one twice in a run (base and head start concurrently).
export function freePort(): number {
    for (let attempt = 0; attempt < 20; attempt++) {
        const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
        const port = listener.port;
        listener.stop(true);
        if (!handedOut.has(port)) {
            handedOut.add(port);
            return port;
        }
    }
    throw new Error("Could not find a free port");
}

function canConnect(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(1000, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}

// Strip ANSI escapes so we can pattern-match server output
function plain(line: string): string {
    return line.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, "");
}

const ERROR_LINE = /(^\s*⨯|\bError:|Module not found|Failed to compile|Unhandled Runtime Error|Build error)/;
const READY_LINE = /\bReady in\b|\bready started server\b/i;
const PORT_IN_USE = /EADDRINUSE|address already in use/i;

class PortInUse extends Error {}

export async function startServer(side: Side, options: Options): Promise<Server> {
    if (side.url) {
        log.debug(`${side.name}: using existing server at ${side.url}`);
        return { url: side.url, errors: [], stop: async () => {} };
    }

    if (options.mode === "prod") {
        const build = options.buildCommand ?? "next build";
        log.step(`Building ${side.name} (${build})`);
        const result = await runShell(build, {
            cwd: side.appDir,
            env: envWithPath(binDirs(side.appDir, side.root), { NEXT_TELEMETRY_DISABLED: "1" }),
            onLine: (line) => log.debug(`[${side.name} build] ${plain(line)}`),
        });
        if (result.code !== 0) {
            throw new UserError(`Building ${side.name} failed (${build}):\n${tail(plain(result.stdout + result.stderr), 40)}`);
        }
    }

    for (let attempt = 1; ; attempt++) {
        try {
            return await launch(side, options, freePort());
        } catch (error) {
            if (!(error instanceof PortInUse) || attempt >= 3) throw error;
            log.debug(`${side.name}: port was taken, retrying on another one`);
        }
    }
}

async function launch(side: Side, options: Options, port: number): Promise<Server> {
    const custom = !!options.command;
    const defaultCommand =
        options.mode === "prod"
            ? "next start --port {port} --hostname 127.0.0.1"
            : "next dev --port {port} --hostname 127.0.0.1";
    const command = (options.command ?? defaultCommand).replaceAll("{port}", String(port));
    log.step(`Starting ${side.name} server (${command})`);

    const env = envWithPath(binDirs(side.appDir, side.root), {
        PORT: String(port),
        NEXT_TELEMETRY_DISABLED: "1",
        BROWSER: "none",
    });
    const output: string[] = [];
    const errors: string[] = [];
    let announcedUrl: string | null = null;
    let ready = false;
    let portInUse = false;
    const proc: LongProcess = startShell(command, {
        cwd: side.appDir,
        env,
        onLine: (raw) => {
            const line = plain(raw);
            output.push(line);
            if (output.length > 300) output.shift();
            log.debug(`[${side.name}] ${line}`);
            const local = line.match(/Local:\s+(https?:\/\/[^\s]+)/);
            if (local) announcedUrl = local[1].replace(/\/$/, "");
            if (READY_LINE.test(line)) ready = true;
            if (PORT_IN_USE.test(line)) portInUse = true;
            if (ERROR_LINE.test(line)) {
                errors.push(line.trim());
                if (errors.length > 50) errors.shift();
            }
        },
    });
    const removeCleanup = onCleanup(() => proc.stop());
    const stop = async () => {
        removeCleanup();
        await proc.stop();
    };

    let exited = false;
    proc.exited.then(() => (exited = true));
    const deadline = Date.now() + options.serverTimeoutMs;
    let url: string | null = null;
    while (Date.now() < deadline) {
        if (portInUse) {
            await stop();
            throw new PortInUse();
        }
        if (exited) {
            await stop();
            throw new UserError(
                `The ${side.name} server exited before it was ready (${command} in ${side.appDir}):\n${tail(output.join("\n"), 40)}`
            );
        }
        // With our own `next` command we also wait for Next's "Ready" line, so a stray listener on
        // the port can't be mistaken for the server
        if ((custom || ready) && (await canConnect("127.0.0.1", port))) {
            url = `http://${custom ? "localhost" : "127.0.0.1"}:${port}`;
            break;
        }
        if (custom && (await canConnect("::1", port))) {
            url = `http://localhost:${port}`;
            break;
        }
        // A custom command might ignore PORT and listen elsewhere; trust the URL it prints
        if (custom && announcedUrl) {
            const { hostname, port: announcedPort } = new URL(announcedUrl);
            if (await canConnect(hostname === "localhost" ? "127.0.0.1" : hostname, Number(announcedPort))) {
                url = announcedUrl;
                break;
            }
        }
        await sleep(300);
    }
    if (!url) {
        await stop();
        throw new UserError(
            `The ${side.name} server did not become ready on port ${port} within ${options.serverTimeoutMs / 1000}s.` +
                (custom ? ` Make sure your --command uses {port} or the PORT environment variable.` : "") +
                `\n${tail(output.join("\n"), 40)}`
        );
    }
    // Give a server that's about to crash (e.g. port taken by a child process) a moment to say so
    await sleep(200);
    if (portInUse) {
        await stop();
        throw new PortInUse();
    }
    log.debug(`${side.name}: server ready at ${url}`);
    return { url, errors, stop };
}
