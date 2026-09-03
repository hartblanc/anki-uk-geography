# AGENTS

Context for AI agents and contributors working on the `anki-uk-geography` repo.

## Documentation
- Documentation for mapshaper can be found at: mapshaper.org/llms.txt
- Documentation for anki can be found at: anki.mintlify.app/llms.txt

## Testing
- Build the deck using `make`
- Generate screenshots using puppeteer via `make screenshots` for some visual feedback
- For live inspection in Anki, launch Anki with `QTWEBENGINE_REMOTE_DEBUGGING=9292` and connect to `localhost:9292` via CDP.
  - A human must be in the loop: they need to import the rebuilt CrowdAnki deck into Anki (`make` does not update a running Anki), navigate to the relevant cards, and switch between fronts/backs as needed.
  - CDP gives access to the real Qt WebEngine renderer, so it can catch issues that puppeteer can not.
- Tradeoffs vs screenshots:
  - Screenshots are fast, scriptable, deterministic, and good for regression checks and docs, but they render in puppeteer rather than Anki's real runtime, so they can miss Anki/AnkiMobile-specific issues (e.g. external script loading races, `<use>` shadow-tree CSS quirks).
  - CDP in Anki is the source of truth for actual behaviour, but requires human involvement for import/navigation, is slower, and is harder to repeat deterministically.

## Screenshots

Two supported ways to get screenshots:

1. **Agents via MCP (preferred).** `.deepcode/settings.json` registers
   `utils/uk_geog/screenshot_mcp.js` as an MCP server. It gets a warm
   Puppeteer instance at startup and exposes a `render_screenshot` tool. Each
   call reads the latest `deck.json` from disk, so screenshots always
   reflect the current build. Rendered PNGs are written to
   `build/screenshots/mcp/` (e.g. `build/screenshots/mcp/city-map-front.png`)
   and the saved path is returned in the tool result. Pass an optional
   `filename` argument to `render_screenshot` to choose the saved PNG name.
   Use `/mcp` to verify the server is connected.
2. **Manual snapshot.** `node utils/uk_geog/capture_screenshots.js ...` gets a
   Puppeteer instance, captures the requested cards, and exits. This is what
   `make screenshots` uses.

### Screenshot tooling architecture

The screenshot pipeline is split into decoupled pieces (`utils/uk_geog/`):

- `screenshot_common.js` - card HTML generation only (reads `deck.json`,
  renders a note template, wraps it in Anki's HTML shell). No puppeteer
  dependency.
- `render_screenshot.js` - a thin puppeteer renderer: given a `file://` or
  `http(s)://` URL and an output path, navigates and screenshots. Knows
  nothing about decks or cards, so it's runnable standalone
  (`node utils/uk_geog/render_screenshot.js --url URL --out PATH`) against
  any page, not just Anki cards.
- `browser_connection.js` - gets a puppeteer browser, in order: (1) the
  `PUPPETEER_BROWSER_URL` env var if set (a CDP HTTP endpoint, e.g.
  `http://127.0.0.1:9222`) - an explicit override for manual/CI use; (2) a
  hook-managed browser (see below), discovered via a connection file rather
  than an env var, since Claude Code hooks can't set env vars that later tool
  calls would see; (3) otherwise, launch and later close its own throwaway
  browser.
- `start_browser.js` - launches one headless Chromium with a CDP endpoint.
  Standalone (no flags) it just prints `PUPPETEER_BROWSER_URL=...` and runs
  until Ctrl+C, for manual/CI use with `PUPPETEER_BROWSER_URL` above. With
  `--managed` (how the hooks below use it) it also writes the connection file
  `browser_connection.js` looks for, and self-exits after 30 minutes of no
  caller touching that file - a backstop in case cleanup never runs.

`capture_screenshots.js` and `screenshot_mcp.js` are orchestrators built on
top of these: they generate card HTML via `screenshot_common.js`, then hand
the resulting `file://` URL to `render_screenshot.js` to screenshot. Neither
launches or closes a browser it doesn't own - a hook-managed or
`PUPPETEER_BROWSER_URL` browser is left running for other callers; a
self-launched one is closed when done.

### Automatic browser lifecycle (Claude Code hooks)

`.claude/settings.json` registers two hooks so an agent session gets a warm
browser for free, scoped to just that session:

- **SessionStart** runs `utils/uk_geog/hooks/session_start.js`, which checks
  whether a hook-managed browser is already running (via the connection
  file) and, if not, launches one detached with `start_browser.js --managed`
  on a freshly-allocated free port. Idempotent, so it's cheap to run on
  every SessionStart reason (startup, resume, clear, compact) - an already
  live browser is just reused.
- **SessionEnd** runs `utils/uk_geog/hooks/session_end.js`, which reads the
  connection file, sends the browser process SIGTERM, and removes the file.

The connection file lives outside the repo (under the OS temp dir, keyed by
a hash of this repo's root) so `make` targets that clear `build/` can't pull
it out from under a running browser, and so each worktree/checkout gets its
own file and never shares a browser with a session running elsewhere.
SessionEnd is documented by Claude Code as best-effort (short timeout, not
guaranteed to fire on every exit path), so `start_browser.js --managed`'s
own 30-minute idle self-timeout is the backstop if it doesn't run.
