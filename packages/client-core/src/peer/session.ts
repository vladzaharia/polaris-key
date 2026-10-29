// WIRE-CONTRACT-V5 §15.5 and §15.6: one `pkey-peer/1` session, per mode (a account, v approver,
// p pair). It owns no socket: Noise messages come in through `receive` (already de-framed) and go
// out through the `send` callback, so the same machine runs over TCP, the relay or memory.
//
// Order: Noise XX (XXpsk0 in mode a) with the payload rules of §15.5; in mode a each side verifies
// the other's certificate against the remote static key and the held ring; then HELLO each way,
// which must be the first record; then, in modes v and p, the commit-reveal SAS. Nothing is
// delivered to the host (`record` events) before that. Every failure ends the session; before the
// transport exists nothing is sent, after it a CLOSE record names the code.

import { base64UrlEncodeBytes, type TrustSet } from "@polaris-key/jws";
import { cleanApp, cleanLabel, cleanPlatform } from "./display.js";
import { admitPeer, replaceRing, ringExpired, verifyRing } from "./cert.js";
import {
  NoiseError,
  NoiseHandshake,
  peerNoiseProtocol,
  peerPrologue,
  peerPsk,
  webCryptoNoisePorts,
  type NoisePorts,
  type NoiseTransport,
  type PeerMode,
} from "./noise.js";
import {
  capsIntersection,
  parseHandshakePayload,
  parseStrictObject,
  payload1,
  payload23,
} from "./payload.js";
import {
  MAX_PEER_MESSAGE_BYTES,
  PEER_CLOSE_CODES,
  RECORD,
  RecordAssembler,
  encodeRecord,
  parseRecord,
  splitMessage,
  type PeerCloseCode,
} from "./record.js";
import {
  parseSasBody,
  sasBody,
  sasCommit,
  sasDisplay,
  sasRevealOk,
  sasValue,
  encodeSasValue,
} from "./sas.js";
import { VOUCH_CAP, VouchFlow } from "./vouch.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const NONE = new Uint8Array(0);

/** §15.6: a HELLO in mode v or p is at most this many bytes. */
const MAX_UNVERIFIED_HELLO = 4096;
export type ClosedReason = PeerCloseCode | "handshake_failed";

export interface PeerHello {
  label?: string;
  platform: string;
  app: string;
  maxMessage: number;
}

/** What mode a needs: this device's certificate, roster view and trust. */
export interface AccountContext {
  trust: TrustSet;
  /** `aud`: the product slug. */
  expectedAud: string;
  /** This device's `pkey-peer+jws`. */
  certJws: string;
  ownSub: string;
  ownDeviceId: string;
  /** The held roster and its epoch, read at use. */
  heldRing: () => { jws: string; epoch: number } | null;
  /**
   * The delivered discovery keys, newest first; the initiator uses the first. The responder tries
   * the first two; an absent (null) previous key is skipped.
   */
  discKeys: readonly (Uint8Array | null)[];
}

export interface PeerSessionOptions {
  mode: PeerMode;
  role: "initiator" | "responder";
  slug: string;
  /** The X25519 private key: the device's agreeKey in mode a, a one-time key in v and p. */
  staticKey: Uint8Array;
  /** Mode a only. */
  account?: AccountContext;
  /** Capabilities this side offers. */
  caps?: readonly string[];
  hello: { label?: string; platform: string; app: string; maxMessage?: number };
  send: (noise: Uint8Array) => void;
  onEvent: (e: SessionEvent) => void;
  ports?: NoisePorts;
  /** Seconds since the epoch (certificate and roster clocks). */
  now?: () => number;
  /** A monotonic clock in seconds, for rekey age. Default `performance.now() / 1000`. */
  mono?: () => number;
  /** Schedule `fn` after `ms`; returns the cancel. Default `setTimeout`. */
  timer?: (fn: () => void, ms: number) => () => void;
  /**
   * Required for a responder in modes v and p (the approver): the limiter that admits a new
   * handshake and caps the sessions waiting on a code. The constructor refuses without it.
   */
  admission?: HandshakeLimiter;
  /**
   * Mode v, initiator only: stop after HELLO and send no SAS record until the host calls
   * `startSas()`. The host dials several approvers and starts the one the person chose (N9).
   */
  holdSas?: boolean;
  /** Rekey after this many sent messages (default 2^20) or seconds (default 3600). */
  rekeyMessages?: number;
  rekeySeconds?: number;
}

export type SessionEvent =
  /** The handshake and the HELLO exchange are done (modes v and p still need the SAS). */
  | {
      type: "established";
      caps: string[];
      /** Display data. Unauthenticated in modes v and p (`helloAuthenticated` is false). */
      hello: PeerHello;
      helloAuthenticated: boolean;
      remoteStatic: Uint8Array;
      /** Mode a: the admitted certificate's device id. */
      peerDeviceId?: string;
    }
  /** Modes v and p: the code both screens show; the host calls `confirmSas()` when the person agrees. */
  | { type: "sas"; code: number; display: string }
  /**
   * A record the host owns, delivered only once the session is open (in modes v and p, after
   * `confirmSas()`). The host must close on an APP_CRITICAL type (0x8100 to 0xFFFD) it does not
   * understand.
   */
  | { type: "record"; recordType: number; body: Uint8Array }
  /** Mode a: a roster that replaced the held one at `epoch`; the host stores it. */
  | { type: "ring"; jws: string; epoch: number }
  /** Mode a: a `TRUST` document the peer sent. Not verified here; the host verifies it (V4 §1). */
  | { type: "trust-unverified"; jws: string }
  /** Mode a: the peer is on a newer roster than the held one; fetch it. */
  | { type: "ring-wanted" }
  | { type: "closed"; code: ClosedReason; byPeer: boolean };

type Phase = "hs" | "hello" | "sas" | "sas-shown" | "open" | "closed";

/** Seconds from the first byte to the transport, and to the person's confirmation (v, p). */
export const TRANSPORT_DEADLINE_SECONDS = 30;
export const SAS_DEADLINE_SECONDS = 120;
const MAX_QUEUED = 16;
/** §15.6: bytes of held records before the person's confirmation, modes v and p. */
const MAX_QUEUED_BYTES = 16 * 1024;
const KNOWN_CLOSE = new Set<string>(PEER_CLOSE_CODES);

class SessionFail extends Error {
  constructor(readonly code: ClosedReason) {
    super(code);
  }
}

export class PeerSession {
  private hs: NoiseHandshake | null = null;
  private hsStep = 0;
  private phase: Phase = "hs";
  private tp: NoiseTransport | null = null;
  private readonly asm: RecordAssembler;
  private chain: Promise<unknown> = Promise.resolve();
  private sendChain: Promise<unknown> = Promise.resolve();
  private peerCaps: string[] = [];
  private peerRing = 0;
  private peerHello: PeerHello | null = null;
  private sentCount = 0;
  private keyedAt = 0;
  private maxSend = MAX_PEER_MESSAGE_BYTES;
  // SAS state
  private nD: Uint8Array | null = null;
  private nM: Uint8Array | null = null;
  private commit: string | null = null;
  private sasDone = false;
  private sasStep = 0;
  private readonly now: () => number;
  private readonly mono: () => number;
  private readonly timer: (fn: () => void, ms: number) => () => void;
  private readonly ports: NoisePorts;
  private caps: string[];
  private cancels: (() => void)[] = [];
  private transportCancel: (() => void) | null = null;
  private sasCancel: (() => void) | null = null;
  private release: (() => void) | null = null;
  private started = false;
  private queued: { type: number; body: Uint8Array }[] = [];
  private peerCertJws = "";
  private peerRemote: Uint8Array | null = null;
  private flow: VouchFlow | null = null;
  private hash: Uint8Array | null = null;

  constructor(private readonly o: PeerSessionOptions) {
    if ((o.mode === "a") !== (o.account !== undefined))
      throw new RangeError("account context");
    if (o.holdSas === true && (o.mode !== "v" || o.role !== "initiator"))
      throw new RangeError("holdSas is for the mode v initiator");
    if (o.mode !== "a" && o.role === "responder" && o.admission === undefined)
      throw new RangeError("an approver needs an admission limiter");
    this.ports = o.ports ?? webCryptoNoisePorts;
    this.now = o.now ?? ((): number => Math.floor(Date.now() / 1000));
    this.mono = o.mono ?? ((): number => performance.now() / 1000);
    this.timer =
      o.timer ??
      ((fn, ms): (() => void) => {
        const h = setTimeout(fn, ms);
        (h as { unref?: () => void }).unref?.();
        return (): void => clearTimeout(h);
      });
    this.asm = new RecordAssembler(o.mode);
    this.caps = [...(o.caps ?? [])];
    // Both mode-v payloads list `vouch/1` (§15.6.1 rule 1); the host cannot leave it out.
    if (o.mode === "v") {
      if (!this.caps.includes(VOUCH_CAP)) this.caps.push(VOUCH_CAP);
      this.flow = new VouchFlow(
        o.role === "initiator" ? "requester" : "approver",
      );
    }
    this.keyedAt = this.mono();
  }

  get isOpen(): boolean {
    return this.phase === "open";
  }

  /**
   * Mode v: this session's order guard (§15.6.1), negotiated when the session is `established`.
   * `null` in the other modes.
   */
  get vouch(): VouchFlow | null {
    return this.flow;
  }

  /**
   * The Noise handshake hash `h`, a copy, once the session is `established` (§15.6.1 binds the
   * vouch to it). Throws before that. It is a public value; the one-time keys never leave the
   * handshake.
   */
  handshakeHash(): Uint8Array {
    if (this.hash === null) throw new Error("session not established");
    return this.hash.slice();
  }

  /**
   * Mode v, `holdSas` initiator: the person chose this approver; send `SAS_COMMIT` now. Only
   * once, only after `established`; any other call closes the session `peer_not_allowed`.
   */
  startSas(): Promise<void> {
    return this.run(async () => {
      if (
        this.o.holdSas !== true ||
        this.phase !== "sas" ||
        this.sasStep !== 0 ||
        this.nD !== null
      )
        throw new SessionFail("peer_not_allowed");
      await this.commitSas();
    });
  }

  /**
   * Modes v and p: the person confirmed the code. Opens the session, sends `CONFIRM` in mode p
   * and delivers the host records held meanwhile.
   */
  confirmSas(): Promise<void> {
    return this.run(async () => {
      if (this.phase !== "sas-shown") throw new SessionFail("peer_not_allowed");
      this.phase = "open";
      this.settle();
      if (this.o.mode === "p")
        await this.emitRecords(RECORD.CONFIRM, utf8("{}"));
      const q = this.queued;
      this.queued = [];
      for (const m of q)
        this.o.onEvent({ type: "record", recordType: m.type, body: m.body });
    });
  }

  private startClock(): void {
    if (this.started) return;
    this.started = true;
    const guard = (sec: number): (() => void) =>
      this.timer(
        () => void this.run(() => this.fail("peer_timeout", false)),
        sec * 1000,
      );
    this.transportCancel = guard(TRANSPORT_DEADLINE_SECONDS);
    if (this.o.mode !== "a") this.sasCancel = guard(SAS_DEADLINE_SECONDS);
  }

  /** The transport is up: its deadline ends. */
  private transportUp(): void {
    this.transportCancel?.();
    this.transportCancel = null;
  }

  /** Modes v and p: the person confirmed. The deadline and the limiter slot end. */
  private settle(): void {
    this.sasCancel?.();
    this.sasCancel = null;
    this.release?.();
    this.release = null;
  }

  private stopClock(): void {
    this.transportUp();
    this.settle();
    for (const c of this.cancels.splice(0)) c();
  }

  get closed(): boolean {
    return this.phase === "closed";
  }

  /** Initiator only: write message 1. */
  start(): Promise<void> {
    return this.run(async () => {
      if (this.o.role !== "initiator" || this.hs !== null)
        throw new SessionFail("handshake_failed");
      const key = this.o.account?.discKeys[0] ?? undefined;
      if (this.o.mode === "a" && key === undefined)
        throw new SessionFail("handshake_failed");
      this.startClock();
      this.hs = await this.newHandshake(key);
      this.o.send(await this.hs.writeMessage(payload1()));
      this.hsStep = 1;
    });
  }

  /** One Noise message from the peer (a de-framed TCP frame, or a relay `RECV` body). */
  receive(noise: Uint8Array): Promise<void> {
    return this.run(async () => {
      if (this.phase === "closed") return;
      if (!this.started && this.o.role === "responder") {
        // An approver counts the attempt only now that a session starts.
        if (this.o.admission !== undefined) {
          this.release = this.o.admission.begin();
          if (this.release === null) throw new SessionFail("peer_busy");
        }
        this.startClock();
      }
      if (this.phase === "hs") await this.onHandshake(noise);
      else await this.onTransport(noise);
    });
  }

  /** Send one message of the host's, split into records. Only once the session is open. */
  sendRecord(type: number, body: Uint8Array): Promise<void> {
    // Host records wait for the person's confirmation (modes v and p); the session owns the rest.
    if (this.phase !== "open")
      return Promise.reject(new Error("session not open"));
    if (
      type === RECORD.HELLO ||
      type === RECORD.CLOSE ||
      type === RECORD.REKEY ||
      type === RECORD.SAS_COMMIT ||
      type === RECORD.SAS_NONCE ||
      type === RECORD.SAS_REVEAL ||
      (type === RECORD.CONFIRM && this.o.mode === "p")
    )
      return Promise.reject(new Error("record owned by the session"));
    if (body.length > this.maxSend)
      return Promise.reject(new Error("message too large"));
    return this.emitRecords(type, body);
  }

  /** Close with a code; sends CLOSE when the transport exists. */
  close(code: PeerCloseCode = "peer_bye"): Promise<void> {
    return this.run(() => this.fail(code, false));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private run(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      try {
        await fn();
      } catch (err) {
        const code: ClosedReason =
          err instanceof SessionFail
            ? err.code
            : err instanceof NoiseError
              ? this.tp === null
                ? "handshake_failed"
                : "peer_bad_frame"
              : "handshake_failed";
        await this.fail(code, false);
      }
    });
    this.chain = next;
    return next;
  }

  private async fail(code: ClosedReason, byPeer: boolean): Promise<void> {
    if (this.phase === "closed") return;
    const wasUp = this.tp !== null;
    this.phase = "closed";
    this.stopClock();
    this.queued = [];
    if (wasUp && !byPeer && code !== "handshake_failed") {
      try {
        await this.emitRecords(RECORD.CLOSE, utf8(JSON.stringify({ code })));
      } catch {
        /* the connection is gone anyway */
      }
    }
    this.o.onEvent({ type: "closed", code, byPeer });
  }

  private async newHandshake(
    discKey: Uint8Array | undefined,
  ): Promise<NoiseHandshake> {
    const { mode, slug } = this.o;
    return new NoiseHandshake({
      role: this.o.role,
      protocol: peerNoiseProtocol(mode),
      prologue: peerPrologue(slug, mode),
      psk: mode === "a" ? await peerPsk(discKey!, slug) : undefined,
      staticKey: this.o.staticKey,
      ports: this.ports,
    });
  }

  private ownPayload(): Uint8Array {
    const a = this.o.account;
    if (a === undefined) return payload23(this.o.mode, this.caps);
    const ring = a.heldRing();
    return payload23(this.o.mode, this.caps, {
      cert: a.certJws,
      ring: ring?.epoch ?? 1,
    });
  }

  private async onHandshake(noise: Uint8Array): Promise<void> {
    const { mode, role } = this.o;
    if (role === "responder" && this.hs === null) {
      // Message 1. In mode a try the current then the previous discovery key; a failed tag
      // closes silently.
      const keys: (Uint8Array | null | undefined)[] =
        mode === "a" ? this.o.account!.discKeys.slice(0, 2) : [undefined];
      let payload: Uint8Array | null = null;
      for (const k of keys) {
        if (k === null) continue;
        try {
          const h = await this.newHandshake(k);
          payload = await h.readMessage(noise);
          this.hs = h;
          break;
        } catch {
          /* try the next key */
        }
      }
      if (this.hs === null || payload === null)
        throw new SessionFail("handshake_failed");
      if (!parseHandshakePayload(mode, 1, payload).ok)
        throw new SessionFail("handshake_failed");
      this.o.send(await this.hs.writeMessage(this.ownPayload()));
      this.hsStep = 2;
      return;
    }
    const hs = this.hs;
    if (hs === null) throw new SessionFail("handshake_failed");
    const message = role === "initiator" ? 2 : 3;
    if (this.hsStep !== (role === "initiator" ? 1 : 2))
      throw new SessionFail("handshake_failed");
    const payload = await hs.readMessage(noise);
    const verdict = parseHandshakePayload(mode, message as 2 | 3, payload);
    if (!verdict.ok) throw new SessionFail("handshake_failed");
    const remote = hs.remoteStatic!;
    let peerDeviceId: string | undefined;
    if (mode === "a") {
      const a = this.o.account!;
      const held = a.heldRing();
      if (held !== null) {
        // A held roster that is expired, unverifiable or another account's must not admit: ask
        // for a fresh one and refuse. Only a device with no roster at all (first run) admits.
        const v = await verifyRing(held.jws, {
          trust: a.trust,
          expectedAud: a.expectedAud,
        });
        if (
          !v.ok ||
          ringExpired(v.ring, this.now()) ||
          v.ring.sub !== a.ownSub
        ) {
          this.o.onEvent({ type: "ring-wanted" });
          throw new SessionFail("handshake_failed");
        }
      } else this.o.onEvent({ type: "ring-wanted" });
      const adm = await this.admit(verdict.cert!, held?.jws ?? null, remote);
      if (!adm.admit)
        throw new SessionFail(
          adm.reason === "peer_revoked" ? "peer_revoked" : "handshake_failed",
        );
      this.peerCertJws = verdict.cert!;
      this.peerRemote = remote;
      const wait = adm.cert.expiresAt - this.now();
      if (wait <= 0) throw new SessionFail("peer_expired");
      this.cancels.push(
        this.timer(
          () => void this.run(() => this.fail("peer_expired", false)),
          Math.min(wait, 2 ** 31 / 1000 - 1) * 1000,
        ),
      );
      peerDeviceId = adm.cert.deviceId;
      this.peerRing = verdict.ring!;
      if (adm.ringSync === "request") this.o.onEvent({ type: "ring-wanted" });
    }
    this.peerCaps = verdict.caps;
    if (role === "initiator") {
      this.o.send(await hs.writeMessage(this.ownPayload()));
    }
    this.tp = await hs.transport();
    this.transportUp();
    this.keyedAt = this.mono();
    this.phase = "hello";
    this.pending = { remote, peerDeviceId };
    await this.sendHello();
  }

  private admit(certJws: string, ringJws: string | null, remote: Uint8Array) {
    const a = this.o.account!;
    return admitPeer(certJws, ringJws, {
      trust: a.trust,
      expectedAud: a.expectedAud,
      now: this.now(),
      session: {
        mode: "a",
        remoteStatic: base64UrlEncodeBytes(remote),
        ownSub: a.ownSub,
        ownDeviceId: a.ownDeviceId,
      },
    });
  }

  private pending: { remote: Uint8Array; peerDeviceId?: string } | null = null;

  private async sendHello(): Promise<void> {
    const h = this.o.hello;
    const body: Record<string, unknown> = {};
    if (h.label !== undefined) body.label = h.label;
    body.platform = h.platform;
    body.app = h.app;
    body.maxMessage = h.maxMessage ?? MAX_PEER_MESSAGE_BYTES;
    await this.emitRecords(RECORD.HELLO, utf8(JSON.stringify(body)));
  }

  private async onTransport(noise: Uint8Array): Promise<void> {
    const tp = this.tp!;
    const plain = await tp.receive.decrypt(NONE, noise);
    const rec = parseRecord(plain);
    if (rec === null) throw new SessionFail("peer_bad_frame");
    const r = this.asm.push(rec);
    if (r.kind === "close") throw new SessionFail(r.code);
    if (r.kind !== "message") return;
    await this.onMessage(r.type, r.body);
  }

  private async onMessage(type: number, body: Uint8Array): Promise<void> {
    if (this.phase === "hello") {
      // The first record each way is HELLO; anything else is refused and closed.
      if (type !== RECORD.HELLO) throw new SessionFail("peer_bad_frame");
      const hello = this.parseHello(body);
      if (hello === null) throw new SessionFail("peer_bad_frame");
      this.peerHello = hello;
      this.maxSend = Math.min(MAX_PEER_MESSAGE_BYTES, hello.maxMessage);
      if (this.flow !== null) {
        // Rule 1 (N7): without `vouch/1` on both sides, close before any SAS record.
        const v = this.flow.negotiate(this.caps, this.peerCaps);
        if (!v.ok) throw new SessionFail(v.close);
      }
      const caps = capsIntersection(this.caps, this.peerCaps);
      this.caps = caps;
      const p = this.pending!;
      this.pending = null;
      this.hash = this.hs!.handshakeHash.slice();
      this.phase = this.o.mode === "a" ? "open" : "sas";
      this.o.onEvent({
        type: "established",
        caps,
        hello,
        helloAuthenticated: this.o.mode === "a",
        remoteStatic: p.remote,
        peerDeviceId: p.peerDeviceId,
      });
      if (this.o.mode === "a") await this.pushRing();
      else if (this.o.role === "initiator" && this.o.holdSas !== true) {
        // D commits first, unless the host holds the code back until it picks this approver.
        await this.commitSas();
      }
      return;
    }
    switch (type) {
      case RECORD.HELLO:
        throw new SessionFail("peer_bad_frame");
      case RECORD.PING:
        await this.emitRecords(RECORD.PONG, body);
        return;
      case RECORD.PONG:
        return;
      case RECORD.REKEY:
        await this.tp!.receive.rekey();
        return;
      case RECORD.CLOSE: {
        const o = parseStrictObject(body);
        const code = typeof o?.code === "string" ? o.code : "";
        this.phase = "closed";
        this.stopClock();
        this.queued = [];
        this.o.onEvent({
          type: "closed",
          code: KNOWN_CLOSE.has(code)
            ? (code as PeerCloseCode)
            : "peer_bad_frame",
          byPeer: true,
        });
        return;
      }
      case RECORD.TRUST: {
        const o = parseStrictObject(body);
        if (o === null || typeof o.trust !== "string")
          throw new SessionFail("peer_bad_frame");
        this.o.onEvent({ type: "trust-unverified", jws: o.trust });
        return;
      }
      case RECORD.SAS_COMMIT:
      case RECORD.SAS_NONCE:
      case RECORD.SAS_REVEAL:
        await this.onSas(type, body);
        return;
      case RECORD.RING:
        await this.onRing(body);
        return;
    }
    // Everything else belongs to the host, and only once the code is settled.
    if (this.phase === "sas-shown") {
      // The peer may confirm first: hold the record (bounded) until this side's person does.
      const held = this.queued.reduce((n, q) => n + q.body.length, 0);
      if (
        this.queued.length >= MAX_QUEUED ||
        held + body.length > MAX_QUEUED_BYTES
      )
        throw new SessionFail("peer_busy");
      this.queued.push({ type, body });
      return;
    }
    if (this.phase !== "open") throw new SessionFail("peer_not_allowed");
    this.o.onEvent({ type: "record", recordType: type, body });
  }

  private parseHello(body: Uint8Array): PeerHello | null {
    // Modes v and p take a HELLO from a peer that is not yet verified: 4 KiB at most (§15.6).
    if (this.o.mode !== "a" && body.length > MAX_UNVERIFIED_HELLO) return null;
    const o = parseStrictObject(body);
    if (o === null) return null;
    if (typeof o.platform !== "string" || typeof o.app !== "string")
      return null;
    if (o.label !== undefined && typeof o.label !== "string") return null;
    // Display data from an unauthenticated peer: NFC, controls and bidi stripped, 64 code points.
    const label = o.label === undefined ? null : cleanLabel(o.label);
    const app = cleanApp(o.app);
    const platform = cleanPlatform(o.platform);
    if (
      typeof o.maxMessage !== "number" ||
      !Number.isSafeInteger(o.maxMessage) ||
      o.maxMessage < 1
    )
      return null;
    return {
      ...(label !== null ? { label } : {}),
      platform,
      app,
      maxMessage: o.maxMessage,
    };
  }

  private async commitSas(): Promise<void> {
    this.nD = this.ports.random(32);
    await this.emitRecords(
      RECORD.SAS_COMMIT,
      sasBody("c", await sasCommit(this.nD)),
    );
    this.sasStep = 1;
  }

  private async onSas(type: number, body: Uint8Array): Promise<void> {
    if (this.phase !== "sas" || this.sasDone)
      throw new SessionFail("peer_bad_frame");
    const initiator = this.o.role === "initiator";
    // Responder (M): COMMIT then REVEAL. Initiator (D): NONCE.
    if (type === RECORD.SAS_COMMIT && !initiator && this.sasStep === 0) {
      const c = parseSasBody("c", body);
      if (c === null) throw new SessionFail("peer_bad_frame");
      this.commit = encodeSasValue(c);
      this.nM = this.ports.random(32);
      await this.emitRecords(RECORD.SAS_NONCE, sasBody("nM", this.nM));
      this.sasStep = 1;
      return;
    }
    if (type === RECORD.SAS_NONCE && initiator && this.sasStep === 1) {
      const nM = parseSasBody("nM", body);
      if (nM === null) throw new SessionFail("peer_bad_frame");
      this.nM = nM;
      await this.emitRecords(RECORD.SAS_REVEAL, sasBody("nD", this.nD!));
      await this.finishSas();
      return;
    }
    if (type === RECORD.SAS_REVEAL && !initiator && this.sasStep === 1) {
      const nD = parseSasBody("nD", body);
      if (nD === null || !(await sasRevealOk(this.commit!, encodeSasValue(nD))))
        throw new SessionFail("peer_bad_frame");
      this.nD = nD;
      await this.finishSas();
      return;
    }
    throw new SessionFail("peer_bad_frame");
  }

  private async finishSas(): Promise<void> {
    const h = this.hs!.handshakeHash;
    const code = await sasValue(h, this.nD!, this.nM!, this.o.mode);
    this.sasDone = true;
    this.phase = "sas-shown";
    this.o.onEvent({ type: "sas", code, display: sasDisplay(code) });
  }

  private async pushRing(): Promise<void> {
    const held = this.o.account!.heldRing();
    if (held !== null && held.epoch > this.peerRing)
      await this.emitRecords(
        RECORD.RING,
        utf8(JSON.stringify({ ring: held.jws })),
      );
  }

  private async onRing(body: Uint8Array): Promise<void> {
    const a = this.o.account!;
    const o = parseStrictObject(body);
    if (o === null || typeof o.ring !== "string")
      throw new SessionFail("peer_bad_frame");
    const r = await replaceRing(a.heldRing()?.jws ?? null, o.ring, {
      trust: a.trust,
      expectedAud: a.expectedAud,
      now: this.now(),
    });
    // A roster that is stale, older or another account's changes nothing.
    if (!r.replace || r.ring.sub !== a.ownSub) return;
    this.o.onEvent({ type: "ring", jws: o.ring, epoch: r.ring.epoch });
    // The new roster may have dropped this peer.
    const adm = await this.admit(this.peerCertJws, o.ring, this.peerRemote!);
    if (!adm.admit) throw new SessionFail("peer_revoked");
  }

  /** Seal records onto the wire, one at a time so a REKEY never interleaves. */
  private emitRecords(type: number, body: Uint8Array): Promise<void> {
    const run = this.sendChain.then(async () => {
      const tp = this.tp;
      if (tp === null || (this.phase === "closed" && type !== RECORD.CLOSE))
        throw new Error("closed");
      await this.maybeRekey();
      for (const plain of splitMessage(type, body)) {
        this.o.send(await tp.send.encrypt(NONE, plain));
        this.sentCount++;
      }
    });
    this.sendChain = run.catch(() => undefined);
    return run;
  }

  private async maybeRekey(): Promise<void> {
    const tp = this.tp!;
    const byCount = this.sentCount >= (this.o.rekeyMessages ?? 1 << 20);
    const bySeconds =
      this.mono() - this.keyedAt >= (this.o.rekeySeconds ?? 3600);
    if (!byCount && !bySeconds) return;
    this.o.send(
      await tp.send.encrypt(
        NONE,
        encodeRecord({ type: RECORD.REKEY, flags: 0, body: NONE }),
      ),
    );
    await tp.send.rekey();
    this.sentCount = 0;
    this.keyedAt = this.mono();
  }
}

/**
 * The approver's admission: at most `max` handshakes a minute per advert (default 5) and at most
 * `maxPending` sessions waiting on a code (default 4). A monotonic clock. An attempt counts only
 * when `begin()` is called, which a session does when it starts.
 */
export class HandshakeLimiter {
  private stamps: number[] = [];
  private pending = 0;
  constructor(
    private readonly max = 5,
    private readonly maxPending = 4,
    private readonly now: () => number = () => performance.now() / 1000,
  ) {}
  /** A release function when one more session may start now; null when refused. */
  begin(): (() => void) | null {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60);
    if (this.stamps.length >= this.max || this.pending >= this.maxPending)
      return null;
    this.stamps.push(t);
    this.pending++;
    let done = false;
    return (): void => {
      if (!done) {
        done = true;
        this.pending--;
      }
    };
  }
}
