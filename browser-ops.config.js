"use strict";

/** Project settings for utils/browser_ops. Every key is optional. */

module.exports = {
  // Anki card width; operations still set their own per page.
  defaultViewport: { width: 800, height: 1159 },

  // Opened when the host starts. Chromium for screenshots and the default
  // check, WebKit for `make webkit-check`.
  warm: ["chromium", "webkit"],
};
