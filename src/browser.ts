import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ColorScheme, Viewport } from "./config";
import { log } from "./log";
import { isWindows, onCleanup, sleep, UserError, withTimeout } from "./util";

// ---------- Finding a browser ----------

const EXECUTABLE_NAMES = new Set([
    "chrome-headless-shell",
    "chrome-headless-shell.exe",
    "headless_shell",
    "headless_shell.exe",
    "chrome",
    "chrome.exe",
    "Google Chrome for Testing",
    "Chromium",
]);

function findExecutableIn(dir: string, depth = 0): string | null {
    if (depth > 5) return null;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const entry of entries) {
        if (entry.isFile() && EXECUTABLE_NAMES.has(entry.name)) return path.join(dir, entry.name);
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = findExecutableIn(path.join(dir, entry.name), depth + 1);
        if (found) return found;
    }
    return null;
}

// Browsers downloaded by Playwright / Puppeteer, newest first, headless shell preferred
function cachedBrowsers(): string[] {
    const home = os.homedir();
    const playwrightRoot =
        process.env.PLAYWRIGHT_BROWSERS_PATH ??
        (isWindows
            ? path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "ms-playwright")
            : process.platform === "darwin"
              ? path.join(home, "Library", "Caches", "ms-playwright")
              : path.join(home, ".cache", "ms-playwright"));
    const results: string[] = [];
    const revision = (name: string) => Number(name.split("-").pop()) || 0;
    for (const prefix of ["chromium_headless_shell-", "chromium-"]) {
        let dirs: string[] = [];
        try {
            dirs = fs.readdirSync(playwrightRoot).filter((name) => name.startsWith(prefix));
        } catch {
            // not installed
        }
        dirs.sort((a, b) => revision(b) - revision(a));
        for (const dir of dirs) {
            const exe = findExecutableIn(path.join(playwrightRoot, dir));
            if (exe) results.push(exe);
        }
    }
    for (const kind of ["chrome-headless-shell", "chrome"]) {
        const dir = path.join(home, ".cache", "puppeteer", kind);
        try {
            const versions = fs.readdirSync(dir).sort().reverse();
            for (const version of versions) {
                const exe = findExecutableIn(path.join(dir, version));
                if (exe) results.push(exe);
            }
        } catch {
            // not installed
        }
    }
    return results;
}

function systemBrowsers(): string[] {
    if (isWindows) {
        const roots = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(
            (root): root is string => !!root
        );
        return roots.flatMap((root) => [
            path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
            path.join(root, "Chromium", "Application", "chrome.exe"),
            path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        ]);
    }
    if (process.platform === "darwin") {
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];
    }
    return ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge"]
        .map((name) => Bun.which(name))
        .filter((exe): exe is string => !!exe);
}

export function findBrowser(explicit?: string): string {
    const requested = explicit ?? process.env.NEXT_CAMERA_BROWSER ?? process.env.CHROME_PATH;
    if (requested) {
        if (fs.existsSync(requested)) return requested;
        const onPath = Bun.which(requested);
        if (onPath) return onPath;
        throw new UserError(`Browser executable not found: ${requested}`);
    }
    for (const candidate of [...cachedBrowsers(), ...systemBrowsers()]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new UserError(
        "No Chrome, Chromium or Edge installation found.\n" +
            "Run `next-camera install-browser` to download one, or pass --browser <path> (or set NEXT_CAMERA_BROWSER)."
    );
}

// ---------- Chrome DevTools Protocol client ----------
// Playwright's transports (pipes / its bundled ws client) don't work under Bun on every platform,
// so we talk CDP directly over Bun's native WebSocket. We only need a handful of commands.

type EventHandler = (method: string, params: any) => void;

class Connection {
    private nextId = 1;
    private callbacks = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string }>();
    private handlers = new Map<string, Set<EventHandler>>();
    private closed = false;

    private constructor(private ws: WebSocket) {
        ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
        ws.addEventListener("close", () => {
            this.closed = true;
            for (const callback of this.callbacks.values()) {
                callback.reject(new Error(`Browser connection closed while waiting for ${callback.method}`));
            }
            this.callbacks.clear();
        });
    }

    static async connect(url: string): Promise<Connection> {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener("error", () => reject(new Error(`Could not connect to the browser at ${url}`)), { once: true });
        });
        return new Connection(ws);
    }

    private onMessage(data: string) {
        const message = JSON.parse(data);
        if (message.id !== undefined) {
            const callback = this.callbacks.get(message.id);
            if (!callback) return;
            this.callbacks.delete(message.id);
            if (message.error) callback.reject(new Error(`${callback.method}: ${message.error.message}`));
            else callback.resolve(message.result);
            return;
        }
        const handlers = this.handlers.get(message.sessionId ?? "");
        if (handlers) for (const handler of handlers) handler(message.method, message.params);
    }

    // Every command gets a timeout: a page that never responds must not hang the whole run
    send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = 90_000): Promise<T> {
        if (this.closed) return Promise.reject(new Error(`Browser connection closed (${method})`));
        const id = this.nextId++;
        const promise = new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.callbacks.delete(id);
                reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
            this.callbacks.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
                method,
            });
        });
        this.ws.send(JSON.stringify({ id, method, params, sessionId }));
        return promise;
    }

    on(sessionId: string, handler: EventHandler): () => void {
        if (!this.handlers.has(sessionId)) this.handlers.set(sessionId, new Set());
        this.handlers.get(sessionId)!.add(handler);
        return () => this.handlers.get(sessionId)?.delete(handler);
    }

    close() {
        this.ws.close();
    }
}

// ---------- Browser ----------

export class Browser {
    private constructor(
        private connection: Connection,
        private process: ChildProcess,
        private userDataDir: string,
        readonly executable: string
    ) {}

    static async launch(executable: string): Promise<Browser> {
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "next-camera-chrome-"));
        const args = [
            "--headless",
            "--remote-debugging-port=0",
            `--user-data-dir=${userDataDir}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--hide-scrollbars",
            "--mute-audio",
            "--force-color-profile=srgb",
            "--font-render-hinting=none",
            "--disable-extensions",
            "--disable-sync",
            "--disable-default-apps",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-features=Translate,MediaRouter,OptimizationHints,PaintHolding",
            "--disable-dev-shm-usage",
            ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []),
            "about:blank",
        ];
        log.debug(`Launching ${executable}`);
        const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

        const wsUrl = await withTimeout(
            new Promise<string>((resolve, reject) => {
                let stderr = "";
                child.stderr!.setEncoding("utf8");
                child.stderr!.on("data", (chunk: string) => {
                    stderr += chunk;
                    const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
                    if (match) resolve(match[1]);
                });
                child.on("error", (error) => reject(new UserError(`Could not start ${executable}: ${error.message}`)));
                child.on("exit", (code) =>
                    reject(new UserError(`Browser exited during startup (code ${code}):\n${stderr.trim().slice(-2000)}`))
                );
            }),
            30_000,
            `Timed out waiting for ${executable} to start`
        );
        const connection = await Connection.connect(wsUrl);
        const browser = new Browser(connection, child, userDataDir, executable);
        onCleanup(() => browser.close());
        return browser;
    }

    async version(): Promise<string> {
        const info = await this.connection.send<{ product: string }>("Browser.getVersion");
        return info.product;
    }

    newTab(viewport: Viewport, colorScheme: ColorScheme): Promise<Tab> {
        return Tab.open(this.connection, viewport, colorScheme);
    }

    private closing: Promise<void> | null = null;
    close(): Promise<void> {
        this.closing ??= (async () => {
            try {
                await withTimeout(this.connection.send("Browser.close"), 3000, "close timeout");
            } catch {
                // fall through to kill
            }
            this.connection.close();
            if (this.process.exitCode === null) this.process.kill();
            // Chrome keeps files locked for a moment after exiting on Windows
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    fs.rmSync(this.userDataDir, { recursive: true, force: true });
                    break;
                } catch {
                    await sleep(300);
                }
            }
        })();
        return this.closing;
    }
}

// ---------- Tab / capture ----------

export interface PageIssue {
    kind: "http" | "console" | "exception" | "request";
    message: string;
}

export interface CaptureOptions {
    navigationTimeoutMs: number;
    fullPage: boolean;
    hide: string[];
    mask: string[];
    css: string;
    waitMs: number;
}

export interface Capture {
    png: Buffer | null;
    width: number;
    height: number;
    status: number | null;
    issues: PageIssue[];
    /** Two consecutive screenshots were identical */
    stable: boolean;
    /** The page was taller than the maximum capture height */
    truncated: boolean;
    /** Navigation or capture failed */
    error?: string;
}

const MAX_CAPTURE_HEIGHT = 16_000;

export function formatConsoleArgs(args: any[]): string {
    const values: string[] = args.map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? arg.type ?? ""));
    let [first, ...rest] = values;
    if (first === undefined) return "";
    // React replays server-side logs in the browser behind a styled badge: "%c%s%c <message>", css, " Server ", css
    let badge = "";
    const badgeMatch = first.match(/^%c%s%c\s*/);
    if (badgeMatch && rest.length >= 3) {
        badge = `[${rest[1].trim()}] `;
        first = first.slice(badgeMatch[0].length);
        rest = rest.slice(3);
    }
    // Apply printf-style substitutions the way the devtools console does (React uses these a lot)
    let index = 0;
    const formatted = first.replace(/%[sdifoOc]/g, (token: string) => {
        const value = rest[index++];
        if (token === "%c") return "";
        return value ?? token;
    });
    return badge + [formatted, ...rest.slice(index)].join(" ").replace(/[ \t]+/g, " ").trim();
}

function truncate(text: string, max = 600): string {
    return text.length > max ? text.slice(0, max) + "…" : text;
}

const FREEZE_SCRIPT = (css: string, hide: string[], mask: string[]) => `(() => {
    const style = document.createElement("style");
    style.setAttribute("data-next-camera", "");
    style.textContent = ${JSON.stringify(
        "*,*::before,*::after{transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}" +
            "nextjs-portal{display:none!important}" +
            hide.map((selector) => `${selector}{visibility:hidden!important}`).join("") +
            css
    )};
    (document.head || document.documentElement).appendChild(style);
    for (const animation of document.getAnimations()) {
        try {
            const timing = animation.effect && animation.effect.getComputedTiming();
            if (timing && Number.isFinite(timing.endTime)) animation.finish(); else animation.cancel();
        } catch {}
    }
    document.querySelectorAll("[data-next-camera-mask]").forEach((el) => el.remove());
    for (const selector of ${JSON.stringify(mask)}) {
        for (const el of document.querySelectorAll(selector)) {
            const rect = el.getBoundingClientRect();
            const box = document.createElement("div");
            box.setAttribute("data-next-camera-mask", "");
            Object.assign(box.style, {
                position: "absolute", left: rect.left + scrollX + "px", top: rect.top + scrollY + "px",
                width: rect.width + "px", height: rect.height + "px", background: "#ff00ff",
                zIndex: "2147483647", pointerEvents: "none",
            });
            document.body.appendChild(box);
        }
    }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
})()`;

const SETTLE_SCRIPT = `(async () => {
    for (const img of document.querySelectorAll('img[loading="lazy"]')) img.loading = "eager";
    const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await Promise.race([document.fonts.ready, timeout(5000)]);
    await Promise.race([
        Promise.all([...document.images].map((img) => img.complete ? null : img.decode().catch(() => null))),
        timeout(5000),
    ]);
})()`;

const NEXT_FRAME_SCRIPT = `new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
})`;

export class Tab {
    private issues: PageIssue[] = [];
    private inflight = new Map<string, { url: string; started: number }>();
    private lastNetworkActivity = Date.now();
    private status: number | null = null;
    private mainFrameId: string | null = null;
    private loadWaiters: (() => void)[] = [];
    private removeHandler: () => void;

    private constructor(
        private connection: Connection,
        private sessionId: string,
        private targetId: string,
        private contextId: string,
        readonly viewport: Viewport
    ) {
        this.removeHandler = connection.on(sessionId, (method, params) => this.onEvent(method, params));
    }

    static async open(connection: Connection, viewport: Viewport, colorScheme: ColorScheme): Promise<Tab> {
        const { browserContextId } = await connection.send("Target.createBrowserContext", { disposeOnDetach: true });
        const { targetId } = await connection.send("Target.createTarget", { url: "about:blank", browserContextId });
        const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
        const tab = new Tab(connection, sessionId, targetId, browserContextId, viewport);
        const send = (method: string, params: object = {}) => connection.send(method, params, sessionId);
        await Promise.all([
            send("Page.enable"),
            send("Runtime.enable"),
            send("Network.enable"),
            send("Emulation.setDeviceMetricsOverride", {
                width: viewport.width,
                height: viewport.height,
                deviceScaleFactor: 1,
                mobile: viewport.mobile,
            }),
            send("Emulation.setEmulatedMedia", {
                features: [
                    { name: "prefers-color-scheme", value: colorScheme },
                    { name: "prefers-reduced-motion", value: "reduce" },
                ],
            }),
            send("Emulation.setTimezoneOverride", { timezoneId: "UTC" }),
            viewport.mobile ? send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }) : null,
        ]);
        return tab;
    }

    private send<T = any>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
        return this.connection.send<T>(method, params, this.sessionId, timeoutMs);
    }

    private onEvent(method: string, params: any) {
        switch (method) {
            case "Network.requestWillBeSent":
                this.inflight.set(params.requestId, { url: params.request.url, started: Date.now() });
                this.lastNetworkActivity = Date.now();
                break;
            case "Network.loadingFinished":
                this.inflight.delete(params.requestId);
                this.lastNetworkActivity = Date.now();
                break;
            case "Network.loadingFailed": {
                const request = this.inflight.get(params.requestId);
                this.inflight.delete(params.requestId);
                this.lastNetworkActivity = Date.now();
                if (!params.canceled && params.errorText !== "net::ERR_ABORTED") {
                    this.issues.push({ kind: "request", message: `${params.errorText} ${request?.url ?? ""}`.trim() });
                }
                break;
            }
            case "Network.responseReceived": {
                const { response, type, frameId } = params;
                if (type === "Document" && (!this.mainFrameId || frameId === this.mainFrameId)) {
                    this.status = response.status;
                } else if (response.status >= 400) {
                    this.issues.push({ kind: "request", message: `HTTP ${response.status} ${response.url}` });
                }
                break;
            }
            case "Runtime.consoleAPICalled":
                if (params.type === "error" || params.type === "assert") {
                    this.issues.push({ kind: "console", message: truncate(formatConsoleArgs(params.args)) });
                }
                break;
            case "Runtime.exceptionThrown": {
                const details = params.exceptionDetails;
                const message = details.exception?.description ?? details.text ?? "Uncaught exception";
                this.issues.push({ kind: "exception", message: truncate(message.split("\n").slice(0, 3).join("\n")) });
                break;
            }
            case "Page.loadEventFired":
                for (const resolve of this.loadWaiters.splice(0)) resolve();
                break;
        }
    }

    private waitForLoad(): Promise<void> {
        return new Promise((resolve) => this.loadWaiters.push(resolve));
    }

    private async waitForNetworkIdle(idleMs: number, timeoutMs: number) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            // Ignore long-lived requests (streaming, long polling) older than 10s
            const now = Date.now();
            const active = [...this.inflight.values()].filter((request) => now - request.started < 10_000).length;
            if (active === 0 && now - this.lastNetworkActivity >= idleMs) return;
            await sleep(50);
        }
        log.debug(`Network did not become idle within ${timeoutMs}ms; continuing`);
    }

    private async evaluate(expression: string, awaitPromise = false) {
        const result = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        }
        return result.result?.value;
    }

    private async screenshot(fullPage: boolean): Promise<{ data: string; width: number; height: number; truncated: boolean }> {
        let width = this.viewport.width;
        let height = this.viewport.height;
        if (fullPage) {
            const metrics = await this.send("Page.getLayoutMetrics");
            const size = metrics.cssContentSize ?? metrics.contentSize;
            width = Math.max(width, Math.ceil(size.width));
            height = Math.max(height, Math.ceil(size.height));
        }
        const truncated = height > MAX_CAPTURE_HEIGHT;
        height = Math.min(height, MAX_CAPTURE_HEIGHT);
        const { data } = await this.send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: fullPage,
            clip: { x: 0, y: 0, width, height, scale: 1 },
        });
        return { data, width, height, truncated };
    }

    async capture(url: string, options: CaptureOptions): Promise<Capture> {
        const result: Capture = { png: null, width: 0, height: 0, status: null, issues: this.issues, stable: false, truncated: false };
        try {
            const loaded = this.waitForLoad();
            // Page.navigate only returns once the server responds (dev servers compile on first request)
            const navigation = await this.send("Page.navigate", { url }, options.navigationTimeoutMs);
            // HTTP errors with an empty body still render an error page, so only network failures are fatal
            if (navigation.errorText && navigation.errorText !== "net::ERR_HTTP_RESPONSE_CODE_FAILURE") {
                throw new Error(`Navigation failed: ${navigation.errorText}`);
            }
            this.mainFrameId = navigation.frameId;
            await withTimeout(loaded, options.navigationTimeoutMs, `Page did not finish loading within ${options.navigationTimeoutMs / 1000}s`);
            await this.evaluate(SETTLE_SCRIPT, true);
            await this.waitForNetworkIdle(500, 15_000);
            if (options.waitMs) await sleep(options.waitMs);

            const freeze = FREEZE_SCRIPT(options.css, options.hide, options.mask);
            await this.evaluate(freeze);
            await this.evaluate(NEXT_FRAME_SCRIPT, true);
            let shot = await this.screenshot(options.fullPage);

            // Retake until two consecutive screenshots match, to catch late layout shifts and flakiness
            for (let attempt = 0; attempt < 3; attempt++) {
                await sleep(250);
                await this.evaluate(freeze);
                await this.evaluate(NEXT_FRAME_SCRIPT, true);
                const next = await this.screenshot(options.fullPage);
                const same = next.data === shot.data;
                shot = next;
                if (same) {
                    result.stable = true;
                    break;
                }
            }
            result.png = Buffer.from(shot.data, "base64");
            result.width = shot.width;
            result.height = shot.height;
            result.truncated = shot.truncated;
        } catch (error) {
            result.error = (error as Error).message;
        }
        result.status = this.status;
        if (this.status !== null && this.status >= 400) {
            result.issues.unshift({ kind: "http", message: `Page responded with HTTP ${this.status}` });
        }
        return result;
    }

    async close() {
        this.removeHandler();
        try {
            await this.connection.send("Target.closeTarget", { targetId: this.targetId });
            await this.connection.send("Target.disposeBrowserContext", { browserContextId: this.contextId });
        } catch {
            // browser may already be gone
        }
    }
}
