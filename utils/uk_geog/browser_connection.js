"use strict";

/**
 * Playwright browser lifecycle, decoupled from anything that renders with it.
 *
 * Resolution order for `getBrowser()`:
 *   1. A connection file written by browser_mcp.js (see there), which
 *      launches its own browser server at startup and exposes it this way
 *      so one-off callers (capture_screenshots.js, render_screenshot.js)
 *      can discover and reuse the already-running process instead of
 *      paying to launch their own. Reused only if the recorded owning PID
 *      is alive and `browserType.connect()` to the recorded endpoint
 *      succeeds - connect() doubles as the liveness check, since a
 *      Playwright server (unlike a CDP browser) exposes no separate HTTP
 *      probe endpoint to check first.
 *
 *      Unlike Puppeteer's CDP-based connect(), Playwright's connect() does
 *      NOT hand a client the contexts/pages another client already created
 *      on the same server - each connect() gets its own private set
 *      (verified empirically: a second connect() to the same launchServer()
 *      sees zero contexts even after a first client created some). So
 *      reuse here only saves the browser process's launch cost, not tab
 *      creation - every caller, managed or not, creates its own `tabs`
 *      pages after obtaining a browser handle (see getBrowser() below).
 *      This is also why browser_mcp.js no longer pre-creates any tabs
 *      itself - nobody could ever see them.
 *
 *      If the owning PID is dead, the browser server it launched may be
 *      orphaned (an abrupt kill, e.g. SIGKILL, skips browser_mcp.js's own
 *      cleanup). Closing a Playwright client connection never terminates
 *      the server it's connected to - verified empirically: the server
 *      outlives every client that disconnects, by design, since it's meant
 *      to serve multiple clients over its lifetime. So cleaning up an
 *      orphan means sending a real termination signal to the browser
 *      process's own PID (recorded separately from the owning script's
 *      PID in the connection file), not connecting to it and closing.
 *   2. Otherwise, launch a throwaway headless browser for this call alone.
 *      This is what one-off CLI invocations fall back to when no
 *      MCP-managed browser is running (e.g. running `make screenshots`
 *      outside of an MCP-connected agent). Calling `browser.close()` is
 *      safe either way and needs no branching by the caller: for a
 *      throwaway browser (obtained via `launch()`) it closes the whole
 *      process; for a managed one (obtained via `connect()`) it just ends
 *      this client's own session and leaves the shared server running for
 *      others - verified empirically.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium, firefox, webkit } = require("playwright");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_ENGINE = "chromium";
// Only meaningful for Chromium - passed through unchanged for other engines,
// which have both tolerated it harmlessly in testing.
const LAUNCH_ARGS = ["--disable-gpu", "--hide-scrollbars"];
const ENGINES = { chromium, firefox, webkit };

function resolveEngine(engine) {
  const browserType = ENGINES[engine];
  if (!browserType) {
    throw new Error(
      `Unknown engine: ${engine} (expected one of ${Object.keys(ENGINES).join(", ")})`
    );
  }
  return browserType;
}

// Keyed by REPO_ROOT + engine so each worktree/checkout, and each browser
// engine within it, gets its own file and never picks up another project's
// (or another engine's) browser. Lives outside the repo so `make` targets
// that clear build/ can't delete it out from under a still-running browser.
function connectionFilePath(engine) {
  const key = crypto
    .createHash("sha1")
    .update(`${REPO_ROOT}:${engine}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), `uk-geog-playwright-browser-${key}.json`);
}

function readConnectionFile(engine) {
  try {
    return JSON.parse(fs.readFileSync(connectionFilePath(engine), "utf8"));
  } catch {
    return null;
  }
}

function writeConnectionFile(engine, data) {
  fs.writeFileSync(connectionFilePath(engine), JSON.stringify(data));
}

function removeConnectionFile(engine) {
  try {
    fs.unlinkSync(connectionFilePath(engine));
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

async function getManagedBrowser(engine, browserType) {
  const info = readConnectionFile(engine);
  if (!info || !info.wsEndpoint || !info.ownerPid) return null;

  if (isPidAlive(info.ownerPid)) {
    try {
      return await browserType.connect(info.wsEndpoint, { timeout: 2000 });
    } catch {
      // Owner alive but endpoint unreachable (still starting up, or a stale
      // file from a previous run) - fall back to launching our own.
      return null;
    }
  }

  // Owner is dead - the browser server it launched is orphaned. See the
  // module doc above for why this signals the browser process directly
  // rather than connecting and closing.
  if (info.browserPid && isPidAlive(info.browserPid)) {
    try {
      process.kill(info.browserPid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  removeConnectionFile(engine);
  return null;
}

/**
 * `tabs` pages are always created fresh by the caller after obtaining a
 * browser handle, whether it's a reused managed browser or a throwaway one -
 * see the module doc above for why Playwright can't just hand back tabs
 * another client already created.
 */
async function getBrowser({ engine = DEFAULT_ENGINE, headless = true, args, tabs = 1 } = {}) {
  const browserType = resolveEngine(engine);
  const launchArgs = args ?? (engine === "chromium" ? LAUNCH_ARGS : []);

  const browser =
    (await getManagedBrowser(engine, browserType)) ||
    (await browserType.launch({ headless, args: launchArgs }));

  const pages = [];
  for (let i = 0; i < tabs; i++) {
    pages.push(await browser.newPage());
  }
  return { browser, pages };
}

module.exports = {
  getBrowser,
  LAUNCH_ARGS,
  DEFAULT_ENGINE,
  ENGINES,
  resolveEngine,
  connectionFilePath,
  readConnectionFile,
  writeConnectionFile,
  removeConnectionFile,
  isPidAlive,
};
