#!/usr/bin/env node
"use strict";

/**
 * MCP server for UK Geography card screenshots.
 *
 * Speaks the Model Context Protocol over stdio (JSON-RPC 2.0) so MCP clients
 * such as Deep Code, Claude, or Cursor can render card screenshots directly.
 *
 * On startup this process only launches the warm headless Chromium instance.
 * Each `render_screenshot` call reads deck.json and the media files fresh from
 * disk, builds the card HTML, and renders it immediately. This means screenshots
 * always reflect the latest build without any manual lifecycle management.
 *
 * Usage:
 *   node utils/uk_geog/screenshot_mcp.js [--deck PATH]
 *
 * Configure in .deepcode/settings.json (or ~/.deepcode/settings.json):
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
const { pathToFileURL } = require("url");
const puppeteer = require("puppeteer");

const {
  REPO_ROOT,
  DEFAULT_DECK,
  MEDIA_DIR,
  MEDIA_FILES,
  VIEWPORT,
  REQUIRED_FIELDS,
  renderTemplate,
  findNote,
  parseSamples,
  wrapHtml,
} = require("./capture_screenshots.js");

const USAGE = `Usage: screenshot_mcp.js [options]

Options:
  --deck PATH   CrowdAnki deck.json (default: built deck)
  --help        Show this help
`;

function parseArgs(argv) {
  const args = { deck: DEFAULT_DECK, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--deck":
        args.deck = argv[++i];
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
  fs.mkdirSync(htmlDir, { recursive: true });
  const cardHtmlPath = path.join(htmlDir, "card.html");
  const cardUrl = pathToFileURL(cardHtmlPath).href;

  // Initialise the warm browser at startup; nothing else is loaded yet.
  console.error("Launching headless Chromium...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--disable-gpu", "--hide-scrollbars"],
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  // Serialise renders on the single warm page.
  let queue = Promise.resolve();

  async function renderCard(argsObj) {
    // Read the deck and media fresh on every render so screenshots reflect the
    // agent's latest build.
    const deck = JSON.parse(fs.readFileSync(args.deck, "utf8"));
    const model = deck.note_models[0];
    const fieldNames = model.flds.map((field) => field.name);
    const css = model.css;
    const templatesByName = Object.fromEntries(
      model.tmpls.map((tmpl) => [tmpl.name, tmpl])
    );

    for (const media of MEDIA_FILES) {
      fs.copyFileSync(path.join(MEDIA_DIR, media), path.join(htmlDir, media));
    }

    const template = String(argsObj.template || "");
    const tmpl = templatesByName[template];
    if (!tmpl) {
      const err = new Error(`Unknown template: ${template}`);
      err.status = 404;
      throw err;
    }

    const required = REQUIRED_FIELDS[tmpl.name] || [];
    const samples = argsObj.samples || [];
    const sampleSpecs = samples.map((spec) =>
      String(spec).includes(":") ? String(spec) : `${tmpl.name}:${spec}`
    );
    const parsedSamples = parseSamples(sampleSpecs);
    const fields = findNote(
      deck.notes,
      fieldNames,
      required,
      parsedSamples[tmpl.name]
    );
    if (!fields) {
      const err = new Error(`No matching note for template: ${tmpl.name}`);
      err.status = 404;
      throw err;
    }

    const side = argsObj.side === "back" ? "back" : "front";
    const dark = Boolean(argsObj.dark);
    const source = side === "back" ? tmpl.afmt : tmpl.qfmt;
    const html = wrapHtml(css, renderTemplate(source, fields), dark);
    fs.writeFileSync(cardHtmlPath, html);

    await page.goto(cardUrl, { waitUntil: "load", timeout: 30000 });
    return page.screenshot({ type: "png" });
  }

  function enqueueRender(argsObj) {
    const run = queue.then(() => renderCard(argsObj));
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
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
        },
        required: ["template"],
      },
    },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", async (line) => {
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
            const png = await enqueueRender(arguments_);
            const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
            const template = arguments_.template || "";
            const side = arguments_.side === "back" ? "back" : "front";
            const dark = Boolean(arguments_.dark);
            sendResult(msg.id, {
              content: [
                {
                  type: "text",
                  text: `Rendered ${template} ${side} (dark: ${dark}) in ${elapsedMs.toFixed(0)} ms`,
                },
                {
                  type: "image",
                  data: png.toString("base64"),
                  mimeType: "image/png",
                },
              ],
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
  });

  const shutdown = async () => {
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

module.exports = { main, parseArgs };
