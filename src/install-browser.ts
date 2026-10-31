import { spawn } from "node:child_process";
import { findBrowser } from "./browser";
import { log } from "./log";
import { UserError } from "./util";

// Playwright's installer downloads the right build for the platform and, with --with-deps, the
// system libraries Chromium needs on Linux. It runs through npx because Playwright's tooling needs
// Node (which Next.js needs anyway). Browsers land in Playwright's cache, where findBrowser looks.
export function installBrowserCommand(withDeps: boolean): string {
    return `npx --yes playwright@latest install${withDeps ? " --with-deps" : ""} chromium-headless-shell`;
}

export async function installBrowser(withDeps: boolean): Promise<number> {
    if (!Bun.which("npx")) {
        throw new UserError("npx was not found. Install Node.js (Next.js needs it anyway) and try again.");
    }
    const command = installBrowserCommand(withDeps);
    log.step(`Installing Chromium headless shell (${command})`);
    const code = await new Promise<number>((resolve) => {
        const child = spawn(command, { stdio: ["inherit", "inherit", "pipe"], shell: true });
        // Playwright always warns in a box that it should be a project dependency when run through
        // npx. That doesn't apply here, so drop the box and pass everything else through.
        let pending = "";
        const forward = (text: string) => {
            for (const line of text.split("\n")) {
                if (!/^\s*[╔║╚]/.test(line)) process.stderr.write(line + "\n");
            }
        };
        child.stderr!.setEncoding("utf8");
        child.stderr!.on("data", (chunk: string) => {
            pending += chunk;
            const end = pending.lastIndexOf("\n");
            if (end === -1) return;
            forward(pending.slice(0, end));
            pending = pending.slice(end + 1);
        });
        child.on("error", () => resolve(-1));
        child.on("close", (exitCode) => {
            if (pending) forward(pending);
            resolve(exitCode ?? -1);
        });
    });
    if (code !== 0) {
        throw new UserError(
            `Installing the browser failed (exit code ${code}).` +
                (process.platform === "linux" && !withDeps ? " If system libraries are missing, retry with --with-deps." : "")
        );
    }
    process.stdout.write(`next-camera will use: ${findBrowser()}\n`);
    return 0;
}
