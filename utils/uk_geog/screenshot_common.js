"use strict";

/**
 * Shared helpers for the screenshot tooling (capture_screenshots.js and
 * screenshot_mcp.js).
 *
 * The two scripts differ in how they are driven (one-off CLI vs long-lived MCP
 * server), but they render the same cards in the same headless Chromium way:
 * read deck.json, pick a note, render the template, wrap it in Anki's HTML
 * shell, navigate a Puppeteer page to it, and screenshot it. Anything that can
 * be shared between those flows lives here.
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_DECK = path.join(
  REPO_ROOT,
  "build",
  "United Kingdom Geography - Regions Counties and Cities",
  "deck.json"
);
const DEFAULT_OUT = path.join(REPO_ROOT, "build", "screenshots");
const VIEWPORT = { width: 800, height: 1159 };

// Fields that must be populated for each template to produce a meaningful card.
const REQUIRED_FIELDS = {
  "BoW - Map": ["BoW"],
  "City - County": ["City", "MacroLocation"],
  "City - Map": ["City"],
  "County - Map": ["County"],
  "County - Region": ["County", "MacroLocation"],
  "Map - BoW": ["BoW"],
  "Map - City": ["City"],
  "Map - County": ["County"],
  "Map - Motorway": ["Motorway"],
  "Map - Region": ["Region"],
  "Motorway - Map": ["Motorway"],
  "Region - Map": ["Region"],
};

function renderTemplate(template, fields) {
  // Sections first ({{#Field}}...{{/Field}}), then simple substitutions.
  let out = template.replace(
    /\{\{#(\w+)\}\}(.*?)\{\{\/\1\}\}/gs,
    (match, name, inner) => (String(fields[name] || "").trim() ? inner : "")
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (match, name) => fields[name] ?? "");
  return out;
}

function findNote(notes, fieldNames, required, sample) {
  required = required || [];
  for (const note of notes) {
    const values = {};
    fieldNames.forEach((name, i) => {
      values[name] = note.fields[i];
    });
    if (
      sample &&
      Object.keys(sample).some(
        (field) =>
          String(values[field] || "").trim() !== String(sample[field]).trim()
      )
    ) {
      continue;
    }
    if (required.every((field) => String(values[field] || "").trim())) {
      return values;
    }
  }
  return null;
}

function slug(name) {
  return name.toLowerCase().replace(" - ", "-").replace(/ /g, "-");
}

function wrapHtml(css, body, dark) {
  const bodyClass = dark ? ' class="nightMode"' : "";
  const darkCss = dark
    ? `
body.nightMode {
  background-color: #2f2f31;
  color: #d0d0d0;
}
body.nightMode .card {
  background-color: #2f2f31;
  color: #d0d0d0;
}
`
    : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
${css}
${darkCss}
</style>
</head>
<body${bodyClass}>
<div class="card">
${body}
</div>
</body>
</html>
`;
}

function parseSamples(items) {
  const samples = {};
  for (const item of items) {
    const [template, fieldEq] = item.split(":");
    const [field, value] = fieldEq.split("=");
    const name = template.trim();
    samples[name] = samples[name] || {};
    samples[name][field.trim()] = value.trim();
  }
  return samples;
}

function ensurePngExtension(name) {
  return /\.png$/i.test(name) ? name : `${name}.png`;
}

function defaultPngName(template, side, dark) {
  return `${slug(template)}-${side}${dark ? "-dark" : ""}.png`;
}

function loadDeck(deckPath) {
  const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));
  const model = deck.note_models[0];
  const fieldNames = model.flds.map((field) => field.name);
  return {
    deck,
    model,
    fieldNames,
    css: model.css,
    templatesByName: Object.fromEntries(
      model.tmpls.map((tmpl) => [tmpl.name, tmpl])
    ),
  };
}

function prepareCard({ deckPath, template, side, dark, samples }) {
  const { deck, fieldNames, css, templatesByName } = loadDeck(deckPath);
  const tmpl = templatesByName[String(template || "")];
  if (!tmpl) {
    const err = new Error(`Unknown template: ${template}`);
    err.status = 404;
    throw err;
  }

  const required = REQUIRED_FIELDS[tmpl.name] || [];
  const sampleSpecs = (samples || []).map((spec) =>
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

  const actualSide = side === "back" ? "back" : "front";
  const isDark = Boolean(dark);
  const source = actualSide === "back" ? tmpl.afmt : tmpl.qfmt;
  const html = wrapHtml(css, renderTemplate(source, fields), isDark);

  return { tmpl, fields, html, side: actualSide, dark: isDark };
}

/**
 * Render one card on a Puppeteer page and save the PNG. The page must have a
 * unique `_poolIndex` property (assigned by the page pool) so parallel renders
 * write to separate scratch HTML files.
 */
async function renderCardToPng(
  page,
  { deckPath, htmlDir, outDir, template, side, dark, samples, filename }
) {
  const prep = prepareCard({ deckPath, template, side, dark, samples });

  const htmlPath = path.join(htmlDir, `card-${page._poolIndex}.html`);
  fs.writeFileSync(htmlPath, prep.html);

  await page.goto(pathToFileURL(htmlPath).href, {
    waitUntil: "load",
    timeout: 30000,
  });
  const png = await page.screenshot({ type: "png" });

  const finalFilename = filename
    ? ensurePngExtension(path.basename(String(filename)))
    : defaultPngName(template, prep.side, prep.dark);
  const pngPath = path.join(outDir, finalFilename);
  fs.writeFileSync(pngPath, png);

  return { png, pngPath, side: prep.side, dark: prep.dark };
}

/**
 * Expand tool/CLI arguments into a flat list of render requests. Supports both
 * the capture_screenshots.js style (templates x sides) and the MCP style
 * (explicit requests with per-render overrides).
 */
function expandRenderRequests({
  allTemplateNames,
  templates,
  sides,
  dark,
  samples,
  requests,
}) {
  const globalSamples = Array.isArray(samples)
    ? samples
    : typeof samples === "string"
      ? [samples]
      : [];
  const expanded = [];

  if (Array.isArray(requests) && requests.length > 0) {
    for (const req of requests) {
      if (!req || typeof req !== "object") {
        throw new Error("Each entry in requests must be an object");
      }
      const template = String(req.template || "").trim();
      if (!template) {
        throw new Error("Each entry in requests must include a template");
      }
      const reqSamples = Array.isArray(req.samples)
        ? req.samples
        : typeof req.samples === "string"
          ? [req.samples]
          : globalSamples;
      expanded.push({
        template,
        side: req.side === "back" ? "back" : "front",
        dark: typeof req.dark === "boolean" ? req.dark : Boolean(dark),
        samples: reqSamples,
        filename: req.filename,
      });
    }
    return expanded;
  }

  const templateList =
    Array.isArray(templates) && templates.length > 0
      ? templates.map((name) => String(name).trim())
      : allTemplateNames;
  const sideList =
    Array.isArray(sides) && sides.length > 0
      ? sides.map((side) => (side === "back" ? "back" : "front"))
      : ["front", "back"];

  for (const template of templateList) {
    for (const side of sideList) {
      expanded.push({
        template,
        side,
        dark: Boolean(dark),
        samples: globalSamples,
      });
    }
  }
  return expanded;
}

/**
 * Simple promise-based pool of Puppeteer pages. Each render takes one tab for
 * the duration of its navigation/screenshot and returns it afterwards, so
 * concurrent calls and batch renders are spread over all open tabs.
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

module.exports = {
  REPO_ROOT,
  DEFAULT_DECK,
  DEFAULT_OUT,
  VIEWPORT,
  REQUIRED_FIELDS,
  renderTemplate,
  findNote,
  slug,
  wrapHtml,
  parseSamples,
  ensurePngExtension,
  defaultPngName,
  loadDeck,
  prepareCard,
  renderCardToPng,
  expandRenderRequests,
  PagePool,
  runWithPool,
};
