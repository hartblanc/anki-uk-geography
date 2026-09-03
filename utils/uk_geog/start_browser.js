#!/usr/bin/env node
"use strict";

/**
 * Starts a single long-lived headless Chromium with a CDP HTTP endpoint, and
 * stays running until killed. Meant to be launched detached by
 * hooks/session_start.js (a Claude Code SessionStart hook) with --managed, so
 * browser_connection.js's getBrowser() can find and reuse it via the
 * connection file instead of launching a fresh browser per screenshot call.
 *
 * With --managed, this writes that connection file (path is deterministic -
 * see browser_connection.js's connectionFilePath(), keyed by this repo's
 * root) and self-terminates after --idle-timeout ms of no callers touching
 * its mtime (default 30 min) - a backstop in case the SessionEnd hook never
 * fires (documented as best-effort, not guaranteed, by Claude Code).
 *
 * Without --managed, this is just a standalone "start a browser and print
 * its CDP URL" tool with no connection file or idle timeout - it prints
 * `PUPPETEER_BROWSER_URL=...` and runs until Ctrl+C, for manual/CI use
 * outside of Claude Code hooks.
 *
 * Usage:
 *   node utils/uk_geog/start_browser.js [--port PORT]
 *   node utils/uk_geog/start_browser.js --port PORT --managed [--idle-timeout MS]
 */

const fs = require("fs");
const puppeteer = require("puppeteer");
const {
  LAUNCH_ARGS,
  connectionFilePath,
  writeConnectionFile,
  removeConnectionFile,
} = require("./browser_connection.js");

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

const USAGE = `Usage: start_browser.js [--port PORT] [--managed] [--idle-timeout MS]

Launches a headless Chromium with a CDP HTTP endpoint and keeps it running
until killed (SIGINT/SIGTERM). Prints "PUPPETEER_BROWSER_URL=<url>" on its
own stdout line once ready.

Options:
  --port PORT         Remote debugging port (default: 9222)
  --managed           Write the connection file browser_connection.js looks
                      for, and self-exit after --idle-timeout ms of no
                      caller touching it (used by hooks/session_start.js)
  --idle-timeout MS   Idle shutdown window when --managed is set
                      (default: ${DEFAULT_IDLE_TIMEOUT_MS})
  --help              Show this help
`;

function parseArgs(argv) {
  const args = { port: 9222, managed: false, idleTimeout: DEFAULT_IDLE_TIMEOUT_MS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--port":
        args.port = parseInt(argv[++i], 10);
        break;
      case "--managed":
        args.managed = true;
        break;
      case "--idle-timeout":
        args.idleTimeout = parseInt(argv[++i], 10);
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

  let idleInterval = null;

  const shutdown = async () => {
    if (idleInterval) clearInterval(idleInterval);
    if (args.managed) removeConnectionFile();
    try {
      await browser.close();
    } catch {
      // Already closing/closed.
    }
    process.exit(0);
  };

  if (args.managed) {
    writeConnectionFile({ pid: process.pid, port: args.port, url: browserURL });
    idleInterval = setInterval(() => {
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(connectionFilePath()).mtimeMs;
      } catch {
        // Connection file removed out from under us (e.g. a SessionEnd
        // hook already cleaned up) - nothing left to stay alive for.
        mtimeMs = -Infinity;
      }
      if (Date.now() - mtimeMs > args.idleTimeout) {
        console.error(`Idle for ${args.idleTimeout}ms, shutting down.`);
        shutdown();
      }
    }, IDLE_CHECK_INTERVAL_MS).unref();
  }
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
