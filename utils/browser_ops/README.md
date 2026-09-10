# browser_ops

Run browser operations against warm, pooled pages. Define each operation
next to the code that uses it, and pay for a browser at most once per
project instead of once per command.

Nothing in this directory knows anything about the project using it. Copy it
into your own project, add Playwright, and it works.

## Why

A command-line script that takes a screenshot spends almost all of its time
not taking a screenshot. Measured on a real project:

|                           |          |
| ------------------------- | -------- |
| node process start        | 40ms     |
| `require("playwright")`   | 155ms    |
| connecting to a browser   | 55ms     |
| **the actual screenshot** | **30ms** |

If something is already holding a browser open, all but the first line and
the last goes away. That's what this does: a host process keeps browsers
warm, and your scripts send it work.

## Defining an operation

An operation is something you do to a page. Define it where you use it:

```js
const { defineOperation } = require("./utils/browser_ops");

const screenshot = defineOperation(module, {
  async run(page, { url, outPath }) {
    await page.goto(url);
    await page.screenshot({ path: outPath });
    return { outPath };
  },
});
```

Then run a batch:

```js
const results = await screenshot.run([
  { url: "https://example.com", outPath: "a.png" },
  { url: "https://example.org", outPath: "b.png" },
]);
```

That's the whole API. There's no registry to add yourself to and no list of
operations anywhere — an operation lives in the module that defines it, and
any module can define one, including in code you don't own.

### Options

`run(items, opts)` takes:

| option        | default    | meaning                                  |
| ------------- | ---------- | ---------------------------------------- |
| `engine`      | `chromium` | `chromium`, `firefox` or `webkit`        |
| `concurrency` | CPU count  | ceiling on pages worked at once          |
| `scale`       | `1`        | device scale factor for the batch        |
| `onResult`    | —          | `(result, item, index)` as each finishes |

Any item may carry its own `scale`, overriding the batch's. One batch can
mix scale factors freely.

There is nothing to tune. How many pages a batch opens is worked out from
the measured cost of the first item and of page creation itself, so an
operation is just a `run` function.

## Rule 1: keep it serializable

`item` and whatever `run` returns must both survive `JSON.stringify`.

The host is a separate process, so it can't be handed your `run` function —
a socket carries data, not closures. What crosses instead is the operation's
_address_: the path of the module that defined it plus its name. That's why
`defineOperation` takes `module` as its first argument — it reads
`module.filename` so an operation knows where it lives without you writing a
path down. The host requires that module, which runs your `defineOperation`
call, and then it has the real function.

So anything that can't be serialized — a Buffer, a Page, a callback — either
stays on one side or goes to a file whose path you pass instead. The
screenshot operation above returns `{outPath}`, not the PNG, for exactly
this reason.

`onResult` is the one exception, and it's handled: it can't cross, so it
fires per item when work runs locally and once per result when the host does
it. Progress output looks the same, just less incremental.

## Each batch gets fresh pages

A batch leases its pages from a pool of ready ones, and they are discarded
when it finishes — never handed to another batch. Each page has a browser
context to itself, which is what lets it be thrown away cleanly, so nothing
an operation leaves behind can reach the next one: cookies, storage,
`addInitScript`, listeners, emulation, routes, viewport, running timers.

Replacements are built in the background after a batch returns its pages, so
the cost normally lands between batches rather than inside one. `warm` keeps
a set ready from startup.

Within a batch there is no isolation: a worker keeps its page for the whole
batch, so items running on it follow one another on the same page. An
operation that needs a clean page per item should start by navigating.

## Rule 2: guard your module's top-level code

Because the host finds an operation by requiring the module that defines it,
loading a module **runs its top-level code inside the host process**. If
your module is also a script, put the script part behind the standard guard:

```js
const thing = defineOperation(module, { ... });

if (require.main === module) {
  main(); // only when run directly, never when the host loads the operation
}
```

Without it, a script that does its work at the top level will do that work a
second time in the host, with its output going to the host's log rather than
your terminal — which is confusing to debug, because the operation itself
still returns the right answer.

Define operations at the top level. Everything else goes behind the guard.

## Running the host

Without a host, everything still works — each call launches its own browser,
uses it, and closes it. The host is purely an optimization, and no code
changes between the two cases.

To run one, call `startHost()` from any long-lived process:

```js
const { startHost } = require("./utils/browser_ops/host.js");
const host = await startHost({ onLog: console.error });
// ... later
await host.close();
```

`mcp.js` here does exactly that and nothing else: an MCP server exposing no
tools, which exists only to hold a host open for the length of an editor
session. Point `.mcp.json` at it:

```json
{
  "mcpServers": {
    "browser": { "command": "node", "args": ["utils/browser_ops/mcp.js"] }
  }
}
```

A `make watch` target or a plain daemon works equally well — MCP is just a
convenient thing to hang it on, since the editor keeps it alive.

Browsers are launched lazily, per engine, the first time something asks. A
WebKit run warms WebKit; it doesn't have to be nominated up front.

### Opening browsers at startup

Lazy is fine, but the first call then pays for the launch — 89ms for
Chromium, 183ms for WebKit, 532ms for Firefox, plus a page each. To open
them ahead of time, list them under `warm` in the config:

```js
module.exports = {
  warm: ["chromium", "webkit"],
};
```

`warm` also sets how many pages are kept ready from then on, so it decides
how much memory sits idle. On this machine a
WebKit browser alone is 76MB, while each of its pages is ~113MB (Chromium
~78MB, Firefox ~234MB). Warming the browser with few pages is the cheap
middle ground — `{engine: "webkit", pages: 2}` holds ~490MB and runs a
40-card check in 1.09s, against ~1090MB and 0.82s for 8.

Naming an engine is usually enough. Pages and scale factor default to what
an ordinary batch uses — scale 1, and as many pages as `concurrency`
defaults to — because a persistent pool grows to `min(concurrency, batch
size)`, so that's exactly what a full-size batch will ask for. Warming fewer
doesn't avoid the work, it just moves page creation onto the first command.

Pass `{engine, scale, pages}` instead when you want a particular scale
factor's context ready, or deliberately fewer pages than a batch will use. Pre-opening pages
is what matters for a batch: on this repo, a 40-card WebKit check went 2.66s
→ 1.87s by warming the browser, then → 0.87s by warming 8 pages with it,
which is the same speed it runs at when fully warm.

`startHost({ warm: [...] })` overrides the config for one host.

Warming starts once the socket is listening, not before, so the host is
reachable immediately and a call arriving mid-warm is served rather than
refused. A request for an engine still being warmed waits for that same
launch rather than starting a second one. `await host.warmed` if you need to
know warming has finished.

## Concurrency

The host owns every page, so a page is lent to one operation at a time and
concurrent callers queue instead of colliding. Two scripts run at once —
or the same script run twice — is fine, and neither has to know about the
other.

This is worth stating because the obvious alternative isn't safe. Sharing a
browser by having each process connect to it over CDP and reuse its pages
means concurrent callers can grab the _same_ page and navigate it out from
under each other. Owning the pages in one process is what removes that,
rather than documenting a rule that callers must not run at the same time.

## Configuration

Optional. Put a `browser-ops.config.js` at your project root (the nearest
directory above with a `package.json`):

```js
module.exports = {
  launchArgs: { chromium: ["--disable-gpu", "--hide-scrollbars"] },
  defaultViewport: { width: 1280, height: 720 },
  defaultEngine: "chromium",
  warm: [],
};
```

Every key is optional and falls back to the value shown. `BROWSER_OPS_ROOT`
overrides root detection if your layout needs it.

## Notes

- Module paths on the wire are resolved relative to the project root and
  refused if they escape it. That's containment, not security: anyone who
  can reach the socket can already run code as you.
- The socket lives in the system temp directory, keyed by project root, so
  each checkout gets its own host. A socket left behind by a host that died
  refuses connections, so callers fall back cleanly with no PID bookkeeping.
- `require("playwright")` is deliberately lazy, loaded only when a browser
  is actually launched. Hoisting it gives back most of what the host is for.
