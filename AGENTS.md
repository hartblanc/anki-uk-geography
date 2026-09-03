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
- `browser_connection.js` - gets a puppeteer browser. If the
  `PUPPETEER_BROWSER_URL` env var is set (a CDP HTTP endpoint, e.g.
  `http://127.0.0.1:9222`), it connects to that existing browser instead of
  launching a new one.
- `start_browser.js` - launches one long-lived headless Chromium with a CDP
  endpoint and prints `PUPPETEER_BROWSER_URL=...` for a caller to export. An
  agent session that expects to render many screenshots can run this once at
  startup so every later `capture_screenshots.js` / `screenshot_mcp.js` /
  `render_screenshot.js` call reuses the same warm browser instead of paying
  launch cost per call.

`capture_screenshots.js` and `screenshot_mcp.js` are orchestrators built on
top of these: they generate card HTML via `screenshot_common.js`, then hand
the resulting `file://` URL to `render_screenshot.js` to screenshot. Neither
launches or closes a browser it doesn't own - if `PUPPETEER_BROWSER_URL` is
set they leave that browser running for other callers; otherwise they launch
their own and close it when done.
