#!/usr/bin/env node
"use strict";

/**
 * Starts a single long-lived headless Chromium with a CDP HTTP endpoint, and
 * stays running until killed. An agent (or any long-lived session) that wants
 * to make many screenshot calls without paying launch cost each time runs
 * this once at startup, exports the printed PUPPETEER_BROWSER_URL, and every
 * subsequent render_screenshot.js / capture_screenshots.js / screenshot_mcp.js
 * call picks it up via browser_connection.js and connects instead of
 * launching its own browser.
 *
 * Usage:
 *   node utils/uk_geog/start_browser.js [--port PORT]
 *   eval "$(node utils/uk_geog/start_browser.js --port 9222 &)"   # example only;
 *   # in practice: start it in the background, then read its first stdout
 *   # line and export it, e.g.:
 *   #   node utils/uk_geog/start_browser.js > /tmp/browser_url & \
 *   #   sleep 1 && export PUPPETEER_BROWSER_URL=$(cat /tmp/browser_url)
 */

const puppeteer = require("puppeteer");
const { LAUNCH_ARGS } = require("./browser_connection.js");

const USAGE = `Usage: start_browser.js [--port PORT]

Launches a headless Chromium with a CDP HTTP endpoint and keeps it running
until killed (SIGINT/SIGTERM). Prints "PUPPETEER_BROWSER_URL=<url>" on its
own stdout line once ready - export that value so other screenshot tools in
this repo connect to it instead of launching their own browser.

Options:
  --port PORT   Remote debugging port (default: 9222)
  --help        Show this help
`;

function parseArgs(argv) {
  const args = { port: 9222, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--port":
        args.port = parseInt(argv[++i], 10);
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

  const browser = await puppeteer.launch({
    headless: true,
    args: [...LAUNCH_ARGS, `--remote-debugging-port=${args.port}`],
  });
  const browserURL = `http://127.0.0.1:${args.port}`;
  console.log(`PUPPETEER_BROWSER_URL=${browserURL}`);
  console.error(`Browser ready at ${browserURL}. Press Ctrl+C to stop.`);

  const shutdown = async () => {
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  browser.on("disconnected", () => process.exit(0));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
