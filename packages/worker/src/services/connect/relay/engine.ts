/**
 * The relay engine (CC-07.1; plans/CC-01-cloud-connect.md §2.7; WIRE-CONTRACT-V5 §15.7).
 *
 * Pure: no clock, no storage, no sockets. The Durable Object shell (CC-07.2) feeds it inputs
 * (connect, frame, tick, close, ring) with the time in milliseconds, and carries out the outputs
 * (send, close, meter). One engine is one room: one person on one product.
 *
 * ── TRUST ────────────────────────────────────────────────────────────────────────────────────
 *
 * The room's members, the connecting device and the person's quota come from the admission
 * `RelayTicket`, which the upgrade route issues after it consumes the single-use ticket
 * (CC-07.3). Nothing in a client frame sets them. In particular a RECV's `from` is the sender's
 * admitted device: a SEND carries only `to`, and the engine never reads a sender out of a frame.
 *
 * ── REFUSALS ─────────────────────────────────────────────────────────────────────────────────
 *
 *   text frame, bad layout, an op for the other direction   close 1008, never answered (§15.7)
 *   bad, expired or malformed ticket                        close 4001
 *   device not in the ticket's members, SEND to a non-member close 4003
 *   room full (32 sockets), repeated rate abuse             close 4008
 *   a device's third socket                                 the oldest closes 4009
 *   rate, person day, product month, paused                 LIMIT 1 / 2 / 3 / 4 and the message is dropped
 *
 * The launch gate `launch.relay` is not here: CC-07.2/.3 must gate the DO and both routes.
 */

import {
  CLOUD_CONNECT_CEILINGS,
  CLOUD_CONNECT_DEFAULTS,
} from "@polaris-key/catalog";
import { hexEncode } from "../../../platform/bytes.js";
import { decodeRelay, encodeRelay } from "@polaris-key/client-core/peer";

/** Close codes: the Room's own (§15.7) and the generic one for a refused envelope. */
export const RELAY_CLOSE = {
  refused: 1008,
  badTicket: 4001,
  notMember: 4003,
  limit: 4008,
  replaced: 4009,
} as const;

/** LIMIT reasons (§15.7). */
export const RELAY_LIMIT = {
  rate: 1,
  person: 2,
  product: 3,
  paused: 4,
} as const;

/** Consecutive rate-limited messages after which the socket is closed 4008. */
export const RATE_STRIKES_MAX = 100;

const DAY_MS = 86_400_000;

/** What the upgrade route hands the room after it consumed the relay ticket. */
export interface RelayTicket {
  /** The device the ticket was issued to: 24 decoded device-id bytes. */
  device: Uint8Array;
  /** The person's devices (24 bytes each), from the roster at ticket time. */
  members: Uint8Array[];
  /** The person's resolved relay bytes per UTC day. Clamped here to the 4 GiB ceiling. */
  dayBytes: number;
  /** The relay setting says paused for this product or person. */
  paused: boolean;
  /** The product's month total is spent. */
  productOver: boolean;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type RelayInput =
  | { kind: "connect"; socket: string; ticket: RelayTicket; now: number }
  | { kind: "frame"; socket: string; data: Uint8Array | string; now: number }
  | { kind: "tick"; now: number; paused?: boolean; productOver?: boolean }
  | { kind: "close"; socket: string; now: number }
  | { kind: "ring"; epoch: number };

export type RelayOutput =
  | { kind: "send"; socket: string; data: Uint8Array }
  | { kind: "close"; socket: string; code: number }
  | { kind: "meter"; day: number; bytes: number };

interface Sock {
  id: string;
  device: string;
  deviceBytes: Uint8Array;
  seq: number;
  tokens: number;
  at: number;
  strikes: number;
}

/** What the shell persists to rebuild an engine after hibernation. */
export interface RelayRestore {
  sockets: { socket: string; device: Uint8Array; seq: number }[];
  members: Uint8Array[];
  dayBytesQuota: number;
  paused: boolean;
  productOver: boolean;
  day: number;
  dayUsed: number;
}

export function clampDayBytes(n: number): number {
  if (!Number.isFinite(n) || n < 0)
    return CLOUD_CONNECT_DEFAULTS.unlicensedRelayBytesPerDay;
  return Math.min(
    Math.floor(n),
    CLOUD_CONNECT_CEILINGS.perPerson.relayBytesPerDay,
  );
}

export class RelayEngine {
  private socks = new Map<string, Sock>();
  private members = new Map<string, Uint8Array>();
  private quota: number = CLOUD_CONNECT_DEFAULTS.unlicensedRelayBytesPerDay;
  private paused = false;
  private productOver = false;
  private day = -1;
  private dayUsed = 0;
  private seq = 0;

  /** The persisted view, for the shell's alarm flush and hibernation. */
  snapshot(): RelayRestore {
    return {
      sockets: [...this.socks.values()].map((s) => ({
        socket: s.id,
        device: s.deviceBytes,
        seq: s.seq,
      })),
      members: [...this.members.values()],
      dayBytesQuota: this.quota,
      paused: this.paused,
      productOver: this.productOver,
      day: this.day,
      dayUsed: this.dayUsed,
    };
  }

  restore(r: RelayRestore, now: number): void {
    this.socks.clear();
    this.members.clear();
    for (const m of r.members) this.members.set(hexEncode(m), m);
    this.quota = clampDayBytes(r.dayBytesQuota);
    this.paused = r.paused;
    this.productOver = r.productOver;
    this.day = r.day;
    this.dayUsed = r.dayUsed;
    for (const s of r.sockets) {
      this.seq = Math.max(this.seq, s.seq + 1);
      this.socks.set(s.socket, {
        id: s.socket,
        device: hexEncode(s.device),
        deviceBytes: s.device,
        seq: s.seq,
        tokens: CLOUD_CONNECT_DEFAULTS.messageBurst,
        at: now,
        strikes: 0,
      });
    }
  }

  step(input: RelayInput): RelayOutput[] {
    const out: RelayOutput[] = [];
    switch (input.kind) {
      case "connect":
        this.connect(input.socket, input.ticket, input.now, out);
        break;
      case "frame":
        this.frame(input.socket, input.data, input.now, out);
        break;
      case "tick":
        this.rollDay(input.now);
        if (input.paused !== undefined) {
          const was = this.paused;
          this.paused = input.paused;
          if (this.paused && !was)
            for (const s of this.socks.values())
              this.limit(s, RELAY_LIMIT.paused, out);
        }
        if (input.productOver !== undefined)
          this.productOver = input.productOver;
        break;
      case "close":
        this.drop(input.socket, out);
        break;
      case "ring": {
        const data = encodeRelay({ op: "ring", epoch: input.epoch });
        for (const s of this.socks.values())
          out.push({ kind: "send", socket: s.id, data });
        break;
      }
    }
    return out;
  }

  // ── admission ──────────────────────────────────────────────────────────────────────────────

  private connect(
    id: string,
    t: RelayTicket,
    now: number,
    out: RelayOutput[],
  ): void {
    const shut = (code: number): void => {
      out.push({ kind: "close", socket: id, code });
    };
    if (this.socks.has(id)) return shut(RELAY_CLOSE.badTicket);
    const wellFormed =
      t.device instanceof Uint8Array &&
      t.device.length === 24 &&
      Array.isArray(t.members) &&
      t.members.length <= 255 &&
      t.members.every((m) => m instanceof Uint8Array && m.length === 24) &&
      Number.isFinite(t.expiresAt);
    if (!wellFormed || t.expiresAt <= now) return shut(RELAY_CLOSE.badTicket);
    const device = hexEncode(t.device);
    if (!t.members.some((m) => hexEncode(m) === device))
      return shut(RELAY_CLOSE.notMember);

    // A room is one person: the latest admission sets the roster and the quota. Devices that
    // left the roster lose their sockets (4003) and are announced gone.
    this.rollDay(now);
    this.members = new Map(t.members.map((m) => [hexEncode(m), m.slice()]));
    this.quota = clampDayBytes(t.dayBytes);
    this.paused = t.paused;
    this.productOver = t.productOver;
    for (const s of [...this.socks.values()]) {
      if (!this.members.has(s.device)) {
        out.push({ kind: "close", socket: s.id, code: RELAY_CLOSE.notMember });
        this.drop(s.id, out);
      }
    }

    const mine = [...this.socks.values()]
      .filter((s) => s.device === device)
      .sort((a, b) => a.seq - b.seq);
    if (mine.length < CLOUD_CONNECT_DEFAULTS.socketsPerDevice) {
      if (this.socks.size >= CLOUD_CONNECT_DEFAULTS.socketsPerRoom)
        return shut(RELAY_CLOSE.limit);
    } else {
      const oldest = mine[0]!;
      out.push({
        kind: "close",
        socket: oldest.id,
        code: RELAY_CLOSE.replaced,
      });
      this.socks.delete(oldest.id); // same device: still present, so no GONE
    }

    const wasOnline = mine.length > 0;
    const sock: Sock = {
      id,
      device,
      deviceBytes: t.device.slice(),
      seq: this.seq++,
      tokens: CLOUD_CONNECT_DEFAULTS.messageBurst,
      at: now,
      strikes: 0,
    };
    this.socks.set(id, sock);

    if (this.paused) {
      this.limit(sock, RELAY_LIMIT.paused, out);
      out.push({ kind: "close", socket: id, code: RELAY_CLOSE.limit });
      this.socks.delete(id);
      return;
    }
    // The newcomer learns who is here; the others learn that a device arrived.
    this.sendMembers(sock, out);
    if (!wasOnline)
      for (const s of this.socks.values())
        if (s.id !== id) this.sendMembers(s, out);
  }

  // ── frames ─────────────────────────────────────────────────────────────────────────────────

  private frame(
    id: string,
    data: Uint8Array | string,
    now: number,
    out: RelayOutput[],
  ): void {
    const s = this.socks.get(id);
    if (!s) return; // unknown or already closed: frames after a close are lost
    const refuse = (code: number): void => {
      out.push({ kind: "close", socket: id, code });
      this.drop(id, out);
    };
    if (typeof data === "string") return refuse(RELAY_CLOSE.refused);

    // Rate first, so a flood of garbage costs the sender, not the room.
    const burst = CLOUD_CONNECT_DEFAULTS.messageBurst;
    s.tokens = Math.min(
      burst,
      s.tokens +
        (Math.max(0, now - s.at) / 1000) *
          CLOUD_CONNECT_DEFAULTS.messagesPerSecond,
    );
    s.at = Math.max(s.at, now);
    if (s.tokens < 1) {
      s.strikes++;
      if (s.strikes >= RATE_STRIKES_MAX) return refuse(RELAY_CLOSE.limit);
      this.limit(s, RELAY_LIMIT.rate, out);
      return;
    }
    s.tokens -= 1;
    s.strikes = 0;

    const msg = decodeRelay("toRoom", data);
    if (!msg) return refuse(RELAY_CLOSE.refused);
    this.rollDay(now);

    switch (msg.op) {
      case "ping":
        out.push({
          kind: "send",
          socket: id,
          data: encodeRelay({ op: "pong", data: msg.data }),
        });
        return;
      case "list":
        this.sendMembers(s, out);
        return;
      case "send": {
        const to = hexEncode(msg.to);
        if (!this.members.has(to)) return refuse(RELAY_CLOSE.notMember);
        if (this.paused) return this.limit(s, RELAY_LIMIT.paused, out);
        if (this.productOver) return this.limit(s, RELAY_LIMIT.product, out);
        if (this.dayUsed + data.length > this.quota)
          return this.limit(s, RELAY_LIMIT.person, out);
        if (to === s.device) return; // nothing to deliver to oneself
        const targets = [...this.socks.values()].filter((x) => x.device === to);
        if (targets.length === 0) return; // offline: dropped (no mailbox in v1)
        // `from` is the admitted device, never a client value.
        const recv = encodeRelay({
          op: "recv",
          from: s.deviceBytes,
          session: msg.session,
          noise: msg.noise,
        });
        for (const x of targets)
          out.push({ kind: "send", socket: x.id, data: recv });
        this.dayUsed += data.length;
        out.push({ kind: "meter", day: this.day, bytes: data.length });
        return;
      }
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────

  private rollDay(now: number): void {
    const d = Math.floor(now / DAY_MS);
    if (d !== this.day) {
      this.day = d;
      this.dayUsed = 0;
    }
  }

  private limit(s: Sock, reason: 1 | 2 | 3 | 4, out: RelayOutput[]): void {
    out.push({
      kind: "send",
      socket: s.id,
      data: encodeRelay({ op: "limit", reason }),
    });
  }

  private online(): Uint8Array[] {
    const seen = new Map<string, Uint8Array>();
    for (const s of this.socks.values()) seen.set(s.device, s.deviceBytes);
    return [...seen.values()];
  }

  private sendMembers(to: Sock, out: RelayOutput[]): void {
    out.push({
      kind: "send",
      socket: to.id,
      data: encodeRelay({ op: "members", devices: this.online() }),
    });
  }

  /** Forget a socket. When it was its device's last, every other socket hears GONE. */
  private drop(id: string, out: RelayOutput[]): void {
    const s = this.socks.get(id);
    if (!s) return;
    this.socks.delete(id);
    if ([...this.socks.values()].some((x) => x.device === s.device)) return;
    const gone = encodeRelay({ op: "gone", device: s.deviceBytes });
    for (const x of this.socks.values())
      out.push({ kind: "send", socket: x.id, data: gone });
  }
}
