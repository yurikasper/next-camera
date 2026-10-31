import fs from "node:fs";
import path from "node:path";
import type { Reason, Skipped } from "./affected";
import type { PageIssue } from "./browser";
import type { ColorScheme } from "./config";
import { out as c } from "./log";
import { plural, toPosix } from "./util";

export interface SideReport {
    label: string;
    kind: "ref" | "working-tree" | "dir";
    ref?: string;
    sha?: string;
    dir: string;
    url?: string;
    /** Error lines printed by the server while capturing (compile errors, SSR exceptions) */
    serverErrors: string[];
}

export interface CaptureReport {
    image: string | null;
    width: number;
    height: number;
    status: number | null;
    stable: boolean;
    truncated: boolean;
    issues: PageIssue[];
    error?: string;
}

export interface RegionReport {
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
    pixels: number;
    image: string;
    /** The region was taller than the maximum panel height and got cut off */
    truncated: boolean;
}

export type CaptureStatus = "changed" | "unchanged" | "failed";

export interface VariantReport {
    variant: string;
    viewport: { width: number; height: number };
    colorScheme: ColorScheme;
    status: CaptureStatus;
    diffPixels: number;
    diffPercent: number;
    diffImage: string | null;
    regions: RegionReport[];
    base: CaptureReport;
    head: CaptureReport;
    /** Page errors in head that weren't in base */
    newIssues: PageIssue[];
    /** Page errors in base that are gone in head */
    resolvedIssues: PageIssue[];
}

export interface RouteReport {
    url: string;
    pattern: string;
    router: "pages" | "app" | null;
    status: CaptureStatus;
    note?: "new page" | "removed page";
    reasons: Reason[];
    variants: VariantReport[];
}

export interface Report {
    tool: "next-camera";
    version: string;
    createdAt: string;
    durationMs: number;
    outDir: string;
    base: SideReport;
    head: SideReport;
    browser: string | null;
    changedFiles: string[];
    selection: "affected" | "all" | "requested";
    routeCount: number;
    globalFiles: string[];
    unmappedFiles: string[];
    ignoredFiles: string[];
    skipped: Skipped[];
    routes: RouteReport[];
    /** Route counts. A route with one changed and one failed variant counts as both changed and failed. */
    summary: { changed: number; unchanged: number; failed: number; skipped: number; newIssues: number };
}

export function summarize(report: Report): Report["summary"] {
    return {
        changed: report.routes.filter((route) => route.status === "changed").length,
        unchanged: report.routes.filter((route) => route.status === "unchanged").length,
        // Routes with any failed variant, including routes whose other variants changed
        failed: report.routes.filter((route) => route.variants.some((variant) => variant.status === "failed")).length,
        skipped: report.skipped.length,
        newIssues: report.routes.reduce(
            (sum, route) => sum + route.variants.reduce((n, variant) => n + variant.newIssues.length, 0),
            0
        ),
    };
}

export function describeReason(reason: Reason): string {
    switch (reason.kind) {
        case "import":
            return reason.via && reason.via.length > 1
                ? `${reason.file} (imported via ${reason.via.slice(0, -1).join(" → ")})`
                : `${reason.file} (the page itself)`;
        case "global":
            return reason.via && reason.via.length > 1
                ? `${reason.file} (imported via ${reason.via.slice(0, -1).join(" → ")}, affects every page)`
                : `${reason.file} (affects every page)`;
        case "asset":
            return `${reason.file} (referenced in ${reason.via?.[reason.via.length - 1] ?? "a page"})`;
        case "all":
            return "--all";
        case "requested":
            return "--route";
    }
}

function formatPercent(value: number): string {
    if (value === 0) return "0%";
    if (value < 0.01) return "<0.01%";
    return `${value < 1 ? value.toFixed(2) : value.toFixed(1)}%`;
}

function sizeChange(variant: VariantReport): string | null {
    const { base, head } = variant;
    if (!base.image || !head.image) return null;
    if (base.width === head.width && base.height === head.height) return null;
    const parts = [];
    if (base.height !== head.height) parts.push(`height ${base.height}→${head.height}px`);
    if (base.width !== head.width) parts.push(`width ${base.width}→${head.width}px`);
    return parts.join(", ");
}

function issueText(issue: PageIssue): string {
    return `${issue.kind}: ${issue.message.split("\n")[0]}`;
}

// ---------- Files ----------

export function writeReportFiles(report: Report) {
    fs.writeFileSync(path.join(report.outDir, "report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(report.outDir, "report.md"), renderMarkdown(report));
}

export function renderMarkdown(report: Report): string {
    const rel = (file: string) => encodeURI(toPosix(path.relative(report.outDir, file)));
    const lines: string[] = [];
    const { summary } = report;
    lines.push(`# Visual changes: ${report.base.label} → ${report.head.label}`, "");
    lines.push(
        `**${summary.changed} changed**, ${summary.unchanged} unchanged, ${summary.failed} failed, ${summary.skipped} skipped` +
            (summary.newIssues ? `, **${plural(summary.newIssues, "new page error")}**` : "") +
            ` · ${new Date(report.createdAt).toISOString()}`,
        ""
    );
    if (report.selection === "affected") {
        lines.push(`<details><summary>${plural(report.changedFiles.length, "changed file")}</summary>`, "");
        for (const file of report.changedFiles) lines.push(`- \`${file}\``);
        lines.push("", "</details>", "");
    }

    const changed = report.routes.filter((route) => route.status === "changed");
    const failed = report.routes.filter((route) => route.variants.some((variant) => variant.status === "failed"));
    const unchanged = report.routes.filter((route) => route.status === "unchanged");
    const withIssues = report.routes.filter((route) => route.variants.some((variant) => variant.newIssues.length));

    if (changed.length) {
        lines.push("## Changed", "");
        for (const route of changed) {
            for (const variant of route.variants.filter((v) => v.status === "changed")) {
                const size = sizeChange(variant);
                lines.push(
                    `### \`${route.url}\` · ${variant.variant} · ${formatPercent(variant.diffPercent)} of pixels changed` +
                        (route.note ? ` (${route.note})` : ""),
                    ""
                );
                lines.push(`Why it was captured: ${route.reasons.map(describeReason).join("; ")}`, "");
                if (size) lines.push(`Page size changed: ${size}`, "");
                if (variant.diffImage) lines.push(`![Overview of changes](${rel(variant.diffImage)})`, "");
                for (const region of variant.regions) {
                    lines.push(
                        `**Region ${region.index}** at x=${region.x}, y=${region.y} (${region.width}×${region.height}px)` +
                            (region.truncated ? " (cropped, see full screenshots)" : ""),
                        "",
                        `![Region ${region.index}](${rel(region.image)})`,
                        ""
                    );
                }
                if (variant.base.image && variant.head.image) {
                    lines.push(`Full screenshots: [before](${rel(variant.base.image)}) · [after](${rel(variant.head.image)})`, "");
                }
            }
        }
    }

    if (withIssues.length) {
        lines.push("## New page errors", "");
        for (const route of withIssues) {
            for (const variant of route.variants) {
                for (const issue of variant.newIssues) lines.push(`- \`${route.url}\` (${variant.variant}): ${issueText(issue)}`);
            }
        }
        lines.push("");
    }

    if (failed.length) {
        lines.push("## Failed", "");
        for (const route of failed) {
            for (const variant of route.variants.filter((v) => v.status === "failed")) {
                const errors = [
                    variant.base.error && `base: ${variant.base.error}`,
                    variant.head.error && `head: ${variant.head.error}`,
                ].filter(Boolean);
                lines.push(`- \`${route.url}\` (${variant.variant}): ${errors.join("; ")}`);
            }
        }
        lines.push("");
    }

    for (const side of [report.base, report.head]) {
        if (side.serverErrors.length) {
            lines.push(`## Server errors (${side === report.base ? "base" : "head"})`, "", "```", ...side.serverErrors, "```", "");
        }
    }

    if (unchanged.length) {
        lines.push("## Unchanged", "");
        for (const route of unchanged) lines.push(`- \`${route.url}\` (${route.variants.map((v) => v.variant).join(", ")})`);
        lines.push("");
    }
    if (report.skipped.length) {
        lines.push("## Skipped", "");
        for (const skipped of report.skipped) lines.push(`- \`${skipped.pattern}\`: ${skipped.reason}`);
        lines.push("");
    }
    if (report.globalFiles.length || report.unmappedFiles.length) {
        lines.push("## Notes", "");
        if (report.globalFiles.length) {
            lines.push(`- These changes can affect every page, so all routes were captured: ${report.globalFiles.map((f) => `\`${f}\``).join(", ")}`);
        }
        if (report.unmappedFiles.length) {
            lines.push(`- Not used by any page: ${report.unmappedFiles.map((f) => `\`${f}\``).join(", ")}`);
        }
        lines.push("");
    }
    return lines.join("\n");
}

// ---------- Console ----------

export function printSummary(report: Report, cwd: string) {
    const show = (file: string) => {
        const rel = path.relative(cwd, file);
        return toPosix(rel.startsWith("..") ? file : rel);
    };
    const lines: string[] = [];
    lines.push(`${c.bold("next-camera")} ${report.base.label} → ${report.head.label}`);

    const variantCount = new Set(report.routes.flatMap((route) => route.variants.map((v) => v.variant))).size;
    if (report.selection === "affected") {
        lines.push(
            `${plural(report.changedFiles.length, "changed file")} → ${plural(report.routes.length, "route")} captured` +
                (variantCount > 1 ? ` × ${variantCount} variants` : "") +
                (report.globalFiles.length ? ` (all routes: ${report.globalFiles.join(", ")} changed)` : "")
        );
    }
    lines.push("");

    const urlWidth = Math.min(40, Math.max(8, ...report.routes.map((route) => route.url.length)));
    const variantWidth = Math.max(7, ...report.routes.flatMap((route) => route.variants.map((v) => v.variant.length)));
    for (const route of report.routes) {
        for (const variant of route.variants) {
            const url = route.url.padEnd(urlWidth);
            const name = variant.variant.padEnd(variantWidth);
            if (variant.status === "changed") {
                const details = [
                    formatPercent(variant.diffPercent),
                    plural(variant.regions.length, "region"),
                    sizeChange(variant),
                    route.note,
                ].filter(Boolean);
                lines.push(`${c.red(c.bold("CHANGED  "))} ${url} ${name} ${details.join(", ")}`);
                if (variant.diffImage) lines.push(`          ${c.dim("overview")} ${show(variant.diffImage)}`);
                for (const region of variant.regions) {
                    lines.push(
                        `          ${c.dim(`region ${region.index}`)} ${show(region.image)} ${c.dim(
                            `(x=${region.x} y=${region.y} ${region.width}×${region.height})`
                        )}`
                    );
                }
            } else if (variant.status === "failed") {
                const error = variant.head.error ? `head: ${variant.head.error}` : `base: ${variant.base.error}`;
                lines.push(`${c.yellow(c.bold("FAILED   "))} ${url} ${name} ${error.split("\n")[0]}`);
            } else {
                lines.push(`${c.green("unchanged")} ${url} ${name}${variant.base.stable && variant.head.stable ? "" : c.dim(" (page was still changing while captured)")}`);
            }
            for (const issue of variant.newIssues.slice(0, 5)) {
                lines.push(`          ${c.yellow("new error")} ${issueText(issue).slice(0, 200)}`);
            }
            if (variant.newIssues.length > 5) lines.push(`          ${c.dim(`…and ${variant.newIssues.length - 5} more new errors`)}`);
        }
    }
    for (const skipped of report.skipped) {
        lines.push(`${c.dim("skipped  ")} ${skipped.pattern.padEnd(urlWidth)} ${c.dim(skipped.reason)}`);
    }
    if (report.routes.length === 0 && report.skipped.length === 0) {
        lines.push(report.changedFiles.length ? "No routes are affected by the changed files." : "No changes between base and head.");
    }

    for (const [name, side] of [["base", report.base], ["head", report.head]] as const) {
        if (side.serverErrors.length) {
            lines.push("", `${c.yellow(`${name} server errors:`)}`);
            for (const line of side.serverErrors.slice(-8)) lines.push(`  ${line.slice(0, 200)}`);
        }
    }
    if (report.unmappedFiles.length) {
        lines.push("", c.dim(`Not used by any page: ${report.unmappedFiles.join(", ")}`));
    }

    const { summary } = report;
    lines.push("");
    if (report.routes.length) {
        lines.push(
            `${summary.changed ? c.red(`${summary.changed} changed`) : "0 changed"}, ${summary.unchanged} unchanged` +
                (summary.failed ? `, ${c.yellow(`${summary.failed} failed`)}` : "") +
                (summary.skipped ? `, ${summary.skipped} skipped` : "") +
                (summary.newIssues ? `, ${c.yellow(plural(summary.newIssues, "new page error"))}` : "")
        );
        lines.push(`Report: ${show(path.join(report.outDir, "report.md"))}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
}
