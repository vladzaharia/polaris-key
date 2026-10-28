// One Cloud Connect session over a TCP socket (CC-08.2; WIRE-CONTRACT-V5 §15.5, §15.6). The
// client-core `PeerChannel` owns the handshake, admission, records, `MORE` reassembly and rekey;
// this file binds it to a `node:net` socket and gives the host `send`, `receive`, `close` and
// events.
//
// Rules this module keeps:
//  - frames are cut by client-core's `FrameReader` (one frame is at most 65,535 bytes); before the
//    handshake completes a frame over `HANDSHAKE_FRAME_MAX` closes the socket;
//  - a socket that has not completed the handshake within `HANDSHAKE_MS` is destroyed;
//  - every failure closes the socket and says why with a typed `LanError`; nothing is accepted
//    silently and nothing reaches the host before the session is open;
//  - the host sees only the APP range (0x0100 to 0x7FFF). An APP-critical type (0x8100 to 0xFFFD)
//    it cannot understand closes the session with `peer_unknown_critical`; other types the
//    session does not own are ignored.

import type { Socket } from "node:net";
import { PolarisError } from "@polaris-key/client-core";
import { ErrorCode } from "../constants.generated.js";
import { printAs } from "../core/redact.js";
import {
  FrameReader,
  PeerChannel,
  encodeFrame,
  type ClosedReason,
  type PeerHello,
  type PeerSessionOptions,
  type SessionEvent,
} from "@polaris-key/client-core/peer";

export const HANDSHAKE_FRAME_MAX = 16_384;
export const HANDSHAKE_MS = 30_000;
/** The first APP record type; `send` defaults to it. */
export const APP_DEFAULT_TYPE = 0x0100;
const MAX_QUEUED_MESSAGES = 256;
/** A peer that sends faster than the host reads: pause the socket at 4 MiB queued, resume under
 *  1 MiB, and close with `peer_busy` at 8 MiB. */
export const QUEUE_PAUSE_BYTES = 4 * 1024 * 1024;
export const QUEUE_RESUME_BYTES = 1024 * 1024;
export const QUEUE_MAX_BYTES = 8 * 1024 * 1024;

export type LanErrorReason =
  | "no_identity"
  | "no_keys"
  | "unknown_peer"
  | "not_listening"
  | "connect_failed"
  | "handshake_failed"
  | "wrong_peer"
  | "closed"
  | "too_large"
  | "bad_type"
  | "queue_full"
  | "not_started";

/** The registered client code of each reason. */
const LAN_CODE: Record<LanErrorReason, string> = {
  no_identity: ErrorCode.notConfigured,
  no_keys: ErrorCode.notConfigured,
  not_started: ErrorCode.notConfigured,
  unknown_peer: ErrorCode.invalidArgument,
  not_listening: ErrorCode.connectUnavailable,
  connect_failed: ErrorCode.networkError,
  handshake_failed: ErrorCode.peerCertInvalid,
  wrong_peer: ErrorCode.peerCertInvalid,
  closed: ErrorCode.networkError,
  too_large: ErrorCode.invalidArgument,
  bad_type: ErrorCode.invalidArgument,
  queue_full: ErrorCode.rateLimited,
};

export class LanError extends PolarisError {
  constructor(
    readonly reason: LanErrorReason,
    message: string,
    options?: { cause?: unknown; closeCode?: SessionCloseCode },
  ) {
    super(LAN_CODE[reason], message, {
      ...(options?.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.name = "LanError";
    this.closeCode = options?.closeCode;
  }
  readonly closeCode: SessionCloseCode | undefined;
}

/** Why a session ended: a client-core code, or the socket going away. */
export type SessionCloseCode = ClosedReason | "connection_lost";

export interface SessionMessage {
  type: number;
  body: Uint8Array;
}

export interface SessionClosed {
  code: SessionCloseCode;
  byPeer: boolean;
}

/** Anything that owns a `PeerChannel`: a TCP socket or a relay session. */
export interface ChannelLink {
  readonly channel: PeerChannel;
  /** Stop (true) or resume (false) reading from the transport, where it can. */
  pause?(on: boolean): void;
}

/** Which path a session took (WIRE-CONTRACT-V5 §15.7: the relay is the fallback). */
export type SessionPath = "lan" | "relay";

export class ConnectSession {
  #queue: SessionMessage[] = [];
  #waiters: {
    resolve: (m: SessionMessage) => void;
    reject: (e: LanError) => void;
  }[] = [];
  #onMessage = new Set<(m: SessionMessage) => void>();
  #onClose = new Set<(c: SessionClosed) => void>();
  #closed: SessionClosed | null = null;
  #bytes = 0;
  readonly #link: ChannelLink;

  /** @internal */
  constructor(
    link: ChannelLink,
    readonly peerDeviceId: string,
    readonly caps: readonly string[],
    readonly hello: PeerHello,
    readonly role: "initiator" | "responder",
    readonly remoteAddress: string,
    readonly path: SessionPath = "lan",
  ) {
    this.#link = link;
    // The link holds the channel and with it the discovery keys: never printed.
    printAs(this, () => ({
      session: "ConnectSession",
      peerDeviceId,
      path,
      role,
    }));
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
      await this.#link.channel.sendRecord(type, body);
    } catch (e) {
      if (e instanceof Error && e.message === "message too large")
        throw new LanError(
          "too_large",
          "The message is larger than the peer accepts.",
        );
      throw new LanError("closed", "The session is closed.", { cause: e });
    }
  }

  /** Send a record of any type the session does not own (a peer document, a later transfer
   *  type). The channel refuses HELLO, CLOSE, REKEY and SAS records. @internal */
  sendRecord(type: number, body: Uint8Array): Promise<void> {
    return this.#link.channel.sendRecord(type, body);
  }

  /** The next message; rejects when the session closes with none waiting. */
  receive(): Promise<SessionMessage> {
    const m = this.#queue.shift();
    if (m !== undefined) {
      this.#bytes -= m.body.length;
      if (this.#bytes < QUEUE_RESUME_BYTES) this.#link.pause?.(false);
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

  /** Close with `peer_bye` (or another code); resolves when the socket is down. */
  async close(code: "peer_bye" | "peer_busy" = "peer_bye"): Promise<void> {
    await this.#link.channel.close(code);
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
      void this.#link.channel.close("peer_busy");
      return;
    }
    this.#queue.push(m);
    this.#bytes += m.body.length;
    if (this.#bytes > QUEUE_PAUSE_BYTES) this.#link.pause?.(true);
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

export interface SocketLinkOptions {
  socket: Socket;
  channel: Omit<PeerSessionOptions, "send" | "onEvent">;
  onRing?: (jws: string, epoch: number) => void;
  onTrust?: (jws: string) => void;
  onRingWanted?: () => void;
  onEstablished?: (s: ConnectSession) => void;
  onEnded?: () => void;
  handshakeMs?: number;
}

/** A socket bound to one `PeerChannel`. */
export class SocketLink {
  readonly channel: PeerChannel;
  readonly opened: Promise<ConnectSession>;
  #session: ConnectSession | null = null;
  #settle!: {
    resolve: (s: ConnectSession) => void;
    reject: (e: LanError) => void;
  };
  #reader = new FrameReader();
  #deadline: NodeJS.Timeout;
  #ended = false;
  #lost = false;

  readonly #o: SocketLinkOptions;

  constructor(o: SocketLinkOptions) {
    this.#o = o;
    printAs(this, () => ({ link: "SocketLink" }));
    const { socket } = o;
    this.opened = new Promise((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    // A rejection nobody awaits (an inbound session) must not crash the process.
    this.opened.catch(() => undefined);
    this.channel = new PeerChannel({
      ...o.channel,
      send: (noise) => {
        if (!socket.destroyed && !socket.writableEnded)
          socket.write(encodeFrame(noise));
      },
      onEvent: (e) => this.#event(e),
    });
    this.#deadline = setTimeout(
      () => this.#fail("handshake_failed", false),
      o.handshakeMs ?? HANDSHAKE_MS,
    );
    this.#deadline.unref();
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.#data(chunk));
    socket.on("error", () => undefined);
    // Frames that arrived before the FIN are still being worked on: queue behind them.
    socket.on("close", () => {
      this.#lost = true;
      void this.channel.close("peer_bye");
    });
  }

  pause(on: boolean): void {
    const s = this.#o.socket;
    if (on) s.pause();
    else if (!s.destroyed) s.resume();
  }

  #data(chunk: Buffer): void {
    if (this.#ended) return;
    const frames = this.#reader.push(chunk);
    if (frames === null) return this.#fail("peer_bad_frame", false);
    for (const f of frames) {
      if (this.#session === null && f.length > HANDSHAKE_FRAME_MAX)
        return this.#fail("handshake_failed", false);
      void this.channel.receive(f);
    }
  }

  #event(e: SessionEvent): void {
    switch (e.type) {
      case "established": {
        if (e.peerDeviceId === undefined) break;
        clearTimeout(this.#deadline);
        this.#session = new ConnectSession(
          this,
          e.peerDeviceId,
          e.caps,
          e.hello,
          this.#o.channel.role,
          this.#o.socket.remoteAddress ?? "",
        );
        this.#o.onEstablished?.(this.#session);
        this.#settle.resolve(this.#session);
        break;
      }
      case "record":
        routeRecord(this, this.#session, e.recordType, e.body);
        break;
      case "ring":
        this.#o.onRing?.(e.jws, e.epoch);
        break;
      case "trust-unverified":
        this.#o.onTrust?.(e.jws);
        break;
      case "ring-wanted":
        this.#o.onRingWanted?.();
        break;
      case "closed":
        this.#finish(
          this.#lost && !e.byPeer
            ? { code: "connection_lost", byPeer: false }
            : { code: e.code, byPeer: e.byPeer },
        );
        break;
      default:
        break;
    }
  }

  #fail(code: SessionCloseCode, byPeer: boolean): void {
    if (this.#ended) return;
    if (this.#session === null) {
      // Not a live session: the channel has nothing to send.
      this.#finish({ code, byPeer });
      void this.channel.close("peer_bye");
      return;
    }
    void this.channel.close("peer_bye");
  }

  #finish(c: SessionClosed): void {
    if (this.#ended) return;
    this.#ended = true;
    clearTimeout(this.#deadline);
    if (this.#session !== null) this.#session.ended(c);
    else
      this.#settle.reject(
        new LanError("handshake_failed", "The peer was not admitted.", {
          closeCode: c.code,
        }),
      );
    const s = this.#o.socket;
    // Let the CLOSE record flush, then drop the socket.
    s.end(() => s.destroy());
    const t = setTimeout(() => s.destroy(), 1000);
    t.unref();
    this.#o.onEnded?.();
  }

  /** Drop the socket now, with no goodbye (the sign-out bound's force path). */
  destroy(): void {
    this.#o.socket.destroy();
  }
}
