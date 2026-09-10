#!/usr/bin/env node
"use strict";

/**
 * Render URLs (file:// or http(s)://) to PNG screenshots.
 *
 * renderMany(items, {concurrency, engine, scale, onRendered}) renders a
 * batch of `{url, html, outPath, viewport?, scale?, fullPage?, waitUntil?,
 * timeout?}` items, returning each merged with its result in `items` order.
 * Extra fields on an item are carried through to its result.
 *
 * Usage:
 *   node utils/uk_geog/render_screenshot.js --url URL --out PATH [--url URL --out PATH ...]
 *     [--viewport WIDTHxHEIGHT] [--scale N] [--full-page] [--wait-until EVENT]
 *     [--timeout MS] [--concurrency N] [--engine chromium|firefox|webkit]
 */

const {
  defineOperation,
  loadConfig,
  DEFAULT_CONCURRENCY,
} = require("../browser_ops");

const DEFAULT_ENGINE = loadConfig().defaultEngine;
const DEFAULT_VIEWPORT = { width: 800, height: 1159 };
const DEFAULT_SCALE = 1;

/**
 * Navigate to `url` and/or set `html`, then save a PNG to `outPath`.
 * An item's `scale` is applied by the pool, not here.
 */
const renderOperation = defineOperation(module, {
  name: "render",
  async run(
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
    await page.screenshot({ path: outPath, type: "png", fullPage });
    return { outPath };
  },
});

/** Render `items` in parallel, each merged with `{outPath}`. */
async function renderMany(
  items,
  { concurrency, engine, scale, onRendered } = {},
) {
  const results = await renderOperation.run(items, {
    concurrency,
    engine,
    scale,
    onResult:
      onRendered &&
      ((result, item, index) =>
        onRendered({ ...item, ...result }, item, index)),
  });
  return results.map((result, i) => ({ ...items[i], ...result }));
}

const USAGE = `Usage: render_screenshot.js --url URL --out PATH [--url URL --out PATH ...] [options]

Renders one or more file:// or http(s):// URLs to PNGs - pass --url/--out as
many times as needed, matched in order. Uses the browser host if one is
running for this repo, otherwise launches and closes its own browser.

Options:
  --url URL            Page to render (file:// or http(s)://); repeatable
  --out PATH           Output PNG path; repeatable, one per --url, in order
  --viewport WxH       Viewport size, e.g. 800x1159 (default: 800x1159)
  --scale N            Device scale factor; 2 doubles the PNG's pixel
                       dimensions for a sharper image (default: 1)
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
    scale: DEFAULT_SCALE,
    fullPage: false,
    waitUntil: "load",
    timeout: 30000,
    concurrency: DEFAULT_CONCURRENCY,
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
      case "--scale":
        args.scale = Number(argv[++i]);
        if (!(args.scale > 0)) {
          console.error("--scale must be a positive number");
          process.exit(2);
        }
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
        if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
          console.error("--concurrency must be a positive integer");
          process.exit(2);
        }
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
    scale: args.scale,
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
