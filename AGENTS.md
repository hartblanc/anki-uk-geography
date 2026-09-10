# AGENTS

Context for AI agents and contributors working on the `anki-uk-geography` repo.

## Documentation

- Documentation for mapshaper can be found at: mapshaper.org/llms.txt
- Documentation for anki can be found at: anki.mintlify.app/llms.txt

## Commands

Run any of these with `--help` for the full list of options.

- **Build the deck** - `make -j$(nproc)`
- **Screenshot Anki cards** - `node utils/uk_geog/capture_screenshots.js [options]`.
  The only entrypoint for card screenshots. Options: `--dark`, `--only LIST`,
  `--sample TEMPLATE:FIELD=VALUE`, `--scale N` (device scale factor; `2`
  doubles each PNG's pixel dimensions), `--concurrency N`, `--stitch PATH`,
  `--out DIR`, `--engine chromium|firefox|webkit`.
- **Check cards for JS/console errors** - `node utils/uk_geog/check_cards.js [options]`.
  Takes no screenshots, and always covers every template x side x theme.
  Options: `--sample`, `--concurrency`, `--engine`. Running it against WebKit
  stands in for AnkiMobile's webview.
- **Screenshot any page** - `node utils/uk_geog/render_screenshot.js --url URL --out PATH`,
  repeatable for several pages in one call. Any `file://` or `http(s)://`
  URL. Also takes `--scale N` and `--engine`.

Make shortcuts: `make screenshots` (dark-mode example grid),
`make webkit-check` and `make chromium-check` (card checks).

## Browser host

`utils/browser_ops/mcp.js` is registered in `.mcp.json`, exposes no tools,
and needs no direct interaction. It keeps browsers warm so the commands
above start faster; nothing about them changes when it isn't connected, and
concurrent calls are safe either way.

Settings live in `browser-ops.config.js`. The component, and how to add a
browser operation, are documented in `utils/browser_ops/README.md`.
