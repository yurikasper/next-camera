import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze, type AnalysisOptions } from "../src/affected";
import { defaultUrlFor, enumerateRoutes } from "../src/routes";
import { compareDirectories } from "../src/sources";

const PAGES = path.join(import.meta.dir, "fixtures", "pages-router");
const EXTENSIONS = ["tsx", "ts", "jsx", "js"];

const OPTIONS: AnalysisOptions = {
    pageExtensions: EXTENSIONS,
    globalFiles: [],
    ignoreFiles: [],
    ignoreRoutes: [],
    routeSamples: {},
};

function affected(root: string, changed: string[], options: Partial<AnalysisOptions> = {}) {
    const sides = [
        { name: "base" as const, root, appDir: root },
        { name: "head" as const, root, appDir: root },
    ];
    return analyze(sides, changed, { ...OPTIONS, ...options });
}

describe("routes", () => {
    test("pages router", () => {
        const routes = enumerateRoutes(PAGES, EXTENSIONS);
        expect(routes.map((route) => route.pattern)).toEqual([
            "/",
            "/example",
            "/example/notindex",
            "/example/subroute",
            "/indirect",
            "/notindex",
        ]);
        const home = routes.find((route) => route.pattern === "/")!;
        expect(home.entries.map((entry) => path.basename(entry))).toEqual(["index.tsx", "_app.tsx", "_document.tsx"]);
    });

    test("dynamic segments", () => {
        expect(defaultUrlFor(["blog", "[slug]"])).toBeNull();
        expect(defaultUrlFor(["docs", "[[...slug]]"])).toBe("/docs");
        expect(defaultUrlFor(["[[...slug]]"])).toBe("/");
        expect(defaultUrlFor(["a", "b"])).toBe("/a/b");
    });
});

describe("affected routes", () => {
    test("a shared component affects every page that imports it, directly or indirectly", () => {
        const result = affected(PAGES, ["src/components/Button/Button.tsx"]);
        expect(result.targets.map((target) => target.url)).toEqual([
            "/",
            "/example",
            "/example/notindex",
            "/example/subroute",
            "/indirect",
            "/notindex",
        ]);
        const indirect = result.targets.find((target) => target.url === "/indirect")!;
        expect(indirect.reasons[0].via).toEqual([
            "src/pages/indirect.tsx",
            "src/components/IndirectUse/IndirectUse.tsx",
            "src/components/Button/Button.tsx",
        ]);
    });

    test("a component used by one page only affects that page", () => {
        const result = affected(PAGES, ["src/components/IndirectUse/IndirectUse.tsx"]);
        expect(result.targets.map((target) => target.url)).toEqual(["/indirect"]);
    });

    test("global CSS imported by _app affects every page", () => {
        const result = affected(PAGES, ["src/styles/globals.css"]);
        expect(result.targets).toHaveLength(6);
    });

    test("config and dependency files affect every page", () => {
        const result = affected(PAGES, ["package.json"]);
        expect(result.globalFiles).toEqual(["package.json"]);
        expect(result.targets).toHaveLength(6);
    });

    test("public assets affect the pages that reference them", () => {
        const result = affected(PAGES, ["public/next.svg", "public/globe.svg"]);
        expect(result.targets.map((target) => target.url)).toEqual(["/"]);
        expect(result.unmappedFiles).toEqual(["public/globe.svg"]);
    });

    test("files no page uses are reported as unmapped", () => {
        const result = affected(PAGES, ["README.md", "src/pages/api/hello.ts"]);
        expect(result.targets).toEqual([]);
        expect(result.unmappedFiles).toEqual(["README.md", "src/pages/api/hello.ts"]);
    });

    test("ignoreRoutes and ignoreFiles", () => {
        const result = affected(PAGES, ["src/components/Button/Button.tsx", "README.md"], {
            ignoreRoutes: ["/example/**"],
            ignoreFiles: ["*.md"],
        });
        expect(result.targets.map((target) => target.url)).toEqual(["/", "/example", "/indirect", "/notindex"]);
        expect(result.ignoredFiles).toEqual(["README.md"]);
    });

    test("--all selects every route", () => {
        const result = affected(PAGES, null as unknown as string[]);
        expect(result.targets).toHaveLength(6);
    });
});

describe("dynamic routes and deleted files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "next-camera-test-"));
    const write = (dir: string, file: string, content: string) => {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), content);
    };
    const base = path.join(root, "base");
    const head = path.join(root, "head");
    write(base, "pages/index.tsx", `import Card from "../components/Card"; export default () => <Card />;`);
    write(base, "components/Card.tsx", `export default () => <div />;`);
    write(base, "pages/blog/[slug].tsx", `import Card from "../../components/Card"; export default () => <Card />;`);
    // head: index no longer uses Card, Card is deleted, blog page inlines it
    write(head, "pages/index.tsx", `export default () => <div />;`);
    write(head, "pages/blog/[slug].tsx", `export default () => <div />;`);
    const sides = [
        { name: "base" as const, root: base, appDir: base },
        { name: "head" as const, root: head, appDir: head },
    ];

    test("a file deleted in head still maps to the pages that used it in base", () => {
        const result = analyze(sides, ["components/Card.tsx"], OPTIONS);
        expect(result.targets.map((target) => target.url)).toEqual(["/"]);
        expect(result.skipped.map((skipped) => skipped.pattern)).toEqual(["/blog/[slug]"]);
    });

    test("sample params make dynamic routes capturable", () => {
        const result = analyze(sides, ["components/Card.tsx"], { ...OPTIONS, routeSamples: { "/blog/[slug]": ["/blog/hello"] } });
        expect(result.targets.map((target) => target.url)).toEqual(["/", "/blog/hello"]);
    });

    test("directory comparison finds added, removed and modified files", () => {
        expect(compareDirectories(base, head)).toEqual(["components/Card.tsx", "pages/blog/[slug].tsx", "pages/index.tsx"]);
    });

    test("directory comparison ignores line-ending-only differences", () => {
        const lf = fs.mkdtempSync(path.join(os.tmpdir(), "next-camera-lf-"));
        const crlf = fs.mkdtempSync(path.join(os.tmpdir(), "next-camera-crlf-"));
        try {
            const text = "export default () => (\n    <div />\n);\n";
            for (const [dir, content] of [[lf, text], [crlf, text.replace(/\n/g, "\r\n")]]) {
                fs.mkdirSync(path.join(dir, "pages"));
                fs.writeFileSync(path.join(dir, "pages", "index.tsx"), content);
            }
            expect(compareDirectories(lf, crlf)).toEqual([]);
        } finally {
            fs.rmSync(lf, { recursive: true, force: true });
            fs.rmSync(crlf, { recursive: true, force: true });
        }
    });
});
