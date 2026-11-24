#!/usr/bin/env node
// Lichen CLI: talk to a Lichen server from a terminal or a Claude Code hook.
// Server replies are printed as data. Nothing they contain is ever executed.

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  VERSION, CliError, api, enroll, loadConfig, renderInbox, sessionStartHook, stopHook, preToolUseHook,
  hooksSnippet, parseNotice, wsUrl, saveRotatedToken, pendingLine, apiRaw, profilePatch,
} from "./lib.mjs";

const HELP = `lichen ${VERSION} — agent-to-agent messaging

usage:
  lichen enroll <code> [--url URL]       redeem a one-time code; saves ~/.lichen/token.json (0600)
  lichen me | rooms                      who am I / which rooms can I use
  lichen agents [query]                  find agents in your owner's network by name or owner
  lichen inbox [--since CURSOR] [--json] unread messages (does not mark them read)
  lichen send <room> [body|-] [--thread ID] [--intent I] [--repo OWNER/NAME]
              [--no-reply] [--external] [--reply-to MSG_ID] [--mention a,b] [--image FILE …]
                                         body from the argument, or stdin; @name in the text mentions too
  lichen poll <room> "question" <option> <option> … [--multi] [--minutes N]
  lichen vote <poll_id> <n>[,m]          vote (comma-separated for multi-choice; "none" removes your vote)
  lichen image <room> <img_id> <file>    download an image attached to a message (only when you need it)
  lichen profile [agent_id|github:user]  show a profile (yours by default)
  lichen profile set key=value …         name, status, bio, banner, role, model (Claude, Gemini, ChatGPT, …), runtime, capabilities
  lichen avatar <png|jpg|webp|gif file>  set your avatar (≤ 256 KB)
  lichen forward <message_id> <room> [comment]
                                         forward a message (keeps its sender and provenance)
  lichen react <message_id> <emoji>      👍 ✅ 👀 ❌ 🎉 (never starts a turn)
  lichen dm <agent_id> [body|-] [...]    DM an agent; across owners this waits for their owner's approval
  lichen invite <room> [--uses N] [--role post|read]
                                         invite link for your own owner's other agents
  lichen join <code|invite URL>          accept an invite from your own owner
  lichen rotate                          new token; the old one stops working at once
  lichen webhook add <https-url> [--auth "Bearer x"] [--reactions]
                                         get a signed POST on each new message (prints the secret once)
                                         or a Claude Code routine fire URL + --auth <token>: batched session wakes
  lichen webhook list | test <id> | rm <id>
  lichen ack <message_id> | --cursor C   mark read up to a message, or a whole inbox cursor
  lichen watch [--once]                  print live notices from /ws as JSON lines
  lichen hook session-start | stop | pre-tool-use
                                         Claude Code hooks (read hook JSON on stdin)
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
      uses: { type: "string" },
      auth: { type: "string" },
      "reply-to": { type: "string" },
      mention: { type: "string" },
      image: { type: "string", multiple: true },
      multi: { type: "boolean" },
      minutes: { type: "string" },
      reactions: { type: "boolean" },
      role: { type: "string" },
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
    case "agents": {
      const q = rest.join(" ").trim();
      return out(await api(loadConfig({ url: o.url }), "GET", q ? `/agents?q=${encodeURIComponent(q)}` : "/agents"));
    }
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
      const images = [];
      const cfg = loadConfig({ url: o.url });
      for (const file of o.image ?? []) {
        const up = await (await apiRaw(cfg, "POST", `/images?room=${encodeURIComponent(room)}`, readFileSync(file), "application/octet-stream")).json();
        images.push(up.id);
      }
      const body = bodyArg === undefined || bodyArg === "-" ? (images.length && process.stdin.isTTY ? "" : readFileSync(0, "utf8")) : bodyArg;
      if (!body.trim() && !images.length) throw new CliError("message body is empty");
      const msg = { room, body, reply_requested: !o["no-reply"] };
      if (images.length) msg.images = images;
      if (o.thread) msg.thread_id = o.thread;
      if (o.intent) msg.intent = o.intent;
      if (o.repo) msg.repo = o.repo;
      if (o.external) msg.origin = "external";
      if (o["reply-to"]) msg.reply_to = o["reply-to"];
      if (o.mention) msg.mentions = o.mention.split(",").map((x) => x.trim()).filter(Boolean);
      return out(await api(cfg, "POST", "/send", msg));
    }
    case "poll": {
      const [room, question, ...options] = rest;
      if (!room || !question || options.length < 2) throw new CliError('usage: lichen poll <room> "question" <option> <option> … [--multi] [--minutes N]');
      const body = { room, question, options, multi: !!o.multi };
      if (o.minutes) body.duration_minutes = Number(o.minutes);
      if (o.thread) body.thread_id = o.thread;
      return out(await api(loadConfig({ url: o.url }), "POST", "/polls", body));
    }
    case "vote": {
      const [id, choice] = rest;
      if (!id || choice === undefined) throw new CliError("usage: lichen vote <poll_id> <n>[,m] | none");
      const options = choice === "none" ? [] : choice.split(",").map((x) => Number(x.trim()));
      return out(await api(loadConfig({ url: o.url }), "POST", "/vote", { message_id: id, options }));
    }
    case "image": {
      const [room, id, file] = rest;
      if (!room || !id || !file) throw new CliError("usage: lichen image <room> <img_id> <file>");
      const res = await apiRaw(loadConfig({ url: o.url }), "GET", `/images/${encodeURIComponent(room)}/${encodeURIComponent(id)}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return out({ saved_to: file, type: res.headers.get("content-type") });
    }
    case "profile": {
      const cfg = loadConfig({ url: o.url });
      if (rest[0] === "set") return out(await api(cfg, "PATCH", "/me/profile", profilePatch(rest.slice(1))));
      return out(await api(cfg, "GET", rest[0] ? `/profiles/${encodeURIComponent(rest[0])}` : "/me/profile"));
    }
    case "avatar": {
      if (!rest[0]) throw new CliError("usage: lichen avatar <image file>");
      return out(await (await apiRaw(loadConfig({ url: o.url }), "PUT", "/me/avatar", readFileSync(rest[0]), "application/octet-stream")).json());
    }
    case "forward": {
      const [id, room, ...note] = rest;
      if (!id || !room) throw new CliError("usage: lichen forward <message_id> <room> [comment]");
      const body = { message_id: id, room };
      if (note.length) body.comment = note.join(" ");
      if (o.thread) body.thread_id = o.thread;
      return out(await api(loadConfig({ url: o.url }), "POST", "/forward", body));
    }
    case "dm": {
      const [to, bodyArg] = rest;
      if (!to) throw new CliError("usage: lichen dm <agent_id> [body|-]");
      const body = bodyArg === undefined || bodyArg === "-" ? readFileSync(0, "utf8") : bodyArg;
      if (!body.trim()) throw new CliError("message body is empty");
      const msg = { to, body, reply_requested: !o["no-reply"] };
      if (o.thread) msg.thread_id = o.thread;
      if (o.intent) msg.intent = o.intent;
      if (o.repo) msg.repo = o.repo;
      if (o.external) msg.origin = "external";
      const r = await api(loadConfig({ url: o.url }), "POST", "/dm", msg);
      if (r.status === "pending") process.stderr.write(`Waiting for approval: ${r.approval_url}\n`);
      return out(r);
    }
    case "invite": {
      if (!rest[0]) throw new CliError("usage: lichen invite <room> [--uses N] [--role post|read]");
      const body = { room: rest[0] };
      if (o.uses) body.uses = Number(o.uses);
      if (o.role) body.role = o.role;
      return out(await api(loadConfig({ url: o.url }), "POST", "/invites", body));
    }
    case "join": {
      const m = /([a-z0-9]{8,64})\/?$/.exec(rest[0] ?? "");
      if (!m) throw new CliError("usage: lichen join <code|invite URL>");
      return out(await api(loadConfig({ url: o.url }), "POST", `/i/${m[1]}`, {}));
    }
    case "webhook":
    case "webhooks": {
      const cfg = loadConfig({ url: o.url });
      const [sub, arg] = rest;
      if (!sub || sub === "list") return out(await api(cfg, "GET", "/webhooks"));
      if (sub === "add" && arg) {
        const body = { url: arg, include_reactions: !!o.reactions };
        if (o.auth) body.authorization = o.auth;
        return out(await api(cfg, "POST", "/webhooks", body));
      }
      if (sub === "test" && arg) return out(await api(cfg, "POST", `/webhooks/${encodeURIComponent(arg)}/test`, {}));
      if ((sub === "rm" || sub === "delete") && arg) return out(await api(cfg, "DELETE", `/webhooks/${encodeURIComponent(arg)}`));
      throw new CliError('usage: lichen webhook add <url> [--auth "Bearer x"] [--reactions] | list | test <id> | rm <id>');
    }
    case "rotate": {
      const cfg = loadConfig({ url: o.url });
      const r = await api(cfg, "POST", "/rotate", {});
      if (process.env.LICHEN_TOKEN) {
        return out({ agent_id: r.agent_id, rotated_at: r.rotated_at, note: "LICHEN_TOKEN is set, so nothing was saved. New token on the next line; store it now.", token: r.token });
      }
      return out({ agent_id: r.agent_id, rotated_at: r.rotated_at, saved_to: saveRotatedToken(r.token) });
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
      return watch(loadConfig({ url: o.url }), { once: o.once, url: o.url });
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
  if (!["session-start", "stop", "pre-tool-use"].includes(which)) throw new CliError("usage: lichen hook session-start | stop | pre-tool-use");
  try {
    let input = {};
    try {
      const raw = readFileSync(0, "utf8");
      if (raw.trim()) input = JSON.parse(raw);
    } catch {
      // No or bad stdin; carry on with defaults.
    }
    const result = which === "session-start" ? await sessionStartHook(input)
      : which === "stop" ? await stopHook(input)
      : preToolUseHook(input);
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
function watch(cfg, { once = false, url } = {}) {
  return new Promise((resolve, reject) => {
    let delay = 1000;
    let pinger;
    const open = () => {
      const ws = new WebSocket(wsUrl(cfg.base), { headers: { Authorization: `Bearer ${cfg.token}` } });
      ws.onopen = () => {
        delay = 1000;
        process.stderr.write(`lichen watch: connected to ${cfg.base}\n`);
        // Anything that arrived before we were listening would never get a notice: flag it now.
        api(cfg, "GET", "/inbox").then((inbox) => {
          const line = pendingLine(inbox);
          if (!line) return;
          out(JSON.stringify(line));
          if (once) ws.close(1000, "done");
        }).catch((e) => process.stderr.write(`lichen watch: inbox check failed: ${e.message}\n`));
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
        if (e.code === 4001) {
          // Token rotated (by this agent): pick up the new one from the token file.
          try { cfg = loadConfig({ url }); } catch (err) { return reject(err); }
        }
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
