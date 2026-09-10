"use strict";

/**
 * Run browser operations against pooled pages.
 *
 * Define an operation where you use it, then run a batch:
 *
 *   const { defineOperation } = require("../browser_ops");
 *
 *   const screenshot = defineOperation(module, {
 *     async run(page, { url, outPath }) {
 *       await page.goto(url);
 *       await page.screenshot({ path: outPath });
 *       return { outPath };
 *     },
 *   });
 *
 *   await screenshot.run([{ url, outPath }]);
 *
 * Work runs on host.js's warm browsers if one is running, otherwise against
 * a browser launched for the call. Two rules either way:
 *
 *   - `item` and whatever `run` returns must survive JSON.stringify.
 *   - Keep script code behind `if (require.main === module)`.
 *
 * See README.md for the full contract and configuration.
 */

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const DEFAULT_CONFIG = {
  launchArgs: { chromium: ["--disable-gpu", "--hide-scrollbars"] },
  // What a fresh page starts as; operations may set their own.
  defaultViewport: { width: 1280, height: 720 },
  defaultEngine: "chromium",
  // Engine names, or {engine, scale, pages}, opened when a host starts.
  // Empty means every browser is launched on first use.
  warm: [],
};

const ENGINE_NAMES = ["chromium", "firefox", "webkit"];
const DEFAULT_SCALE = 1;

// Default `concurrency`, and the default page count for warming.
const DEFAULT_CONCURRENCY = os.cpus().length;

// Give up on the host after this and run locally instead.
const HOST_CONNECT_TIMEOUT_MS = 2000;

// Nearest directory at or above `from` containing a package.json.
function findRoot(from) {
  let dir = path.dirname(from);
  while (true) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(from);
    dir = parent;
  }
}

const ROOT = process.env.BROWSER_OPS_ROOT
  ? path.resolve(process.env.BROWSER_OPS_ROOT)
  : findRoot(__dirname);

// Defaults merged with `browser-ops.config.js` at the root, if present.
let cachedConfig;
function loadConfig() {
  if (cachedConfig) return cachedConfig;
  let overrides = {};
  const configPath = path.join(ROOT, "browser-ops.config.js");
  if (fs.existsSync(configPath)) {
    overrides = require(configPath);
  }
  cachedConfig = {
    ...DEFAULT_CONFIG,
    ...overrides,
    launchArgs: {
      ...DEFAULT_CONFIG.launchArgs,
      ...(overrides.launchArgs || {}),
    },
  };
  return cachedConfig;
}

// Socket the host listens on, one per project root.
function hostSocketPath() {
  const key = crypto.createHash("sha1").update(ROOT).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `browser-ops-${key}.sock`);
}

function assertEngine(engine) {
  if (!ENGINE_NAMES.includes(engine)) {
    throw new Error(
      `Unknown engine: ${engine} (expected one of ${ENGINE_NAMES.join(", ")})`,
    );
  }
  return engine;
}

// Keep this require lazy: callers served by the host never load Playwright.
function browserTypeFor(engine) {
  return require("playwright")[assertEngine(engine)];
}

/* ------------------------------------------------------------------ *
 * Defining and addressing operations
 * ------------------------------------------------------------------ */

// "relative/module.js#name" -> {run}
const REGISTRY = new Map();

// Operations whose cost was timed rather than declared.
const measuredCost = new WeakMap();

const addressKey = ({ module: modulePath, name }) => `${modulePath}#${name}`;

/**
 * Define an operation.
 *
 *   module   pass `module` itself, so the operation knows its own path
 *   run      (page, item) => result
 *   name     for several operations in one module (default: "default")
 *
 * Returns a handle whose `run(items, opts)` executes a batch and returns
 * the results in `items` order.
 */
function defineOperation(module, { name = "default", run }) {
  if (typeof run !== "function") {
    throw new Error(`Operation ${name} needs a run(page, item) function`);
  }
  const address = {
    module: path.relative(ROOT, module.filename),
    name,
  };
  REGISTRY.set(addressKey(address), { run });

  return {
    address,
    run: (items, opts) => runOp(address, items, opts),
  };
}

/**
 * Find the operation an address names, requiring its module if needed.
 * Throws if the module resolves outside the project root.
 */
function lookupOperation(address) {
  const key = addressKey(address);
  const known = REGISTRY.get(key);
  if (known) return known;

  const resolved = path.resolve(ROOT, address.module);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error(
      `Operation module is outside the project root: ${address.module}`,
    );
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Operation module not found: ${address.module}`);
  }
  require(resolved);

  const op = REGISTRY.get(key);
  if (!op) {
    throw new Error(
      `${address.module} doesn't define an operation named "${address.name}"`,
    );
  }
  return op;
}

/* ------------------------------------------------------------------ *
 * Pages, contexts and browsers
 * ------------------------------------------------------------------ */

// Timed page-creation samples per engine, filled in by createPage.
const pageCostSamples = new Map();

function recordPageCost(engine, ms) {
  const samples = pageCostSamples.get(engine) ?? [];
  samples.push(ms);
  pageCostSamples.set(engine, samples);
}

/**
 * Measured cost of one newPage() for `engine`, or null if nothing has been
 * timed yet. The first page of a browser carries one-time warmup (up to 3x
 * on Firefox), so it's only used when it's the sole sample.
 */
function newPageCost(engine) {
  const samples = pageCostSamples.get(engine);
  if (!samples || !samples.length) return null;
  const usable = samples.length > 1 ? samples.slice(1) : samples;
  const sorted = [...usable].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * A page for one batch to use, thrown away afterwards.
 *
 * Each page gets its own context because that is the only way to shed
 * cookies, storage and init scripts, and because deviceScaleFactor is fixed
 * when a context is created. Closing the page means closing its context;
 * callers never handle the context themselves.
 */
async function createPage(browser, engine, scale, viewport) {
  const started = Date.now();
  const context = await browser.newContext({
    deviceScaleFactor: scale,
    viewport,
  });
  const page = await context.newPage();
  recordPageCost(engine, Date.now() - started);
  return page;
}

const discard = (page) =>
  page
    .context()
    .close()
    .catch(() => {});

/**
 * Ready-to-use pages for one (engine, scale), kept topped up to `target` so
 * a batch usually finds enough waiting for it.
 */
class PagePool {
  constructor(browser, engine, scale, viewport, keepReady) {
    this.browser = browser;
    this.engine = engine;
    this.scale = scale;
    this.viewport = viewport;
    // Only a pool that outlives the batch benefits from rebuilding pages.
    this.keepReady = keepReady;
    this.ready = [];
    // What warm() asks for, if anything; otherwise a sensible default.
    this.target = keepReady ? DEFAULT_CONCURRENCY : 0;
    this.refilling = null;
  }

  // `count` pages for a batch. Takes what's ready and builds the rest in
  // parallel, so a batch never waits on a refill that's still running.
  // Leasing doesn't raise `target`: how many pages are kept ready - and so
  // how much memory sits idle - stays whatever `warm` asked for.
  async lease(count) {
    const taken = this.ready.splice(0, count);
    const shortfall = count - taken.length;
    if (shortfall > 0) {
      taken.push(
        ...(await Promise.all(
          Array.from({ length: shortfall }, () =>
            createPage(this.browser, this.engine, this.scale, this.viewport),
          ),
        )),
      );
    }
    return taken;
  }

  // Give back a batch's pages: discard them, then rebuild up to `target` in
  // the background so the next batch finds them ready.
  release(pages) {
    for (const page of pages) discard(page);
    if (this.keepReady) this.refill();
  }

  refill() {
    if (this.refilling) return this.refilling;
    const wanted = this.target - this.ready.length;
    if (wanted <= 0) return Promise.resolve();
    this.refilling = Promise.all(
      Array.from({ length: wanted }, () =>
        createPage(this.browser, this.engine, this.scale, this.viewport)
          .then((page) => this.ready.push(page))
          .catch((err) =>
            process.emitWarning(
              `browser_ops: page refill failed (${err.message})`,
            ),
          ),
      ),
    ).finally(() => {
      this.refilling = null;
    });
    return this.refilling;
  }

  // Keep exactly `count` pages ready from now on. Set by warm(), so asking
  // for fewer than the default really does hold fewer.
  async ensureReady(count) {
    this.target = count;
    await Promise.all(this.ready.splice(count).map(discard));
    await this.refill();
  }

  async close() {
    await Promise.all(this.ready.splice(0).map(discard));
  }
}

/**
 * Pages to lease for `itemCount` items, capped at `concurrency`.
 * Throwaway pools take `sqrt(itemCount * costMs / newPageCost)` once both
 * costs are known; everything else takes the cap.
 */
function pickPageCount({
  itemCount,
  concurrency,
  engine,
  costMs,
  reusable = false,
}) {
  if (itemCount <= 1) return 1;
  const openCost = newPageCost(engine);
  if (reusable || costMs == null || openCost == null) {
    return Math.max(1, Math.min(concurrency, itemCount));
  }
  const optimal = Math.round(Math.sqrt((itemCount * costMs) / openCost));
  return Math.max(1, Math.min(concurrency, optimal));
}

/**
 * Owns browsers and their page pools, and runs operations against them.
 * One browser per engine, one page pool per (engine, scale factor).
 *
 * `persistent` keeps pages ready between batches - true on the host, false
 * for a one-shot local call.
 */
class BrowserPool {
  constructor({ persistent = false } = {}) {
    this.persistent = persistent;
    // Both maps hold the promise of the thing, so concurrent callers share
    // one launch rather than starting duplicates.
    this.browsers = new Map(); // engine -> Promise<Browser>
    this.pools = new Map(); // `${engine}:${scale}` -> Promise<PagePool>
  }

  // Drop a browser and every pool built on it, so the next call starts
  // fresh. `pending` guards against evicting a newer replacement.
  forget(engine, pending) {
    if (this.browsers.get(engine) === pending) this.browsers.delete(engine);
    for (const key of [...this.pools.keys()]) {
      if (key.startsWith(`${engine}:`)) this.pools.delete(key);
    }
  }

  browserFor(engine) {
    let pending = this.browsers.get(engine);
    if (!pending) {
      pending = browserTypeFor(engine)
        .launch({
          headless: true,
          args: loadConfig().launchArgs[engine] ?? [],
        })
        .then((browser) => {
          browser.on("disconnected", () => this.forget(engine, pending));
          return browser;
        })
        .catch((err) => {
          this.browsers.delete(engine);
          throw err;
        });
      this.browsers.set(engine, pending);
    }
    return pending;
  }

  pagePoolFor(engine, scale) {
    const key = `${engine}:${scale}`;
    let pending = this.pools.get(key);
    if (!pending) {
      pending = this.browserFor(engine)
        .then(
          (browser) =>
            new PagePool(
              browser,
              engine,
              scale,
              loadConfig().defaultViewport,
              this.persistent,
            ),
        )
        .catch((err) => {
          this.pools.delete(key);
          throw err;
        });
      this.pools.set(key, pending);
    }
    return pending;
  }

  /**
   * Open browsers and pages before any request arrives.
   *
   * `targets` are engine names, or `{engine, scale, pages}` to override the
   * defaults (scale 1, DEFAULT_CONCURRENCY pages). Failures are reported to
   * `onWarm({engine, scale, pages, ms, ok, error})`, never thrown.
   */
  async warm(targets = [], { onWarm } = {}) {
    await Promise.all(
      targets.map(async (target) => {
        const started = Date.now();
        let engine, scale, pages;
        try {
          ({
            engine,
            scale = DEFAULT_SCALE,
            pages = DEFAULT_CONCURRENCY,
          } = typeof target === "string" ? { engine: target } : (target ?? {}));
          assertEngine(engine);
          const pool = await this.pagePoolFor(engine, scale);
          await pool.ensureReady(pages);
          if (onWarm) {
            onWarm({
              engine,
              scale,
              pages,
              ms: Date.now() - started,
              ok: true,
            });
          }
        } catch (err) {
          if (onWarm) {
            onWarm({ engine, scale, pages, ok: false, error: err.message });
          }
        }
      }),
    );
  }

  /**
   * Run the operation at `address` over every item, in `items` order.
   * An item's own `scale` overrides the batch's, so one batch may mix them.
   *
   * Each worker keeps one page for the whole batch, so items running on it
   * follow one another without being isolated from each other. Isolation is
   * between batches: every page is discarded when its batch finishes.
   */
  async run(
    address,
    items,
    {
      engine = loadConfig().defaultEngine,
      concurrency = DEFAULT_CONCURRENCY,
      scale: batchScale = DEFAULT_SCALE,
      onResult,
    } = {},
  ) {
    const op = lookupOperation(address);
    assertEngine(engine);

    const scaleOf = (item) => item.scale ?? batchScale;
    const results = new Array(items.length);
    let firstJob = 0;

    // Sizing a throwaway pool needs to know what one run costs: time the
    // first item, and reuse that for later batches in this process.
    let costMs = measuredCost.get(op);
    if (!this.persistent && costMs == null && items.length > 1) {
      const pool = await this.pagePoolFor(engine, scaleOf(items[0]));
      const [page] = await pool.lease(1);
      const started = Date.now();
      try {
        results[0] = await op.run(page, items[0]);
        costMs = Math.max(1, Date.now() - started);
      } finally {
        pool.release([page]);
      }
      measuredCost.set(op, costMs);
      firstJob = 1;
      if (onResult) onResult(results[0], items[0], 0);
    }

    // One queue of item indices per scale factor: a page's scale is fixed
    // when it's created, so it can only work items that share it.
    const queues = new Map();
    for (let i = firstJob; i < items.length; i++) {
      const scale = scaleOf(items[i]);
      if (!queues.has(scale)) queues.set(scale, []);
      queues.get(scale).push(i);
    }

    const leased = new Map(); // scale -> {pool, pages}
    for (const [scale, queue] of queues) {
      const pool = await this.pagePoolFor(engine, scale);
      const pages = await pool.lease(
        pickPageCount({
          itemCount: queue.length,
          concurrency,
          engine,
          costMs,
          reusable: this.persistent,
        }),
      );
      leased.set(scale, { pool, pages });
    }

    try {
      // Each worker keeps one page for the whole batch and pulls from its
      // scale's queue. The first failure stops the rest.
      let failure = null;
      const worker = async (scale, page) => {
        const queue = queues.get(scale);
        while (!failure) {
          const index = queue.shift();
          if (index === undefined) return;
          try {
            results[index] = await op.run(page, items[index]);
          } catch (err) {
            failure ??= err;
            throw err;
          }
          if (onResult) onResult(results[index], items[index], index);
        }
      };

      const workers = [];
      for (const [scale, { pages }] of leased) {
        for (const page of pages) workers.push(worker(scale, page));
      }
      await Promise.all(workers);
      return results;
    } finally {
      for (const { pool, pages } of leased.values()) pool.release(pages);
    }
  }

  async close() {
    for (const pending of this.pools.values()) {
      try {
        await (await pending).close();
      } catch {
        // Never built, or already gone.
      }
    }
    this.pools.clear();
    for (const pending of this.browsers.values()) {
      try {
        await (await pending).close();
      } catch {
        // Never launched, or already gone.
      }
    }
    this.browsers.clear();
  }
}

function requestFromHost(address, items, opts) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(hostSocketPath());
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };

    const timer = setTimeout(
      () => finish(resolve, null),
      HOST_CONNECT_TIMEOUT_MS,
    );

    socket.on("error", () => finish(resolve, null));

    socket.on("connect", () => {
      // Only the connect is deadlined; the work itself may take a while.
      clearTimeout(timer);
      socket.write(`${JSON.stringify({ address, items, opts })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let message;
      try {
        message = JSON.parse(buffer.slice(0, newline));
      } catch {
        return finish(reject, new Error("Malformed reply from browser host"));
      }
      if (message.ok) return finish(resolve, message.results);
      const err = new Error(message.error);
      if (message.stack) err.stack = message.stack;
      finish(reject, err);
    });

    socket.on("close", () => finish(resolve, null));
  });
}

/**
 * Run the operation at `address` over `items`. Callers reach this through
 * the handle `defineOperation` returns.
 *
 * Options: `engine`, `concurrency`, `scale`, `onResult(result, item, i)`.
 * `onResult` fires per item locally, once per result via the host.
 */
async function runOp(address, items, opts = {}) {
  const { onResult, ...transportable } = opts;

  if (items.length) {
    const hosted = await requestFromHost(address, items, transportable);
    if (hosted) {
      if (onResult) hosted.forEach((r, i) => onResult(r, items[i], i));
      return hosted;
    }
  }

  const pool = new BrowserPool();
  try {
    return await pool.run(address, items, opts);
  } finally {
    await pool.close();
  }
}

module.exports = {
  defineOperation,
  loadConfig,
  DEFAULT_CONCURRENCY,
  // For host.js and the process that runs it.
  BrowserPool,
  hostSocketPath,
  ROOT,
};
