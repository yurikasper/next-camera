import { describe, expect, test } from "bun:test";
import { formatConsoleArgs } from "../src/browser";

// Console arguments as CDP sends them (Runtime.RemoteObject)
const value = (v: unknown) => ({ type: typeof v, value: v });

describe("console messages", () => {
    test("plain arguments are joined", () => {
        expect(formatConsoleArgs([value("Failed:"), value(42)])).toBe("Failed: 42");
    });

    test("printf-style substitutions are applied and styles dropped", () => {
        expect(formatConsoleArgs([value("%cWarning: %s is %d"), value("color:red"), value("x"), value(3)])).toBe("Warning: x is 3");
    });

    test("React's replayed server logs get a readable badge", () => {
        const args = [value("%c%s%c IndirectUse: failed to load user"), value("background: #e6e6e6"), value(" Server "), value("")];
        expect(formatConsoleArgs(args)).toBe("[Server] IndirectUse: failed to load user");
    });

    test("objects use their description", () => {
        expect(formatConsoleArgs([value("Error:"), { type: "object", description: "TypeError: x is undefined" }])).toBe(
            "Error: TypeError: x is undefined"
        );
    });
});
