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
 *      the browser actually answering at the recorded URL still reports the
 *      exact browser id (a UUID Chrome generates fresh per launch, embedded
 *      in its devtools endpoint) recorded when the file was written -
 *      checking that a PID is alive and a port answers isn't enough, since
 *      an abrupt kill (SIGKILL) skips browser_mcp.js's own cleanup and can
 *      leave both a stale file and an orphaned browser process behind, and
 *      OS PIDs get reused. If the id matches but the recording PID is dead,
 *      the browser is an orphan (its owner never got to close it) - this
 *      closes it and removes the file rather than reusing or leaving it to
 *      leak. Never closed on a genuine reuse - browser_mcp.js owns that
 *      lifecycle, tied to its own process (spawned and reaped by the MCP
 *      host, e.g. Claude Code, so that's real process-lifecycle cleanup,
 *      not a heuristic).
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

// The browser id is the UUID Chrome embeds in its devtools endpoint
// (ws://host:port/devtools/browser/<uuid>), generated fresh on every
// launch. Returns null if nothing answers at browserURL.
async function getLiveBrowserId(browserURL) {
  try {
    const res = await fetch(`${browserURL}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const { webSocketDebuggerUrl } = await res.json();
    if (!webSocketDebuggerUrl) return null;
    return new URL(webSocketDebuggerUrl).pathname.split("/").pop();
  } catch {
    return null;
  }
}

async function isEndpointAlive(browserURL) {
  return (await getLiveBrowserId(browserURL)) !== null;
}

async function getManagedBrowserURL() {
  const info = readConnectionFile();
  if (!info || !info.url || !info.pid || !info.browserId) return null;

  const liveId = await getLiveBrowserId(info.url);
  const isOurs = liveId !== null && liveId === info.browserId;
  const ownerAlive = isPidAlive(info.pid);

  if (isOurs && ownerAlive) return info.url;

  if (isOurs && !ownerAlive) {
    // Confirmed to be the exact browser we recorded, but its owning
    // browser_mcp.js process is gone (e.g. killed abruptly, skipping its
    // own cleanup) - it's orphaned. Close it so it doesn't leak forever
    // unwatched, then let the caller fall back to launching a fresh one.
    try {
      const orphan = await puppeteer.connect({ browserURL: info.url });
      await orphan.close();
    } catch {
      // Already gone.
    }
    removeConnectionFile();
    return null;
  }

  // Not confirmed as ours (id mismatch, or nothing answered). Never touch
  // whatever - if anything - is actually at that URL, since we can't
  // positively identify it as a browser we started; only forget the stale
  // record once its recorded owner is also confirmed dead.
  if (!ownerAlive) removeConnectionFile();
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
  getLiveBrowserId,
};
