#!/usr/bin/env node
"use strict";

/**
 * MCP server for UK Geography card screenshots.
 *
 * Speaks the Model Context Protocol over stdio (JSON-RPC 2.0) so MCP clients
 * such as Deep Code, Claude, or Cursor can render card screenshots directly.
 *
 * On startup this process launches its own warm headless Chromium with a
 * small pool of open tabs (default 4, like capture_screenshots.js), and
 * writes a connection file (see browser_connection.js) exposing its CDP
 * endpoint so one-off callers - capture_screenshots.js, render_screenshot.js
 * - can discover and reuse this same browser instead of launching their own.
 * Because an MCP host (Claude Code, Cursor, etc.) spawns this process over
 * stdio and holds its stdin open for the life of the session, stdin closing
 * (rl.on("close")) is a real, OS-level "the session ended" signal - not a
 * heuristic - so the browser and its connection file are always cleaned up
 * exactly when the owning session goes away, including most crashes.
 *
 * Each `render_screenshot` call reads deck.json fresh from disk, builds the
 * card HTML, and renders it immediately on the next free tab. This means
 * screenshots always reflect the latest build without any manual lifecycle
 * management, and concurrent/batch requests are spread across the tabs
 * instead of being serialised. Each render is also written to
 * build/screenshots/mcp/ (or --out DIR) as a PNG so it can be opened
 * directly from disk.
 *
 * `render_screenshots` is the batch equivalent of `capture_screenshots.js`: it
 * can render every card type, or a selected list of templates, on either side,
 * with optional dark mode and per-template note samples.
 *
 * Usage:
 *   node utils/uk_geog/screenshot_mcp.js [--deck PATH] [--out DIR] [--concurrency N]
 *
 * Configure in .mcp.json (Claude Code) or .deepcode/settings.json (Deep Code):
 *   {
 *     "mcpServers": {
 *       "uk-geography-screenshots": {
 *         "command": "node",
 *         "args": ["utils/uk_geog/screenshot_mcp.js"]
 *       }
 *     }
 *   }
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const puppeteer = require("puppeteer");

const {
  REPO_ROOT,
  DEFAULT_DECK,
  VIEWPORT,
  loadDeck,
  writeCardHtml,
  cardPngPath,
  expandRenderRequests,
} = require("./screenshot_common.js");
const { LAUNCH_ARGS, getFreePort, writeConnectionFile, removeConnectionFile } = require("./browser_connection.js");
const { renderToFile, PagePool, runWithPool } = require("./render_screenshot.js");

const DEFAULT_MCP_OUT = path.join(REPO_ROOT, "build", "screenshots", "mcp");

const USAGE = `Usage: screenshot_mcp.js [options]

Options:
  --deck PATH        CrowdAnki deck.json (default: built deck)
  --out DIR          Output directory for PNGs (default: build/screenshots/mcp)
  --concurrency N    Number of parallel browser tabs (default: 4)
  --help             Show this help
`;

function parseArgs(argv) {
  const args = {
    deck: DEFAULT_DECK,
    out: DEFAULT_MCP_OUT,
    concurrency: 4,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--deck":
        args.deck = argv[++i];
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--concurrency":
        args.concurrency = parseInt(argv[++i], 10);
        if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
          console.error("--concurrency must be a positive integer");
          process.exit(2);
        }
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        console.error(USAGE);
        process.exit(2);
    }
  }
  return args;
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendError(id, code, message) {
  send({
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: { code, message },
  });
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const htmlDir = path.join(REPO_ROOT, "build", "screenshots", "mcp-html");
  const pngDir = path.resolve(args.out);
  fs.mkdirSync(htmlDir, { recursive: true });
  fs.mkdirSync(pngDir, { recursive: true });

  // Launch the warm browser at startup with a pool of tabs, matching the
  // parallel page pool in capture_screenshots.js, and announce it via the
  // connection file so other callers can discover and reuse it.
  const port = await getFreePort();
  const browser = await puppeteer.launch({
    headless: true,
    args: [...LAUNCH_ARGS, `--remote-debugging-port=${port}`],
  });
  const browserURL = `http://127.0.0.1:${port}`;
  writeConnectionFile({ pid: process.pid, port, url: browserURL });
  console.error(`Launched headless Chromium on ${browserURL} (${args.concurrency} tabs)...`);
  const pages = [];
  for (let i = 0; i < args.concurrency; i++) {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page._poolIndex = i;
    pages.push(page);
  }
  const pagePool = new PagePool(pages);

  async function renderOne(argsObj) {
    const page = await pagePool.acquire();
    try {
      const html = writeCardHtml({
        deckPath: args.deck,
        htmlDir,
        template: argsObj.template,
        side: argsObj.side,
        dark: argsObj.dark,
        samples: argsObj.samples,
        scratchKey: page._poolIndex,
      });
      const pngPath = cardPngPath({
        outDir: pngDir,
        template: argsObj.template,
        side: html.side,
        dark: html.dark,
        filename: argsObj.filename,
      });
      const { png } = await renderToFile(page, { url: html.url, outPath: pngPath });
      return { png, pngPath };
    } finally {
      pagePool.release(page);
    }
  }

  async function renderBatch(argsObj) {
    // Read the deck once here so we can support "all templates" as the default;
    // writeCardHtml still reads it fresh for each screenshot, matching the
    // existing guarantee that renders reflect the latest build on disk.
    const { templatesByName } = loadDeck(args.deck);
    const allTemplateNames = Object.keys(templatesByName);

    const requests = expandRenderRequests({
      allTemplateNames,
      templates: argsObj.templates,
      sides: argsObj.sides,
      dark: argsObj.dark,
      samples: argsObj.samples,
      requests: argsObj.requests,
    });

    const results = await runWithPool(pagePool, requests, async (page, req) => {
      try {
        const html = writeCardHtml({
          deckPath: args.deck,
          htmlDir,
          template: req.template,
          side: req.side,
          dark: req.dark,
          samples: req.samples,
          scratchKey: page._poolIndex,
        });
        const pngPath = cardPngPath({
          outDir: pngDir,
          template: req.template,
          side: html.side,
          dark: html.dark,
          filename: req.filename,
        });
        await renderToFile(page, { url: html.url, outPath: pngPath });
        return {
          ok: true,
          template: req.template,
          side: req.side,
          dark: req.dark,
          path: pngPath,
        };
      } catch (err) {
        return {
          ok: false,
          template: req.template,
          side: req.side,
          dark: req.dark,
          error: err.message || String(err),
        };
      }
    });

    return {
      count: results.length,
      rendered: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    };
  }

  const TOOLS = [
    {
      name: "render_screenshot",
      description:
        "Render a UK Geography card as a PNG screenshot. Returns the image " +
        "plus a short text summary.",
      inputSchema: {
        type: "object",
        properties: {
          template: {
            type: "string",
            description:
              "Card template name, e.g. City - Map, City - County, BoW - Map",
          },
          side: {
            type: "string",
            enum: ["front", "back"],
            description: "Which side of the card to render (default: front)",
          },
          dark: {
            type: "boolean",
            description: "Render in dark mode (default: false)",
          },
          samples: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional note selectors: FIELD=VALUE or TEMPLATE:FIELD=VALUE, e.g. City=Gloucester",
          },
          filename: {
            type: "string",
            description:
              "Optional output filename for the saved PNG (defaults to <template>-<side>[-dark].png, e.g. city-map-front.png)",
          },
        },
        required: ["template"],
      },
    },
    {
      name: "render_screenshots",
      description:
        "Render a batch of card screenshots, like capture_screenshots.js. " +
        "By default renders front and back for every card type; pass templates " +
        "and/or sides to restrict it, dark for night mode, and samples to choose " +
        "specific notes. Alternatively pass explicit requests for full control.",
      inputSchema: {
        type: "object",
        properties: {
          templates: {
            type: "array",
            items: { type: "string" },
            description:
              "Card template names to render, e.g. [\"City - Map\", \"Map - City\"]. Defaults to all card types.",
          },
          sides: {
            type: "array",
            items: { type: "string", enum: ["front", "back"] },
            description:
              "Which sides to render per template. Defaults to [\"front\", \"back\"].",
          },
          dark: {
            type: "boolean",
            description: "Render in dark mode (default: false)",
          },
          samples: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional note selectors: FIELD=VALUE or TEMPLATE:FIELD=VALUE, e.g. City=Gloucester or City - Map:City=Gloucester",
          },
          requests: {
            type: "array",
            items: {
              type: "object",
              properties: {
                template: {
                  type: "string",
                  description: "Card template name, e.g. City - Map",
                },
                side: {
                  type: "string",
                  enum: ["front", "back"],
                  description: "Which side to render (default: front)",
                },
                dark: {
                  type: "boolean",
                  description: "Render in dark mode (default: false)",
                },
                samples: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Optional note selectors for this request; overrides the top-level samples",
                },
                filename: {
                  type: "string",
                  description:
                    "Optional output filename for this PNG; defaults to <template>-<side>[-dark].png",
                },
              },
              required: ["template"],
            },
            description:
              "Explicit render requests. If provided, templates/sides are ignored.",
          },
        },
        required: [],
      },
    },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  let pendingTasks = 0;
  const idleWaiters = [];

  function whenIdle() {
    if (pendingTasks === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  async function handleMCPLine(line) {
    if (!line.trim()) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      sendError(null, -32700, "Parse error");
      return;
    }

    if (msg.id === undefined) {
      // Notification (e.g. notifications/initialized): no response required.
      return;
    }

    try {
      switch (msg.method) {
        case "initialize":
          sendResult(msg.id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "uk-geography-screenshots",
              version: "1.0.0",
            },
          });
          break;

        case "ping":
          sendResult(msg.id, {});
          break;

        case "tools/list":
          sendResult(msg.id, { tools: TOOLS });
          break;

        case "tools/call": {
          const name = msg.params && msg.params.name;
          const arguments_ = (msg.params && msg.params.arguments) || {};
          if (name === "render_screenshot") {
            const start = process.hrtime.bigint();
            const { png, pngPath } = await renderOne(arguments_);
            const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
            const template = arguments_.template || "";
            const side = arguments_.side === "back" ? "back" : "front";
            const dark = Boolean(arguments_.dark);
            sendResult(msg.id, {
              content: [
                {
                  type: "text",
                  text:
                    `Rendered ${template} ${side} (dark: ${dark}) in ` +
                    `${elapsedMs.toFixed(0)} ms\nSaved: ${pngPath}`,
                },
                {
                  type: "image",
                  data: png.toString("base64"),
                  mimeType: "image/png",
                },
              ],
            });
          } else if (name === "render_screenshots") {
            const start = process.hrtime.bigint();
            const result = await renderBatch(arguments_);
            const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
            const lines = result.results.map((r) => {
              if (r.ok) {
                return (
                  `  ${r.template} ${r.side}${r.dark ? " (dark)" : ""} -> ` +
                  r.path
                );
              }
              return `  ${r.template} ${r.side} FAILED: ${r.error}`;
            });
            const summary =
              `Rendered ${result.rendered}/${result.count} screenshots ` +
              `(${result.failed} failed) in ${elapsedMs.toFixed(0)} ms\n` +
              lines.join("\n");
            sendResult(msg.id, {
              content: [{ type: "text", text: summary }],
            });
          } else {
            sendError(msg.id, -32602, `Unknown tool: ${name}`);
          }
          break;
        }

        default:
          sendError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      console.error(`[mcp] error: ${err && err.stack ? err.stack : err}`);
      sendError(msg.id, -32603, err.message || String(err));
    }
  }

  rl.on("line", (line) => {
    pendingTasks++;
    handleMCPLine(line).finally(() => {
      pendingTasks--;
      if (pendingTasks === 0) {
        for (const resolve of idleWaiters.splice(0)) resolve();
      }
    });
  });

  const shutdown = async () => {
    await whenIdle();
    removeConnectionFile();
    try {
      await browser.close();
    } catch {
      // Browser may already be closed.
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  rl.on("close", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
