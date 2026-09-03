# AGENTS

Context for AI agents and contributors working on the `anki-uk-geography` repo.

## Documentation
- Documentation for mapshaper can be found at: mapshaper.org/llms.txt
- Documentation for anki can be found at: anki.mintlify.app/llms.txt

## Testing
- Build the deck using `make`
- Generate screenshots using puppeteer via `make screenshots` for some visual feedback
- Run `make webkit-check` to render every note template (front/back, light/dark)
  in Playwright's real WebKit engine and fail on any JS error or a zoombox
  that doesn't populate. This stands in for AnkiMobile's WebKit-based webview.
  Requires the Playwright WebKit browser (fetched by `npm install`, or
  manually via `npx playwright install webkit`). See `utils/uk_geog/webkit_check.js`.
- For live inspection in Anki, launch Anki with `QTWEBENGINE_REMOTE_DEBUGGING=9292` and connect to `localhost:9292` via CDP.
  - A human must be in the loop: they need to import the rebuilt CrowdAnki deck into Anki (`make` does not update a running Anki), navigate to the relevant cards, and switch between fronts/backs as needed.
  - CDP gives access to the real Qt WebEngine renderer, so it can catch issues that puppeteer can not.
- Tradeoffs:
  - Screenshots are fast, scriptable, deterministic, and good for regression checks and docs, but they render in puppeteer (Chromium) rather than Anki's real runtime.
  - `webkit-check` closes most of the WebKit-vs-Chromium gap (it caught, and current templates pass: no external `<script src>` races and no `<use>` shadow-tree CSS quirks, since the composed map SVGs are inlined as plain `<g>`/`<circle>` elements rather than `<use>` references). It still runs desktop WebKit, not iOS WebKit/AnkiMobile itself, so it can't catch iOS-only issues (viewport quirks, touch events, AnkiMobile's own JS bridge).
  - CDP in Anki (or a real AnkiMobile device) is the source of truth for actual behaviour, but requires human involvement for import/navigation, is slower, and is harder to repeat deterministically.

## Screenshots

Two supported ways to get screenshots:

1. **Agents via MCP (preferred).** `.deepcode/settings.json` registers
   `utils/uk_geog/screenshot_mcp.js` as an MCP server. It launches the warm
   Puppeteer instance at startup and exposes a `render_screenshot` tool. Each
   call reads the latest `deck.json` from disk, so screenshots always
   reflect the current build. Rendered PNGs are written to
   `build/screenshots/mcp/` (e.g. `build/screenshots/mcp/city-map-front.png`)
   and the saved path is returned in the tool result. Pass an optional
   `filename` argument to `render_screenshot` to choose the saved PNG name.
   Use `/mcp` to verify the server is connected.
2. **Manual snapshot.** `node utils/uk_geog/capture_screenshots.js ...` launches
   a fresh Puppeteer instance, captures the requested cards, and exits. This is
   what `make screenshots` uses.
