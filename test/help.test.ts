import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { helpText, parseCli } from "../src/cli";

const topic = (...argv: string[]) => {
    const args = parseCli(argv);
    return args.command === "help" ? (args.positionals[0] ?? "general") : `not help: ${args.command}`;
};

describe("help", () => {
    test("general help", () => {
        expect(topic("--help")).toBe("general");
        expect(topic("-h")).toBe("general");
        expect(topic("help")).toBe("general");
        // --help with refs or directories is still the general help
        expect(topic("main", "--help")).toBe("general");
        expect(helpText()).toStartWith("next-camera ");
        expect(helpText()).toContain("next-camera help <command>");
    });

    test("per-command help", () => {
        expect(topic("help", "clean")).toBe("clean");
        expect(topic("clean", "--help")).toBe("clean");
        expect(topic("install-browser", "-h")).toBe("install-browser");
        expect(topic("help", "install-browser")).toBe("install-browser");
        expect(helpText("clean")).toStartWith("next-camera clean [--all]");
        expect(helpText("install-browser")).toStartWith("next-camera install-browser [--with-deps]");
    });

    test("unknown help topics are errors", () => {
        expect(() => helpText("nope")).toThrow('No help for "nope"');
        const result = spawnSync(process.execPath, [path.join(import.meta.dir, "..", "src", "index.ts"), "help", "nope"], {
            encoding: "utf8",
            env: { ...process.env, NO_COLOR: "1" },
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("clean, install-browser");
    });
});
