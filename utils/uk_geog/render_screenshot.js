#!/usr/bin/env node
"use strict";

/**
 * Thin, decoupled screenshot renderer: given a URL (file:// or http(s)://)
 * and an output path, renders it to a PNG. It knows nothing about Anki cards,
 * decks, or templates - anything that produces HTML worth screenshotting
 * (screenshot_common.js, or anything else) just needs to hand this a URL.
 *
 * Connects to an existing browser via PUPPETEER_BROWSER_URL when set (see
 * browser_connection.js / start_browser.js); otherwise launches and closes
 * its own throwaway browser for the one render.
 *
 * Also exports PagePool/runWithPool, a small pool of puppeteer pages for
 * spreading many renders across a handful of open tabs - used by
 * capture_screenshots.js and screenshot_mcp.js to batch-render cards.
 *
 * Usage:
 *   node utils/uk_geog/render_screenshot.js --url URL --out PATH
 *     [--viewport WIDTHxHEIGHT] [--full-page] [--wait-until EVENT] [--timeout MS]
 */

const fs = require("fs");
const path = require("path");

const { getBrowser } = require("./browser_connection.js");

const DEFAULT_VIEWPORT = { width: 800, height: 1159 };

/**
 * Navigate `page` to `url` and save a screenshot to `outPath`. This is the
 * entire puppeteer-rendering concern: no HTML generation, no deck/template
 * knowledge.
 */
async function renderToFile(
  page,
  { url, outPath, fullPage = false, waitUntil = "load", timeout = 30000 }
) {
  await page.goto(url, { waitUntil, timeout });
  const png = await page.screenshot({ type: "png", fullPage });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);
  return { png, outPath };
}

/**
 * Simple promise-based pool of Puppeteer pages. Each render takes one tab for
 * the duration of its navigation/screenshot and returns it afterwards, so
 * concurrent calls and batch renders are spread over all open tabs.
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

const USAGE = `Usage: render_screenshot.js --url URL --out PATH [options]

Renders a file:// or http(s):// URL to a PNG. Connects to an existing browser
via the PUPPETEER_BROWSER_URL env var (see start_browser.js) if set, otherwise
launches and closes its own headless Chromium.

Options:
  --url URL           Page to render (file:// or http(s)://); required
  --out PATH           Output PNG path; required
  --viewport WxH       Viewport size, e.g. 800x1159 (default: 800x1159)
  --full-page          Capture the full scrollable page, not just the viewport
  --wait-until EVENT   Puppeteer waitUntil event (default: load)
  --timeout MS         Navigation timeout in ms (default: 30000)
  --help               Show this help
`;

function parseArgs(argv) {
  const args = {
    url: null,
    out: null,
    viewport: null,
    fullPage: false,
    waitUntil: "load",
    timeout: 30000,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--url":
        args.url = argv[++i];
        break;
      case "--out":
        args.out = argv[++i];
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
  if (!args.url || !args.out) {
    console.error("--url and --out are required");
    console.error(USAGE);
    process.exit(2);
  }

  const viewport = args.viewport ? parseViewport(args.viewport) : DEFAULT_VIEWPORT;
  const { browser, shouldClose } = await getBrowser();
  try {
    const page = await browser.newPage();
    try {
      await page.setViewport(viewport);
      const { outPath } = await renderToFile(page, {
        url: args.url,
        outPath: args.out,
        fullPage: args.fullPage,
        waitUntil: args.waitUntil,
        timeout: args.timeout,
      });
      console.log(`Captured ${outPath}`);
    } finally {
      await page.close();
    }
  } finally {
    if (shouldClose) await browser.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

module.exports = { renderToFile, PagePool, runWithPool, DEFAULT_VIEWPORT };
