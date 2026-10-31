import fs from "node:fs";
import path from "node:path";
import { log } from "./log";
import { isInside, pathKey } from "./util";

type Loader = "ts" | "tsx" | "js" | "jsx";

const CODE_LOADERS: Record<string, Loader> = {
    ".ts": "ts",
    ".mts": "ts",
    ".cts": "ts",
    ".tsx": "tsx",
    ".js": "jsx",
    ".jsx": "jsx",
    ".mjs": "js",
    ".cjs": "js",
};
const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less"]);
const MDX_EXTENSIONS = new Set([".mdx", ".md"]);

export function isSourceFile(file: string): boolean {
    const ext = path.extname(file).toLowerCase();
    return ext in CODE_LOADERS || STYLE_EXTENSIONS.has(ext) || MDX_EXTENSIONS.has(ext);
}

const transpilers = new Map<Loader, Bun.Transpiler>();
function transpiler(loader: Loader): Bun.Transpiler {
    let instance = transpilers.get(loader);
    if (!instance) {
        instance = new Bun.Transpiler({ loader, target: "browser" });
        transpilers.set(loader, instance);
    }
    return instance;
}

const IMPORT_REGEX =
    /(?:^|[^.\w$])(?:import|export)\s*(?:[\w*{}\s,$]*?\s*from\s*)?["']([^"'\n]+)["']|(?:^|[^.\w$])(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const STYLE_IMPORT_REGEX = /@(?:import|use|forward|config|plugin|reference)\s+(?:url\(\s*)?["']([^"']+)["']/g;

function regexSpecifiers(text: string, regex: RegExp): string[] {
    return [...text.matchAll(regex)].map((match) => match[1] ?? match[2]).filter(Boolean);
}

export interface Closure {
    /** file key -> key of the file that imported it (null for entries) */
    parents: Map<string, string | null>;
}

/**
 * Import graph of the local source files of one checkout. Files are only scanned when reached
 * from a route entry, so unrelated code is never parsed. Packages in node_modules are ignored,
 * but workspace packages symlinked into node_modules are followed when they live inside the root.
 */
export class ImportGraph {
    private deps = new Map<string, string[]>();
    private texts = new Map<string, string>();
    readonly paths = new Map<string, string>();

    constructor(readonly root: string) {}

    key(file: string): string {
        const key = pathKey(file);
        if (!this.paths.has(key)) this.paths.set(key, path.resolve(file));
        return key;
    }

    text(key: string): string | undefined {
        return this.texts.get(key);
    }

    scannedKeys(): IterableIterator<string> {
        return this.texts.keys();
    }

    private resolve(specifier: string, fromFile: string, style: boolean): string | null {
        const spec = specifier.split("?")[0].split("#")[0];
        if (!spec || spec.startsWith("node:") || spec.startsWith("bun:")) return null;
        if (/^[a-z][a-z\d+.-]*:/i.test(spec) && !/^[a-z]:[\\/]/i.test(spec)) return null; // URLs, data:, virtual modules
        const fromDir = path.dirname(fromFile);

        // In CSS, `@import "foo.css"` is relative to the stylesheet
        if (style && !spec.startsWith(".") && !spec.startsWith("/")) {
            const candidate = path.join(fromDir, spec);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        }

        let resolved: string;
        try {
            resolved = Bun.resolveSync(spec, fromDir);
        } catch {
            return null;
        }
        if (!path.isAbsolute(resolved)) return null;
        if (/[\\/]node_modules[\\/]/.test(resolved)) {
            try {
                resolved = fs.realpathSync(resolved);
            } catch {
                return null;
            }
            if (/[\\/]node_modules[\\/]/.test(resolved)) return null;
        }
        return isInside(resolved, this.root) ? resolved : null;
    }

    private scan(key: string): string[] {
        const cached = this.deps.get(key);
        if (cached) return cached;
        const file = this.paths.get(key)!;
        const ext = path.extname(file).toLowerCase();
        const deps: string[] = [];
        this.deps.set(key, deps);

        const loader = CODE_LOADERS[ext];
        const style = STYLE_EXTENSIONS.has(ext);
        if (!loader && !style && !MDX_EXTENSIONS.has(ext)) return deps; // assets are leaves

        let text: string;
        try {
            text = fs.readFileSync(file, "utf8");
        } catch {
            return deps;
        }
        this.texts.set(key, text);

        let specifiers: string[];
        if (loader) {
            try {
                specifiers = transpiler(loader)
                    .scanImports(text)
                    .map((entry) => entry.path);
            } catch (error) {
                log.debug(`Falling back to regex import scan for ${file}: ${(error as Error).message.split("\n")[0]}`);
                specifiers = regexSpecifiers(text, IMPORT_REGEX);
            }
        } else if (style) {
            specifiers = regexSpecifiers(text, STYLE_IMPORT_REGEX);
        } else {
            specifiers = regexSpecifiers(text, IMPORT_REGEX);
        }

        for (const specifier of new Set(specifiers)) {
            const resolved = this.resolve(specifier, file, style);
            if (resolved) deps.push(this.key(resolved));
        }
        return deps;
    }

    // Every local file reachable from the entries, with the importer of each one for explaining chains
    closure(entries: string[]): Closure {
        const parents = new Map<string, string | null>();
        const queue: string[] = [];
        for (const entry of entries) {
            const key = this.key(entry);
            if (!parents.has(key)) {
                parents.set(key, null);
                queue.push(key);
            }
        }
        while (queue.length) {
            const current = queue.shift()!;
            for (const dep of this.scan(current)) {
                if (!parents.has(dep)) {
                    parents.set(dep, current);
                    queue.push(dep);
                }
            }
        }
        return { parents };
    }

    // Import chain from the route entry down to `key`, as paths
    chain(closure: Closure, key: string): string[] {
        const chain: string[] = [];
        for (let current: string | null | undefined = key; current; current = closure.parents.get(current)) {
            chain.unshift(this.paths.get(current) ?? current);
            if (chain.length > 50) break;
        }
        return chain;
    }
}
