"use strict";

/**
 * Card HTML generation, shared by the screenshot tooling (capture_screenshots.js
 * and screenshot_mcp.js): read deck.json, pick a note, render the template,
 * and wrap it in Anki's HTML shell. Deliberately has no puppeteer dependency -
 * turning that HTML into a screenshot is a separate concern handled by
 * render_screenshot.js, which just needs a URL to navigate to.
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
  "Map - Region": ["Region"],
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
 * Generate a card's HTML and write it to a scratch file, returning a URL a
 * renderer can navigate to. Pure HTML generation - no puppeteer involved, so
 * this can be tested or reused independently of how the resulting page gets
 * screenshotted. `scratchKey` distinguishes concurrent writers (e.g. a page
 * pool index) so parallel renders don't clobber each other's scratch file.
 */
function writeCardHtml({ deckPath, htmlDir, template, side, dark, samples, scratchKey }) {
  const prep = prepareCard({ deckPath, template, side, dark, samples });
  const htmlPath = path.join(htmlDir, `card-${scratchKey}.html`);
  fs.writeFileSync(htmlPath, prep.html);
  return {
    htmlPath,
    url: pathToFileURL(htmlPath).href,
    tmpl: prep.tmpl,
    side: prep.side,
    dark: prep.dark,
  };
}

/**
 * Resolve the output PNG path for a rendered card, honouring an explicit
 * filename override or falling back to the `<template>-<side>[-dark].png`
 * convention.
 */
function cardPngPath({ outDir, template, side, dark, filename }) {
  const finalFilename = filename
    ? ensurePngExtension(path.basename(String(filename)))
    : defaultPngName(template, side, dark);
  return path.join(outDir, finalFilename);
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
  writeCardHtml,
  cardPngPath,
  expandRenderRequests,
};
