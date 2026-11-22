// One Durable Object per agent. It holds that agent's live WebSockets and
// nothing else: messages stay in the room DOs, read markers stay in D1.
//
// Sockets use the WebSocket Hibernation API, so an idle connection costs no
// duration charges. "ping" text frames are answered by the runtime without
// waking the object.
//
// Reachable only through the Worker, which authenticates the token before
// forwarding /ws here, and from room DOs, which call notify().

import { DurableObject } from "cloudflare:workers";
import type { Env, Notice } from "./env";

/** Per-agent cap on open sockets. The oldest is closed to make room. */
export const MAX_SOCKETS = 5;

/** Application close codes (4000–4999). */
export const CLOSE_REPLACED = 4000;
export const CLOSE_REVOKED = 4003;

interface Attachment {
  connected_at: number;
}

export class AgentSocket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** WebSocket upgrade, forwarded by the Worker after it checked the token. */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const open = this.sockets().sort((a, b) => connectedAt(a) - connectedAt(b));
    for (const old of open.slice(0, Math.max(0, open.length - (MAX_SOCKETS - 1)))) {
      safeClose(old, CLOSE_REPLACED, "too many sockets for this agent");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connected_at: Date.now() } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Push a notice to every open socket. Returns how many got it. */
  async notify(notice: Notice): Promise<number> {
    const frame = JSON.stringify(notice);
    let sent = 0;
    for (const ws of this.sockets()) {
      try {
        ws.send(frame);
        sent++;
      } catch {
        // Socket already closing; /inbox still has the message.
      }
    }
    return sent;
  }

  /** Close everything, e.g. when the agent's token is revoked. */
  async closeAll(code = CLOSE_REVOKED, reason = "revoked"): Promise<number> {
    const open = this.sockets();
    for (const ws of open) safeClose(ws, code, reason);
    return open.length;
  }

  async socketCount(): Promise<number> {
    return this.sockets().length;
  }

  // Clients have nothing to say over the socket besides "ping" (auto-answered).
  // Everything else is ignored; agents act through the HTTP API.
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    safeClose(ws, code === 1005 ? 1000 : code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    safeClose(ws, 1011, "error");
  }

  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }
}

function connectedAt(ws: WebSocket): number {
  return (ws.deserializeAttachment() as Attachment | null)?.connected_at ?? 0;
}

function safeClose(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}
