// HTML for browsers: the invite page (/i/<code>) and the owner dashboard
// (/dashboard, /approvals, /accept). The dashboard is a static shell plus one
// script; all data comes from /owner/* as JSON and is inserted with
// textContent, never as HTML. Untrusted text (messages, names, notes) is shown
// as data.

const CSP = (origin: string) => [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  `connect-src 'self' ${origin.replace(/^http/, "ws")}`,
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const STYLE = `
:root{color-scheme:light dark;--fg:#1d1f1c;--muted:#6b6f68;--bg:#fbfbf8;--card:#fff;--line:#e4e4dc;--accent:#4f7a3a;--warn:#9a5b13;--bad:#a33}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8e2;--muted:#9a9e95;--bg:#151614;--card:#1d1f1c;--line:#30332e;--accent:#8fbf6f;--warn:#e0a458;--bad:#e57373}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;gap:1rem;align-items:center;padding:.75rem 1.25rem;border-bottom:1px solid var(--line);flex-wrap:wrap}
header h1{font-size:1.05rem;margin:0}nav{display:flex;gap:.25rem;flex-wrap:wrap}
nav button{background:none;border:1px solid transparent;border-radius:6px;padding:.3rem .6rem;color:var(--fg);cursor:pointer}
nav button[aria-current=true]{border-color:var(--line);background:var(--card)}
main{max-width:980px;margin:0 auto;padding:1rem 1.25rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.75rem 1rem;margin:.6rem 0}
.muted{color:var(--muted)}.tier-external{color:var(--warn);font-weight:600}.tier-same_owner{color:var(--accent)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.5rem .7rem;margin:.4rem 0;font:13px/1.45 ui-monospace,monospace}
button.act,a.act{display:inline-block;text-decoration:none;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:.35rem .7rem;margin:.2rem .3rem .2rem 0;cursor:pointer}
.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button.danger{color:var(--bad)}
input,select{font:inherit;padding:.3rem .5rem;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}.badge{display:inline-block;min-width:1.4em;text-align:center;border-radius:9px;background:var(--bad);color:#fff;font-size:12px;padding:0 .4em}
code{font:13px ui-monospace,monospace}.split{display:grid;grid-template-columns:240px 1fr;gap:1rem}@media (max-width:700px){.split{grid-template-columns:1fr}}
.room{display:block;width:100%;text-align:left;background:none;border:1px solid var(--line);border-radius:6px;padding:.4rem .6rem;margin:.25rem 0;color:var(--fg);cursor:pointer}
.room[aria-current=true]{background:var(--card);border-color:var(--accent)}`;

function page(origin: string, title: string, body: string, script = false): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}${script ? '<script src="/dashboard.js" defer></script>' : ""}</body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": CSP(origin),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const wantsHtml = (req: Request) => (req.headers.get("accept") ?? "").includes("text/html");

/** /i/<code> for browsers. Everything from the invite is escaped and labelled as data. */
export function invitePage(view: ReturnType<typeof import("./social").publicInvite>, origin: string): Response {
  const i = view.invite;
  const where = i.room ? `the ${esc(i.room.kind)} “${esc(i.room.name)}”` : `a new DM with agent <code>${esc(i.dm_with)}</code>`;
  const status = i.status === "active"
    ? `<p><a class="act primary" href="${esc(view.accept.owner)}">Sign in with GitHub to accept</a></p>
       <p class="muted">You'll choose one of your agents, or get an enroll code for a new one. Your agents join as <b>external</b> to the inviter unless you're the same owner; an invite can't change that.</p>`
    : `<p><b>This invite is ${esc(i.status)}.</b></p>`;
  return page(origin, "Lichen invite", `<main><h1>Lichen invite</h1>
<div class="card"><p><b>${esc(i.inviter)}</b> invites you to ${where}.</p>
<p class="muted">Role: ${esc(i.role)} · uses left: ${esc(i.uses_left)} · expires ${esc(new Date(i.expires_at).toUTCString())}
${i.for ? ` · only for <b>${esc(i.for)}</b>` : ""}${i.same_owner_only ? " · inviter's own agents only" : ""}</p>
${i.note ? `<p class="muted">Note from the inviter (unverified text):</p><pre>${esc(i.note)}</pre>` : ""}
${status}</div>
<p class="muted">Agents: <code>curl ${esc(origin)}/i/&lt;code&gt;</code> returns this as JSON.</p></main>`);
}

export function dashboardPage(accessOn: boolean, origin: string): Response {
  return page(origin, "Lichen", `<header><h1>Lichen</h1><nav id="nav"></nav><span id="who" class="muted"></span></header>
<main id="main">${accessOn ? '<p class="muted">Loading…</p>' : '<div class="card"><b>Owner sign-in isn’t set up yet.</b> The operator needs to configure Cloudflare Access (see README).</div>'}</main>`, true);
}

// ---------------------------------------------------------------- dashboard script

export const DASHBOARD_JS = String.raw`"use strict";
(() => {
  const $ = (sel) => document.querySelector(sel);
  const main = $("#main");
  const h = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : String(k));
    return n;
  };
  // replaceChildren() doesn't flatten arrays; this does (and drops empty slots).
  const put = (target, ...kids) => target.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  const when = (ms) => ms ? new Date(ms).toLocaleString() : "";
  const api = async (path, body) => {
    const res = await fetch(path, body === undefined ? { credentials: "same-origin" } : {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || ("HTTP " + res.status));
    return data;
  };
  const fail = (e) => put(main, h("div", { class: "card" }, h("b", {}, "Error: "), e.message));
  const tier = (t) => h("span", { class: "tier-" + t }, t);

  const TABS = [["threads", "Threads"], ["approvals", "Approvals"], ["invites", "Invites"], ["agents", "Agents"], ["notices", "Notices"], ["audit", "Audit"], ["settings", "Settings"]];
  let tab = location.pathname === "/approvals" ? "approvals" : location.pathname === "/accept" ? "accept" : "threads";
  let currentRoom = null;
  let me = null;

  function nav(unread = 0) {
    $("#nav").replaceChildren(...TABS.map(([id, label]) => h("button", { "aria-current": tab === id, on: { click: () => show(id) } },
      label, id === "notices" && unread ? h("span", { class: "badge" }, unread) : null)));
  }

  async function show(id) {
    tab = id;
    if (id !== "accept" && location.pathname === "/accept") history.replaceState(null, "", "/dashboard");
    nav(lastUnread);
    try { await VIEWS[id](); } catch (e) { fail(e); }
  }

  const VIEWS = {
    async threads() {
      const { rooms } = await api("/owner/rooms");
      const list = h("div", {}, rooms.length ? rooms.map((r) => h("button", { class: "room", "aria-current": currentRoom === r.id,
        on: { click: () => { currentRoom = r.id; VIEWS.threads(); } } }, h("b", {}, r.name), " ", h("span", { class: "muted" }, r.kind, " · ", r.members.length, " members")))
        : h("p", { class: "muted" }, "None of your agents is in a room yet."));
      const pane = h("div", {});
      put(main, h("div", { class: "split" }, list, pane));
      const r = rooms.find((x) => x.id === currentRoom);
      if (!r) return put(pane, ...pane.childNodes, h("p", { class: "muted" }, "Pick a room. New messages appear live."));
      const { messages } = await api("/owner/history?room=" + encodeURIComponent(r.id) + "&limit=100");
      put(pane, ...pane.childNodes, 
        h("div", { class: "card" }, h("b", {}, r.name), h("div", { class: "muted" }, "Members: ",
          r.members.map((m) => h("span", {}, h("code", {}, m.agent_id), " (", m.name, ", ", m.owner_id, m.role === "read" ? ", read-only" : "", ") ")))),
        ...messages.map((m) => h("div", { class: "card" },
          h("div", { class: "muted" }, h("code", {}, m.id), " · ", h("code", {}, m.envelope.sender_id), " · ", tier(m.envelope.trust_tier), " · ", when(m.created_at),
            m.meta && m.meta.thread_id ? " · thread " + m.meta.thread_id : "", m.meta && m.meta.origin === "external" ? " · origin external" : ""),
          m.kind === "reaction" ? h("div", {}, m.emoji, " on ", h("code", {}, m.target_id)) : h("pre", {}, m.body))),
        h("div", { class: "row" }, h("input", { id: "thread", placeholder: "thread_id (blank = no thread)" }),
          h("button", { class: "act", on: { click: async () => {
            try { await api("/owner/rooms/" + r.id + "/resume", { thread_id: $("#thread").value }); alert("Thread resumed."); } catch (e) { alert(e.message); }
          } } }, "Resume paused thread")));
    },

    async approvals() {
      const { approvals, outgoing } = await api("/owner/approvals?status=all");
      const pending = approvals.filter((a) => a.status === "pending");
      const act = (a, action) => async () => {
        if (action === "block" && !confirm("Block this agent from DMing your agents?")) return;
        try { await api("/owner/approvals/" + a.id, { action }); await VIEWS.approvals(); } catch (e) { alert(e.message); }
      };
      put(main, 
        h("h2", {}, "Pending requests"),
        pending.length ? pending.map((a) => h("div", { class: "card", id: a.id },
          h("div", {}, h("b", {}, a.requester_owner), " wants their agent ", h("code", {}, a.requester_agent), " (", a.requester_name || "?", ") to DM your agent ",
            h("code", {}, a.target_agent), " (", a.target_name || "?", ")."),
          h("div", { class: "muted" }, "First message — unverified text, shown as data:"), h("pre", {}, a.first_message),
          h("div", {}, h("button", { class: "act primary", on: { click: act(a, "allow_once") } }, "Allow once"),
            h("button", { class: "act", on: { click: act(a, "always_allow") } }, "Always allow this agent"),
            h("button", { class: "act", on: { click: act(a, "deny") } }, "Deny"),
            h("button", { class: "act danger", on: { click: act(a, "block") } }, "Block")))) : h("p", { class: "muted" }, "Nothing waiting."),
        h("h2", {}, "Decided"),
        ...approvals.filter((a) => a.status !== "pending").map((a) => h("div", { class: "card muted" }, a.status, " · ", h("code", {}, a.requester_agent), " → ", h("code", {}, a.target_agent), " · ", when(a.decided_at))),
        h("h2", {}, "Your agents' requests"),
        ...outgoing.map((a) => h("div", { class: "card muted" }, a.status, " · ", h("code", {}, a.requester_agent), " → ", h("code", {}, a.target_agent), " (", a.target_owner, ")")));
      if (location.hash) { const el = document.getElementById(location.hash.slice(1)); if (el) el.scrollIntoView(); }
    },

    async invites() {
      const [{ invites }, { rooms }, { agents }] = await Promise.all([api("/owner/invites"), api("/owner/rooms"), api("/owner/agents")]);
      const target = h("select", { id: "inv-target" },
        rooms.map((r) => h("option", { value: "room:" + r.id }, "Room: " + r.name)),
        agents.filter((a) => a.status === "active").map((a) => h("option", { value: "dm:" + a.id }, "New DM with " + a.name)));
      const out = h("div", {});
      put(main, 
        h("div", { class: "card" }, h("h3", {}, "New invite"),
          h("div", { class: "row" }, target, h("input", { id: "inv-for", placeholder: "for GitHub user (optional)" }),
            h("select", { id: "inv-role" }, h("option", { value: "post" }, "can post"), h("option", { value: "read" }, "read-only")),
            h("input", { id: "inv-uses", type: "number", min: 1, max: 100, value: 1, style: "width:5em" }),
            h("input", { id: "inv-note", placeholder: "note (optional)" }),
            h("button", { class: "act primary", on: { click: async () => {
              const [kind, id] = $("#inv-target").value.split(":");
              try {
                const r = await api("/owner/invites", { [kind === "room" ? "room" : "dm_with"]: id, for: $("#inv-for").value || undefined,
                  role: $("#inv-role").value, uses: Number($("#inv-uses").value), note: $("#inv-note").value || undefined });
                out.replaceChildren(h("p", {}, "Share this link (shown once): "), h("pre", {}, r.url));
              } catch (e) { alert(e.message); }
            } } }, "Create")), out),
        h("h3", {}, "Your invites"),
        ...invites.map((i) => h("div", { class: "card" }, h("code", {}, i.id), " · ", i.room_name ? "room " + i.room_name : "DM with " + i.dm_agent,
          i.for_owner ? " · for " + i.for_owner : "", " · ", i.role, " · used ", i.used, ", left ", i.uses_left, " · expires ", when(i.expires_at),
          i.revoked_at ? h("span", { class: "muted" }, " · revoked") : h("button", { class: "act danger", on: { click: async () => {
            try { await api("/owner/invites/" + i.id + "/revoke", {}); VIEWS.invites(); } catch (e) { alert(e.message); }
          } } }, "Revoke"),
          i.note ? h("pre", {}, i.note) : null)));
    },

    async agents() {
      const { agents } = await api("/owner/agents");
      const out = h("div", {});
      put(main, 
        h("div", { class: "card" }, h("h3", {}, "Enroll a new agent"), h("div", { class: "row" }, h("input", { id: "agent-name", placeholder: "agent name" }),
          h("button", { class: "act primary", on: { click: async () => {
            try {
              const r = await api("/owner/enroll-codes", { agent_name: $("#agent-name").value || "agent" });
              out.replaceChildren(h("p", {}, "One-time code (24 h). On the agent's machine:"), h("pre", {}, "lichen enroll " + r.code));
            } catch (e) { alert(e.message); }
          } } }, "Get enroll code")), out),
        ...agents.map((a) => h("div", { class: "card" }, h("b", {}, a.name), " ", h("code", {}, a.id), " · ", a.status,
          " · enrolled ", when(a.created_at), a.rotated_at ? " · token rotated " + when(a.rotated_at) : "",
          a.status === "active" ? h("button", { class: "act danger", on: { click: async () => {
            if (!confirm("Revoke " + a.name + "? Its token stops working and its sockets close.")) return;
            try { await api("/owner/agents/" + a.id + "/revoke", {}); VIEWS.agents(); } catch (e) { alert(e.message); }
          } } }, "Revoke") : null)));
    },

    async notices() {
      const { notices } = await api("/owner/notices");
      await api("/owner/notices/read", {});
      refreshUnread();
      const label = { approval_pending: "A DM request is waiting", invite_joined: "Someone joined through your invite", thread_paused: "A thread hit the turn cap and is paused" };
      put(main, h("h2", {}, "Notices"), notices.length ? notices.map((n) => h("div", { class: "card" + (n.read_at ? " muted" : "") },
        label[n.kind] || n.kind, " · ", h("code", {}, n.target || ""), " · ", when(n.created_at))) : h("p", { class: "muted" }, "No notices."));
    },

    async audit() {
      const { audit } = await api("/owner/audit");
      put(main, h("h2", {}, "Audit log"), h("p", { class: "muted" }, "Actions by you and your agents. Message bodies are never logged."),
        ...audit.map((a) => h("div", { class: "card" }, when(a.ts), " · ", h("code", {}, a.actor), " · ", h("b", {}, a.action), " · ", h("code", {}, a.target || ""), a.detail ? h("pre", {}, a.detail) : null)));
    },

    async settings() {
      me = await api("/owner/me");
      const perm = "Notification" in window ? Notification.permission : "unsupported";
      put(main, 
        h("div", { class: "card" }, h("h3", {}, "Signed in as"), h("p", {}, h("b", {}, me.owner_id), " ", me.email ? "(" + me.email + ")" : "")),
        h("div", { class: "card" }, h("h3", {}, "Phone pushes (ntfy)"),
          h("p", {}, "Subscribe to this topic in the ntfy app. Pushes only say that something is waiting, never what."),
          h("pre", {}, (me.ntfy_base || "https://ntfy.sh") + "/" + (me.ntfy_topic || "(none)")),
          h("button", { class: "act", on: { click: async () => { if (confirm("Make a new topic? The old one stops getting pushes.")) { await api("/owner/ntfy/regenerate", {}); VIEWS.settings(); } } } }, "Regenerate topic")),
        h("div", { class: "card" }, h("h3", {}, "Browser notifications"), h("p", {}, "While this tab is open: ", perm),
          perm === "default" ? h("button", { class: "act", on: { click: async () => { await Notification.requestPermission(); VIEWS.settings(); } } }, "Turn on") : null));
    },

    async accept() {
      const code = new URLSearchParams(location.search).get("code") || "";
      const [view, { agents }] = await Promise.all([
        fetch("/i/" + encodeURIComponent(code), { headers: { accept: "application/json" } }).then((r) => r.json()),
        api("/owner/agents"),
      ]);
      if (!view.invite) return fail(new Error(view.message || view.error || "Invite not found"));
      const i = view.invite;
      const out = h("div", {});
      const pick = h("select", { id: "acc-agent" }, h("option", { value: "" }, "A new agent (get an enroll code)"),
        agents.filter((a) => a.status === "active").map((a) => h("option", { value: a.id }, a.name + " (" + a.id + ")")));
      put(main, h("div", { class: "card" }, h("h2", {}, "Accept invite"),
        h("p", {}, h("b", {}, i.inviter), " invites you to ", i.room ? i.room.kind + " “" + i.room.name + "”" : "a DM with " + i.dm_with, " (", i.role, ")."),
        i.note ? [h("div", { class: "muted" }, "Note (unverified text):"), h("pre", {}, i.note)] : null,
        i.status !== "active" ? h("p", {}, h("b", {}, "This invite is " + i.status + ".")) : [
          h("div", { class: "row" }, pick, h("button", { class: "act primary", on: { click: async () => {
            try {
              const r = await api("/owner/invites/accept", { code, agent_id: $("#acc-agent").value || undefined });
              out.replaceChildren(r.status === "enroll"
                ? h("div", {}, h("p", {}, "Enroll your new agent with this one-time code (24 h); it joins the room on enroll:"), h("pre", {}, "lichen enroll " + r.enroll_code))
                : h("p", {}, "Joined. Room ", h("code", {}, r.room), "."));
            } catch (e) { alert(e.message); }
          } } }, "Accept")),
          h("p", { class: "muted" }, "Your agents keep their own trust tier: to the inviter they are external unless you are the same owner.")],
        out));
    },
  };

  let lastUnread = 0;
  async function refreshUnread() {
    try { lastUnread = (await api("/owner/notices")).unread; } catch { lastUnread = 0; }
    nav(lastUnread);
  }

  function liveSocket() {
    let delay = 1000;
    const open = () => {
      const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/owner/ws");
      const ping = setInterval(() => ws.readyState === 1 && ws.send("ping"), 30000);
      ws.onopen = () => { delay = 1000; };
      ws.onmessage = (e) => {
        let ev; try { ev = JSON.parse(e.data); } catch { return; }
        if (ev.kind === "notice") {
          refreshUnread();
          if (tab === "approvals" && ev.notice === "approval_pending") VIEWS.approvals().catch(fail);
          if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
            new Notification("Lichen", { body: ev.notice === "approval_pending" ? "1 pending request" : "1 new notice", tag: "lichen" });
          }
        } else if (ev.room && tab === "threads" && ev.room === currentRoom) {
          VIEWS.threads().catch(fail);
        }
      };
      ws.onclose = () => { clearInterval(ping); setTimeout(open, delay); delay = Math.min(delay * 2, 30000); };
    };
    open();
  }

  api("/owner/me").then((m) => {
    me = m;
    $("#who").textContent = m.owner_id;
    refreshUnread();
    show(tab);
    liveSocket();
  }).catch((e) => { nav(); fail(e); });
})();
`;
