#!/usr/bin/env node
"use strict";

/**
 * Renders a URL (file:// or http(s)://) to a PNG screenshot using Playwright.
 *
 * renderMany(items, {concurrency, engine, onRendered}) is the only exported
 * entry point: renders a batch of `{url, html, outPath, viewport?, fullPage?,
 * waitUntil?, timeout?}` items (plus any extra fields you want carried
 * through) in parallel over a pool of pages, returning each item merged
 * with its result (`{png, outPath}`). `onRendered(result, item, index)`, if
 * given, fires as each finishes - that's completion order, not `items`
 * order.
 *
 *
 * Usage:
 *   node utils/uk_geog/render_screenshot.js --url URL --out PATH [--url URL --out PATH ...]
 *     [--viewport WIDTHxHEIGHT] [--full-page] [--wait-until EVENT] [--timeout MS]
 *     [--concurrency N] [--engine chromium|firefox|webkit]
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { runMany } = require("./page_pool.js");

const DEFAULT_VIEWPORT = { width: 800, height: 1159 };

// Measured cost of renderToFile()'s work (navigate + screenshot) against an
// already-running browser, in milliseconds - fed to page_pool.js's
// pool-sizing so a batch opens the right number of pages.
const TASK_COST_MS = 50;

/**
 * Navigate `page` to `url`, setContent to html, and save a screenshot to
 * `outPath`. The entire rendering concern. Returns `{png, outPath}`.
 */
async function renderToFile(
  page,
  {
    url,
    html,
    outPath,
    viewport = DEFAULT_VIEWPORT,
    fullPage = false,
    waitUntil = "load",
    timeout = 30000,
  },
) {
  await page.setViewportSize(viewport);
  if (url) {
    await page.goto(url, { waitUntil, timeout });
  }
  if (html) {
    await page.setContent(html, { waitUntil, timeout });
  }

  const png = await page.screenshot({ path: outPath, type: "png", fullPage });
  return { png, outPath };
}

/**
 * Render every item in `items` (each renderToFile()'s own options, plus any
 * extra fields you want carried through to the result - handy for tagging
 * each render with its own metadata) in parallel, over a pool of pages
 * sized for the batch. Returns each item merged with `{png, outPath}`, in
 * `items` order. `onRendered(result, item, index)`, if given, fires as
 * each finishes - that's completion order, not `items` order.
 */
async function renderMany(items, { concurrency, engine, onRendered } = {}) {
  return runMany(
    items,
    async (page, item, index) => {
      const result = { ...item, ...(await renderToFile(page, item)) };
      if (onRendered) onRendered(result, item, index);
      return result;
    },
    { concurrency, engine, taskCostMs: TASK_COST_MS },
  );
}

const USAGE = `Usage: render_screenshot.js --url URL --out PATH [--url URL --out PATH ...] [options]

Renders one or more file:// or http(s):// URLs to PNGs - pass --url/--out as
many times as needed, matched in order. Connects to the browser
browser_mcp.js has running for this repo, if any, otherwise launches and
closes its own headless browser.

Options:
  --url URL            Page to render (file:// or http(s)://); repeatable
  --out PATH           Output PNG path; repeatable, one per --url, in order
  --viewport WxH       Viewport size, e.g. 800x1159 (default: 800x1159)
  --full-page          Capture the full scrollable page, not just the viewport
  --wait-until EVENT   Playwright waitUntil event (default: load)
  --timeout MS         Navigation timeout in ms (default: 30000)
  --concurrency N      Max parallel pages (default: CPU core count)
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
    concurrency: os.cpus().length,
    engine: "chromium",
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
        "times - one --out per --url, matched in order",
    );
    console.error(USAGE);
    process.exit(2);
  }

  const viewport = args.viewport
    ? parseViewport(args.viewport)
    : DEFAULT_VIEWPORT;
  const items = args.url.map((url, i) => ({
    url,
    outPath: args.out[i],
    viewport,
    fullPage: args.fullPage,
    waitUntil: args.waitUntil,
    timeout: args.timeout,
  }));

  await renderMany(items, {
    concurrency: args.concurrency,
    engine: args.engine,
    onRendered: (result) => console.log(`Captured ${result.outPath}`),
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

module.exports = { renderMany };
