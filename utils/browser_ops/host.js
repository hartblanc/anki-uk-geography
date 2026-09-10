"use strict";

/**
 * Serve operations (see index.js) against warm browsers over a unix socket.
 *
 *   const host = await startHost({ onLog: console.error });
 *   await host.close();
 *
 * Browsers launch per engine on first use, or up front via the `warm`
 * config key. Callers reach this through index.js's runOp(), which falls
 * back to a local browser when no host is listening.
 *
 * Protocol: newline-delimited JSON, one request per line.
 *   -> {address, items, opts}
 *   <- {ok: true, results} | {ok: false, error, stack}
 */

const fs = require("fs");
const net = require("net");

const { BrowserPool, hostSocketPath, loadConfig } = require("./index.js");

/**
 * Start listening on this project's socket. Returns `{socketPath, warmed,
 * close}`; always call `close()` before the process exits.
 *
 * `warm` overrides the config's `warm` key. Warming runs in the background
 * once the socket is up; await `warmed` if you need it finished.
 *
 * Throws with `code: "EHOSTRUNNING"` if a host is already listening.
 */
async function startHost({ onLog, warm } = {}) {
  const socketPath = hostSocketPath();
  const log = onLog ?? (() => {});

  if (await isHostListening(socketPath)) {
    const err = new Error(
      `A browser host is already listening on ${socketPath} - not starting a second one.`,
    );
    err.code = "EHOSTRUNNING";
    throw err;
  }
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // Nothing to clean up.
  }

  const pool = new BrowserPool({ persistent: true });

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    // Answer in order, so a client can't be handed someone else's reply.
    let queue = Promise.resolve();

    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        queue = queue.then(() => handle(pool, socket, line, log));
      }
    });

    socket.on("error", () => {});
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  // Warm after listening, so a caller arriving mid-warm is still served.
  const targets = warm ?? loadConfig().warm ?? [];
  const warmed = pool.warm(targets, {
    onWarm: (r) =>
      log(
        r.ok
          ? `warmed ${r.engine}${r.scale === 1 ? "" : ` @${r.scale}x`} ` +
              `(${r.pages} page${r.pages === 1 ? "" : "s"}) in ${r.ms}ms`
          : `failed to warm ${r.engine}: ${r.error}`,
      ),
  });

  const close = async () => {
    await warmed.catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Already gone.
    }
    await pool.close();
  };

  return { socketPath, warmed, close };
}

async function handle(pool, socket, line, log) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return reply(socket, { ok: false, error: "Malformed request" });
  }

  const { address, items, opts } = request;
  const started = Date.now();
  try {
    const results = await pool.run(address, items ?? [], opts ?? {});
    log(
      `${address.module}#${address.name} x${items?.length ?? 0} in ` +
        `${Date.now() - started}ms`,
    );
    reply(socket, { ok: true, results });
  } catch (err) {
    log(`${address?.module ?? "?"} failed: ${err.message}`);
    reply(socket, {
      ok: false,
      error: err.message || String(err),
      stack: err.stack,
    });
  }
}

function reply(socket, message) {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(message)}\n`);
}

// Whether something is already accepting connections on `socketPath`.
function isHostListening(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

module.exports = { startHost };
