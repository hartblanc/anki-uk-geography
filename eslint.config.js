"use strict";

const js = require("@eslint/js");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

module.exports = [
  js.configs.recommended,
  prettier,
  {
    // Everything under utils/ and the root config files run as plain Node
    // CommonJS scripts (build tooling, browser_ops, screenshot capture).
    files: ["**/*.js"],
    ignores: ["utils/uk_geog/snippets/**"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
  },
  {
    // These are plain <script> snippets injected verbatim into Anki card
    // templates (see utils/uk_geog/templates), so they run in the browser,
    // not Node, and are never require()'d.
    files: ["utils/uk_geog/snippets/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: globals.browser,
    },
  },
  {
    // showCard/settle here are handed straight to Playwright's
    // page.evaluate() and execute in the page, not in this Node process.
    files: ["utils/uk_geog/check_cards.js"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
