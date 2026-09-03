#!/usr/bin/env node
"use strict";

/**
 * Claude Code SessionEnd hook: tears down the Puppeteer browser this
 * project's SessionStart hook (session_start.js) started for this session,
 * so it doesn't keep running after the agent exits.
 *
 * SessionEnd hooks are best-effort in Claude Code (short shared timeout,
 * exit code ignored) so this just fires a SIGTERM and removes the
 * connection file immediately without waiting to confirm the process
 * exited. start_browser.js's own idle-timeout is the backstop if this
 * hook doesn't run at all (e.g. a hard crash).
 */

const { readConnectionFile, removeConnectionFile, isPidAlive } = require("../browser_connection.js");

function main() {
  const info = readConnectionFile();
  removeConnectionFile();
  if (!info || !info.pid) return;
  if (!isPidAlive(info.pid)) return;
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

main();
