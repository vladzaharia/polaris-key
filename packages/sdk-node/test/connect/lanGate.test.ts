// @pkey-feature connect.lan
// The accept gate the LAN transports share (CC-15.N2; lanGate.ts): the verdict on the socket's own
// addresses before a byte is read, the pending limits per address, the handshake window that ends
// at `established()`, and the dual-stack listener.
import { connect as tcp, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcceptGate,
  listenTcp,
  type GateSlot,
} from "../../src/connect/lanGate.js";
import { sleep, until } from "../lanFixtures.js";

let servers: Server[] = [];
let clients: Socket[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.destroy();
  for (const s of servers.splice(0)) s.close();
});

/** A listener whose accepted sockets go through `gate`; the slots and the sockets it admitted. */
async function serve(
  gate: AcceptGate,
  refuse = false,
): Promise<{ port: number; slots: GateSlot[]; accepted: Socket[] }> {
  const slots: GateSlot[] = [];
  const accepted: Socket[] = [];
  const server = await listenTcp("127.0.0.1", 0, (s) => {
    const slot = gate.admit(s, refuse);
    if (slot !== null) {
      slots.push(slot);
      accepted.push(s);
    }
  });
  servers.push(server);
  return { port: (server.address() as { port: number }).port, slots, accepted };
}

function dial(port: number): Socket {
  const s = tcp({ host: "127.0.0.1", port });
  s.on("error", () => undefined);
  clients.push(s);
  return s;
}

const closed = (s: Socket): Promise<void> =>
  new Promise((r) => (s.destroyed ? r() : s.once("close", () => r())));

describe("the accept gate", () => {
  it("closes a loopback source unless loopback is allowed", async () => {
    const { port, slots } = await serve(new AcceptGate());
    const c = dial(port);
    await closed(c);
    expect(slots).toHaveLength(0);
  });

  it("admits a loopback source when allowed and takes its slot", async () => {
    const gate = new AcceptGate({ allowLoopback: true });
    const { port, slots } = await serve(gate);
    dial(port);
    await until(() => slots.length === 1);
    expect(gate.size).toBe(1);
    expect(slots[0]!.address).toBe("127.0.0.1");
  });

  it("closes a connection that is refused for capacity before it is read", async () => {
    const { port, slots } = await serve(
      new AcceptGate({ allowLoopback: true }),
      true,
    );
    await closed(dial(port));
    expect(slots).toHaveLength(0);
  });

  it("limits sockets per source address and frees a slot on settle", async () => {
    const gate = new AcceptGate({
      allowLoopback: true,
      maxPendingPerAddress: 1,
    });
    const { port, slots } = await serve(gate);
    dial(port);
    await until(() => slots.length === 1);
    const second = dial(port);
    await closed(second);
    expect(slots).toHaveLength(1);
    slots[0]!.settle();
    expect(gate.size).toBe(0);
    dial(port);
    await until(() => slots.length === 2);
  });

  it("frees the slot when the socket closes", async () => {
    const gate = new AcceptGate({ allowLoopback: true });
    const { port, slots, accepted } = await serve(gate);
    dial(port);
    await until(() => slots.length === 1);
    accepted[0]!.destroy();
    await until(() => gate.size === 0);
  });

  it("destroys a socket that never reaches the transport, and spares one that did", async () => {
    const gate = new AcceptGate({ allowLoopback: true, handshakeMs: 60 });
    const { port, slots, accepted } = await serve(gate);
    const a = dial(port);
    const b = dial(port);
    await until(() => slots.length === 2);
    const up = accepted.findIndex((s) => s.remotePort === b.localPort);
    slots[up]!.established();
    await closed(a);
    await sleep(100);
    expect(b.destroyed).toBe(false);
    gate.destroyPending({ keepUp: true });
    await sleep(20);
    expect(b.destroyed).toBe(false);
    gate.destroyPending();
    await closed(b);
  });
});

describe("listenTcp", () => {
  it("listens on a random port on the host it is given", async () => {
    const s = await listenTcp("127.0.0.1", 0, (c) => c.destroy());
    servers.push(s);
    const a = s.address() as { port: number; address: string };
    expect(a.address).toBe("127.0.0.1");
    expect(a.port).toBeGreaterThan(0);
  });

  it("with no host listens dual-stack, or on IPv4 where IPv6 is missing", async () => {
    const s = await listenTcp(undefined, 0, (c) => c.destroy());
    servers.push(s);
    expect(["::", "0.0.0.0"]).toContain(
      (s.address() as { address: string }).address,
    );
  });
});
