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
  nothing about decks or cards, so it's runnable standalone against any
  page, not just Anki cards - and accepts one or many `--url`/`--out` pairs
  in a single invocation. Also exports `renderMany(items, task, options)`
  for rendering many screenshots against a shared browser and however many
  tabs it already has - this is the only browser access
  `capture_screenshots.js` needs (see below). Neither this CLI nor
  `renderMany()` ever opens a tab of their own: the page pool `renderMany()`
  builds internally (acquiring/releasing tabs across concurrent renders,
  not exported) is populated from `browser.pages()` as found. Whoever
  launches a browser owns creating its tabs - `browser_mcp.js` for a shared
  one (see below), `browser_connection.js`'s `getBrowser({ tabs })` for a
  fresh throwaway one.
- `browser_connection.js` - gets a puppeteer browser: (1) the browser
  `browser_mcp.js` is running, discovered via a connection file (see below);
  (2) otherwise, launch a throwaway one (opening `tabs` of them, since a
  fresh launch starts with only one) that the caller should close when done.
  Only `render_screenshot.js` and `browser_mcp.js` import this directly.

`capture_screenshots.js` is the orchestrator built on top of these: it
generates card HTML via `card_html.js`, then calls `render_screenshot.js`'s
`renderMany()` with a task that, per card, finishes generating that card's
HTML and calls `renderToFile()` on the page it's handed. It never talks to
`browser_connection.js` directly, never sees a browser or page pool as a
concept, and never closes a browser it doesn't own - `renderMany()` handles
all of that: an MCP-managed browser is left running for other callers, a
self-launched one is closed when done.

`browser_mcp.js` deliberately does none of this rendering work itself -
it doesn't import `card_html.js` or `render_screenshot.js` at all. Its only
responsibility is the browser's lifetime (see below); the tools it would
otherwise expose over MCP don't exist, so `capture_screenshots.js` stays
the single entrypoint that actually takes a screenshot, whether or not an
MCP session is connected.

### Automatic browser lifecycle (MCP)

`browser_mcp.js` launches its own browser at startup, opens `--concurrency`
tabs on it (default 4), and writes a connection file exposing its CDP
endpoint, so `capture_screenshots.js` / `render_screenshot.js` calls made
during the same session discover and reuse it via `browser_connection.js`
instead of launching their own. Pre-opening a fixed set of tabs here -
rather than each call creating its own on a browser it doesn't own - is
what lets many separate invocations share a bounded pool instead of
accumulating tabs nothing ever closes.

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
guards against a caller picking that up: reuse requires the recorded owning
PID to be alive and the recorded URL to answer. If the PID is dead, the
browser it launched is treated as an orphan - it gets closed if still
reachable, and the stale file removed, rather than reused or left leaking.
