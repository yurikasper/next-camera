import fs from "node:fs";
import path from "node:path";
import { analyze, type Analysis, type Target } from "./affected";
import { Browser, findBrowser, type Capture, type PageIssue } from "./browser";
import { VERSION, type Options } from "./cli";
import type { ColorScheme, Viewport } from "./config";
import { diffScreenshots, encodePng, findRegions, renderOverview, renderRegion } from "./image";
import { log, out as c } from "./log";
import {
    printSummary,
    summarize,
    writeReportFiles,
    type CaptureReport,
    type Report,
    type RouteReport,
    type SideReport,
    type VariantReport,
} from "./report";
import { startServer, type Server } from "./server";
import { prepareSides, resolveSources, type Side } from "./sources";
import { formatDuration, plural, routeSlug, UserError } from "./util";

const OUTPUT_MARKER = ".next-camera-output";

// The output folder is wiped on every run, so refuse to touch folders we didn't create
function prepareOutDir(outDir: string) {
    if (fs.existsSync(outDir)) {
        const entries = fs.readdirSync(outDir);
        if (entries.length && !entries.includes(OUTPUT_MARKER)) {
            throw new UserError(`Output directory ${outDir} is not empty and wasn't created by next-camera. Pick another --out`);
        }
        for (const entry of ["routes", "report.json", "report.md"]) {
            fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
        }
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, OUTPUT_MARKER), "");
    // Keep the output out of git (and out of Tailwind's source scanning) without touching the user's .gitignore
    fs.writeFileSync(path.join(outDir, ".gitignore"), "*\n");
}

function sideReport(side: Side, server?: Server): SideReport {
    return {
        label: side.label,
        kind: side.kind,
        ref: side.ref,
        sha: side.sha,
        dir: side.appDir,
        url: server?.url ?? side.url,
        serverErrors: server?.errors ?? [],
    };
}

// Base and head run on different ports, so normalize origins before comparing error messages
function normalizeIssue(issue: PageIssue): string {
    return `${issue.kind}:${issue.message.replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/g, "<origin>")}`;
}

function issueDelta(from: PageIssue[], to: PageIssue[]): PageIssue[] {
    const known = new Set(from.map(normalizeIssue));
    const seen = new Set<string>();
    return to.filter((issue) => {
        const key = normalizeIssue(issue);
        if (known.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function captureReport(capture: Capture, image: string | null): CaptureReport {
    return {
        image,
        width: capture.width,
        height: capture.height,
        status: capture.status,
        stable: capture.stable,
        truncated: capture.truncated,
        issues: capture.issues,
        error: capture.error,
    };
}

interface Variant {
    name: string;
    viewport: Viewport;
    colorScheme: ColorScheme;
}

function variantsFor(options: Options): Variant[] {
    return options.viewports.flatMap((viewport) =>
        options.colorSchemes.map((colorScheme) => ({
            name: colorScheme === "dark" ? `${viewport.name}-dark` : viewport.name,
            viewport,
            colorScheme,
        }))
    );
}

async function captureTarget(
    browser: Browser,
    servers: { base: Server; head: Server },
    target: Target,
    variant: Variant,
    options: Options
): Promise<VariantReport> {
    const captureOptions = {
        navigationTimeoutMs: options.navigationTimeoutMs,
        fullPage: options.fullPage,
        hide: options.hide,
        mask: options.mask,
        css: options.css,
        waitMs: options.waitMs,
    };
    const tabs = await Promise.all([
        browser.newTab(variant.viewport, variant.colorScheme),
        browser.newTab(variant.viewport, variant.colorScheme),
    ]);
    let base: Capture;
    let head: Capture;
    try {
        [base, head] = await Promise.all([
            tabs[0].capture(servers.base.url + target.url, captureOptions),
            tabs[1].capture(servers.head.url + target.url, captureOptions),
        ]);
    } finally {
        await Promise.all(tabs.map((tab) => tab.close()));
    }

    const dir = path.join(options.out, "routes", routeSlug(target.url), variant.name);
    fs.mkdirSync(dir, { recursive: true });
    const write = (name: string, data: Buffer) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, data);
        return file;
    };
    const baseImage = base.png ? write("base.png", base.png) : null;
    const headImage = head.png ? write("head.png", head.png) : null;

    const report: VariantReport = {
        variant: variant.name,
        viewport: { width: variant.viewport.width, height: variant.viewport.height },
        colorScheme: variant.colorScheme,
        status: "failed",
        diffPixels: 0,
        diffPercent: 0,
        diffImage: null,
        regions: [],
        base: captureReport(base, baseImage),
        head: captureReport(head, headImage),
        newIssues: issueDelta(base.issues, head.issues),
        resolvedIssues: issueDelta(head.issues, base.issues),
    };
    if (!base.png || !head.png) return report;

    const diff = diffScreenshots(base.png, head.png, options.threshold);
    report.diffPixels = diff.diffPixels;
    report.diffPercent = (diff.diffPixels / (diff.width * diff.height)) * 100;
    if (diff.diffPixels === 0) {
        report.status = "unchanged";
        return report;
    }

    report.status = "changed";
    const regions = findRegions(diff.mask, diff.width, diff.height, options.maxRegions);
    report.diffImage = write("diff.png", encodePng(renderOverview(diff, regions)));
    report.regions = regions.map((region, i) => {
        const rendered = renderRegion(diff, region);
        return {
            index: i + 1,
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
            pixels: region.pixels,
            image: write(`region-${i + 1}.png`, encodePng(rendered.image)),
            truncated: rendered.truncated,
        };
    });
    return report;
}

function routeStatus(variants: VariantReport[]): RouteReport["status"] {
    if (variants.some((variant) => variant.status === "changed")) return "changed";
    if (variants.some((variant) => variant.status === "failed")) return "failed";
    return "unchanged";
}

function printDryRun(analysis: Analysis, changedFiles: string[], options: Options) {
    const lines: string[] = [];
    if (options.routes.length === 0 && !options.all) {
        lines.push(`${plural(changedFiles.length, "changed file")}:`);
        for (const file of changedFiles) lines.push(`  ${file}`);
        lines.push("");
    }
    lines.push(`${plural(analysis.targets.length, "route")} would be captured:`);
    for (const target of analysis.targets) {
        lines.push(`  ${c.bold(target.url)}${target.inHead ? "" : c.dim(" (removed in head)")}${target.inBase ? "" : c.dim(" (new in head)")}`);
        for (const reason of target.reasons.slice(0, 5)) {
            if (reason.kind === "import" || reason.kind === "asset") {
                lines.push(c.dim(`    ${reason.file}${reason.via && reason.via.length > 1 ? ` ← ${reason.via.slice(0, -1).reverse().join(" ← ")}` : ""}`));
            } else if (reason.kind === "global") {
                lines.push(c.dim(`    ${reason.file} (affects every page)`));
            }
        }
        if (target.reasons.length > 5) lines.push(c.dim(`    …and ${target.reasons.length - 5} more`));
    }
    for (const skipped of analysis.skipped) lines.push(`  ${c.dim(`skipped ${skipped.pattern}: ${skipped.reason}`)}`);
    if (analysis.unmappedFiles.length) lines.push("", c.dim(`Not used by any page: ${analysis.unmappedFiles.join(", ")}`));
    process.stdout.write(lines.join("\n") + "\n");
}

export async function compare(options: Options): Promise<number> {
    const started = Date.now();
    const sources = await resolveSources(options);
    const { base, head } = sources;
    log.step(`Comparing ${c.bold(base.label)} → ${c.bold(head.label)}`);

    const selection: Report["selection"] = options.routes.length ? "requested" : options.all ? "all" : "affected";
    const report: Report = {
        tool: "next-camera",
        version: VERSION,
        createdAt: new Date().toISOString(),
        durationMs: 0,
        outDir: options.out,
        base: sideReport(base),
        head: sideReport(head),
        browser: null,
        changedFiles: sources.changedFiles,
        selection,
        routeCount: 0,
        globalFiles: [],
        unmappedFiles: [],
        ignoredFiles: [],
        skipped: [],
        routes: [],
        summary: { changed: 0, unchanged: 0, failed: 0, skipped: 0, newIssues: 0 },
    };
    const finish = (code: number) => {
        report.durationMs = Date.now() - started;
        report.summary = summarize(report);
        if (!options.dryRun) writeReportFiles(report);
        if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        else printSummary(report, options.cwd);
        return code;
    };

    if (!options.dryRun) prepareOutDir(options.out);
    if (selection === "affected" && sources.changedFiles.length === 0) {
        log.info("No changed files.");
        return finish(0);
    }
    if (selection === "affected") log.info(plural(sources.changedFiles.length, "changed file"));

    await prepareSides(sources, options, !options.dryRun);

    log.step(selection === "requested" ? "Collecting requested routes" : "Finding affected routes");
    const analysis: Analysis =
        selection === "requested"
            ? {
                  targets: options.routes.map((url) => ({
                      url,
                      pattern: url,
                      router: null,
                      reasons: [{ kind: "requested" }],
                      inBase: true,
                      inHead: true,
                  })),
                  skipped: [],
                  globalFiles: [],
                  unmappedFiles: [],
                  ignoredFiles: [],
                  routeCount: options.routes.length,
              }
            : analyze([base, head], selection === "all" ? null : sources.changedFiles, {
                  pageExtensions: options.pageExtensions,
                  globalFiles: options.globalFiles,
                  ignoreFiles: options.ignoreFiles,
                  ignoreRoutes: options.ignoreRoutes,
                  routeSamples: options.routeSamples,
              });
    Object.assign(report, {
        routeCount: analysis.routeCount,
        globalFiles: analysis.globalFiles,
        unmappedFiles: analysis.unmappedFiles,
        ignoredFiles: analysis.ignoredFiles,
        skipped: analysis.skipped,
    });

    if (options.dryRun) {
        if (options.json) {
            const { targets, skipped, globalFiles, unmappedFiles, ignoredFiles } = analysis;
            const plan = {
                base: sideReport(base),
                head: sideReport(head),
                changedFiles: sources.changedFiles,
                targets,
                skipped,
                globalFiles,
                unmappedFiles,
                ignoredFiles,
            };
            process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
        } else {
            printDryRun(analysis, sources.changedFiles, options);
        }
        return 0;
    }
    if (analysis.targets.length === 0) {
        log.info("No routes are affected by the changed files.");
        return finish(0);
    }

    const variants = variantsFor(options);
    log.info(`${plural(analysis.targets.length, "route")} to capture${variants.length > 1 ? ` × ${variants.length} variants` : ""}`);

    const executable = findBrowser(options.browser);
    const [browser, baseServer, headServer] = await Promise.all([
        Browser.launch(executable),
        startServer(base, options),
        startServer(head, options),
    ]);
    report.browser = await browser.version().catch(() => executable);
    report.base = sideReport(base, baseServer);
    report.head = sideReport(head, headServer);
    log.debug(`Browser: ${report.browser} (${executable})`);

    for (const target of analysis.targets) {
        const variantReports: VariantReport[] = [];
        for (const variant of variants) {
            const t0 = Date.now();
            log.step(`Capturing ${target.url} ${c.dim(`(${variant.name})`)}`);
            const result = await captureTarget(browser, { base: baseServer, head: headServer }, target, variant, options);
            log.debug(`${target.url} ${variant.name}: ${result.status} in ${formatDuration(Date.now() - t0)}`);
            variantReports.push(result);
        }
        report.routes.push({
            url: target.url,
            pattern: target.pattern,
            router: target.router,
            status: routeStatus(variantReports),
            note: !target.inBase ? "new page" : !target.inHead ? "removed page" : undefined,
            reasons: target.reasons,
            variants: variantReports,
        });
    }

    await Promise.all([baseServer.stop(), headServer.stop(), browser.close()]);
    log.step(`Done in ${formatDuration(Date.now() - started)}`);

    const summary = summarize(report);
    const failed = summary.changed > 0 || summary.newIssues > 0 || summary.failed > 0;
    return finish(options.failOnDiff && failed ? 1 : 0);
}
