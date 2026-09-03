# AGENTS

Context for AI agents and contributors working on the `anki-uk-geography` repo.

## Documentation
- Documentation for mapshaper can be found at: mapshaper.org/llms.txt
- Documentation for anki can be found at: anki.mintlify.app/llms.txt

## Testing
- Build the deck using `make`
- Generate screenshots using Playwright's Chromium via `make screenshots` for some visual feedback
- Run `make webkit-check` to render every note template (front/back, light/dark)
  in Playwright's real WebKit engine and fail on any JS error, console
  error/warning, or a zoombox that doesn't populate. This stands in for
  AnkiMobile's WebKit-based webview. It's `capture_screenshots.js --engine
  webkit --check` under the hood - not a separate script - so any engine
  (`--engine chromium|firefox|webkit`) can run the same check. `npm install`
  fetches the Playwright WebKit browser automatically (see `postinstall` in
  `package.json`).
- For live inspection in Anki, launch Anki with `QTWEBENGINE_REMOTE_DEBUGGING=9292` and connect to `localhost:9292` via CDP.
  - A human must be in the loop: they need to import the rebuilt CrowdAnki deck into Anki (`make` does not update a running Anki), navigate to the relevant cards, and switch between fronts/backs as needed.
  - CDP gives access to the real Qt WebEngine renderer, so it can catch issues that headless Chromium/WebKit can not.
- Tradeoffs:
  - Screenshots are fast, scriptable, deterministic, and good for regression checks and docs, but they render in headless Chromium rather than Anki's real runtime.
  - `--engine webkit --check` closes most of the WebKit-vs-Chromium gap (it caught, and current templates pass: no external `<script src>` races and no `<use>` shadow-tree CSS quirks, since the composed map SVGs are inlined as plain `<g>`/`<circle>` elements rather than `<use>` references - see `build_note_templates.py`). It still runs desktop WebKit, not iOS WebKit/AnkiMobile itself, so it can't catch iOS-only issues (viewport quirks, touch events, AnkiMobile's own JS bridge).
  - CDP in Anki (or a real AnkiMobile device) is the source of truth for actual behaviour, but requires human involvement for import/navigation, is slower, and is harder to repeat deterministically.

## Screenshots

All via Playwright (`npm install` fetches its Chromium/WebKit browsers automatically):

- **Take a screenshot of an Anki card** - `node utils/uk_geog/capture_screenshots.js [options]`.
  This is the only entrypoint for card screenshots; use it whether or not
  an MCP session is connected. Key options: `--dark`, `--only LIST`,
  `--sample TEMPLATE:FIELD=VALUE`, `--concurrency N`, `--stitch PATH`,
  `--engine chromium|firefox|webkit` (default: chromium), `--check` (assert
  every render is free of JS/console errors and that zoomboxes populate -
  see Testing above). Run with `--help` for the full list. `make
  screenshots` is a shortcut that runs it with a fixed set of options for
  the dark-mode example grid.
- **Screenshot an arbitrary page** (not an Anki card) - `node utils/uk_geog/render_screenshot.js --url URL --out PATH`,
  repeatable for multiple pages in one call. Works with any `file://` or
  `http(s)://` URL. Also takes `--engine chromium|firefox|webkit`.
- **`browser_mcp.js`** (registered in `.mcp.json`) needs no direct
  interaction - it exposes no tools. If connected (check with `/mcp`), it's
  just keeping a browser process warm in the background (chromium, by
  default) so the two commands above skip the launch cost; screenshots are
  always taken by running them directly, exactly the same either way.
