#!/usr/bin/env node
"use strict";

/**
 * Renders every note template's card (front/back, light/dark) and fails if
 * any render throws a JS error or logs a console error/warning. Never takes
 * a screenshot.
 *
 * Cards are shown the way Anki's reviewer shows them: one page per session,
 * with each card swapped into it in turn, so state left by one card can
 * break the next. Each template's front and back are shown twice through.
 *
 * Works with any engine (--engine chromium|firefox|webkit, default chromium).
 * WebKit runs as AnkiMobile on an iPhone and an iPad unless --client says
 * otherwise; other engines run as desktop Anki.
 *
 * Usage:
 *   node utils/uk_geog/check_cards.js [options]
 */

const {
  DEFAULT_DECK,
  CLIENTS,
  pageHtml,
  prepareCard,
  resolveRenderRequests,
} = require("./cards.js");
const {
  defineOperation,
  loadConfig,
  DEFAULT_CONCURRENCY,
} = require("../browser_ops");

const DEFAULT_ENGINE = loadConfig().defaultEngine;
const ROUNDS = 2;

// Show a card as Anki's reviewer does: swap #qa's contents and the body's
// classes, then re-create each script so it runs.
function showCard({ content, bodyClass }) {
  document.body.className = bodyClass;
  const qa = document.getElementById("qa");
  qa.innerHTML = content;
  for (const old of qa.querySelectorAll("script")) {
    const script = document.createElement("script");
    for (const { name, value } of old.attributes) {
      script.setAttribute(name, value);
    }
    script.textContent = old.textContent;
    old.replaceWith(script);
  }
}

const settle = () =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

/**
 * Load `shell`, then show `cards` ({content, bodyClass}) in it one after
 * another, `rounds` times through. Returns `{navError, showings}`, with
 * `{consoleIssues, pageErrors}` for each card shown, in order.
 */
const checkOperation = defineOperation(module, {
  name: "check",
  async run(page, { shell, cards, rounds = 1, timeout = 30000 }) {
    const showings = [];
    let current;
    const next = () => {
      current = { consoleIssues: [], pageErrors: [] };
      showings.push(current);
    };

    const onConsole = (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        current.consoleIssues.push(`${msg.type()}: ${msg.text()}`);
      }
    };
    const onPageError = (err) =>
      current.pageErrors.push(err.message || String(err));

    page.on("console", onConsole);
    page.on("pageerror", onPageError);

    // Anything the shell itself reports lands on the first card.
    next();
    let navError = null;
    try {
      await page.setContent(shell, { timeout });
      for (let n = 0; n < rounds * cards.length; n++) {
        if (n > 0) next();
        await page.evaluate(showCard, cards[n % cards.length]);
        await page.evaluate(settle);
      }
    } catch (err) {
      navError = err.message || String(err);
    }

    page.off("console", onConsole);
    page.off("pageerror", onPageError);

    return { navError, showings };
  },
});

const USAGE = `Usage: check_cards.js [options]

Renders every note template (front/back, light/dark) and fails if any
render throws a JS error or logs a console error/warning. Cards are shown
one after another in the same page, as Anki's reviewer does. Doesn't take
or save any screenshots.

Options:
  --deck PATH        CrowdAnki deck.json (default: built deck)
  --sample SPEC      TEMPLATE:FIELD=VALUE note selector; repeatable
  --concurrency N    Number of parallel browser pages (default: CPU core count)
  --engine NAME      Browser engine: chromium (default), firefox, webkit
  --client NAME      Anki client to emulate: ${Object.keys(CLIENTS).join(", ")};
                     repeatable (default: iphone and ipad on webkit,
                     otherwise desktop)
  --help             Show this help
`;

function parseArgs(argv) {
  const args = {
    deck: DEFAULT_DECK,
    sample: [],
    concurrency: DEFAULT_CONCURRENCY,
    engine: DEFAULT_ENGINE,
    client: [],
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
      case "--client":
        args.client.push(argv[++i]);
        if (!CLIENTS[args.client.at(-1)]) {
          console.error(
            `--client must be one of: ${Object.keys(CLIENTS).join(", ")}`,
          );
          process.exit(2);
        }
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
  if (!args.client.length) {
    args.client = args.engine === "webkit" ? ["iphone", "ipad"] : ["desktop"];
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

  // One session per client, template and theme, showing its front and back.
  const groups = new Map();
  for (const req of requests) {
    const key = `${req.template}\n${req.dark}`;
    if (!groups.has(key)) groups.set(key, []);
    const { content, bodyClass } = prepareCard({
      deckPath: args.deck,
      template: req.template,
      side: req.side,
      dark: req.dark,
      samples: req.samples,
    });
    groups.get(key).push({ req, content, bodyClass });
  }
  const sessions = [];
  for (const client of args.client) {
    for (const renders of groups.values()) {
      sessions.push({ client, dark: renders[0].req.dark, renders });
    }
  }

  const checked = await checkOperation.run(
    sessions.map(({ client, dark, renders }) => ({
      shell: pageHtml({ client }),
      cards: renders.map(({ content, bodyClass }) => ({ content, bodyClass })),
      rounds: ROUNDS,
      context: {
        ...CLIENTS[client].context,
        colorScheme: dark ? "dark" : "light",
      },
    })),
    { concurrency: args.concurrency, engine: args.engine },
  );

  let total = 0;
  let failures = 0;
  sessions.forEach(({ client, renders }, s) => {
    const { navError, showings } = checked[s];
    renders.forEach(({ req }, i) => {
      total++;
      const problems = [];
      if (navError) problems.push(`page failed: ${navError}`);
      for (let n = i; n < showings.length; n += renders.length) {
        const { consoleIssues, pageErrors } = showings[n];
        const when = n < renders.length ? "" : "shown again: ";
        if (pageErrors.length) {
          problems.push(`${when}JS errors: ${pageErrors.join(" | ")}`);
        }
        if (consoleIssues.length) {
          problems.push(`${when}console: ${consoleIssues.join(" | ")}`);
        }
      }

      if (problems.length) {
        failures++;
        console.error(
          `[FAIL] ${client} ${req.template} ${req.side}${req.dark ? " (dark)" : ""}: ${problems.join("; ")}`,
        );
      }
    });
  });

  console.log(
    `\n${args.engine} check (${args.client.join(", ")}): ` +
      `${total - failures}/${total} renders clean.`,
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
