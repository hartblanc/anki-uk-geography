"use strict";

/**
 * Puppeteer browser lifecycle, decoupled from anything that renders with it.
 *
 * By default `getBrowser()` launches a throwaway headless Chromium that the
 * caller should close when done (`shouldClose: true`) - this is what one-off
 * CLI invocations (capture_screenshots.js, render_screenshot.js) use.
 *
 * If PUPPETEER_BROWSER_URL is set, it connects to an already-running browser's
 * CDP HTTP endpoint instead (`shouldClose: false`), so the caller must leave
 * it running for other callers. Start such a browser with start_browser.js -
 * an agent (or any long-lived session) runs it once at startup, exports the
 * printed PUPPETEER_BROWSER_URL, and every render after that reuses the same
 * warm browser instead of paying launch cost per call.
 */

const puppeteer = require("puppeteer");

const LAUNCH_ARGS = ["--disable-gpu", "--hide-scrollbars"];

async function getBrowser({ headless = true, args = LAUNCH_ARGS } = {}) {
  const browserURL = process.env.PUPPETEER_BROWSER_URL;
  if (browserURL) {
    const browser = await puppeteer.connect({ browserURL });
    return { browser, shouldClose: false };
  }
  const browser = await puppeteer.launch({ headless, args });
  return { browser, shouldClose: true };
}

module.exports = { getBrowser, LAUNCH_ARGS };
