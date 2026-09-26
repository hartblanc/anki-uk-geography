"use strict";

module.exports = {
  plugins: ["prettier-plugin-mustache"],
  overrides: [
    {
      // Card templates use Anki's {{Field}} / {{#Field}}...{{/Field}}
      // syntax (real Mustache, not Handlebars), so the mustache-aware
      // parser understands them instead of choking on or mangling them
      // the way the plain HTML parser would.
      //
      // Not included: src/note_models/UK_Constituencies/templates and
      // utils/constituencies/uk_constituencies.html. Both contain a bare
      // <use href="..."> inside inline SVG (missing the self-closing
      // slash), which trips up this plugin's HTML parser - and neither is
      // part of the current build (grep the Makefile: nothing references
      // UK_Constituencies), so it wasn't worth fixing to bring them in.
      files: ["utils/uk_geog/templates/**/*.html"],
      options: { parser: "mustache" },
    },
  ],
};
