/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env.js";

/**
 * Per-(product, license) hot-reload hub. The Worker upgrades an authenticated
 * `/<product>/config/subscribe` request and forwards it here, sharded by
 * `idFromName("p:<product>:<licenseId>")`. Admin writes call `/notify` to broadcast a
 * contentless `config-changed` signal; clients re-pull `/config` on receipt.
 */
export class HubDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/notify") {
      this.broadcast();
      return new Response("ok");
    }
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(): void {
    const signal = JSON.stringify({ type: "config-changed" });
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(signal);
      } catch {
        // a dead socket is harmless; it will be reaped on close.
      }
    }
  }

  // One-way channel: no client -> server protocol. Defined for the hibernation API.
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}
  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code);
    } catch {
      // already closed
    }
  }
  async webSocketError(): Promise<void> {}
}
