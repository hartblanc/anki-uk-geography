"use strict";

/** Project settings for utils/browser_ops. Every key is optional. */

module.exports = {
  // Playwright context options for every page. The viewport is the Anki card
  // size; operations still set their own per page.
  defaultContext: { viewport: { width: 800, height: 1159 } },

  // Opened when the host starts. Chromium for screenshots and the default
  // check, WebKit for `make webkit-check`.
  warm: ["chromium", "webkit"],
};
