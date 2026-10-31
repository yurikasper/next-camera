# next-camera

Screenshot the pages of a Next.js app before and after a change, diff them, and get a report of
what changed visually, including the regressions you didn't mean to cause.

It only captures the routes that can actually be affected: it follows imports from every page
(`_app`, layouts and so on included) to the files you changed. A tweak to a shared `Button` captures
every page that renders it, directly or through other components. A change to `package.json` or
`next.config` captures every page.

```
$ bunx next-camera
next-camera HEAD (480ac06) → working tree
4 changed files → 4 routes captured

CHANGED   /         desktop 0.78%, 1 region
          overview .next-camera/routes/index/desktop/diff.png
          region 1 .next-camera/routes/index/desktop/region-1.png (x=322 y=275 416×224)
CHANGED   /indirect desktop 13.5%, 1 region
          overview .next-camera/routes/indirect/desktop/diff.png
          region 1 .next-camera/routes/indirect/desktop/region-1.png (x=0 y=48 1280×168)
          new error console: IndirectUse: failed to load user
CHANGED   /new      desktop 0.14%, 2 regions, new page
          ...
CHANGED   /notindex desktop 0.40%, 1 region, removed page
          ...
          new error http: Page responded with HTTP 404

4 changed, 0 unchanged, 2 new page errors
Report: .next-camera/report.md
```

Progress goes to stderr; only this summary goes to stdout.

Built for coding agents as much as for humans: one command, no setup, a short text summary on
stdout, a Markdown report with cropped BEFORE / AFTER / DIFF images, and a JSON report.

## Requirements

- [Bun](https://bun.sh) 1.2+
- Node.js (Next.js itself runs on Node)
- git, when comparing refs or your working tree
- Chrome, Chromium or Edge. Detected automatically, including browsers downloaded by Playwright or
  Puppeteer. If you have none, run `next-camera install-browser`. It downloads Chromium headless
  shell with Playwright's installer. Add `--with-deps` on Linux to also install the system
  libraries it needs (may ask for sudo).

## Running it

```sh
bunx next-camera              # once published to npm
bun /path/to/cli/src/index.ts # from a checkout of this repo
bun link && next-camera       # or link it globally from cli/

bun run build                 # standalone executable in dist/next-camera (no Bun needed to run it)
```

## Usage

```sh
next-camera                     # HEAD vs your working tree (uncommitted + untracked changes)
next-camera main                # main vs your working tree
next-camera main feature        # two refs
next-camera ./base ./head       # two directories, e.g. two CI checkouts (no git needed)

next-camera --dry-run           # just list the affected routes and why
next-camera --route /pricing    # capture specific URLs, skipping the analysis
next-camera --all               # capture every route
next-camera --viewport desktop,mobile --dark
next-camera --head-url http://localhost:3000   # reuse your running dev server for head
next-camera --json              # JSON report on stdout
next-camera --fail-on-diff      # exit 1 if anything changed (for CI)
next-camera clean               # delete the cached worktrees for this repo
next-camera install-browser     # download Chromium if no Chrome/Chromium/Edge is installed
```

Run it from the app directory, or anywhere in the repo with `--app apps/web`. Run `next-camera --help`
for every option.

## How it works

1. **Resolve base and head.** Each one is a git ref or a directory. Refs are checked out in git
   worktrees kept in a cache folder outside the repo (`%LOCALAPPDATA%\next-camera`,
   `~/Library/Caches/next-camera`, `~/.cache/next-camera` or `NEXT_CAMERA_CACHE_DIR`). They're
   reused between runs, so `node_modules` and the `.next` cache survive. Next.js treats the topmost
   lockfile above an app as the workspace root. So if a parent of the cache folder has a lockfile (a
   stray `~/package-lock.json` is common), the worktrees go in `.next-camera-wt/` beside the
   repo instead, where their parent folders match the repo's. Your working tree gets snapshotted
   into a worktree too: HEAD plus your uncommitted and untracked files. That way the tool never
   runs a second `next dev` in your project folder, where it would fight with your own dev server
   over `.next`. Use `--in-place` to skip the snapshot when you know nothing else is running
   there. `.env*` files are copied into the worktrees.
2. **Find changed files.** `git diff` for refs and the working tree, a file-by-file comparison for
   directories, or `--changed <file>` to provide the list yourself.
3. **Find affected routes.** Pages Router and App Router routes are enumerated, and for each one
   the import graph is followed from the page and everything wrapping it (`_app`, `_document`,
   layouts, templates, loading/error files). Bun's transpiler scans the imports and Bun's resolver
   follows them (tsconfig `paths`, workspace packages). This runs on both base and head, so a
   file deleted in head still maps to the pages that used it. Changed images, fonts and `public/`
   files map to the pages whose code mentions them by name. Config, dependency and middleware
   changes affect every page.
4. **Install and start.** Dependencies are installed with the repo's package manager when the
   lockfile changed (worktrees) or `node_modules` is missing (directories). Then `next dev` starts
   for base and head on free ports (`--mode prod` builds and runs `next start` instead).
5. **Capture.** Headless Chrome, driven over the DevTools protocol, loads each route on both
   servers. It waits for the load event, fonts, images (lazy ones forced to load) and network idle,
   then finishes animations, disables transitions, hides the Next.js dev overlay and takes a
   full-page screenshot. It retakes the screenshot until two in a row are identical. Console errors,
   uncaught exceptions, failed requests and HTTP errors are recorded too.
6. **Diff.** [pixelmatch](https://github.com/mapbox/pixelmatch) compares the screenshots, ignoring
   anti-aliasing. Changed pixels are grouped into regions, and each region gets a BEFORE / AFTER /
   DIFF image. Page errors that appear in head but not in base are reported as new errors.

## Output

Everything goes to `.next-camera/` (`--out`), which is replaced on every run and ignores itself in git.

```
.next-camera/
  report.md                       summary with embedded images
  report.json                     everything, machine readable (same as --json)
  routes/<route>/<variant>/
    base.png  head.png            full-page screenshots
    diff.png                      head faded, changed pixels red, numbered region boxes
    region-1.png ...              BEFORE / AFTER / DIFF panels for each changed region
```

`<route>` is the URL with `/` replaced by `__` (`/` → `index`, `/blog/post` → `blog__post`), and
`<variant>` is the viewport name plus `-dark` for dark mode.

Region crops are at least 640×160px around the change, so small changes keep their surroundings.
Changes close enough to share a crop are reported as one region.

## Config

Optional. Put `next-camera.config.json` (or `.ts` / `.js` / `.mjs`) in the app directory:

```json
{
    "viewports": ["desktop", "mobile"],
    "routes": {
        "/blog/[slug]": ["/blog/hello-world"],
        "/search": ["/search?q=shoes"]
    },
    "mask": ["[data-testid=clock]"],
    "hide": [".cookie-banner"],
    "ignoreRoutes": ["/admin/**"],
    "ignoreFiles": ["**/*.test.tsx"],
    "setup": "pnpm prisma generate"
}
```

| Option | Default | |
|---|---|---|
| `app` | auto | App directory relative to the repo/dir root (monorepos) |
| `mode` | `"dev"` | `"prod"` runs `next build` + `next start` |
| `command` | `next dev --port {port} --hostname 127.0.0.1` | Start command; `{port}` is replaced and `PORT` is set |
| `buildCommand` | `next build` | Build command for `mode: "prod"` |
| `setup` | | Command run in each prepared worktree after installing (codegen etc.) |
| `viewports` | `["desktop"]` | `desktop` 1280×800, `laptop` 1440×900, `tablet` 768×1024, `mobile` 390×844, `"WxH"` or `{ name, width, height, mobile }` |
| `colorSchemes` | `["light"]` | Add `"dark"` to capture with `prefers-color-scheme: dark` |
| `routes` | | Sample URLs per route pattern. Required for dynamic routes, optional for static ones |
| `ignoreRoutes` | | Route patterns (globs) never to capture |
| `ignoreFiles` | | Changed files (globs, root-relative) to ignore |
| `globalFiles` | | Extra files (globs, app-relative) that affect every page |
| `mask` | | Selectors covered with a magenta box (clocks, random content) |
| `hide` | | Selectors hidden with `visibility: hidden` |
| `css` | | Extra CSS injected before screenshots |
| `threshold` | `0.1` | Per-pixel color difference threshold, 0–1 |
| `wait` | `0` | Extra milliseconds to wait before screenshots |
| `fullPage` | `true` | Capture the whole page instead of only the viewport |
| `serverTimeout` | `180` | Seconds to wait for a server to start |
| `navigationTimeout` | `60` | Seconds to wait for a page to load |
| `pageExtensions` | from `next.config` or `tsx,ts,jsx,js` | |
| `browser` | auto | Chrome/Chromium/Edge executable (also `NEXT_CAMERA_BROWSER`) |
| `out` | `.next-camera` | Output directory |

**Dynamic routes** like `/blog/[slug]` need sample URLs: add them under `routes` or pass
`--route /blog/hello`. Otherwise they're listed as skipped. Optional catch-alls (`[[...slug]]`) are
captured at their base path.

## Using it from coding agents

Add something like this to your `CLAUDE.md` / `AGENTS.md`:

```md
## Visual regression check
After changing UI code (components, styles, pages, config), run `bunx next-camera` in the app
directory. It screenshots every page affected by the uncommitted changes, before and after.
- Every CHANGED route lists `region-N.png` images (BEFORE / AFTER / DIFF panels). Open them and
  check that each change is intended. A changed route you didn't mean to touch is a regression.
- "new error" lines are console errors, exceptions or HTTP errors your change introduced.
- To compare the whole branch, run `bunx next-camera main`. To check one page, run `--route /path`.
- If a dev server is already running for this app, pass `--head-url http://localhost:3000`.
```

The summary on stdout is short and lists the image paths, so an agent can open just the crops it
needs. `report.json` has everything, including why each route was captured (the import chain from
the page to the changed file).

## CI

Check out base and head side by side and compare the two directories. No git work is involved.
For example, on GitHub Actions:

```yaml
name: Visual diff
on: pull_request
jobs:
  next-camera:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { ref: "${{ github.event.pull_request.base.sha }}", path: base }
      - uses: actions/checkout@v7
        with: { ref: "${{ github.event.pull_request.head.sha }}", path: head }
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 22 }
      - uses: oven-sh/setup-bun@v2
      - run: pnpm install --frozen-lockfile
        working-directory: base
      - run: pnpm install --frozen-lockfile
        working-directory: head
      # ubuntu-latest ships Google Chrome, which is detected automatically
      - run: bunx next-camera ./base ./head --out next-camera-output
      - uses: actions/upload-artifact@v7
        if: always()
        with: { name: next-camera, path: next-camera-output }
```

## Notes and limitations

- Pages are captured as an anonymous visitor. Pages behind auth, or that depend on data that
  differs between runs, will need `mask` / `hide`, or `routes` pointing at stable URLs.
- The analysis follows static and dynamic `import`/`require` calls. Anything loaded another way
  (a CMS, runtime file reads) isn't tracked. Use `--all` or `--route` for those.
- Base and head servers run the same way (`dev` by default), so dev-only differences cancel out.
  `--mode prod` is closer to production but has to build twice.
- Screenshots use a device scale factor of 1, the UTC timezone and `prefers-reduced-motion: reduce`.

## Development

```sh
bun install
bun test           # unit tests (route discovery, import analysis, diffing)
bun run typecheck
bun run build      # dist/next-camera executable
```

`test/fixtures` holds the source of a small Pages Router app and App Router app used by the tests.

## Publishing

Publishing a GitHub release runs `.github/workflows/publish.yml`. It checks that the release tag
matches `package.json` (`v0.1.0` ↔ `0.1.0`), runs the type check and tests, builds standalone
executables for every platform and attaches them to the release, then publishes to npm with
trusted publishing. Prerelease versions (`0.2.0-beta.1`) are published under their own dist-tag
(`beta`), not `latest`.
