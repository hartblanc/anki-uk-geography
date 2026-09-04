"use strict";

/**
 * Playwright browser lifecycle, decoupled from anything that renders with it.
 *
 * ASSUMES CALLERS DON'T RUN CONCURRENTLY against a managed Chromium (see
 * launchManagedChromium() and getBrowser() below) - two capture_screenshots.js
 * / render_screenshot.js invocations running at the same time could grab and
 * navigate the same pre-existing page, corrupting each other's screenshot.
 * This repo's actual usage (one agent, one shell command at a time) doesn't
 * hit that; if it ever might, don't use the CDP/shared-page path.
 *
 * Resolution order for `getBrowser()`:
 *   1. A connection file written by browser_mcp.js (see there), which
 *      launches its own browser server at startup and exposes it this way
 *      so one-off callers (capture_screenshots.js, render_screenshot.js)
 *      can discover and reuse the already-running process instead of
 *      paying to launch their own.
 *
 *      For Chromium specifically, browser_mcp.js also exposes a real CDP
 *      endpoint (via --remote-debugging-port) and pre-creates a pool of
 *      pages up front, connected here with connectOverCDP() instead of
 *      Playwright's own connect(). Unlike Playwright's own protocol - where
 *      each connect() gets an entirely private, empty set of contexts/pages
 *      (verified empirically: a second connect() to the same
 *      launchServer() sees zero contexts even after a first client created
 *      some) - a CDP connection sees the SAME browser state as every other
 *      client, including pages nobody currently connected created.
 *
 *      That's true only for pages living in the browser's *default*
 *      context - the one that already exists the moment you connect, not
 *      one created via `browser.newContext()`. Verified empirically: pages
 *      in an explicitly-created context are torn down the moment the
 *      client that created them disconnects (even though the context
 *      itself survives), while pages in the pre-existing default context
 *      persist regardless of who created them or when that client
 *      disconnects. launchManagedChromium() relies on exactly this to
 *      pre-create a pool of pages once, at startup, that later callers can
 *      reuse with ~zero creation cost - not just a warm connection, an
 *      actual pre-existing page (measured: connect() + grab an existing
 *      page + navigate + screenshot came to ~48ms total, vs. ~85-90ms to
 *      connect and create a fresh page even in an already-warm context,
 *      vs. ~200ms+ for WebKit/Firefox's cold connect()+newPage() - see
 *      commit history for the full benchmarks this is based on).
 *
 *      WebKit and Firefox don't speak CDP, so they keep using connect()
 *      with fully private pages, created fresh every time - see
 *      render_screenshot.js's pickTabCount() for how that cost is priced
 *      into how many of them get created for a given batch.
 *
 *      Liveness: connectOverCDP()/connect(), wrapped in a timeout, doubles
 *      as the check - Playwright's own server exposes no separate HTTP
 *      probe endpoint the way CDP's /json/version does (though it's used
 *      internally by launchManagedChromium(), to find the port a throwaway
 *      free-port bind chose).
 *
 *      If the owning PID is dead, the browser server it launched may be
 *      orphaned (an abrupt kill, e.g. SIGKILL, skips browser_mcp.js's own
 *      cleanup). Closing a client connection (either style) never
 *      terminates the server it's connected to - verified empirically: the
 *      server outlives every client that disconnects, by design, since
 *      it's meant to serve multiple clients over its lifetime. So cleaning
 *      up an orphan means sending a real termination signal to the browser
 *      process's own PID (recorded separately from the owning script's
 *      PID in the connection file), not connecting to it and closing.
 *   2. Otherwise, launch a throwaway headless browser for this call alone.
 *      This is what one-off CLI invocations fall back to when no
 *      MCP-managed browser is running (e.g. running `make screenshots`
 *      outside of an MCP-connected agent). Calling `browser.close()` is
 *      safe either way and needs no branching by the caller: for a
 *      throwaway browser (obtained via `launch()`) it closes the whole
 *      process; for a managed one (obtained via `connect()`/
 *      `connectOverCDP()`) it just ends this client's own session and
 *      leaves the shared server running for others - verified empirically.
 */

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
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

/**
 * Bind port 0 (OS picks a free one) just long enough to read back which
 * port it chose, then release it immediately for Chromium to bind instead.
 * Needed because Playwright neither forwards a launched browser's own
 * stdout/stderr (where `--remote-debugging-port=0` normally prints its
 * chosen port) nor allows an explicit --user-data-dir (where Chromium
 * would otherwise write it to a DevToolsActivePort file) - both checked
 * empirically. This has the usual tiny bind-race window of any
 * find-then-reuse free port strategy; acceptable here since it's a single
 * local process on a single machine, not a public service.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Used only by browser_mcp.js for its managed Chromium: launches with a
 * real CDP endpoint exposed and pre-creates `tabs` pages in the browser's
 * default context, up front - see the module doc above for why that
 * specific context (not one made via newContext()) is what lets those
 * pages survive for later callers to reuse at ~zero cost, and for the
 * no-concurrent-callers assumption this whole path relies on. Returns the
 * BrowserServer (for its .process() PID and eventual .close()) and the CDP
 * URL to record in the connection file.
 */
async function launchManagedChromium({ headless = true, tabs = 4 } = {}) {
  const port = await findFreePort();
  const server = await chromium.launchServer({
    headless,
    args: [...LAUNCH_ARGS, `--remote-debugging-port=${port}`],
  });
  const cdpUrl = `http://127.0.0.1:${port}`;

  const setup = await chromium.connectOverCDP(cdpUrl);
  const defaultCtx = setup.contexts()[0] ?? (await setup.newContext());
  for (let i = 0; i < tabs; i++) {
    await defaultCtx.newPage();
  }
  await setup.close(); // Disconnects only - the pages persist on the server.

  return { server, cdpUrl };
}

async function getManagedBrowser(engine, browserType) {
  const info = readConnectionFile(engine);
  if (!info || !info.ownerPid || !(info.cdpUrl || info.wsEndpoint)) return null;

  if (isPidAlive(info.ownerPid)) {
    try {
      if (info.cdpUrl) {
        const browser = await browserType.connectOverCDP(info.cdpUrl, { timeout: 2000 });
        return { browser, sharedPages: true };
      }
      const browser = await browserType.connect(info.wsEndpoint, { timeout: 2000 });
      return { browser, sharedPages: false };
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
 * Get `tabs` pages to render with. For a CDP-managed Chromium, reuses
 * pre-existing pages from the pool launchManagedChromium() created (see
 * module doc above - and its no-concurrent-callers assumption) rather than
 * creating fresh ones, topping up only if the pool turns out smaller than
 * `tabs` needs (those extras land in the same default context, so they
 * join the persistent, reusable pool too). Every other case - Playwright's
 * own connect() for WebKit/Firefox, or a throwaway launch() - always
 * creates `tabs` fresh private pages, since there's nothing shared to reuse.
 */
async function getBrowser({ engine = DEFAULT_ENGINE, headless = true, args, tabs = 1 } = {}) {
  const browserType = resolveEngine(engine);
  const launchArgs = args ?? (engine === "chromium" ? LAUNCH_ARGS : []);

  const managed = await getManagedBrowser(engine, browserType);
  if (managed) {
    const { browser, sharedPages } = managed;
    if (sharedPages) {
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const pages = ctx.pages();
      while (pages.length < tabs) {
        pages.push(await ctx.newPage());
      }
      return { browser, pages: pages.slice(0, tabs) };
    }
    const pages = [];
    for (let i = 0; i < tabs; i++) pages.push(await browser.newPage());
    return { browser, pages };
  }

  const browser = await browserType.launch({ headless, args: launchArgs });
  const pages = [];
  for (let i = 0; i < tabs; i++) {
    pages.push(await browser.newPage());
  }
  return { browser, pages };
}

module.exports = {
  getBrowser,
  launchManagedChromium,
  findFreePort,
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
