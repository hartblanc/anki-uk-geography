# AGENTS

Context for AI agents and contributors working on the `anki-uk-geography` repo.

## Documentation
- Documentation for mapshaper can be found at: mapshaper.org/llms.txt
- Documentation for anki can be found at: anki.mintlify.app/llms.txt

## Testing
- Build the deck using `make -j16`
- **Take a screenshot of an Anki card** - `node utils/uk_geog/capture_screenshots.js [options]`.
  This is the only entrypoint for card screenshots; use it whether or not
  an MCP session is connected. Key options: `--dark`, `--only LIST`,
  `--sample TEMPLATE:FIELD=VALUE`, `--concurrency N`, `--stitch PATH`,
  `--engine chromium|firefox|webkit` (default: chromium). Run with `--help`
  for the full list. `make screenshots` is a shortcut that runs it with a
  fixed set of options for the dark-mode example grid.
- **Check a card for JS/console errors** (no screenshot taken) - `node
  utils/uk_geog/check_cards.js [options]`. This is what `make webkit-check`
  runs (see Testing above); takes `--sample`, `--concurrency`, `--engine`
  like above, and always covers every template x side x theme (there's no
  `--dark`/`--only` to narrow it, since a check's job is full coverage).
- **Screenshot an arbitrary page** (not just an Anki card) - `node utils/uk_geog/render_screenshot.js --url URL --out PATH`,
  repeatable for multiple pages in one call. Works with any `file://` or
  `http(s)://` URL. Also takes `--engine chromium|firefox|webkit`.
- **`browser_mcp.js`** (registered in `.mcp.json`) needs no direct
  interaction - it exposes no tools. If connected (check with `/mcp`), it's
  just keeping a browser process warm in the background (chromium, by
  default) so the commands above skip the launch cost; screenshots/checks
  are always taken by running them directly, exactly the same either way.
  With `--cdp-pool-size [N]` (Chromium only; this repo's `.mcp.json` passes
  it, but it's off by default otherwise; N defaults to CPU core count if
  omitted) it additionally pre-creates a pool of N pages up front that later
  calls reuse directly instead of creating their own - this assumes callers
  don't run concurrently against it (two calls could grab the same page and
  race); this repo's usual one-at-a-time usage doesn't hit that. Without
  `--cdp-pool-size`, or for WebKit/Firefox (which don't support the CDP
  connection it relies on), every call still creates its own private pages
  against a plain connection.
