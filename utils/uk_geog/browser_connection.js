"use strict";

/**
 * Puppeteer browser lifecycle, decoupled from anything that renders with it.
 *
 * Resolution order for `getBrowser()`:
 *   1. PUPPETEER_BROWSER_URL env var, if set - an explicit override (e.g. for
 *      CI, or a developer pointing at a debug browser by hand). Never closed
 *      by the caller.
 *   2. A connection file written by a browser that a Claude Code SessionStart
 *      hook launched for this project directory (see hooks/session_start.js
 *      and start_browser.js) - reused if its PID and CDP endpoint are both
 *      still alive. Never closed by the caller; a SessionEnd hook owns
 *      killing it (with a self-idle-timeout in start_browser.js as a
 *      backstop if the hook never fires).
 *   3. Otherwise, launch a throwaway headless Chromium that the caller should
 *      close when done (`shouldClose: true`) - this is what one-off CLI
 *      invocations fall back to when no hook-managed browser is running
 *      (e.g. running `make screenshots` outside of Claude Code).
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

// Bumps the file's mtime so start_browser.js's idle-timeout treats this as
// recent activity and doesn't shut itself down while still in use.
function touchConnectionFile() {
  try {
    const now = new Date();
    fs.utimesSync(connectionFilePath(), now, now);
  } catch {
    // Best-effort; a missed touch just makes the idle timeout a bit tighter.
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

async function getHookManagedBrowser() {
  const info = readConnectionFile();
  if (!info || !info.url || !info.pid) return null;
  if (!isPidAlive(info.pid)) return null;
  if (!(await isEndpointAlive(info.url))) return null;
  touchConnectionFile();
  return info.url;
}

async function getBrowser({ headless = true, args = LAUNCH_ARGS } = {}) {
  const envURL = process.env.PUPPETEER_BROWSER_URL;
  if (envURL) {
    const browser = await puppeteer.connect({ browserURL: envURL });
    return { browser, shouldClose: false };
  }

  const hookURL = await getHookManagedBrowser();
  if (hookURL) {
    const browser = await puppeteer.connect({ browserURL: hookURL });
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
  touchConnectionFile,
  isPidAlive,
  isEndpointAlive,
};
