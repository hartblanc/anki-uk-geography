#!/usr/bin/env node
"use strict";

/**
 * MCP server that manages a shared Puppeteer browser's lifetime for this
 * repo's screenshot tooling - nothing else. It exposes no tools: the only
 * entrypoint for actually taking a screenshot is capture_screenshots.js
 * (built on render_screenshot.js / card_html.js), whether or not
 * this server is running.
 *
 * On startup this launches a headless Chromium, opens --concurrency tabs on
 * it (default 4), and writes a connection file (see browser_connection.js)
 * exposing its CDP endpoint, so capture_screenshots.js / render_screenshot.js
 * calls made during the same session discover and reuse this browser instead
 * of launching their own. Initializing the tabs here (rather than in
 * render_screenshot.js, which just uses whatever tabs a browser already has)
 * is what lets many separate capture_screenshots.js invocations share a
 * fixed, bounded set of tabs instead of each accumulating its own on a
 * browser they don't own and will never close.
 *
 * Because an MCP host (Claude Code, Cursor, etc.) spawns this process over
 * stdio and holds its stdin pipe open for the life of the session, stdin
 * closing (rl.on("close")) is a real, OS-level "the session ended" signal -
 * not a heuristic - so the browser and its connection file are always
 * cleaned up exactly when the owning session goes away, including most
 * crashes. SIGINT/SIGTERM are also handled directly.
 *
 * Usage:
 *   node utils/uk_geog/browser_mcp.js [--concurrency N]
 *
 * Configure in .mcp.json:
 *   {
 *     "mcpServers": {
 *       "uk-geography-browser": {
 *         "command": "node",
 *         "args": ["utils/uk_geog/browser_mcp.js"]
 *       }
 *     }
 *   }
 */

const readline = require("readline");
const puppeteer = require("puppeteer");

const { LAUNCH_ARGS, writeConnectionFile, removeConnectionFile } = require("./browser_connection.js");

const USAGE = `Usage: browser_mcp.js [--concurrency N]

Options:
  --concurrency N   Tabs to open on the shared browser at startup (default: 4)
  --help            Show this help
`;

function parseArgs(argv) {
  const args = { concurrency: 4, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--concurrency":
        args.concurrency = parseInt(argv[++i], 10);
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

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendError(id, code, message) {
  send({
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: { code, message },
  });
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  // Leaving --remote-debugging-port unset lets Chrome pick and bind its own
  // free port atomically (puppeteer parses the actual port back out of its
  // startup log) - no separate probe-then-reuse step, so no window for
  // something else to grab that port first.
  const browser = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
  const { port } = new URL(browser.wsEndpoint());
  const browserURL = `http://127.0.0.1:${port}`;
  writeConnectionFile({ pid: process.pid, port: Number(port), url: browserURL });

  // A launch starts with exactly one tab; open the rest now so every
  // capture_screenshots.js call that reuses this browser finds a fixed,
  // ready pool instead of creating (and never closing) its own tabs.
  const existing = await browser.pages();
  for (let i = existing.length; i < args.concurrency; i++) {
    await browser.newPage();
  }

  console.error(
    `Launched headless Chromium on ${browserURL} with ${args.concurrency} ` +
      "tabs for capture_screenshots.js to reuse."
  );

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  function handleMCPLine(line) {
    if (!line.trim()) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      sendError(null, -32700, "Parse error");
      return;
    }

    if (msg.id === undefined) {
      // Notification (e.g. notifications/initialized): no response required.
      return;
    }

    switch (msg.method) {
      case "initialize":
        sendResult(msg.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "uk-geography-browser",
            version: "2.0.0",
          },
        });
        break;

      case "ping":
        sendResult(msg.id, {});
        break;

      case "tools/list":
        // No tools - this server only keeps a shared browser alive.
        // Take screenshots via capture_screenshots.js instead.
        sendResult(msg.id, { tools: [] });
        break;

      case "tools/call":
        sendError(
          msg.id,
          -32601,
          "This server exposes no tools - it only manages the shared browser's " +
            "lifetime. Take screenshots with capture_screenshots.js."
        );
        break;

      default:
        sendError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  rl.on("line", handleMCPLine);

  const shutdown = async () => {
    removeConnectionFile();
    try {
      await browser.close();
    } catch {
      // Browser may already be closed.
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  rl.on("close", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
