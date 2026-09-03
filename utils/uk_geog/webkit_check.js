#!/usr/bin/env node
"use strict";

/**
 * Render every note template (front/back, light/dark) in a real WebKit engine
 * via Playwright, standing in for AnkiMobile's WebKit-based webview. Fails
 * the build if any render throws a page error, logs a console error/warning,
 * or fails to navigate.
 *
 * For zoombox-enabled templates it also checks that the zoombox actually
 * populated (display:block, non-empty), since a script exception there would
 * otherwise silently leave an empty popup rather than failing loudly.
 *
 * Unlike the MCP server, this is a one-shot check rather than a long-lived
 * process, so deck.json is loaded once upfront and reused for every render
 * instead of being re-read per card. Renders run concurrently across a small
 * pool of pages, matching capture_screenshots.js and screenshot_mcp.js.
 *
 * Requires the Playwright WebKit browser: `npx playwright install webkit`.
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

let webkit;
try {
  ({ webkit } = require("playwright"));
} catch (err) {
  if (err.code === "MODULE_NOT_FOUND") {
    console.error(
      "Playwright is required for the WebKit check. Run `npm install` " +
        "(and `npx playwright install webkit` once, to fetch the browser) first."
    );
    process.exit(1);
  }
  throw err;
}

const {
  REPO_ROOT,
  DEFAULT_DECK,
  VIEWPORT,
  REQUIRED_FIELDS,
  findNote,
  loadDeck,
  renderTemplate,
  wrapHtml,
  PagePool,
  runWithPool,
} = require("./screenshot_common.js");

const HTML_DIR = path.join(REPO_ROOT, "build", "webkit_check", "html");
const CONCURRENCY = 4;

// Templates whose back (or front, for the "Map - X" direction) shows the
// zoombox popup; used to sanity-check it actually rendered content. Each
// value picks a note whose zoombox is known to trigger (see zoomNames in the
// templates), since most counties/cities intentionally don't show one.
const ZOOMBOX_SAMPLES = {
  "City - Map": { City: "City of London" },
  "County - Map": { County: "City of London" },
  "Map - County": { County: "City of London" },
  "County - Region": { County: "City of London" },
};

function buildHtml({ css, templatesByName, tmplName, side, dark, fields }) {
  const tmpl = templatesByName[tmplName];
  const source = side === "back" ? tmpl.afmt : tmpl.qfmt;
  return wrapHtml(css, renderTemplate(source, fields), dark);
}

async function checkZoombox(page) {
  return page.evaluate(() => {
    const zb = document.getElementById("zoombox");
    if (!zb) return null;
    return {
      display: getComputedStyle(zb).display,
      childCount: zb.children.length,
    };
  });
}

/** Render one job (template/side/dark) on a pooled page and check it. */
async function renderJob(page, job) {
  const { tmplName, side, dark, html, zoomboxSample } = job;

  const slug = tmplName.toLowerCase().replace(/ /g, "-");
  const htmlPath = path.join(
    HTML_DIR,
    `${slug}-${side}${dark ? "-dark" : ""}-${page._poolIndex}.html`
  );
  fs.writeFileSync(htmlPath, html);

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
    await page.goto(pathToFileURL(htmlPath).href, {
      waitUntil: "load",
      timeout: 30000,
    });
    await page.waitForTimeout(100);
  } catch (e) {
    navError = e.message;
  }

  let zoomboxIssue = null;
  if (!navError && zoomboxSample) {
    const zb = await checkZoombox(page).catch((e) => ({ error: e.message }));
    if (zb && zb.error) {
      zoomboxIssue = `zoombox check failed: ${zb.error}`;
    } else if (zb && (zb.display !== "block" || zb.childCount === 0)) {
      zoomboxIssue = `zoombox did not populate (display=${zb.display}, children=${zb.childCount})`;
    }
  }

  page.off("console", onConsole);
  page.off("pageerror", onPageError);

  return {
    template: tmplName,
    side,
    dark,
    navError,
    consoleIssues,
    pageErrors,
    zoomboxIssue,
  };
}

async function run() {
  fs.mkdirSync(HTML_DIR, { recursive: true });

  // Loaded once and reused for every render below, rather than re-reading
  // deck.json per card.
  const { deck, fieldNames, css, templatesByName } = loadDeck(DEFAULT_DECK);
  const templateNames = Object.keys(templatesByName);

  const jobs = [];
  for (const tmplName of templateNames) {
    const required = REQUIRED_FIELDS[tmplName] || [];
    const zoomboxSample = ZOOMBOX_SAMPLES[tmplName];
    const fields = findNote(deck.notes, fieldNames, required, zoomboxSample);
    if (!fields) {
      console.log(`[skip] ${tmplName}: no matching note in deck`);
      continue;
    }

    for (const side of ["front", "back"]) {
      for (const dark of [false, true]) {
        const html = buildHtml({ css, templatesByName, tmplName, side, dark, fields });
        jobs.push({ tmplName, side, dark, html, zoomboxSample });
      }
    }
  }

  if (!jobs.length) {
    console.log("No renderable templates found.");
    return;
  }

  const browser = await webkit.launch();
  const pageCount = Math.min(CONCURRENCY, jobs.length);
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const page = await browser.newPage({ viewport: VIEWPORT });
    page._poolIndex = i;
    pages.push(page);
  }
  const pool = new PagePool(pages);

  const results = await runWithPool(pool, jobs, renderJob);

  await browser.close();

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

  console.log(
    `\nWebKit check: ${results.length - failures}/${results.length} renders clean.`
  );

  if (failures > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
