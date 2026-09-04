#!/usr/bin/env node
"use strict";

/**
 * Thin, decoupled screenshot renderer: given a URL (file:// or http(s)://)
 * and an output path, renders it to a PNG. It knows nothing about Anki cards,
 * decks, or templates - anything that produces HTML worth screenshotting
 * (card_html.js, or anything else) just needs to hand this a URL. The CLI
 * below accepts one or many --url/--out pairs.
 *
 * Connects to the browser browser_mcp.js has running for this repo, if any
 * (see browser_connection.js); otherwise launches and closes its own
 * throwaway browser for the render(s).
 *
 * Also exports renderMany(), for rendering many screenshots against a pool
 * of pages on a shared or throwaway browser - this is the only browser
 * access capture_screenshots.js needs; it never imports
 * browser_connection.js, or deals with a page pool, directly. `engine`
 * selects which Playwright browser type to use (chromium/firefox/webkit),
 * passed straight through to browser_connection.js's getBrowser().
 *
 * Usage:
 *   node utils/uk_geog/render_screenshot.js --url URL --out PATH [--url URL --out PATH ...]
 *     [--viewport WIDTHxHEIGHT] [--full-page] [--wait-until EVENT] [--timeout MS]
 *     [--concurrency N] [--engine chromium|firefox|webkit]
 */

const fs = require("fs");
const path = require("path");

const { getBrowser, DEFAULT_ENGINE } = require("./browser_connection.js");

const DEFAULT_VIEWPORT = { width: 800, height: 1159 };

// Empirically measured, steady-state (i.e. not the browser's very first
// connection, which pays extra one-time warmup cost regardless of engine):
// how long browser.newPage() takes against an already-running browser, per
// engine, vs. how long one render (goto + screenshot of a real Anki card)
// takes on a page that already exists. newPage() cost varies enormously by
// engine (Chromium is cheap enough to be worth parallelizing almost
// immediately; WebKit/Firefox cost 4-5x a render, so a small batch is
// better off staying on one page). Render cost is close to engine-agnostic,
// since it's dominated by parsing/painting the same HTML either way.
const NEW_PAGE_COST_MS = { chromium: 40, firefox: 230, webkit: 200 };
const RENDER_COST_MS = 50;

/**
 * Pick how many pages to open for a batch of `itemCount` renders, up to
 * `concurrency`. Opening P tabs (created one at a time, then worked in
 * parallel) costs roughly `P * newPageCost + (itemCount / P) * renderCost`
 * wall-clock time; that's minimized at `P = sqrt(itemCount * renderCost /
 * newPageCost)`. Below that, an extra tab's own creation cost outweighs the
 * time it would save - e.g. for WebKit (newPage ~4x a render), a 2-item
 * batch isn't worth a second tab, but a 40-item one is worth about three.
 */
function pickTabCount(itemCount, concurrency, engine) {
  if (itemCount <= 1) return 1;
  const openCost = NEW_PAGE_COST_MS[engine] ?? NEW_PAGE_COST_MS[DEFAULT_ENGINE];
  const optimal = Math.round(Math.sqrt((itemCount * RENDER_COST_MS) / openCost));
  return Math.max(1, Math.min(concurrency, optimal));
}

/**
 * Navigate `page` to `url` and save a screenshot to `outPath`. This is the
 * entire rendering concern: no HTML generation, no deck/template knowledge,
 * no browser lifecycle.
 */
async function renderToFile(
  page,
  { url, outPath, viewport = DEFAULT_VIEWPORT, fullPage = false, waitUntil = "load", timeout = 30000 }
) {
  await page.setViewportSize(viewport);
  await page.goto(url, { waitUntil, timeout });
  const png = await page.screenshot({ type: "png", fullPage });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);
  return { png, outPath };
}

/**
 * Simple promise-based pool of Playwright pages. Each render takes one tab
 * for the duration of its navigation/screenshot and returns it afterwards,
 * so concurrent calls and batch renders are spread over all open tabs.
 * Purely an implementation detail of renderMany() below - not exported.
 */
class PagePool {
  constructor(pages) {
    this.free = pages.slice();
    this.total = this.free.length;
    this.waiters = [];
  }

  async acquire() {
    const page = this.free.shift();
    if (page) return page;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(page) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(page);
    else this.free.push(page);
  }
}

/**
 * Run `task(page, item)` for each item across a page pool, preserving input
 * order in the returned results array.
 */
async function runWithPool(pool, items, task) {
  const results = new Array(items.length);
  let nextJob = 0;

  async function worker() {
    while (true) {
      const index = nextJob++;
      if (index >= items.length) return;
      const page = await pool.acquire();
      try {
        results[index] = await task(page, items[index], index);
      } finally {
        pool.release(page);
      }
    }
  }

  const workerCount = Math.min(pool.total, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Renders many screenshots against a pool of pages, spread across whichever
 * browser getBrowser() hands back (a shared MCP-managed one, or a throwaway
 * one launched just for this call - see browser_connection.js for how
 * that's decided and why every caller always creates its own pages either
 * way). The number of pages is chosen by pickTabCount() rather than always
 * opening `concurrency` of them: each `newPage()` has a real, measurable
 * cost (e.g. ~200ms for WebKit even against an already-running server), so
 * a small batch doesn't pay for tabs it wouldn't get enough parallel work
 * out of to be worth their own creation cost. For each item, calls
 * `task(page, item, index)` - `index` is this item's position in `items`,
 * stable and unique across the whole batch regardless of concurrency, for a
 * caller that needs a per-item scratch key (e.g. capture_screenshots.js's
 * scratch HTML files). The caller decides what "rendering an item" means
 * (e.g. generating HTML first) and is expected to call renderToFile itself.
 * `browser.close()` is safe to call unconditionally here regardless of
 * whether the browser was shared or freshly launched - see
 * browser_connection.js's module doc for why. The caller never sees the
 * browser, a page pool, or browser_connection.js at all.
 */
async function renderMany(items, task, { concurrency = 4, engine = DEFAULT_ENGINE } = {}) {
  const tabs = pickTabCount(items.length, concurrency, engine);
  const { browser, pages } = await getBrowser({ engine, tabs });
  try {
    const pool = new PagePool(pages);
    return await runWithPool(pool, items, task);
  } finally {
    await browser.close();
  }
}

const USAGE = `Usage: render_screenshot.js --url URL --out PATH [--url URL --out PATH ...] [options]

Renders one or more file:// or http(s):// URLs to PNGs - pass --url/--out as
many times as needed, matched in order. Connects to the browser
browser_mcp.js has running for this repo, if any, otherwise launches and
closes its own headless browser.

Options:
  --url URL           Page to render (file:// or http(s)://); repeatable
  --out PATH           Output PNG path; repeatable, one per --url, in order
  --viewport WxH       Viewport size, e.g. 800x1159 (default: 800x1159)
  --full-page          Capture the full scrollable page, not just the viewport
  --wait-until EVENT   Playwright waitUntil event (default: load)
  --timeout MS         Navigation timeout in ms (default: 30000)
  --concurrency N      Max parallel tabs (default: 4)
  --engine NAME        Browser engine: chromium (default), firefox, webkit
  --help               Show this help
`;

function parseArgs(argv) {
  const args = {
    url: [],
    out: [],
    viewport: null,
    fullPage: false,
    waitUntil: "load",
    timeout: 30000,
    concurrency: 4,
    engine: DEFAULT_ENGINE,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--url":
        args.url.push(argv[++i]);
        break;
      case "--out":
        args.out.push(argv[++i]);
        break;
      case "--viewport":
        args.viewport = argv[++i];
        break;
      case "--full-page":
        args.fullPage = true;
        break;
      case "--wait-until":
        args.waitUntil = argv[++i];
        break;
      case "--timeout":
        args.timeout = parseInt(argv[++i], 10);
        break;
      case "--concurrency":
        args.concurrency = parseInt(argv[++i], 10);
        break;
      case "--engine":
        args.engine = argv[++i];
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        console.error(USAGE);
        process.exit(2);
    }
  }
  return args;
}

function parseViewport(spec) {
  const match = /^(\d+)x(\d+)$/.exec(String(spec || ""));
  if (!match) {
    console.error(`Invalid --viewport, expected WIDTHxHEIGHT: ${spec}`);
    process.exit(2);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.url.length || args.url.length !== args.out.length) {
    console.error(
      "--url and --out are required, and must be given the same number of " +
        "times - one --out per --url, matched in order"
    );
    console.error(USAGE);
    process.exit(2);
  }

  const viewport = args.viewport ? parseViewport(args.viewport) : DEFAULT_VIEWPORT;
  const items = args.url.map((url, i) => ({ url, outPath: args.out[i] }));

  await renderMany(
    items,
    async (page, item) => {
      const { outPath } = await renderToFile(page, {
        url: item.url,
        outPath: item.outPath,
        viewport,
        fullPage: args.fullPage,
        waitUntil: args.waitUntil,
        timeout: args.timeout,
      });
      console.log(`Captured ${outPath}`);
    },
    { concurrency: args.concurrency, engine: args.engine }
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

module.exports = { renderToFile, renderMany, pickTabCount, DEFAULT_VIEWPORT };
