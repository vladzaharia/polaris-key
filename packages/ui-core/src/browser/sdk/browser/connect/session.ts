// One Cloud Connect session in the browser (CC-09.2; WIRE-CONTRACT-V5 §15.5, §15.6). The
// client-core `PeerChannel` owns the handshake, admission, records, `MORE` reassembly and rekey;
// the relay binds it to the room and this class gives the host `send`, `receive`, `close` and
// events.
//
// Rules this module keeps:
//  - every failure says why with a typed `LanError`; nothing reaches the host before the session
//    is open;
//  - the host sees only the APP range (0x0100 to 0x7FFF). An APP-critical type (0x8100 to 0xFFFD)
//    it cannot understand closes the session with `peer_unknown_critical`; other types the
//    session does not own are ignored;
//  - a peer that sends faster than the host reads is bounded by bytes, not only by count: past
//    `QUEUE_MAX_BYTES` queued the session closes with `peer_busy`. A WebSocket cannot be paused,
//    so there is no resume threshold: the cap is the backpressure;
//  - the link, and with it the channel and its discovery keys, is held in a WeakMap, so it is
//    in no enumerable field, no `JSON.stringify` and no console expansion.

import type { PeerChannel, PeerHello } from "@polaris-key/client-core/peer";
import { LanError, type SessionCloseCode } from "./errors.js";
import { printAs } from "./redact.js";

export { LanError, type SessionCloseCode } from "./errors.js";

/** The first APP record type; `send` defaults to it. */
export const APP_DEFAULT_TYPE = 0x0100;
const MAX_QUEUED_MESSAGES = 256;
/** Queued bytes at which an unread session is closed with `peer_busy`. */
export const QUEUE_MAX_BYTES = 8 * 1024 * 1024;

export interface SessionMessage {
  type: number;
  body: Uint8Array;
}

export interface SessionClosed {
  code: SessionCloseCode;
  byPeer: boolean;
}

/** Anything that owns a `PeerChannel`: a relay session. */
export interface ChannelLink {
  readonly channel: PeerChannel;
}

/** Which path a session took. The browser has the relay only. */
export type SessionPath = "relay";

const links = new WeakMap<object, ChannelLink>();

export class ConnectSession {
  readonly peerDeviceId: string;
  readonly caps: readonly string[];
  readonly hello: PeerHello;
  readonly role: "initiator" | "responder";
  readonly path: SessionPath = "relay";
  #queue: SessionMessage[] = [];
  #waiters: {
    resolve: (m: SessionMessage) => void;
    reject: (e: LanError) => void;
  }[] = [];
  #onMessage = new Set<(m: SessionMessage) => void>();
  #onClose = new Set<(c: SessionClosed) => void>();
  #closed: SessionClosed | null = null;
  #bytes = 0;

  /** @internal */
  constructor(
    link: ChannelLink,
    peerDeviceId: string,
    caps: readonly string[],
    hello: PeerHello,
    role: "initiator" | "responder",
  ) {
    links.set(this, link);
    this.peerDeviceId = peerDeviceId;
    this.caps = caps;
    this.hello = hello;
    this.role = role;
    printAs(this, () => ({
      session: "ConnectSession",
      peerDeviceId,
      path: "relay",
      role,
    }));
  }

  get #channel(): PeerChannel {
    return links.get(this)!.channel;
  }

  get closed(): SessionClosed | null {
    return this.#closed;
  }

  /** Send one message (up to the peer's `maxMessage`, at most 1 MiB) as an APP record. */
  async send(body: Uint8Array, type: number = APP_DEFAULT_TYPE): Promise<void> {
    if (!Number.isInteger(type) || type < 0x0100 || type > 0x7fff)
      throw new LanError("bad_type", "Application types are 0x0100 to 0x7FFF.");
    if (this.#closed !== null)
      throw new LanError("closed", "The session is closed.");
    try {
      await this.#channel.sendRecord(type, body);
    } catch (e) {
      if (e instanceof Error && e.message === "message too large")
        throw new LanError(
          "too_large",
          "The message is larger than the peer accepts.",
        );
      throw new LanError("closed", "The session is closed.");
    }
  }

  /** Send a record of any type the session does not own. The channel refuses HELLO, CLOSE, REKEY
   *  and SAS records. @internal */
  sendRecord(type: number, body: Uint8Array): Promise<void> {
    return this.#channel.sendRecord(type, body);
  }

  /** The next message; rejects when the session closes with none waiting. */
  receive(): Promise<SessionMessage> {
    const m = this.#queue.shift();
    if (m !== undefined) {
      this.#bytes -= m.body.length;
      return Promise.resolve(m);
    }
    if (this.#closed !== null)
      return Promise.reject(new LanError("closed", "The session is closed."));
    return new Promise((resolve, reject) =>
      this.#waiters.push({ resolve, reject }),
    );
  }

  /** Called for each message instead of queueing it. Returns the unsubscribe. */
  onMessage(fn: (m: SessionMessage) => void): () => void {
    this.#onMessage.add(fn);
    return () => this.#onMessage.delete(fn);
  }

  onClose(fn: (c: SessionClosed) => void): () => void {
    this.#onClose.add(fn);
    if (this.#closed !== null) fn(this.#closed);
    return () => this.#onClose.delete(fn);
  }

  /** Close with `peer_bye` (or another code). */
  async close(code: "peer_bye" | "peer_busy" = "peer_bye"): Promise<void> {
    await this.#channel.close(code);
  }

  /** @internal */
  deliver(m: SessionMessage): void {
    if (this.#closed !== null) return;
    if (this.#onMessage.size > 0) {
      for (const f of [...this.#onMessage]) f(m);
      return;
    }
    const w = this.#waiters.shift();
    if (w !== undefined) return w.resolve(m);
    if (
      this.#queue.length >= MAX_QUEUED_MESSAGES ||
      this.#bytes + m.body.length > QUEUE_MAX_BYTES
    ) {
      void this.#channel.close("peer_busy");
      return;
    }
    this.#queue.push(m);
    this.#bytes += m.body.length;
  }

  /** @internal */
  ended(c: SessionClosed): void {
    if (this.#closed !== null) return;
    this.#closed = c;
    for (const w of this.#waiters.splice(0))
      w.reject(new LanError("closed", "The session is closed."));
    for (const f of [...this.#onClose]) f(c);
  }
}

/**
 * A record the channel hands up: the APP range goes to the host's session; an APP-critical type
 * (0x8100 to 0xFFFD) the host cannot understand closes the session; the rest is ignored.
 */
export function routeRecord(
  link: ChannelLink,
  session: ConnectSession | null,
  type: number,
  body: Uint8Array,
): void {
  if (type >= 0x0100 && type <= 0x7fff) session?.deliver({ type, body });
  else if (type >= 0x8100 && type <= 0xfffd)
    void link.channel.close("peer_unknown_critical");
}
