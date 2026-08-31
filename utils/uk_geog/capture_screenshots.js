#!/usr/bin/env node
"use strict";

/**
 * Generate front/back screenshots of card types using Puppeteer's bundled Chromium.
 *
 * Reads the built CrowdAnki deck, renders each note template with a real note's
 * fields, wraps it in the same HTML shell Anki uses, and screenshots each side
 * with Puppeteer's headless Chromium.
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
const { pathToFileURL } = require("url");

let puppeteer;
try {
  puppeteer = require("puppeteer");
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

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_DECK = path.join(
  REPO_ROOT,
  "build",
  "United Kingdom Geography - Regions Counties and Cities",
  "deck.json"
);
const DEFAULT_OUT = path.join(REPO_ROOT, "build", "screenshots");
const MEDIA_DIR = path.join(REPO_ROOT, "build", "media");
const MEDIA_FILES = ["_maps.js", "_zoombox.js", "_move_to_front.js"];
const VIEWPORT = { width: 800, height: 1159 };

// Fields that must be populated for each template to produce a meaningful card.
const REQUIRED_FIELDS = {
  "BoW - Map": ["BoW"],
  "City - County": ["City", "MacroLocation"],
  "City - Map": ["City"],
  "County - Map": ["County"],
  "County - Region": ["County", "MacroLocation"],
  "Map - BoW": ["BoW"],
  "Map - City": ["City"],
  "Map - County": ["County"],
  "Map - Region": ["Region"],
  "Region - Map": ["Region"],
};

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

function renderTemplate(template, fields) {
  // Sections first ({{#Field}}...{{/Field}}), then simple substitutions.
  let out = template.replace(
    /\{\{#(\w+)\}\}(.*?)\{\{\/\1\}\}/gs,
    (match, name, inner) => (String(fields[name] || "").trim() ? inner : "")
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (match, name) => fields[name] ?? "");
  return out;
}

function findNote(notes, fieldNames, required, sample) {
  required = required || [];
  for (const note of notes) {
    const values = {};
    fieldNames.forEach((name, i) => {
      values[name] = note.fields[i];
    });
    if (
      sample &&
      Object.keys(sample).some(
        (field) =>
          String(values[field] || "").trim() !== String(sample[field]).trim()
      )
    ) {
      continue;
    }
    if (required.every((field) => String(values[field] || "").trim())) {
      return values;
    }
  }
  return null;
}

function slug(name) {
  return name.toLowerCase().replace(" - ", "-").replace(/ /g, "-");
}

function wrapHtml(css, body, dark) {
  const bodyClass = dark ? ' class="nightMode"' : "";
  const darkCss = dark
    ? `
body.nightMode {
  background-color: #2f2f31;
  color: #d0d0d0;
}
body.nightMode .card {
  background-color: #2f2f31;
  color: #d0d0d0;
}
`
    : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
${css}
${darkCss}
</style>
</head>
<body${bodyClass}>
<div class="card">
${body}
</div>
</body>
</html>
`;
}

function parseSamples(items) {
  const samples = {};
  for (const item of items) {
    const [template, fieldEq] = item.split(":");
    const [field, value] = fieldEq.split("=");
    const name = template.trim();
    samples[name] = samples[name] || {};
    samples[name][field.trim()] = value.trim();
  }
  return samples;
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

  const deck = JSON.parse(fs.readFileSync(args.deck, "utf8"));
  const model = deck.note_models[0];
  const fieldNames = model.flds.map((field) => field.name);
  const css = model.css;
  const samples = parseSamples(args.sample);

  let templates = model.tmpls;
  if (args.only) {
    const onlyNames = args.only.split(",").map((name) => name.trim());
    const byName = Object.fromEntries(templates.map((tmpl) => [tmpl.name, tmpl]));
    templates = onlyNames
      .filter((name) => byName[name])
      .map((name) => byName[name]);
  }

  // Intermediate HTML goes under build/ (git-ignored); only the PNGs are output.
  const htmlDir = path.join(REPO_ROOT, "build", "screenshots", "html");
  fs.mkdirSync(htmlDir, { recursive: true });
  fs.mkdirSync(args.out, { recursive: true });
  for (const media of MEDIA_FILES) {
    fs.copyFileSync(path.join(MEDIA_DIR, media), path.join(htmlDir, media));
  }

  const captured = [];
  const captureJobs = [];
  for (const tmpl of templates) {
    const name = tmpl.name;
    const required = REQUIRED_FIELDS[name] || [];
    const fields = findNote(deck.notes, fieldNames, required, samples[name]);
    if (!fields) {
      console.log(`Skipping ${name}: no matching note found`);
      continue;
    }

    const base = slug(name);
    const suffix = args.dark ? "-dark" : "";
    const frontPng = path.join(args.out, `${base}-front${suffix}.png`);
    const backPng = path.join(args.out, `${base}-back${suffix}.png`);

    for (const [side, source, outPng] of [
      ["front", tmpl.qfmt, frontPng],
      ["back", tmpl.afmt, backPng],
    ]) {
      const html = wrapHtml(css, renderTemplate(source, fields), args.dark);
      const htmlPath = path.join(htmlDir, `${base}-${side}${suffix}.html`);
      fs.writeFileSync(htmlPath, html);
      const url = pathToFileURL(htmlPath).href;
      console.log(`Capturing ${name} ${side} -> ${outPng}`);
      captureJobs.push({ url, out: outPng });
    }

    captured.push([name, frontPng, backPng]);
  }

  // Capture after building all HTML so Puppeteer can reuse one browser session;
  // the HTML files are loaded directly via file:// URLs. The card templates
  // inject maps synchronously from external scripts, so the "load" event is
  // sufficient; no extra settle delay is needed.
  if (captureJobs.length) {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--disable-gpu", "--hide-scrollbars"],
    });
    try {
      // Reuse a small pool of pages across all screenshots. Navigating replaces
      // the old DOM, so this avoids the per-screenshot page creation cost while
      // still overlapping page loads when capturing many cards.
      const pages = [];
      const pageCount = Math.min(args.concurrency, captureJobs.length);
      for (let i = 0; i < pageCount; i++) {
        const page = await browser.newPage();
        await page.setViewport(VIEWPORT);
        pages.push(page);
      }

      let nextJob = 0;
      async function captureWithPage(page) {
        while (true) {
          const index = nextJob++;
          if (index >= captureJobs.length) return;
          const job = captureJobs[index];
          await page.goto(job.url, { waitUntil: "load", timeout: 30000 });
          await page.screenshot({ path: job.out, type: "png" });
          console.log(`Captured ${job.out}`);
        }
      }

      await Promise.all(pages.map(captureWithPage));
    } finally {
      await browser.close();
    }
  }

  if (args.stitch && captured.length) {
    stitch(captured, args.stitch, args.dark);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
