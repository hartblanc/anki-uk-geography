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

`node utils/uk_geog/capture_screenshots.js ...` is the only entrypoint for
taking a screenshot - agents included. This is what `make screenshots` uses.
It gets a Puppeteer browser (see architecture below), captures the requested
cards, and exits.

`.mcp.json` registers `utils/uk_geog/browser_mcp.js` as an MCP server,
but it exposes no tools and does no rendering - its only job is keeping a
warm shared browser alive for the session so repeated `capture_screenshots.js` calls
reuse it instead of paying launch cost each time (see below). Use `/mcp` to
verify it's connected; take screenshots by running `capture_screenshots.js`
regardless of whether it is.

### Screenshot tooling architecture

The screenshot pipeline is split into decoupled pieces (`utils/uk_geog/`):

- `card_html.js` - card HTML generation only (reads `deck.json`,
  renders a note template, wraps it in Anki's HTML shell). No puppeteer
  dependency.
- `render_screenshot.js` - a thin puppeteer renderer: given a `file://` or
  `http(s)://` URL and an output path, navigates and screenshots. Knows
  nothing about decks or cards, so it's runnable standalone
  (`node utils/uk_geog/render_screenshot.js --url URL --out PATH`) against
  any page, not just Anki cards. Also exports `openBrowserPool()`, which is
  the only browser access `capture_screenshots.js` needs (see below).
- `browser_connection.js` - gets a puppeteer browser: (1) the browser
  `browser_mcp.js` is running, discovered via a connection file (see below);
  (2) otherwise, launch and later close its own throwaway browser. Only
  `render_screenshot.js` and `browser_mcp.js` import this directly.

`capture_screenshots.js` is the orchestrator built on top of these: it
generates card HTML via `card_html.js`, then hands the resulting `file://`
URL to `render_screenshot.js` to screenshot - `renderToFile()` for the
render itself, `openBrowserPool()` for the browser and page pool it renders
into. It never talks to `browser_connection.js` directly, and never closes
a browser it doesn't own - an MCP-managed browser is left running for other
callers; a self-launched one is closed when done.

`browser_mcp.js` deliberately does none of this rendering work itself -
it doesn't import `card_html.js` or `render_screenshot.js` at all. Its only
responsibility is the browser's lifetime (see below); the tools it would
otherwise expose over MCP don't exist, so `capture_screenshots.js` stays
the single entrypoint that actually takes a screenshot, whether or not an
MCP session is connected.

### Automatic browser lifecycle (MCP)

`browser_mcp.js` launches its own browser at startup and writes a
connection file exposing its CDP endpoint, so `capture_screenshots.js` /
`render_screenshot.js` calls made during the same session discover and
reuse it via `browser_connection.js` instead of launching their own.

Because an MCP host (Claude Code, Cursor, etc.) spawns this process over
stdio and holds its stdin pipe open for the life of the session, cleanup is
tied to a real OS-level signal, not a heuristic: when the host process exits
- normal quit, `/clear`-driven restart, most crashes - the pipe closes,
Node's `readline` interface fires its `"close"` event, and the shutdown
handler closes the browser and removes the connection file. `SIGINT`/
`SIGTERM` are also handled directly as a second path to the same cleanup.
This was chosen over a hooks-based approach (SessionStart/SessionEnd) after
confirming hooks have no equivalent: they're one-shot invocations with no
persistent connection to the session and no exposed PID, and Claude Code
documents `SessionEnd` itself as best-effort, not guaranteed to fire.

The connection file lives outside the repo (under the OS temp dir, keyed by
a hash of this repo's root) so `make` targets that clear `build/` can't pull
it out from under a running browser, and so each worktree/checkout gets its
own file and never shares a browser with a session running elsewhere.

**Surviving an abrupt kill (SIGKILL).** A hard kill skips `browser_mcp.js`'s
own cleanup entirely, which can leave both a stale connection file and an
orphaned (still-running) browser process behind. `browser_connection.js`
guards against a caller picking that up: reuse requires the browser actually
answering at the recorded URL to report the exact browser id recorded in the
file - a UUID Chrome generates fresh on every launch, embedded in its
devtools endpoint - not just that a PID is alive and a port answers. A bare
PID check alone isn't enough, since OS PIDs get reused. If the id matches
but the recording PID is dead, it's confirmed to be our own orphaned
browser (and only then): it gets closed and the file removed instead of
reused or left leaking. If the id doesn't match, whatever's actually there
is left untouched (it can't be identified as ours), and only the stale file
record is forgotten, once its recorded owner is also confirmed dead.
