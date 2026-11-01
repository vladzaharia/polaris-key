// A faithful in-process contact room for the inter-account link tests (CC-19.5). It re-implements
// the observable framing of the Worker's contact room (WIRE-CONTRACT-V5 §15.7) over client-core's
// own envelope codec: a contact ticket is single use and binds (device, rid); the room pins the
// first two devices that connect and closes a third with 4003; `from`, `to` and `MEMBERS` carry the
// alias SHA-256(rid || deviceId)[0..24], never the device id; a SEND to an offline peer is dropped
// silently; LIST answers MEMBERS; PING answers PONG; a message that fails its layout closes 1008.
import {
  contactAlias,
  decodeRelay,
  encodeRelay,
  type RelayMessage,
} from "@polaris-key/client-core/peer";
import type { RelaySocket } from "../src/connect/relay.js";
import type { MultiWorker } from "./lanFixtures.js";

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export class ContactSock implements RelaySocket {
  binaryType = "blob";
  onopen: RelaySocket["onopen"] = null;
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  device: string | null = null;
  rid: string | null = null;
  alias: Uint8Array | null = null;
  open = false;
  closed = false;
  closeCode: number | null = null;

  constructor(
    readonly rooms: FakeContactRooms,
    readonly url: string,
    readonly protocols: string[],
  ) {
    setTimeout(() => void rooms.admit(this), 0);
  }

  send(data: Uint8Array): void {
    if (!this.open) throw new Error("not open");
    this.rooms.fromClient(this, data);
  }

  close(code = 1000): void {
    if (this.closed) return;
    this.shut(code);
  }

  shut(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.closeCode = code;
    this.rooms.sockets = this.rooms.sockets.filter((s) => s !== this);
    setTimeout(() => this.onclose?.({ code }), 0);
  }

  deliver(m: RelayMessage): void {
    if (!this.open) return;
    const bytes = encodeRelay(m);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    setTimeout(() => this.onmessage?.({ data: buf }), 0);
  }
}

export class FakeContactRooms {
  sockets: ContactSock[] = [];
  /** Per room: the aliases pinned (hex). */
  pins = new Map<string, string[]>();
  /** Every message a client sent, with the room and the alias that sent it. */
  received: { rid: string; alias: string; msg: RelayMessage }[] = [];
  /** Every `Sec-WebSocket-Protocol` list offered. */
  offered: string[][] = [];

  constructor(private readonly worker: MultiWorker) {}

  webSocket = (url: string, protocols: string[]): RelaySocket =>
    new ContactSock(this, url, protocols);

  async admit(s: ContactSock): Promise<void> {
    this.offered.push(s.protocols);
    const [proto, ticket] = s.protocols;
    const t =
      ticket === undefined ? undefined : this.worker.contactTickets.get(ticket);
    if (proto !== "pkey-relay.1" || t === undefined) return s.shut(4001);
    // An account ticket never opens a contact room, and the reverse (§15.7).
    this.worker.contactTickets.delete(ticket!);
    const alias = await contactAlias(t.rid, t.device);
    const pins = this.pins.get(t.rid) ?? [];
    if (!pins.includes(hex(alias))) {
      if (pins.length >= 2) return s.shut(4003);
      pins.push(hex(alias));
      this.pins.set(t.rid, pins);
    }
    s.device = t.device;
    s.rid = t.rid;
    s.alias = alias;
    const mine = this.sockets.filter(
      (x) => x.rid === t.rid && hex(x.alias!) === hex(alias),
    );
    if (mine.length >= 2) mine[0]!.shut(4009);
    s.open = true;
    this.sockets.push(s);
    s.onopen?.({});
  }

  fromClient(s: ContactSock, data: Uint8Array): void {
    const m = decodeRelay("toRoom", data);
    if (m === null) return s.shut(1008);
    this.received.push({ rid: s.rid!, alias: hex(s.alias!), msg: m });
    if (m.op === "send") {
      const to = hex(m.to);
      // `from` is the sender's alias, stamped here. An offline peer drops it silently.
      for (const t of this.sockets.filter(
        (x) => x.rid === s.rid && hex(x.alias!) === to,
      ))
        t.deliver({
          op: "recv",
          from: s.alias!,
          session: m.session,
          noise: m.noise,
        });
    } else if (m.op === "list") s.deliver(this.members(s.rid!));
    else if (m.op === "ping") s.deliver({ op: "pong", data: m.data });
  }

  members(rid: string): RelayMessage {
    const seen = new Map<string, Uint8Array>();
    for (const x of this.sockets)
      if (x.rid === rid) seen.set(hex(x.alias!), x.alias!);
    return { op: "members", devices: [...seen.values()] };
  }

  /** Close every socket from the room's side. */
  dropAll(code: number): void {
    for (const s of [...this.sockets]) s.shut(code);
  }

  /** Every 24-byte value the clients put on the wire as `to` (hex). */
  sentTo(): string[] {
    return this.received.flatMap((r) =>
      r.msg.op === "send" ? [hex(r.msg.to)] : [],
    );
  }
}
