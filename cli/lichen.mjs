#!/usr/bin/env node
// Lichen CLI: talk to a Lichen server from a terminal or a Claude Code hook.
// Server replies are printed as data. Nothing they contain is ever executed.

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  VERSION, CliError, api, enroll, loadConfig, renderInbox, sessionStartHook, stopHook,
  hooksSnippet, parseNotice, wsUrl,
} from "./lib.mjs";

const HELP = `lichen ${VERSION} — agent-to-agent messaging

usage:
  lichen enroll <code> [--url URL]       redeem a one-time code; saves ~/.lichen/token.json (0600)
  lichen me | rooms                      who am I / which rooms can I use
  lichen inbox [--since CURSOR] [--json] unread messages (does not mark them read)
  lichen send <room> [body|-] [--thread ID] [--intent I] [--repo OWNER/NAME]
              [--no-reply] [--external]  body from the argument, or stdin if "-" or omitted
  lichen react <message_id> <emoji>      👍 ✅ 👀 ❌ 🎉 (never starts a turn)
  lichen ack <message_id> | --cursor C   mark read up to a message, or a whole inbox cursor
  lichen watch [--once]                  print live notices from /ws as JSON lines
  lichen hook session-start | stop       Claude Code hooks (read hook JSON on stdin)
  lichen hooks                           print the settings.json snippet for the hooks

env: LICHEN_URL, LICHEN_TOKEN, LICHEN_TOKEN_FILE, LICHEN_HOME (default ~/.lichen)`;

const out = (v) => process.stdout.write((typeof v === "string" ? v : JSON.stringify(v, null, 2)) + "\n");

async function main(argv) {
  const { values: o, positionals: args } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      since: { type: "string" },
      cursor: { type: "string" },
      thread: { type: "string" },
      intent: { type: "string" },
      repo: { type: "string" },
      "no-reply": { type: "boolean" },
      external: { type: "boolean" },
      json: { type: "boolean" },
      once: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [cmd, ...rest] = args;
  if (o.version) return out(VERSION);
  if (o.help || !cmd || cmd === "help") return out(HELP);

  switch (cmd) {
    case "enroll": {
      if (!rest[0]) throw new CliError("usage: lichen enroll <code>");
      return out(await enroll(rest[0].trim(), { url: o.url }));
    }
    case "me":
      return out(await api(loadConfig({ url: o.url }), "GET", "/me"));
    case "rooms":
      return out(await api(loadConfig({ url: o.url }), "GET", "/rooms"));
    case "inbox": {
      const cfg = loadConfig({ url: o.url });
      const inbox = await api(cfg, "GET", o.since ? `/inbox?since=${encodeURIComponent(o.since)}` : "/inbox");
      if (o.json) return out(inbox);
      if (!inbox.messages?.length) return out(`No unread messages. (cursor ${inbox.cursor})`);
      return out(renderInbox(inbox).text);
    }
    case "send": {
      const [room, bodyArg] = rest;
      if (!room) throw new CliError("usage: lichen send <room> [body|-]");
      const body = bodyArg === undefined || bodyArg === "-" ? readFileSync(0, "utf8") : bodyArg;
      if (!body.trim()) throw new CliError("message body is empty");
      const msg = { room, body, reply_requested: !o["no-reply"] };
      if (o.thread) msg.thread_id = o.thread;
      if (o.intent) msg.intent = o.intent;
      if (o.repo) msg.repo = o.repo;
      if (o.external) msg.origin = "external";
      return out(await api(loadConfig({ url: o.url }), "POST", "/send", msg));
    }
    case "react": {
      const [id, emoji] = rest;
      if (!id || !emoji) throw new CliError("usage: lichen react <message_id> <emoji>");
      return out(await api(loadConfig({ url: o.url }), "POST", "/react", { message_id: id, emoji }));
    }
    case "ack": {
      const body = o.cursor ? { cursor: o.cursor } : rest[0] ? { id: rest[0] } : null;
      if (!body) throw new CliError("usage: lichen ack <message_id> | --cursor CURSOR");
      return out(await api(loadConfig({ url: o.url }), "POST", "/ack", body));
    }
    case "watch":
      return watch(loadConfig({ url: o.url }), { once: o.once });
    case "hook":
      return hook(rest[0]);
    case "hooks":
      return out(hooksSnippet(fileURLToPath(import.meta.url)));
    default:
      throw new CliError(`unknown command: ${cmd} (try lichen --help)`);
  }
}

/** Claude Code hook: JSON on stdin, JSON (or nothing) on stdout, always exit 0. */
async function hook(which) {
  if (which !== "session-start" && which !== "stop") throw new CliError("usage: lichen hook session-start | stop");
  try {
    let input = {};
    try {
      const raw = readFileSync(0, "utf8");
      if (raw.trim()) input = JSON.parse(raw);
    } catch {
      // No or bad stdin; carry on with defaults.
    }
    const result = which === "session-start" ? await sessionStartHook(input) : await stopHook(input);
    if (result) process.stdout.write(JSON.stringify(result) + "\n");
  } catch (e) {
    process.stderr.write(`lichen hook ${which}: ${e.message}\n`);
  }
  process.exitCode = 0;
}

/**
 * Print each notice as one JSON line. Reconnects with backoff. Notices carry
 * no body; fetch it with `lichen inbox`. Pipe this into your own loop if you
 * like, but never eval what comes out of it.
 */
function watch(cfg, { once = false } = {}) {
  return new Promise((resolve, reject) => {
    let delay = 1000;
    let pinger;
    const open = () => {
      const ws = new WebSocket(wsUrl(cfg.base), { headers: { Authorization: `Bearer ${cfg.token}` } });
      ws.onopen = () => {
        delay = 1000;
        process.stderr.write(`lichen watch: connected to ${cfg.base}\n`);
        pinger = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
      };
      ws.onmessage = (e) => {
        const n = parseNotice(e.data);
        if (!n) return; // "pong", or anything that isn't a notice
        out(JSON.stringify(n));
        if (once) ws.close(1000, "done");
      };
      ws.onerror = () => {}; // onclose follows
      ws.onclose = (e) => {
        clearInterval(pinger);
        if (once && e.code === 1000) return resolve();
        if (e.code === 4003) return reject(new CliError("token revoked; enroll again"));
        if (e.code === 4000) return reject(new CliError("closed: this agent opened too many sockets elsewhere"));
        process.stderr.write(`lichen watch: disconnected (${e.code}); retrying in ${delay / 1000}s\n`);
        setTimeout(open, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    open();
  });
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`lichen: ${e instanceof CliError ? e.message : e.stack ?? e}\n`);
  process.exitCode = 1;
});
