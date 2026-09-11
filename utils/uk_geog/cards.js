"use strict";

/**
 * Deck and card-HTML utilities for Anki's CrowdAnki export format: load a
 * deck.json, find a note that satisfies a template's required fields,
 * render a template's `{{Field}}`/`{{#Field}}...{{/Field}}` syntax against
 * it, and wrap the result in a page shaped like an Anki client's reviewer
 * (front/back, light/dark). Has no browser automation dependency - the
 * output is HTML, for something else to open and render.
 *
 * `samples` throughout is a list of `"TEMPLATE:FIELD=VALUE"` strings (or
 * just `"FIELD=VALUE"` when it's already scoped to one template) used to
 * pick a specific note instead of the first one that satisfies the
 * template's required fields.
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_DECK = path.join(
  REPO_ROOT,
  "build",
  "United Kingdom Geography - Regions Counties and Cities",
  "deck.json",
);

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
    (match, name, inner) => (String(fields[name] || "").trim() ? inner : ""),
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (match, name) => fields[name] ?? "");
  return out;
}

// Find the first note with every field in `required` populated, optionally
// narrowed further to one whose fields match `sample` (a {field: value} map
// - see parseSamples() below). Returns a {fieldName: value} map, or null if
// no note qualifies.
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
          String(values[field] || "").trim() !== String(sample[field]).trim(),
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

/**
 * Anki clients a card can be rendered as. `htmlClass` and `mobile` shape the
 * page like that client's reviewer; `context` is the Playwright context
 * options that emulate its device. Mobile viewports are AnkiMobile's
 * approximate card area.
 */
const CLIENTS = {
  desktop: { htmlClass: "", mobile: false, context: {} },
  iphone: {
    htmlClass: "webkit safari mobile ios iphone js retina orientation_portrait",
    mobile: true,
    context: {
      viewport: { width: 393, height: 659 },
      screen: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    },
  },
  ipad: {
    htmlClass: "webkit safari mobile ios ipad js retina orientation_portrait",
    mobile: true,
    context: {
      viewport: { width: 820, height: 1010 },
      screen: { width: 820, height: 1180 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    },
  },
};

// Stand-in for the reviewer's night-mode colours.
const NIGHT_CSS = `.card.nightMode {
  background-color: #2f2f31;
  color: #d0d0d0;
}`;

function clientFor(name) {
  const client = CLIENTS[name];
  if (!client) {
    throw new Error(
      `Unknown client: ${name} (expected one of ${Object.keys(CLIENTS).join(", ")})`,
    );
  }
  return client;
}

/**
 * A page shaped like `client`'s reviewer, with `content` in #qa and
 * `bodyClass` on body. Omit both for an empty page to show cards in.
 */
function pageHtml({ client = "desktop", bodyClass = "card", content = "" }) {
  const { htmlClass, mobile } = clientFor(client);
  const viewport = mobile
    ? '<meta name="viewport" id="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=10,user-scalable=1">\n'
    : "";
  return `<!doctype html>
<html${htmlClass ? ` class="${htmlClass}"` : ""}>
<head>
<meta charset="utf-8">
${viewport}<style>
${NIGHT_CSS}
</style>
</head>
<body class="${bodyClass}">
<div id="qa">
${content}
</div>
</body>
</html>
`;
}

// Parse "TEMPLATE:FIELD=VALUE" spec strings into {TEMPLATE: {FIELD: VALUE}}.
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

// Load a CrowdAnki deck.json and flatten its single note model into the
// shape the rest of this file works with.
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
      model.tmpls.map((tmpl) => [tmpl.name, tmpl]),
    ),
  };
}

// Find a usable note for `template` and render it. Returns `{html, content,
// bodyClass}`: the whole page for `client` (default "desktop"), or what
// goes in #qa and on body to show it in an existing one. Throws (with a
// `.status` of 404) if the template doesn't exist or no note satisfies it.
function prepareCard({ deckPath, template, side, dark, samples, client }) {
  const { deck, fieldNames, css, templatesByName } = loadDeck(deckPath);
  const tmpl = templatesByName[String(template || "")];
  if (!tmpl) {
    const err = new Error(`Unknown template: ${template}`);
    err.status = 404;
    throw err;
  }

  const required = REQUIRED_FIELDS[tmpl.name] || [];
  const sampleSpecs = (samples || []).map((spec) =>
    String(spec).includes(":") ? String(spec) : `${tmpl.name}:${spec}`,
  );
  const parsedSamples = parseSamples(sampleSpecs);
  const fields = findNote(
    deck.notes,
    fieldNames,
    required,
    parsedSamples[tmpl.name],
  );
  if (!fields) {
    const err = new Error(`No matching note for template: ${tmpl.name}`);
    err.status = 404;
    throw err;
  }

  const actualSide = side === "back" ? "back" : "front";
  const isDark = Boolean(dark);
  const source = actualSide === "back" ? tmpl.afmt : tmpl.qfmt;
  const content = `<style>\n${css}\n</style>\n${renderTemplate(source, fields)}`;
  const bodyClass = `card card${tmpl.ord + 1}${isDark ? " nightMode night_mode" : ""}`;

  return { html: pageHtml({ client, bodyClass, content }), content, bodyClass };
}

/**
 * Expand a set of options into a flat list of render requests
 * (`{template, side, dark, samples, filename}`). Two modes:
 *   - `requests`: an explicit array of `{template, side?, dark?, samples?,
 *     filename?}` objects, each with its own overrides.
 *   - otherwise: the cross product of `templates` (or `allTemplateNames`)
 *     and `sides` (both default to "every template"/"front and back"),
 *     all sharing the same `dark`/`samples`.
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
 * Load the deck, work out which templates actually have a usable note -
 * skipping (and logging) any that don't, before any rendering is attempted,
 * so a missing note shows up as a reported skip rather than a render
 * failure - and expand those into a flat list of render requests across
 * each of `darkModes`. `only`, if given, narrows to just those template
 * names (silently ignoring ones that don't exist); omit it to check every
 * template in the deck. Returns `{usableTemplates, requests}`.
 */
function resolveRenderRequests({
  deckPath,
  only,
  darkModes = [false],
  samples,
} = {}) {
  const { deck, fieldNames, templatesByName } = loadDeck(deckPath);

  let templateNames = Object.keys(templatesByName);
  if (only && only.length) {
    templateNames = only.filter((name) => templatesByName[name]);
  }

  const parsedSamples = parseSamples(samples || []);
  const usableTemplates = [];
  for (const name of templateNames) {
    const required = REQUIRED_FIELDS[name] || [];
    const fields = findNote(
      deck.notes,
      fieldNames,
      required,
      parsedSamples[name],
    );
    if (!fields) {
      console.log(`Skipping ${name}: no matching note found`);
      continue;
    }
    usableTemplates.push(name);
  }

  let requests = [];
  for (const dark of darkModes) {
    requests = requests.concat(
      expandRenderRequests({
        allTemplateNames: usableTemplates,
        sides: ["front", "back"],
        dark,
        samples,
      }),
    );
  }

  return { usableTemplates, requests };
}

module.exports = {
  REPO_ROOT,
  DEFAULT_DECK,
  CLIENTS,
  pageHtml,
  prepareCard,
  resolveRenderRequests,
};
