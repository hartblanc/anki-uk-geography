"use strict";

/**
 * Puppeteer browser lifecycle, decoupled from anything that renders with it.
 * Callers never create tabs on a browser they don't own - see getBrowser()'s
 * `tabs` option below and render_screenshot.js's renderMany().
 *
 * Resolution order for `getBrowser()`:
 *   1. A connection file written by browser_mcp.js (see there), which
 *      launches its own browser at startup and exposes it this way so
 *      one-off callers (capture_screenshots.js, render_screenshot.js) can
 *      discover and reuse it instead of launching their own. Reused only if
 *      the recorded owning PID is alive and the recorded URL answers.
 *      If the PID is dead, the browser it launched is an orphan (an abrupt
 *      kill, e.g. SIGKILL, skips browser_mcp.js's own cleanup) - this closes
 *      it if still reachable and removes the stale file, rather than
 *      leaving it to leak. Never closed on a genuine reuse - browser_mcp.js
 *      owns that lifecycle, tied to its own process (spawned and reaped by
 *      the MCP host, e.g. Claude Code, so that's real process-lifecycle
 *      cleanup, not a heuristic).
 *   2. Otherwise, launch a throwaway headless Chromium that the caller should
 *      close when done (`shouldClose: true`) - this is what one-off CLI
 *      invocations fall back to when no MCP-managed browser is running
 *      (e.g. running `make screenshots` outside of an MCP-connected agent).
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LAUNCH_ARGS = ["--disable-gpu", "--hide-scrollbars"];

// Keyed by REPO_ROOT so each worktree/checkout gets its own file and never
// picks up another project's (or another worktree's) browser. Lives outside
// the repo so `make` targets that clear build/ can't delete it out from
// under a still-running browser.
function connectionFilePath() {
  const key = crypto.createHash("sha1").update(REPO_ROOT).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `uk-geog-puppeteer-browser-${key}.json`);
}

function readConnectionFile() {
  try {
    return JSON.parse(fs.readFileSync(connectionFilePath(), "utf8"));
  } catch {
    return null;
  }
}

function writeConnectionFile(data) {
  fs.writeFileSync(connectionFilePath(), JSON.stringify(data));
}

function removeConnectionFile() {
  try {
    fs.unlinkSync(connectionFilePath());
  } catch {
    // Already gone.
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isEndpointAlive(browserURL) {
  try {
    const res = await fetch(`${browserURL}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function getManagedBrowserURL() {
  const info = readConnectionFile();
  if (!info || !info.url || !info.pid) return null;

  if (isPidAlive(info.pid)) {
    return (await isEndpointAlive(info.url)) ? info.url : null;
  }

  // Owner is dead - the browser it launched is orphaned (e.g. killed
  // abruptly, skipping browser_mcp.js's own cleanup). Close it if it's
  // still reachable so it doesn't leak forever unwatched, then remove the
  // stale record and let the caller fall back to launching a fresh one.
  if (await isEndpointAlive(info.url)) {
    try {
      const orphan = await puppeteer.connect({ browserURL: info.url });
      await orphan.close();
    } catch {
      // Already gone.
    }
  }
  removeConnectionFile();
  return null;
}

/**
 * `tabs` only matters when this ends up launching a fresh browser (no
 * MCP-managed one running): a launch starts with exactly one tab, so this
 * opens more to reach the requested count. It's ignored when connecting to
 * an existing managed browser - that browser's tab count was already
 * decided by whoever launched it (see browser_mcp.js), and callers use
 * whatever's actually there (see render_screenshot.js's renderMany())
 * rather than resizing a browser they don't own.
 */
async function getBrowser({ headless = true, args = LAUNCH_ARGS, tabs = 1 } = {}) {
  const managedURL = await getManagedBrowserURL();
  if (managedURL) {
    const browser = await puppeteer.connect({ browserURL: managedURL });
    return { browser, shouldClose: false };
  }

  const browser = await puppeteer.launch({ headless, args });
  const existing = await browser.pages();
  for (let i = existing.length; i < tabs; i++) {
    await browser.newPage();
  }
  return { browser, shouldClose: true };
}

module.exports = {
  getBrowser,
  LAUNCH_ARGS,
  connectionFilePath,
  readConnectionFile,
  writeConnectionFile,
  removeConnectionFile,
  isPidAlive,
  isEndpointAlive,
};
