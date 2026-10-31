type Stream = { isTTY?: boolean };

function colorsEnabled(stream: Stream): boolean {
    if (process.env.NO_COLOR) return false;
    if (process.env.FORCE_COLOR) return true;
    return !!stream.isTTY;
}

function palette(enabled: boolean) {
    const wrap = (open: number, close: number) => (text: string) =>
        enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;
    return {
        bold: wrap(1, 22),
        dim: wrap(2, 22),
        red: wrap(31, 39),
        green: wrap(32, 39),
        yellow: wrap(33, 39),
        blue: wrap(34, 39),
        magenta: wrap(35, 39),
        cyan: wrap(36, 39),
        gray: wrap(90, 39),
    };
}

// Colors for text written to stdout (the final summary) and stderr (progress logs)
export const out = palette(colorsEnabled(process.stdout));
export const err = palette(colorsEnabled(process.stderr));

let verbose = false;
let quiet = false;

export function configureLog(options: { verbose?: boolean; quiet?: boolean }) {
    verbose = !!options.verbose;
    quiet = !!options.quiet;
}

export function isVerbose() {
    return verbose;
}

function write(line: string) {
    process.stderr.write(line + "\n");
}

// All logging goes to stderr so stdout stays reserved for the summary / --json report
export const log = {
    step(message: string) {
        if (!quiet) write(`${err.cyan("›")} ${message}`);
    },
    info(message: string) {
        if (!quiet) write(`  ${message}`);
    },
    warn(message: string) {
        write(`${err.yellow("warning")} ${message}`);
    },
    error(message: string) {
        write(`${err.red("error")} ${message}`);
    },
    debug(message: string) {
        if (verbose) write(err.gray(`  ${message}`));
    },
};
