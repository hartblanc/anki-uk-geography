#!/usr/bin/env node
"use strict";

/**
 * Generate front/back screenshots of Anki card templates, using Playwright's
 * bundled browsers (chromium by default; see --engine).
 *
 * Reads the built CrowdAnki deck, renders each requested note template with
 * a real note's fields, wraps it in Anki's HTML card shell, and screenshots
 * each side to a PNG.
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
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { execFileSync } = require("child_process");

const {
  REPO_ROOT,
  DEFAULT_DECK,
  prepareCard,
  resolveRenderRequests,
} = require("./cards.js");
const { renderMany } = require("./render_screenshot.js");

const DEFAULT_OUT = path.join(REPO_ROOT, "build", "screenshots");

const USAGE = `Usage: capture_screenshots.js [options]

Options:
  --deck PATH        CrowdAnki deck.json (default: built deck)
  --out DIR          Output directory for PNGs (default: build/screenshots)
  --dark             Render in dark mode
  --only LIST        Comma-separated template names to capture
  --sample SPEC      TEMPLATE:FIELD=VALUE note selector; repeatable
  --concurrency N    Number of parallel browser pages (default: CPU core count)
  --stitch PATH      Stitch captured front/back pairs into a 2-column grid
  --engine NAME      Browser engine: chromium (default), firefox, webkit
  --help             Show this help
`;

function parseArgs(argv) {
  const args = {
    deck: DEFAULT_DECK,
    out: DEFAULT_OUT,
    dark: false,
    only: null,
    sample: [],
    concurrency: os.cpus().length,
    stitch: null,
    engine: "chromium",
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
    { stdio: "inherit" },
  );
  console.log(`Stitched ${captured.length} cards -> ${outPng}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const only = args.only
    ? args.only.split(",").map((name) => name.trim())
    : null;
  const { usableTemplates, requests } = resolveRenderRequests({
    deckPath: args.deck,
    only,
    darkModes: [args.dark],
    samples: args.sample,
  });

  if (!requests.length) {
    return;
  }

  // HTML generation doesn't touch a page or the browser at all, so it
  // happens here as plain preprocessing - one scratch HTML file per
  // request, keyed by its position so concurrent renders never collide.
  const items = requests.map((req, index) => {
    const { html } = prepareCard({
      deckPath: args.deck,
      template: req.template,
      side: req.side,
      dark: req.dark,
      samples: req.samples,
    });
    const outPath = cardPngPath({
      outDir: args.out,
      template: req.template,
      side: req.side,
      dark: req.dark,
      filename: req.filename,
    });
    return { html, outPath, template: req.template, side: req.side };
  });

  // Renders everything in parallel over a small pool of browser pages,
  // reusing each one across cards instead of paying per-screenshot page
  // creation cost.
  const results = await renderMany(items, {
    concurrency: args.concurrency,
    engine: args.engine,
    onRendered: (result) => console.log(`Captured ${result.outPath}`),
  });

  const byTemplate = new Map();
  for (const result of results) {
    if (!result) continue;
    let entry = byTemplate.get(result.template);
    if (!entry) {
      entry = { front: null, back: null };
      byTemplate.set(result.template, entry);
    }
    entry[result.side] = result.outPath;
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
}

/**
 * Resolve the output PNG path for a rendered card, honouring an explicit
 * filename override or falling back to the `<template>-<side>[-dark].png`
 * convention.
 */
function cardPngPath({ outDir, template, side, dark, filename }) {
  const finalFilename = filename
    ? ensurePngExtension(path.basename(String(filename)))
    : defaultPngName(template, side, dark);
  return path.join(outDir, finalFilename);
}

function ensurePngExtension(name) {
  return /\.png$/i.test(name) ? name : `${name}.png`;
}

function defaultPngName(template, side, dark) {
  return `${slug(template)}-${side}${dark ? "-dark" : ""}.png`;
}

function slug(name) {
  return name.toLowerCase().replace(" - ", "-").replace(/ /g, "-");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
