#!/usr/bin/env node
"use strict";

/**
 * MCP server that keeps a shared Playwright browser process warm for this
 * repo's screenshot tooling - nothing else. It exposes no tools: the only
 * entrypoint for actually taking a screenshot is capture_screenshots.js
 * (built on render_screenshot.js / card_html.js), whether or not
 * this server is running.
 *
 * On startup this launches a headless browser server (default engine:
 * chromium; pass --engine to run a different one) and writes a connection
 * file (see browser_connection.js) exposing its endpoint, so
 * capture_screenshots.js / render_screenshot.js calls made during the same
 * session can connect to the already-running process instead of paying to
 * launch their own.
 *
 * For Chromium this also pre-creates a pool of --concurrency pages up
 * front (see browser_connection.js's launchManagedChromium()), exposed via
 * a real CDP endpoint so later callers can connectOverCDP() and reuse an
 * already-existing page at ~zero cost instead of paying to create a fresh
 * one on every single call - the single biggest chunk of what used to make
 * Chromium tool-call latency scale linearly with the number of separate
 * calls in a session (see commit history for the benchmarks). This
 * ASSUMES callers don't run concurrently against it - see
 * browser_connection.js's module doc for why that matters here.
 * WebKit/Firefox don't speak CDP, so they launch via Playwright's own
 * launchServer() protocol instead, with no shared pages: each caller still
 * creates fully private pages, same as before.
 *
 * Because an MCP host (Claude Code, Cursor, etc.) spawns this process over
 * stdio and holds its stdin pipe open for the life of the session, stdin
 * closing (rl.on("close")) is a real, OS-level "the session ended" signal -
 * not a heuristic - so the browser and its connection file are always
 * cleaned up exactly when the owning session goes away, including most
 * crashes. SIGINT/SIGTERM are also handled directly.
 *
 * Usage:
 *   node utils/uk_geog/browser_mcp.js [--engine chromium|firefox|webkit] [--concurrency N]
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

const {
  resolveEngine,
  DEFAULT_ENGINE,
  launchManagedChromium,
  writeConnectionFile,
  removeConnectionFile,
} = require("./browser_connection.js");

const USAGE = `Usage: browser_mcp.js [--engine chromium|firefox|webkit] [--concurrency N]

Options:
  --engine NAME     Browser engine to keep warm (default: ${DEFAULT_ENGINE})
  --concurrency N   Pages to pre-create in the pool; Chromium only (default: 4)
  --help            Show this help
`;

function parseArgs(argv) {
  const args = { engine: DEFAULT_ENGINE, concurrency: 4, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--engine":
        args.engine = argv[++i];
        break;
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

  let server, cdpUrl, wsEndpoint;
  if (args.engine === "chromium") {
    ({ server, cdpUrl } = await launchManagedChromium({
      headless: true,
      tabs: args.concurrency,
    }));
  } else {
    const browserType = resolveEngine(args.engine);
    server = await browserType.launchServer({ headless: true, args: [] });
    wsEndpoint = server.wsEndpoint();
  }

  writeConnectionFile(args.engine, {
    ownerPid: process.pid,
    browserPid: server.process().pid,
    engine: args.engine,
    ...(cdpUrl ? { cdpUrl } : { wsEndpoint }),
  });

  console.error(
    `Launched headless ${args.engine} on ${cdpUrl ?? wsEndpoint}` +
      (cdpUrl ? ` with ${args.concurrency} pre-created pages` : "") +
      " for capture_screenshots.js to connect to."
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
            version: "3.0.0",
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
    removeConnectionFile(args.engine);
    try {
      await server.close();
    } catch {
      // Already gone.
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
