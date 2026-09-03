#!/usr/bin/env node
"use strict";

/**
 * Claude Code SessionStart hook: makes sure a warm, hook-managed Puppeteer
 * browser is running for this project directory, so capture_screenshots.js /
 * screenshot_mcp.js / render_screenshot.js calls made during the session
 * connect to it instead of launching Chromium per call (see
 * browser_connection.js). Idempotent - safe to run on every SessionStart
 * (startup, resume, clear, compact): if a live one already exists it's left
 * alone, matching hook and touched so its idle timer resets.
 *
 * Env vars don't propagate from a hook to later tool calls in Claude Code,
 * so this can't just `export` a connection string - instead the browser
 * writes a connection file (path derived from this repo's root, see
 * browser_connection.js's connectionFilePath()) that later tool calls
 * discover on their own. This also means the browser this hook starts is
 * scoped to this project directory/worktree - never shared with a session
 * running elsewhere.
 *
 * Runs node utils/uk_geog/start_browser.js --managed as a detached child so
 * it outlives this hook process; hooks/session_end.js tears it down (with
 * start_browser.js's own idle-timeout as a backstop, since SessionEnd is
 * best-effort, not guaranteed, per Claude Code's docs).
 */

const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const {
  readConnectionFile,
  isPidAlive,
  isEndpointAlive,
  touchConnectionFile,
} = require("../browser_connection.js");

const START_BROWSER = path.join(__dirname, "..", "start_browser.js");
const READY_TIMEOUT_MS = 5000;
const READY_POLL_MS = 200;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function hasLiveManagedBrowser() {
  const info = readConnectionFile();
  if (!info || !info.pid || !info.url) return false;
  if (!isPidAlive(info.pid)) return false;
  if (!(await isEndpointAlive(info.url))) return false;
  touchConnectionFile();
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (await hasLiveManagedBrowser()) {
    console.error("[uk-geog screenshots] reusing existing managed browser");
    return;
  }

  const port = await getFreePort();
  const child = spawn(
    process.execPath,
    [START_BROWSER, "--port", String(port), "--managed"],
    { detached: true, stdio: "ignore" }
  );
  child.unref();

  // Best-effort wait so the very first screenshot call in the session can
  // use the warm browser too; not fatal if it isn't ready in time - callers
  // fall back to launching their own throwaway browser regardless.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await hasLiveManagedBrowser()) {
      console.error(`[uk-geog screenshots] started managed browser on port ${port}`);
      return;
    }
    await sleep(READY_POLL_MS);
  }
  console.error(
    `[uk-geog screenshots] managed browser on port ${port} not ready after ` +
      `${READY_TIMEOUT_MS}ms; screenshot calls will fall back to launching their own`
  );
}

main().catch((err) => {
  console.error(`[uk-geog screenshots] session_start hook failed: ${err && err.stack ? err.stack : err}`);
});
