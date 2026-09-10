#!/usr/bin/env node
"use strict";

/**
 * Renders every note template's card (front/back, light/dark) and fails if
 * any render throws a JS error or logs a console error/warning. Never takes
 * a screenshot.
 *
 * Works with any engine (--engine chromium|firefox|webkit, default chromium);
 * running it against WebKit stands in for AnkiMobile's WebKit-based webview.
 *
 * Usage:
 *   node utils/uk_geog/check_cards.js [options]
 */

const {
  DEFAULT_DECK,
  prepareCard,
  resolveRenderRequests,
} = require("./cards.js");
const {
  defineOperation,
  loadConfig,
  DEFAULT_CONCURRENCY,
} = require("../browser_ops");

const DEFAULT_ENGINE = loadConfig().defaultEngine;

/**
 * Load `html` and report console errors/warnings, uncaught page errors, and
 * whether the load failed. Returns `{navError, consoleIssues, pageErrors}`.
 */
const checkOperation = defineOperation(module, {
  name: "check",
  async run(page, { html, waitUntil = "load", timeout = 30000 }) {
    const consoleMessages = [];
    const pageErrors = [];

    const onConsole = (msg) =>
      consoleMessages.push({ type: msg.type(), text: msg.text() });
    const onPageError = (err) => pageErrors.push(err.message || String(err));

    page.on("console", onConsole);
    page.on("pageerror", onPageError);

    let navError = null;
    try {
      await page.setContent(html, { waitUntil, timeout });
    } catch (err) {
      navError = err.message || String(err);
    }

    page.off("console", onConsole);
    page.off("pageerror", onPageError);

    const consoleIssues = consoleMessages
      .filter((msg) => msg.type === "error" || msg.type === "warning")
      .map((msg) => `${msg.type}: ${msg.text}`);

    return { navError, consoleIssues, pageErrors };
  },
});

const USAGE = `Usage: check_cards.js [options]

Renders every note template (front/back, light/dark) and fails if any
render throws a JS error or logs a console error/warning. Doesn't take or
save any screenshots.

Options:
  --deck PATH        CrowdAnki deck.json (default: built deck)
  --sample SPEC      TEMPLATE:FIELD=VALUE note selector; repeatable
  --concurrency N    Number of parallel browser pages (default: CPU core count)
  --engine NAME      Browser engine: chromium (default), firefox, webkit
  --help             Show this help
`;

function parseArgs(argv) {
  const args = {
    deck: DEFAULT_DECK,
    sample: [],
    concurrency: DEFAULT_CONCURRENCY,
    engine: DEFAULT_ENGINE,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--deck":
        args.deck = argv[++i];
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const { requests } = resolveRenderRequests({
    deckPath: args.deck,
    darkModes: [false, true],
    samples: args.sample,
  });

  if (!requests.length) {
    console.log("No checkable templates found.");
    return;
  }

  const items = requests.map((req) => ({
    html: prepareCard({
      deckPath: args.deck,
      template: req.template,
      side: req.side,
      dark: req.dark,
      samples: req.samples,
    }).html,
  }));

  const checked = await checkOperation.run(items, {
    concurrency: args.concurrency,
    engine: args.engine,
  });

  const results = checked.map((result, i) => ({
    template: requests[i].template,
    side: requests[i].side,
    dark: requests[i].dark,
    ...result,
  }));

  let failures = 0;
  for (const r of results) {
    const problems = [];
    if (r.navError) problems.push(`navigation failed: ${r.navError}`);
    if (r.pageErrors.length)
      problems.push(`JS errors: ${r.pageErrors.join(" | ")}`);
    if (r.consoleIssues.length)
      problems.push(`console: ${r.consoleIssues.join(" | ")}`);

    if (problems.length) {
      failures++;
      console.error(
        `[FAIL] ${r.template} ${r.side}${r.dark ? " (dark)" : ""}: ${problems.join("; ")}`,
      );
    }
  }

  console.log(
    `\n${args.engine} check: ${results.length - failures}/${results.length} renders clean.`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
