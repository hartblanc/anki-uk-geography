"use strict";

/**
 * Puppeteer browser lifecycle, decoupled from anything that renders with it.
 *
 * Resolution order for `getBrowser()`:
 *   1. PUPPETEER_BROWSER_URL env var, if set - an explicit override (e.g. for
 *      CI, or a developer pointing at a debug browser started by hand with
 *      start_browser.js). Never closed by the caller.
 *   2. A connection file written by screenshot_mcp.js (see there), which
 *      launches its own browser at startup and exposes it this way so
 *      one-off callers (capture_screenshots.js, render_screenshot.js) can
 *      discover and reuse it instead of launching their own. Reused only if
 *      its PID and CDP endpoint are both still alive. Never closed by the
 *      caller - screenshot_mcp.js owns its lifecycle, tied to its own
 *      process (it's spawned and reaped by the MCP host, e.g. Claude Code,
 *      so this is real process-lifecycle cleanup, not a heuristic).
 *   3. Otherwise, launch a throwaway headless Chromium that the caller should
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
  if (!isPidAlive(info.pid)) return null;
  if (!(await isEndpointAlive(info.url))) return null;
  return info.url;
}

async function getBrowser({ headless = true, args = LAUNCH_ARGS } = {}) {
  const envURL = process.env.PUPPETEER_BROWSER_URL;
  if (envURL) {
    const browser = await puppeteer.connect({ browserURL: envURL });
    return { browser, shouldClose: false };
  }

  const managedURL = await getManagedBrowserURL();
  if (managedURL) {
    const browser = await puppeteer.connect({ browserURL: managedURL });
    return { browser, shouldClose: false };
  }

  const browser = await puppeteer.launch({ headless, args });
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
