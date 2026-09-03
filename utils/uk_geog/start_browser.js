#!/usr/bin/env node
"use strict";

/**
 * Starts a single long-lived headless Chromium with a CDP HTTP endpoint, and
 * stays running until killed. Prints "PUPPETEER_BROWSER_URL=<url>" once
 * ready - export that value so capture_screenshots.js / render_screenshot.js
 * / screenshot_mcp.js connect to this browser instead of launching their own
 * (see browser_connection.js).
 *
 * For an MCP-connected agent, screenshot_mcp.js already launches and manages
 * its own browser this way automatically (see there) - this script is for
 * manual/CI use: running screenshots repeatedly by hand, or from a shell
 * script, without going through MCP at all.
 *
 * Usage:
 *   node utils/uk_geog/start_browser.js [--port PORT]
 */

const puppeteer = require("puppeteer");
const { LAUNCH_ARGS } = require("./browser_connection.js");

const USAGE = `Usage: start_browser.js [--port PORT]

Launches a headless Chromium with a CDP HTTP endpoint and keeps it running
until killed (SIGINT/SIGTERM). Prints "PUPPETEER_BROWSER_URL=<url>" on its
own stdout line once ready - export that value so other screenshot tools in
this repo connect to it instead of launching their own browser.

Options:
  --port PORT   Remote debugging port. Default: none - Chrome picks and
                binds its own free port atomically, avoiding the conflict
                risk of naming a fixed port (e.g. two invocations, or
                anything else already using it) up front. Pass this only
                when you specifically want a stable, known port.
  --help        Show this help
`;

function parseArgs(argv) {
  const args = { port: null, help: false };
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

  const launchArgs = args.port ? [...LAUNCH_ARGS, `--remote-debugging-port=${args.port}`] : LAUNCH_ARGS;
  const browser = await puppeteer.launch({ headless: true, args: launchArgs });
  const port = args.port || new URL(browser.wsEndpoint()).port;
  const browserURL = `http://127.0.0.1:${port}`;
  console.log(`PUPPETEER_BROWSER_URL=${browserURL}`);
  console.error(`Browser ready at ${browserURL}. Press Ctrl+C to stop.`);

  const shutdown = async () => {
    try {
      await browser.close();
    } catch {
      // Already closing/closed.
    }
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
