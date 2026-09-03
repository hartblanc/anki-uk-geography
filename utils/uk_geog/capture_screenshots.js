#!/usr/bin/env node
"use strict";

/**
 * Generate front/back screenshots of card types using Puppeteer's bundled Chromium.
 *
 * Reads the built CrowdAnki deck, renders each note template with a real note's
 * fields, wraps it in the same HTML shell Anki uses, and screenshots each side
 * with Puppeteer's headless Chromium via render_screenshot.js's
 * openBrowserPool(), which launches and closes its own browser unless
 * browser_mcp.js has one running for this repo, in which case it reuses that
 * instead - handy for long-lived agent sessions making repeated calls.
 *
 * Examples:
 *   # All card types, light mode
 *   node utils/uk_geog/capture_screenshots.js
 *
 *   # Dark mode for three specific cards, using named sample notes, stitched
 *   # into a 2-column (front, back) grid.
 *   node utils/uk_geog/capture_screenshots.js \
 *     --dark \
 *     --only "City - Map,City - County,BoW - Map" \
 *     --sample "City - Map:City=Gloucester" \
 *     --sample "City - County:City=Gloucester" \
 *     --sample "BoW - Map:BoW=Bristol Channel" \
 *     --stitch build/screenshots/dark-mode-grid.png
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

try {
  require.resolve("puppeteer");
} catch (err) {
  if (err.code === "MODULE_NOT_FOUND") {
    console.error(
      "Puppeteer is required for screenshots. Run `npm install` first so " +
        "the bundled Chromium is available."
    );
    process.exit(1);
  }
  throw err;
}

const {
  REPO_ROOT,
  DEFAULT_DECK,
  DEFAULT_OUT,
  REQUIRED_FIELDS,
  findNote,
  parseSamples,
  loadDeck,
  writeCardHtml,
  cardPngPath,
  expandRenderRequests,
} = require("./card_html.js");
const { renderToFile, runWithPool, openBrowserPool, DEFAULT_VIEWPORT } = require("./render_screenshot.js");

const USAGE = `Usage: capture_screenshots.js [options]

Options:
  --deck PATH        CrowdAnki deck.json (default: built deck)
  --out DIR          Output directory for PNGs (default: build/screenshots)
  --dark             Render in dark mode
  --only LIST        Comma-separated template names to capture
  --sample SPEC      TEMPLATE:FIELD=VALUE note selector; repeatable
  --concurrency N    Number of parallel browser tabs (default: 4)
  --stitch PATH      Stitch captured front/back pairs into a 2-column grid
  --help             Show this help
`;

function parseArgs(argv) {
  const args = {
    deck: DEFAULT_DECK,
    out: DEFAULT_OUT,
    dark: false,
    only: null,
    sample: [],
    concurrency: 4,
    stitch: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--deck":
        args.deck = argv[++i];
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--dark":
        args.dark = true;
        break;
      case "--only":
        args.only = argv[++i];
        break;
      case "--sample":
        args.sample.push(argv[++i]);
        break;
      case "--concurrency":
        args.concurrency = parseInt(argv[++i], 10);
        if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
          console.error("--concurrency must be a positive integer");
          process.exit(2);
        }
        break;
      case "--stitch":
        args.stitch = argv[++i];
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

function stitch(captured, outPng, dark) {
  const files = [];
  for (const [, front, back] of captured) {
    files.push(front, back);
  }
  const background = dark ? "#2f2f31" : "white";
  execFileSync(
    "montage",
    [
      ...files,
      "-tile",
      `2x${captured.length}`,
      "-geometry",
      "+4+4",
      "-background",
      background,
      outPng,
    ],
    { stdio: "inherit" }
  );
  console.log(`Stitched ${captured.length} cards -> ${outPng}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const htmlDir = path.join(REPO_ROOT, "build", "screenshots", "html");
  fs.mkdirSync(htmlDir, { recursive: true });
  fs.mkdirSync(args.out, { recursive: true });

  const { deck, fieldNames, templatesByName } = loadDeck(args.deck);
  const samples = parseSamples(args.sample);

  let templateNames = Object.keys(templatesByName);
  if (args.only) {
    const onlyNames = args.only.split(",").map((name) => name.trim());
    templateNames = onlyNames.filter((name) => templatesByName[name]);
  }

  // Skip templates that have no usable note before opening a browser, so the
  // CLI reports them as skips rather than per-side render failures.
  const usableTemplates = [];
  for (const name of templateNames) {
    const required = REQUIRED_FIELDS[name] || [];
    const fields = findNote(deck.notes, fieldNames, required, samples[name]);
    if (!fields) {
      console.log(`Skipping ${name}: no matching note found`);
      continue;
    }
    usableTemplates.push(name);
  }

  const requests = expandRenderRequests({
    allTemplateNames: usableTemplates,
    sides: ["front", "back"],
    dark: args.dark,
    samples: args.sample,
  });

  if (!requests.length) {
    return;
  }

  // Reuse a small pool of pages across all screenshots. Navigating replaces
  // the old DOM, so this avoids the per-screenshot page creation cost while
  // still overlapping page loads when capturing many cards.
  const pageCount = Math.min(args.concurrency, requests.length);
  const { pool, close } = await openBrowserPool({ concurrency: pageCount, viewport: DEFAULT_VIEWPORT });
  try {
    const results = await runWithPool(pool, requests, async (page, req) => {
      console.log(`Capturing ${req.template} ${req.side}`);
      const html = writeCardHtml({
        deckPath: args.deck,
        htmlDir,
        template: req.template,
        side: req.side,
        dark: req.dark,
        samples: req.samples,
        scratchKey: page._poolIndex,
      });
      const pngPath = cardPngPath({
        outDir: args.out,
        template: req.template,
        side: html.side,
        dark: html.dark,
        filename: req.filename,
      });
      await renderToFile(page, { url: html.url, outPath: pngPath });
      console.log(`Captured ${pngPath}`);
      return { template: req.template, side: req.side, pngPath };
    });

    const byTemplate = new Map();
    for (const result of results) {
      if (!result) continue;
      let entry = byTemplate.get(result.template);
      if (!entry) {
        entry = { front: null, back: null };
        byTemplate.set(result.template, entry);
      }
      entry[result.side] = result.pngPath;
    }

    const captured = [];
    for (const name of usableTemplates) {
      const entry = byTemplate.get(name);
      if (entry && entry.front && entry.back) {
        captured.push([name, entry.front, entry.back]);
      }
    }

    if (args.stitch && captured.length) {
      stitch(captured, args.stitch, args.dark);
    }
  } finally {
    await close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
