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
  prepareCard,
} = require("./screenshot_common.js");

const HTML_DIR = path.join(REPO_ROOT, "build", "webkit_check", "html");

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

async function run() {
  fs.mkdirSync(HTML_DIR, { recursive: true });

  const { deck, fieldNames, templatesByName } = loadDeck(DEFAULT_DECK);
  const templateNames = Object.keys(templatesByName);

  const browser = await webkit.launch();
  const context = await browser.newContext({ viewport: VIEWPORT });

  const results = [];

  for (const tmplName of templateNames) {
    const required = REQUIRED_FIELDS[tmplName] || [];
    const zoomboxSample = ZOOMBOX_SAMPLES[tmplName];
    const fields = findNote(deck.notes, fieldNames, required, zoomboxSample);
    if (!fields) {
      console.log(`[skip] ${tmplName}: no matching note in deck`);
      continue;
    }
    const samples = zoomboxSample
      ? Object.entries(zoomboxSample).map(([field, value]) => `${tmplName}:${field}=${value}`)
      : [];

    for (const side of ["front", "back"]) {
      for (const dark of [false, true]) {
        const prep = prepareCard({
          deckPath: DEFAULT_DECK,
          template: tmplName,
          side,
          dark,
          samples,
        });

        const slug = tmplName.toLowerCase().replace(/ /g, "-");
        const htmlPath = path.join(
          HTML_DIR,
          `${slug}-${side}${dark ? "-dark" : ""}.html`
        );
        fs.writeFileSync(htmlPath, prep.html);

        const page = await context.newPage();
        const consoleIssues = [];
        const pageErrors = [];
        page.on("console", (msg) => {
          if (msg.type() === "error" || msg.type() === "warning") {
            consoleIssues.push(`${msg.type()}: ${msg.text()}`);
          }
        });
        page.on("pageerror", (err) => {
          pageErrors.push(err.message || String(err));
        });

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

        await page.close();

        results.push({
          template: tmplName,
          side,
          dark,
          navError,
          consoleIssues,
          pageErrors,
          zoomboxIssue,
        });
      }
    }
  }

  await context.close();
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
