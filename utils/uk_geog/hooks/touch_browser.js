#!/usr/bin/env node
"use strict";

/**
 * Claude Code UserPromptSubmit hook: heartbeat for the managed browser's
 * idle timer (see start_browser.js's --idle-timeout). Screenshot calls
 * already touch the connection file when they reuse the browser, but a
 * session can go a long time between screenshots while still very much
 * alive - this touches it on every user message instead, so the browser
 * lives for the session's actual lifetime rather than being reaped after a
 * quiet stretch. Registered with "async": true in .claude/settings.json so
 * it never adds latency to sending a message.
 *
 * No-op (not an error) if no managed browser is currently running.
 */

const { touchConnectionFile } = require("../browser_connection.js");

touchConnectionFile();
