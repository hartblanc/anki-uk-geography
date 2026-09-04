"use strict";

/**
 * Playwright browser page pool: runs a batch of tasks against a pool of pages sized
 * to fit the work, plus (for the shared, cross-process case) the machinery
 * to stand up and discover that pool in the first place.
 *
 * runMany(items, task, {concurrency, engine, taskCostMs}) is the entry
 * point most callers need: runs `task(page, item, index)` for every item in
 * `items`, against a pool of pages, obtaining a browser and closing it
 * entirely within the call - callers never see a browser directly. Knows
 * nothing about what a task actually does or how expensive it is, so
 * there's no built-in default cost: every caller must measure and pass its
 * own `taskCostMs`.
 *
 * createPagePool({engine, cdpPoolSize}) starts a shared browser server that
 * runMany() calls made by OTHER processes can discover and draw pages from,
 * instead of each one paying to launch its own. Pass `cdpPoolSize` to also
 * pre-create that many pages up front, over a real CDP endpoint (Chromium
 * only) - those calls then reuse the pages directly at near-zero cost
 * instead of creating fresh ones every time. Only one process should draw
 * from a given engine's shared pool at a time: concurrent callers against a
 * CDP page pool could grab and navigate the same page, corrupting each
 * other's work.
 *
 * Supports the `chromium`, `firefox`, and `webkit` engines (DEFAULT_ENGINE:
 * chromium).
 */

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { chromium, firefox, webkit } = require("playwright");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_ENGINE = "chromium";
// Disables GPU compositing and OS scrollbar overlays, which otherwise leak
// into screenshots. Chromium-only.
const LAUNCH_ARGS = ["--disable-gpu", "--hide-scrollbars"];
const ENGINES = { chromium, firefox, webkit };

// How long browser.newPage() takes against an already-running browser, per
// engine, in milliseconds (steady-state - not the browser's very first
// connection, which pays extra one-time warmup cost). Chromium is cheap
// enough to be worth parallelizing almost immediately; WebKit/Firefox cost
// 4-5x as much, so a small batch is better off staying on fewer pages.
const NEW_PAGE_COST_MS = { chromium: 40, firefox: 230, webkit: 200 };

// Look up the Playwright browser type for `engine`, throwing for anything
// not in ENGINES above.
function resolveEngine(engine) {
  const browserType = ENGINES[engine];
  if (!browserType) {
    throw new Error(
      `Unknown engine: ${engine} (expected one of ${Object.keys(ENGINES).join(", ")})`,
    );
  }
  return browserType;
}

// Launch args for `engine`: LAUNCH_ARGS for Chromium, none for anything else.
function launchArgsFor(engine) {
  return engine === "chromium" ? LAUNCH_ARGS : [];
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
 * Start a browser server that other processes' runMany() calls can
 * discover and draw pages from via getBrowser() below, and write the
 * connection file describing it. Returns `{endpoint, cdpPool, close}`:
 *   - `endpoint`: the URL the server is reachable on.
 *   - `cdpPool`: whether a CDP page pool was created (see below).
 *   - `close()`: shuts the server down and removes the connection file.
 *     Always call this before the calling process exits.
 *
 * Plain case (`cdpPoolSize` omitted): a plain launchServer() for `engine`,
 * exposing its own wsEndpoint.
 *
 * cdpPoolSize case (Chromium only - throws for any other engine, since
 * WebKit/Firefox don't speak CDP): exposes a real CDP endpoint instead (via
 * --remote-debugging-port) and pre-creates `cdpPoolSize` pages up front, so
 * later runMany() calls can reuse them directly at near-zero cost instead
 * of creating fresh ones.
 */
async function createPagePool({ engine = DEFAULT_ENGINE, cdpPoolSize } = {}) {
  const cdpPool = cdpPoolSize != null;
  if (cdpPool && engine !== "chromium") {
    throw new Error(
      `cdpPoolSize is Chromium only (got engine ${engine}) - WebKit/Firefox don't speak CDP.`,
    );
  }

  let server, cdpUrl, wsEndpoint;
  if (cdpPool) {
    const port = await findFreePort();
    server = await chromium.launchServer({
      headless: true,
      args: [...LAUNCH_ARGS, `--remote-debugging-port=${port}`],
    });
    cdpUrl = `http://127.0.0.1:${port}`;

    const setup = await chromium.connectOverCDP(cdpUrl);
    // The default context (the one that already exists at connect time, not
    // one made via newContext()) is the only one whose pages outlive this
    // client's disconnect - that's what lets getBrowser() callers reuse them
    // later.
    const defaultCtx = setup.contexts()[0] ?? (await setup.newContext());
    for (let i = 0; i < cdpPoolSize; i++) {
      await defaultCtx.newPage();
    }
    await setup.close(); // Disconnects only - the pages persist on the server.
  } else {
    const browserType = resolveEngine(engine);
    server = await browserType.launchServer({
      headless: true,
      args: launchArgsFor(engine),
    });
    wsEndpoint = server.wsEndpoint();
  }

  writeConnectionFile(engine, {
    ownerPid: process.pid,
    browserPid: server.process().pid,
    engine,
    ...(cdpUrl ? { cdpUrl } : { wsEndpoint }),
  });

  const close = async () => {
    removeConnectionFile(engine);
    try {
      await server.close();
    } catch {
      // Already gone.
    }
  };

  return { endpoint: cdpUrl ?? wsEndpoint, cdpPool: !!cdpUrl, close };
}

/**
 * Try to connect to the browser server described by `engine`'s connection
 * file, if there's a live one. Returns `{browser, sharedPages}` on success
 * (`sharedPages` true if it's a CDP page pool - see createPagePool()
 * above), or null if there's no connection file, its endpoint didn't
 * respond, or its owning process has exited (in which case this also
 * terminates the now-orphaned browser process and removes the stale file).
 * Callers should fall back to launching their own browser on null.
 */
async function connectManagedBrowser(engine, browserType) {
  const info = readConnectionFile(engine);
  if (!info || !info.ownerPid || !(info.cdpUrl || info.wsEndpoint)) return null;

  if (isPidAlive(info.ownerPid)) {
    try {
      if (info.cdpUrl) {
        const browser = await browserType.connectOverCDP(info.cdpUrl, {
          timeout: 2000,
        });
        return { browser, sharedPages: true };
      }
      const browser = await browserType.connect(info.wsEndpoint, {
        timeout: 2000,
      });
      return { browser, sharedPages: false };
    } catch {
      // Owner alive but endpoint unreachable (still starting up, or a stale
      // file from a previous run) - fall back to launching our own.
      return null;
    }
  }

  // Owner is dead - the browser server it launched may be orphaned (a hard
  // kill skips its own cleanup). Closing a client connection never shuts
  // down a shared server (see getBrowser() below), so terminate it directly.
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
 * Get `pageCount` ready-to-use pages plus the browser they belong to.
 * Reuses an already-running browser server for `engine` if its connection
 * file points to a live one, otherwise launches a private, throwaway
 * browser for this call alone.
 *
 * If the shared server has a CDP page pool, reuses its pre-created pages
 * directly (creating more only if `pageCount` exceeds what's available)
 * instead of paying to create fresh ones. Every other case - a plain shared
 * connection, or a throwaway launch - always creates `pageCount` fresh
 * pages.
 *
 * Always call `browser.close()` when done, regardless of which path was
 * taken: for a throwaway browser this shuts down the whole process; for a
 * shared one it just ends this connection, leaving the server running for
 * the next caller.
 */
async function getBrowser({ engine = DEFAULT_ENGINE, pageCount = 1 } = {}) {
  const browserType = resolveEngine(engine);

  const managed = await connectManagedBrowser(engine, browserType);
  if (managed) {
    const { browser, sharedPages } = managed;
    if (sharedPages) {
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const pages = ctx.pages();
      while (pages.length < pageCount) {
        pages.push(await ctx.newPage());
      }
      return { browser, pages: pages.slice(0, pageCount) };
    }
    const pages = [];
    for (let i = 0; i < pageCount; i++) pages.push(await browser.newPage());
    return { browser, pages };
  }

  const browser = await browserType.launch({
    headless: true,
    args: launchArgsFor(engine),
  });
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    pages.push(await browser.newPage());
  }
  return { browser, pages };
}

/**
 * Pick how many pages to open for a batch of `itemCount` tasks, capped at
 * `concurrency`. Opening P pages (created one at a time, then worked in
 * parallel) costs roughly `P * newPageCost + (itemCount / P) * taskCostMs`
 * wall-clock time; this picks the P that minimizes it:
 * `P = sqrt(itemCount * taskCostMs / newPageCost)`. Below that, an extra
 * page's own creation cost outweighs the time it would save.
 *
 * `taskCostMs` is required: how expensive a single `task` call is depends
 * entirely on the caller's own callback, and there's no safe way to guess
 * it here. Pass the measured cost, in milliseconds, of running your task
 * once against an already-running browser (not the first call, which pays
 * extra one-time warmup cost).
 *
 * `concurrency` is a hard cap independent of the formula above - it's meant
 * to reflect this machine's actual parallelism, which the cost formula has
 * no way to know about on its own. `os.cpus().length` is a reasonable
 * default; pass a lower number to limit parallelism further.
 */
function pickPageCount(itemCount, concurrency, engine, taskCostMs) {
  if (typeof taskCostMs !== "number" || !(taskCostMs > 0)) {
    throw new Error(
      "pickPageCount requires a positive taskCostMs - there's no default, " +
        "since there's no way to know what your task actually costs (see " +
        "this function's doc comment)",
    );
  }
  if (itemCount <= 1) return 1;
  const openCost = NEW_PAGE_COST_MS[engine] ?? NEW_PAGE_COST_MS[DEFAULT_ENGINE];
  const optimal = Math.round(Math.sqrt((itemCount * taskCostMs) / openCost));
  return Math.max(1, Math.min(concurrency, optimal));
}

/**
 * Simple promise-based pool of Playwright pages. Each task takes one page for
 * its duration and returns it afterwards, so concurrent calls and batch
 * runs are spread over all open pages. Purely an implementation detail of
 * runMany() below - not exported.
 */
class PagePool {
  constructor(pages) {
    this.free = pages.slice();
    this.total = this.free.length;
    this.waiters = [];
  }

  async acquire() {
    const page = this.free.shift();
    if (page) return page;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(page) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(page);
    else this.free.push(page);
  }
}

/**
 * Run `task(page, item)` for each item across a page pool, preserving input
 * order in the returned results array.
 */
async function runWithPool(pool, items, task) {
  const results = new Array(items.length);
  let nextJob = 0;

  async function worker() {
    while (true) {
      const index = nextJob++;
      if (index >= items.length) return;
      const page = await pool.acquire();
      try {
        results[index] = await task(page, items[index], index);
      } finally {
        pool.release(page);
      }
    }
  }

  const workerCount = Math.min(pool.total, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Run `task(page, item, index)` for every item in `items`, spread across a
 * pool of Playwright pages sized for the batch (see pickPageCount() above).
 * The caller never deals with a browser or a page pool directly - one is
 * obtained, used, and closed entirely within this call.
 *
 * `index` is each item's position in `items`, stable and unique across the
 * whole batch regardless of concurrency - useful as a per-item scratch key.
 * Results are returned in `items` order, not completion order.
 *
 * `taskCostMs` is required (see pickPageCount() above for why and how to
 * measure it); `concurrency` defaults to this machine's CPU core count and
 * `engine` to DEFAULT_ENGINE.
 */
async function runMany(
  items,
  task,
  { concurrency = os.cpus().length, engine = DEFAULT_ENGINE, taskCostMs } = {},
) {
  const pageCount = pickPageCount(
    items.length,
    concurrency,
    engine,
    taskCostMs,
  );
  const { browser, pages } = await getBrowser({ engine, pageCount });
  try {
    const pool = new PagePool(pages);
    return await runWithPool(pool, items, task);
  } finally {
    await browser.close();
  }
}

module.exports = { runMany, createPagePool };
