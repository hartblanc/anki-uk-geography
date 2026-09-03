#!/usr/bin/env node
"use strict";

/**
 * Generate front/back screenshots of card types using Playwright's bundled
 * browsers.
 *
 * Reads the built CrowdAnki deck, renders each note template with a real note's
 * fields, wraps it in the same HTML shell Anki uses, and screenshots each side
 * with Playwright's headless browser (chromium by default; see --engine) via
 * render_screenshot.js's renderMany(), which launches and closes its own
 * browser unless browser_mcp.js has one running for this repo, in which case
 * it connects to that instead - handy for long-lived agent sessions making
 * repeated calls. This script never deals with the browser or a page pool
 * directly.
 *
 * --check turns the same rendering pipeline into a regression check: every
 * template is rendered on both sides and in both themes (ignoring --dark and
 * --only) and the run fails if any render throws a JS error, logs a console
 * error/warning, or - for zoombox-enabled templates - the zoombox fails to
 * populate. This is what `make webkit-check` runs (--engine webkit --check),
 * but it works with any engine, e.g. to catch a regression in the default
 * Chromium path too.
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
 *
 *   # WebKit render check, standing in for AnkiMobile's webview.
 *   node utils/uk_geog/capture_screenshots.js --engine webkit --check
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

try {
  require.resolve("playwright");
} catch (err) {
  if (err.code === "MODULE_NOT_FOUND") {
    console.error(
      "Playwright is required for screenshots. Run `npm install` first - " +
        "its postinstall script fetches the browsers too."
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
const { renderToFile, renderMany } = require("./render_screenshot.js");
const { DEFAULT_ENGINE } = require("./browser_connection.js");

// Templates whose back (or front, for the "Map - X" direction) shows the
// zoombox popup; used by --check to sanity-check it actually rendered
// content. Each value picks a note whose zoombox is known to trigger (see
// zoomNames in the templates), since most counties/cities intentionally
// don't show one - and to pick which templates get the zoombox assertion at
// all. A user-supplied --sample for the same template takes precedence.
const ZOOMBOX_SAMPLES = {
  "City - Map": { City: "City of London" },
  "County - Map": { County: "City of London" },
  "Map - County": { County: "City of London" },
  "County - Region": { County: "City of London" },
};

const USAGE = `Usage: capture_screenshots.js [options]

Options:
  --deck PATH        CrowdAnki deck.json (default: built deck)
  --out DIR          Output directory for PNGs (default: build/screenshots)
  --dark             Render in dark mode (ignored with --check)
  --only LIST        Comma-separated template names to capture (ignored with --check)
  --sample SPEC      TEMPLATE:FIELD=VALUE note selector; repeatable
  --concurrency N    Number of parallel browser tabs (default: 4)
  --stitch PATH      Stitch captured front/back pairs into a 2-column grid
  --engine NAME      Browser engine: chromium (default), firefox, webkit
  --check            Render every template x side x theme and fail on any
                      JS/console error or an unpopulated zoombox, instead of
                      just capturing PNGs
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
    engine: DEFAULT_ENGINE,
    check: false,
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
      case "--check":
        args.check = true;
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

/** Read the zoombox popup's state on the current page, or null if this card has none. */
async function readZoombox(page) {
  return page.evaluate(() => {
    const zb = document.getElementById("zoombox");
    if (!zb) return null;
    return {
      display: getComputedStyle(zb).display,
      childCount: zb.children.length,
    };
  });
}

/**
 * Render every template x side x theme and assert each one is clean: no JS
 * exception, no console error/warning, and (for ZOOMBOX_SAMPLES templates) a
 * populated zoombox. Exits non-zero if anything fails.
 */
async function runCheck(args, { deck, fieldNames, templatesByName, htmlDir }) {
  const templateNames = Object.keys(templatesByName);
  const userSamples = parseSamples(args.sample);

  // Pick a note that actually triggers the zoombox for templates that have
  // one, unless the caller already asked for a specific note.
  const zoomboxSampleSpecs = [];
  for (const [tmplName, fields] of Object.entries(ZOOMBOX_SAMPLES)) {
    if (userSamples[tmplName]) continue;
    for (const [field, value] of Object.entries(fields)) {
      zoomboxSampleSpecs.push(`${tmplName}:${field}=${value}`);
    }
  }
  const sampleArgs = [...args.sample, ...zoomboxSampleSpecs];
  const parsedSamples = parseSamples(sampleArgs);

  const usableTemplates = [];
  for (const name of templateNames) {
    const required = REQUIRED_FIELDS[name] || [];
    const fields = findNote(deck.notes, fieldNames, required, parsedSamples[name]);
    if (!fields) {
      console.log(`Skipping ${name}: no matching note found`);
      continue;
    }
    usableTemplates.push(name);
  }

  let requests = [];
  for (const dark of [false, true]) {
    requests = requests.concat(
      expandRenderRequests({
        allTemplateNames: usableTemplates,
        sides: ["front", "back"],
        dark,
        samples: sampleArgs,
      })
    );
  }

  if (!requests.length) {
    console.log("No renderable templates found.");
    return;
  }

  const results = await renderMany(
    requests,
    async (page, req, index) => {
      const html = writeCardHtml({
        deckPath: args.deck,
        htmlDir,
        template: req.template,
        side: req.side,
        dark: req.dark,
        samples: req.samples,
        scratchKey: index,
      });

      const consoleIssues = [];
      const pageErrors = [];
      const onConsole = (msg) => {
        if (msg.type() === "error" || msg.type() === "warning") {
          consoleIssues.push(`${msg.type()}: ${msg.text()}`);
        }
      };
      const onPageError = (err) => {
        pageErrors.push(err.message || String(err));
      };
      page.on("console", onConsole);
      page.on("pageerror", onPageError);

      let navError = null;
      try {
        const pngPath = cardPngPath({
          outDir: args.out,
          template: req.template,
          side: html.side,
          dark: html.dark,
          filename: req.filename,
        });
        await renderToFile(page, { url: html.url, outPath: pngPath });
      } catch (e) {
        navError = e.message;
      }

      let zoomboxIssue = null;
      if (!navError && ZOOMBOX_SAMPLES[req.template]) {
        const zb = await readZoombox(page).catch((e) => ({ error: e.message }));
        if (zb && zb.error) {
          zoomboxIssue = `zoombox check failed: ${zb.error}`;
        } else if (zb && (zb.display !== "block" || zb.childCount === 0)) {
          zoomboxIssue = `zoombox did not populate (display=${zb.display}, children=${zb.childCount})`;
        }
      }

      page.off("console", onConsole);
      page.off("pageerror", onPageError);

      return {
        template: req.template,
        side: req.side,
        dark: req.dark,
        navError,
        consoleIssues,
        pageErrors,
        zoomboxIssue,
      };
    },
    { concurrency: args.concurrency, engine: args.engine }
  );

  let failures = 0;
  for (const r of results) {
    const problems = [];
    if (r.navError) problems.push(`navigation failed: ${r.navError}`);
    if (r.pageErrors.length) problems.push(`JS errors: ${r.pageErrors.join(" | ")}`);
    if (r.consoleIssues.length) problems.push(`console: ${r.consoleIssues.join(" | ")}`);
    if (r.zoomboxIssue) problems.push(r.zoomboxIssue);

    if (problems.length) {
      failures++;
      console.error(
        `[FAIL] ${r.template} ${r.side}${r.dark ? " (dark)" : ""}: ${problems.join("; ")}`
      );
    }
  }

  console.log(`\n${args.engine} check: ${results.length - failures}/${results.length} renders clean.`);
  if (failures > 0) {
    process.exitCode = 1;
  }
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

  if (args.check) {
    await runCheck(args, { deck, fieldNames, templatesByName, htmlDir });
    return;
  }

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

  // renderMany spreads these across a small pool of browser tabs, reusing
  // each one across cards instead of paying per-screenshot page creation
  // cost - this script never sees the browser or the pool itself.
  const results = await renderMany(
    requests,
    async (page, req, index) => {
      console.log(`Capturing ${req.template} ${req.side}`);
      const html = writeCardHtml({
        deckPath: args.deck,
        htmlDir,
        template: req.template,
        side: req.side,
        dark: req.dark,
        samples: req.samples,
        scratchKey: index,
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
    },
    { concurrency: args.concurrency, engine: args.engine }
  );

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
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
