// Cross-compile standalone executables for every platform into dist/
import { $ } from "bun";

const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"];

for (const target of targets) {
    const outfile = `dist/next-camera-${target}${target.startsWith("windows") ? ".exe" : ""}`;
    console.log(`Building ${outfile}`);
    await $`bun build ./src/index.ts --compile --minify --target=bun-${target} --outfile ${outfile}`.quiet();
}
