#!/usr/bin/env node
"use strict";

/**
 * MCP server that keeps a shared Playwright browser process warm in the
 * background. Exposes no tools of its own - nothing here takes a
 * screenshot or checks a page; it only manages a browser's lifetime so
 * other commands in this toolkit can skip the cost of launching their own.
 *
 * On startup, launches a headless browser (default engine: chromium; pass
 * --engine for a different one) and writes a connection file describing how
 * to reach it, so other processes can connect to this one for as long as it
 * keeps running.
 *
 * By default that's a plain connection: each caller that connects still
 * creates its own private pages. Pass --cdp-pool-size [N] (Chromium only) to
 * instead expose a real CDP endpoint with N pages pre-created up front (N
 * defaults to this machine's CPU core count if omitted) - callers then reuse
 * those pages directly at near-zero cost instead of creating fresh ones.
 * However, when using --cdp-pool-size, independent processes will share a
 * single browser instance, these processes must therefore tolerate any state
 * that previous runs leave behind, and should avoid accessing the browser at
 * the same time. Pre-created pages are not supported for WebKit or Firefox.
 *
 * Because MCP hosts spawn this process over stdio and hold the stdin pipe open
 * for the life of the session, stdin closing is treated as a "the session
 * ended" signal - the browser and its connection file are always cleaned up
 * when that happens, including most crashes. SIGINT/SIGTERM are also handled
 * directly.
 *
 * Usage:
 *   node utils/uk_geog/browser_mcp.js [--engine chromium|firefox|webkit] [--cdp-pool-size [N]]
 *
 * Configure in .mcp.json:
 *   {
 *     "mcpServers": {
 *       "uk-geography-browser": {
 *         "command": "node",
 *         "args": ["utils/uk_geog/browser_mcp.js", "--cdp-pool-size"]
 *       }
 *     }
 *   }
 */

const os = require("os");
const readline = require("readline");

const { createPagePool } = require("./page_pool.js");

const USAGE = `Usage: browser_mcp.js [--engine chromium|firefox|webkit] [--cdp-pool-size [N]]

Options:
  --engine NAME        Browser engine to keep warm (default: chromium)
  --cdp-pool-size [N]  Pre-create a shared pool of N pages over a real CDP
                       endpoint, instead of a plain connection with no
                       shared pages. Chromium only; off by default (see
                       this file's module doc for the tradeoff it makes).
                       N defaults to CPU core count if omitted.
  --help               Show this help
`;

function parseArgs(argv) {
  const args = {
    engine: "chromium",
    // Presence, not just truthiness, is what enables --cdp-pool-size - null
    // means the flag was never passed, so a plain connection is used.
    cdpPoolSize: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--engine":
        args.engine = argv[++i];
        break;
      case "--cdp-pool-size": {
        // The size is optional - only consume the next token as N if it's
        // actually numeric, so a bare --cdp-pool-size before another flag
        // (or at the end of argv) isn't misparsed as swallowing it.
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          args.cdpPoolSize = parseInt(next, 10);
          i++;
        } else {
          args.cdpPoolSize = os.cpus().length;
        }
        break;
      }
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

  let pool;
  try {
    pool = await createPagePool({
      engine: args.engine,
      cdpPoolSize: args.cdpPoolSize,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  console.error(
    `Launched headless ${args.engine} on ${pool.endpoint}` +
      (pool.cdpPool ? ` with ${args.cdpPoolSize} pre-created pages` : "") +
      " for other processes to connect to.",
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
        sendResult(msg.id, { tools: [] });
        break;

      case "tools/call":
        sendError(
          msg.id,
          -32601,
          "This server exposes no tools - it only manages the shared browser's lifetime.",
        );
        break;

      default:
        sendError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  rl.on("line", handleMCPLine);

  const shutdown = async () => {
    await pool.close();
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
