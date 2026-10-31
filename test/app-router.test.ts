import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze, type AnalysisOptions } from "../src/affected";
import { enumerateRoutes, findRouterDirs } from "../src/routes";
import { toPosix } from "../src/util";

const SAMPLE = path.join(import.meta.dir, "fixtures", "app-router");
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

const urls = (result: ReturnType<typeof affected>) => result.targets.map((target) => target.url);

describe("app router sample", () => {
    test("routes and the layouts wrapping them", () => {
        const routes = enumerateRoutes(SAMPLE, EXTENSIONS);
        expect(routes.map((route) => route.pattern)).toEqual(["/", "/indirect", "/subroute"]);
        expect(routes.every((route) => route.router === "app")).toBe(true);
        const sub = routes.find((route) => route.pattern === "/subroute")!;
        expect(sub.entries.map((entry) => toPosix(path.relative(SAMPLE, entry)))).toEqual([
            "src/app/subroute/page.tsx",
            "src/app/layout.tsx",
        ]);
    });

    test("a shared component affects every page using it, through relative and @/ imports", () => {
        const result = affected(SAMPLE, ["src/components/Button/Button.tsx"]);
        expect(urls(result)).toEqual(["/", "/indirect", "/subroute"]);
        const indirect = result.targets.find((target) => target.url === "/indirect")!;
        expect(indirect.reasons[0].via).toEqual([
            "src/app/indirect/page.tsx",
            "src/components/IndirectUse/IndirectUse.tsx",
            "src/components/Button/Button.tsx",
        ]);
    });

    test("a component used by one page only affects that page", () => {
        expect(urls(affected(SAMPLE, ["src/components/IndirectUse/IndirectUse.tsx"]))).toEqual(["/indirect"]);
    });

    test("the root layout and the global CSS it imports affect every page", () => {
        expect(urls(affected(SAMPLE, ["src/app/layout.tsx"]))).toEqual(["/", "/indirect", "/subroute"]);
        expect(urls(affected(SAMPLE, ["src/app/globals.css"]))).toEqual(["/", "/indirect", "/subroute"]);
    });
});

// A synthetic app using the App Router features the sample doesn't have
describe("app router features", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "next-camera-app-"));
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
    const files: Record<string, string> = {
        "components/Nav.tsx": `export default () => <nav />;`,
        "components/Banner.tsx": `export default () => <aside />;`,
        "components/Sidebar.tsx": `export default () => <aside />;`,
        "components/StatsCard.tsx": `export default () => <div />;`,
        "components/Card.tsx": `export default () => <div />;`,
        "app/globals.css": `body { margin: 0 }`,
        "app/layout.tsx": `import Nav from "../components/Nav"; import "./globals.css"; export default ({ children }) => <html><body><Nav />{children}</body></html>;`,
        "app/page.tsx": `export default () => <main />;`,
        // Route group with its own layout: not part of the URL
        "app/(marketing)/layout.tsx": `import Banner from "../../components/Banner"; export default ({ children }) => <><Banner />{children}</>;`,
        "app/(marketing)/about/page.tsx": `export default () => <main />;`,
        "app/(marketing)/pricing/page.tsx": `export default () => <main />;`,
        // Nested layout + loading UI scoped to /dashboard, and a parallel route slot rendered on /dashboard
        "app/dashboard/layout.tsx": `import Sidebar from "../../components/Sidebar"; export default ({ children, stats }) => <><Sidebar />{stats}{children}</>;`,
        "app/dashboard/loading.tsx": `export default () => <p>Loading</p>;`,
        "app/dashboard/page.tsx": `export default () => <main />;`,
        "app/dashboard/@stats/page.tsx": `import StatsCard from "../../../components/StatsCard"; export default () => <StatsCard />;`,
        "app/dashboard/settings/page.tsx": `export default () => <main />;`,
        // Dynamic segments
        "app/blog/[slug]/page.tsx": `import Card from "../../../components/Card"; export default () => <Card />;`,
        "app/docs/[[...slug]]/page.tsx": `import Card from "../../../components/Card"; export default () => <Card />;`,
        // Private folders and intercepting routes are not pages
        "app/feed/page.tsx": `import Thing from "../_components/Thing"; export default () => <Thing />;`,
        "app/feed/(.)photo/page.tsx": `export default () => <dialog />;`,
        "app/_components/Thing.tsx": `export default () => <div />;`,
        "app/_internal/page.tsx": `export default () => <main />;`,
        // Route handler, not a page
        "app/api/health/route.ts": `export function GET() { return new Response("ok"); }`,
        // The Pages Router can live next to the App Router
        "pages/legacy.tsx": `export default () => <main />;`,
    };
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), content);
    }

    test("route groups, slots, private folders and intercepting routes", () => {
        const routes = enumerateRoutes(root, EXTENSIONS);
        expect(routes.map((route) => `${route.router} ${route.pattern}`)).toEqual([
            "app /",
            "app /about",
            "app /blog/[slug]",
            "app /dashboard",
            "app /dashboard/settings",
            "app /docs/[[...slug]]",
            "app /feed",
            "pages /legacy",
            "app /pricing",
        ]);
    });

    test("a route's entries are its page, its slots and every layout/loading file above it", () => {
        const dashboard = enumerateRoutes(root, EXTENSIONS).find((route) => route.pattern === "/dashboard")!;
        expect(dashboard.entries.map((entry) => toPosix(path.relative(root, entry))).sort()).toEqual([
            "app/dashboard/@stats/page.tsx",
            "app/dashboard/layout.tsx",
            "app/dashboard/loading.tsx",
            "app/dashboard/page.tsx",
            "app/layout.tsx",
        ]);
    });

    test("the root layout affects every app route but not pages/ routes", () => {
        const result = affected(root, ["components/Nav.tsx"]);
        expect(urls(result)).toEqual(["/", "/about", "/dashboard", "/dashboard/settings", "/docs", "/feed", "/pricing"]);
        expect(result.skipped.map((skipped) => skipped.pattern)).toEqual(["/blog/[slug]"]);
    });

    test("a route group layout only affects the routes in the group", () => {
        expect(urls(affected(root, ["components/Banner.tsx"]))).toEqual(["/about", "/pricing"]);
    });

    test("a nested layout and loading UI only affect their subtree", () => {
        expect(urls(affected(root, ["components/Sidebar.tsx"]))).toEqual(["/dashboard", "/dashboard/settings"]);
        expect(urls(affected(root, ["app/dashboard/loading.tsx"]))).toEqual(["/dashboard", "/dashboard/settings"]);
    });

    test("a parallel route slot affects the route it renders on", () => {
        expect(urls(affected(root, ["components/StatsCard.tsx"]))).toEqual(["/dashboard"]);
    });

    test("dynamic segments need samples, optional catch-alls don't", () => {
        const result = affected(root, ["components/Card.tsx"]);
        expect(urls(result)).toEqual(["/docs"]);
        expect(result.skipped.map((skipped) => skipped.pattern)).toEqual(["/blog/[slug]"]);
        const withSamples = affected(root, ["components/Card.tsx"], { routeSamples: { "/blog/[slug]": ["/blog/hello", "/blog/bye"] } });
        expect(urls(withSamples)).toEqual(["/blog/bye", "/blog/hello", "/docs"]);
    });

    test("components in private folders map to the pages importing them", () => {
        expect(urls(affected(root, ["app/_components/Thing.tsx"]))).toEqual(["/feed"]);
    });

    test("files that aren't pages are reported as unmapped", () => {
        const result = affected(root, ["app/_internal/page.tsx", "app/feed/(.)photo/page.tsx", "app/api/health/route.ts"]);
        expect(result.targets).toEqual([]);
        expect(result.unmappedFiles).toEqual(["app/_internal/page.tsx", "app/feed/(.)photo/page.tsx", "app/api/health/route.ts"]);
    });

    test("app/ at the root takes precedence over src/app", () => {
        const both = fs.mkdtempSync(path.join(os.tmpdir(), "next-camera-dirs-"));
        try {
            fs.mkdirSync(path.join(both, "app"), { recursive: true });
            fs.mkdirSync(path.join(both, "src", "app"), { recursive: true });
            expect(findRouterDirs(both).appDir).toBe(path.join(both, "app"));
            fs.rmSync(path.join(both, "app"), { recursive: true });
            expect(findRouterDirs(both).appDir).toBe(path.join(both, "src", "app"));
        } finally {
            fs.rmSync(both, { recursive: true, force: true });
        }
    });
});
