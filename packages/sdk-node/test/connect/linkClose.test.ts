// @pkey-feature connect.lan
// How a link ends itself (WIRE-CONTRACT-V5 §15.6): the handshake deadline is `peer_timeout`, not
// `handshake_failed`, and a zero-length frame closes `peer_bad_frame` whether or not the session
// is established, with the CLOSE going out first when the transport exists.
import {
  createServer,
  connect as tcp,
  type Server,
  type Socket,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  LanError,
  SocketLink,
  WRITE_MAX_BYTES,
  type SessionClosed,
} from "../../src/connect/session.js";
import { until } from "../lanFixtures.js";

let servers: Server[] = [];
let sockets: Socket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
});

/** A listener that accepts and never answers. */
async function silentPort(): Promise<number> {
  const server = createServer((x) => sockets.push(x));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as { port: number }).port;
}

async function dial(port: number): Promise<Socket> {
  const s = tcp({ host: "127.0.0.1", port });
  sockets.push(s);
  await new Promise<void>((r) => s.once("connect", () => r()));
  return s;
}

const channel = {
  mode: "v" as const,
  role: "initiator" as const,
  slug: "demo",
  staticKey: new Uint8Array(32).fill(1),
  hello: { platform: "linux", app: "demo" },
};

describe("the link deadline", () => {
  it("reports peer_timeout to a host that owns the session (modes v and p)", async () => {
    const socket = await dial(await silentPort());
    let closed: SessionClosed | null = null;
    new SocketLink({
      socket,
      channel,
      handshakeMs: 60,
      onEvent: () => undefined,
      onClosed: (c) => (closed = c),
    });
    await until(() => closed !== null, 2000);
    expect(closed).toEqual({ code: "peer_timeout", byPeer: false });
  });

  it("rejects `opened` with the close code peer_timeout, not a handshake failure code", async () => {
    const socket = await dial(await silentPort());
    const link = new SocketLink({ socket, channel, handshakeMs: 60 });
    const err = await link.opened.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LanError);
    expect(err).toMatchObject({
      reason: "handshake_failed",
      closeCode: "peer_timeout",
    });
  });
});

describe("a zero-length frame before the transport", () => {
  it("closes the link peer_bad_frame", async () => {
    const socket = await dial(await silentPort());
    const link = new SocketLink({ socket, channel, handshakeMs: 5000 });
    socket.emit("data", Buffer.from([0, 0]));
    await expect(link.opened).rejects.toMatchObject({
      closeCode: "peer_bad_frame",
    });
  });
});

describe("the TCP write bound", () => {
  it("lan: a peer that does not read is closed peer_busy at the write bound", async () => {
    const socket = await dial(await silentPort());
    // The socket reports more unsent bytes than the bound allows, as it does for a peer that
    // never reads.
    Object.defineProperty(socket, "writableLength", {
      get: () => WRITE_MAX_BYTES + 1,
    });
    let closed: SessionClosed | null = null;
    const link = new SocketLink({
      socket,
      channel,
      handshakeMs: 5000,
      onEvent: () => undefined,
      onClosed: (c) => (closed = c),
    });
    void link.channel.start();
    await until(() => closed !== null, 2000);
    expect(closed).toEqual({ code: "peer_busy", byPeer: false });
    expect(socket.destroyed).toBe(true);
  });
});
