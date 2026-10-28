// A faithful in-process relay for the Cloud Connect tests (CC-08.3). The worker package cannot be
// imported here, so this room re-implements the CC-07 engine's observable framing (WIRE-CONTRACT-V5
// §15.7) over client-core's own envelope codec: a ticket is single use and names the device;
// `from` is stamped from the admission, never read from the client; SEND reaches the sockets of
// `to`; LIST answers MEMBERS; PING answers PONG; an envelope that fails its layout closes 1008.
import {
  decodeRelay,
  deviceIdBytes,
  encodeRelay,
  type RelayMessage,
} from "@polaris-key/client-core/peer";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import type { RelaySocket } from "../src/connect/relay.js";
import type { MultiWorker } from "./lanFixtures.js";

export class FakeSock implements RelaySocket {
  binaryType = "blob";
  onopen: RelaySocket["onopen"] = null;
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  device: string | null = null;
  open = false;
  closed = false;
  closeCode: number | null = null;

  constructor(
    readonly room: FakeRoom,
    readonly url: string,
    readonly protocols: string[],
  ) {
    setTimeout(() => room.admit(this), 0);
  }

  send(data: Uint8Array): void {
    if (!this.open) throw new Error("not open");
    this.room.fromClient(this, data);
  }

  /** The client closed. */
  close(code = 1000): void {
    if (this.closed) return;
    this.shut(code);
  }

  /** Either side closes: the client's `onclose` fires with `code`. */
  shut(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.closeCode = code;
    this.room.sockets = this.room.sockets.filter((s) => s !== this);
    setTimeout(() => this.onclose?.({ code }), 0);
  }

  deliver(m: RelayMessage | Uint8Array): void {
    if (!this.open) return;
    const bytes = m instanceof Uint8Array ? m : encodeRelay(m);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    setTimeout(() => this.onmessage?.({ data: buf }), 0);
  }
}

export class FakeRoom {
  sockets: FakeSock[] = [];
  everOpened: FakeSock[] = [];
  /** Every message a client sent, decoded, with the device that sent it. */
  received: { device: string; msg: RelayMessage }[] = [];
  /** The `Sec-WebSocket-Protocol` lists clients offered, in order. */
  offered: string[][] = [];
  /** Close the next admission with this code. */
  rejectWith: number | null = null;

  constructor(private readonly worker: MultiWorker) {}

  webSocket = (url: string, protocols: string[]): RelaySocket => {
    const s = new FakeSock(this, url, protocols);
    this.everOpened.push(s);
    return s;
  };

  admit(s: FakeSock): void {
    this.offered.push(s.protocols);
    const [proto, ticket] = s.protocols;
    if (this.rejectWith !== null) {
      const c = this.rejectWith;
      this.rejectWith = null;
      return s.shut(c);
    }
    const device =
      ticket === undefined ? undefined : this.worker.tickets.get(ticket);
    if (proto !== "pkey-relay.1" || device === undefined) return s.shut(4001);
    this.worker.tickets.delete(ticket!); // single use
    if (!this.worker.members.has(device)) return s.shut(4003);
    s.device = device;
    // A third socket of a device replaces the oldest.
    const mine = this.sockets.filter((x) => x.device === device);
    if (mine.length >= 2) mine[0]!.shut(4009);
    s.open = true;
    this.sockets.push(s);
    s.onopen?.({});
  }

  fromClient(s: FakeSock, data: Uint8Array): void {
    const m = decodeRelay("toRoom", data);
    if (m === null) return s.shut(1008);
    this.received.push({ device: s.device!, msg: m });
    if (m.op === "send") {
      const to = base64UrlEncodeBytes(m.to);
      // `from` is the admitted device, whatever the client wrote.
      for (const t of this.sockets.filter((x) => x.device === to))
        t.deliver({
          op: "recv",
          from: deviceIdBytes(s.device!),
          session: m.session,
          noise: m.noise,
        });
    } else if (m.op === "list") s.deliver(this.members());
    else if (m.op === "ping") s.deliver({ op: "pong", data: m.data });
  }

  members(): RelayMessage {
    const ids = [...new Set(this.sockets.map((s) => s.device!))];
    return { op: "members", devices: ids.map((d) => deviceIdBytes(d)) };
  }

  /** Close every socket from the room's side. */
  dropAll(code: number): void {
    for (const s of [...this.sockets]) s.shut(code);
  }

  /** Tell every socket the roster is at `epoch`. */
  pushRing(epoch: number): void {
    for (const s of this.sockets) s.deliver({ op: "ring", epoch });
  }

  /** Put a RECV on a device's sockets as if `from` sent it. */
  inject(from: string, to: string, session: number, noise: Uint8Array): void {
    for (const t of this.sockets.filter((x) => x.device === to))
      t.deliver({ op: "recv", from: deviceIdBytes(from), session, noise });
  }

  /** SEND ops the clients wrote, from one device. */
  sends(device: string): Extract<RelayMessage, { op: "send" }>[] {
    return this.received.flatMap((r) =>
      r.device === device && r.msg.op === "send" ? [r.msg] : [],
    );
  }
}

/** A timer the test drives: nothing fires until `fire` picks it. */
export class ManualTimer {
  pending: { ms: number; fn: () => void; id: number }[] = [];
  delays: number[] = [];
  #n = 0;

  timer = (fn: () => void, ms: number): (() => void) => {
    const id = ++this.#n;
    this.delays.push(ms);
    this.pending.push({ ms, fn, id });
    return () => {
      this.pending = this.pending.filter((p) => p.id !== id);
    };
  };

  /** Run the first pending timer that matches; false when none does. */
  fire(match: (ms: number) => boolean): boolean {
    const p = this.pending.find((x) => match(x.ms));
    if (p === undefined) return false;
    this.pending = this.pending.filter((x) => x !== p);
    p.fn();
    return true;
  }
}
