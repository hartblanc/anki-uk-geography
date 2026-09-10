#!/usr/bin/env node
"use strict";

/**
 * MCP server that runs this project's browser host (host.js). Exposes no
 * tools - it only stays alive for the length of an MCP session so the host
 * inside it can keep browsers warm for whatever else runs meanwhile.
 *
 * Which browsers open at startup is the `warm` key in
 * browser-ops.config.js; anything else launches on first use.
 *
 * Usage:
 *   node utils/browser_ops/mcp.js
 *
 * Configure in .mcp.json:
 *   {
 *     "mcpServers": {
 *       "browser": {
 *         "command": "node",
 *         "args": ["utils/browser_ops/mcp.js"]
 *       }
 *     }
 *   }
 */

const readline = require("readline");

const fs = require("fs");
const path = require("path");

const { startHost } = require("./host.js");
const { ROOT } = require("./index.js");

const USAGE = `Usage: mcp.js

Runs this project's browser host, keeping browsers warm for any command that
uses utils/browser_ops. Exposes no MCP tools.

Options:
  --help   Show this help
`;

// Name the server after the project, so a host serving several checkouts is
// distinguishable in an MCP client.
function serverInfo() {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  } catch {
    // No package.json, or unreadable.
  }
  return {
    name: `${pkg.name ?? "browser-ops"}-browser`,
    version: pkg.version ?? "0.0.0",
  };
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
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }

  // Another session may already be hosting this project. That's fine -
  // commands find it by socket - so idle rather than failing to connect.
  let host = null;
  try {
    host = await startHost({ onLog: (line) => console.error(line) });
    console.error(
      `Browser host listening on ${host.socketPath}. Browsers named in ` +
        "browser-ops.config.js's `warm` are opening now; any other engine " +
        "starts on first use.",
    );
  } catch (err) {
    if (err.code !== "EHOSTRUNNING") {
      console.error(err.message);
      process.exit(2);
    }
    console.error(`${err.message} Commands will use the existing one.`);
  }

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
          serverInfo: serverInfo(),
        });
        break;

      case "ping":
        sendResult(msg.id, {});
        break;

      case "tools/list":
        // No tools - this server only keeps the browser host running.
        sendResult(msg.id, { tools: [] });
        break;

      case "tools/call":
        sendError(
          msg.id,
          -32601,
          "This server exposes no tools - it only runs the browser host.",
        );
        break;

      default:
        sendError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  rl.on("line", handleMCPLine);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (host) await host.close();
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
