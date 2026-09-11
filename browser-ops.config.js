"use strict";

const { CLIENTS } = require("./utils/uk_geog/cards.js");

/** Project settings for utils/browser_ops. Every key is optional. */

module.exports = {
  // Playwright context options for every page. The viewport is the Anki card
  // size; operations still set their own per page.
  defaultContext: { viewport: { width: 800, height: 1159 } },

  // Opened when the host starts. Chromium and WebKit cover screenshots and
  // check_cards.js's default (light, desktop) sessions; its dark sessions
  // and WebKit's iPhone/ipad clients each use their own context, so those
  // are warmed too, at a lower page count since check_cards' queues are
  // small.
  warm: [
    "chromium",
    { engine: "chromium", context: { colorScheme: "dark" }, pages: 2 },
    "webkit",
    { engine: "webkit", context: CLIENTS.iphone.context, pages: 2 },
    {
      engine: "webkit",
      context: { ...CLIENTS.iphone.context, colorScheme: "dark" },
      pages: 2,
    },
    { engine: "webkit", context: CLIENTS.ipad.context, pages: 2 },
    {
      engine: "webkit",
      context: { ...CLIENTS.ipad.context, colorScheme: "dark" },
      pages: 2,
    },
  ],
};
