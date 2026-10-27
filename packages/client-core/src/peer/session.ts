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
import { admitPeer, replaceRing } from "./cert.js";
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

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const NONE = new Uint8Array(0);

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
  /** The delivered discovery keys, newest first; the initiator uses the first. */
  discKeys: readonly Uint8Array[];
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
  /** Seconds since the epoch. */
  now?: () => number;
  /** Rekey after this many sent messages (default 2^20) or seconds (default 3600). */
  rekeyMessages?: number;
  rekeySeconds?: number;
}

export type SessionEvent =
  /** The handshake and the HELLO exchange are done (modes v and p still need the SAS). */
  | {
      type: "established";
      caps: string[];
      hello: PeerHello;
      remoteStatic: Uint8Array;
      /** Mode a: the admitted certificate's device id. */
      peerDeviceId?: string;
    }
  /** Modes v and p: the code both screens show. */
  | { type: "sas"; code: number; display: string }
  /** A record the host owns. */
  | { type: "record"; recordType: number; body: Uint8Array }
  /** Mode a: a roster that replaced the held one; the host stores it. */
  | { type: "ring"; jws: string }
  /** Mode a: the peer is on a newer roster than the held one; fetch it. */
  | { type: "ring-wanted" }
  | { type: "closed"; code: ClosedReason; byPeer: boolean };

type Phase = "hs" | "hello" | "sas" | "open" | "closed";

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
  private readonly ports: NoisePorts;
  private caps: string[];

  constructor(private readonly o: PeerSessionOptions) {
    if ((o.mode === "a") !== (o.account !== undefined))
      throw new RangeError("account context");
    this.ports = o.ports ?? webCryptoNoisePorts;
    this.now = o.now ?? ((): number => Math.floor(Date.now() / 1000));
    this.asm = new RecordAssembler(o.mode);
    this.caps = [...(o.caps ?? [])];
    this.keyedAt = this.now();
  }

  get isOpen(): boolean {
    return this.phase === "open" || this.phase === "sas";
  }
  get closed(): boolean {
    return this.phase === "closed";
  }

  /** Initiator only: write message 1. */
  start(): Promise<void> {
    return this.run(async () => {
      if (this.o.role !== "initiator" || this.hs !== null)
        throw new SessionFail("handshake_failed");
      this.hs = await this.newHandshake(this.o.account?.discKeys[0]);
      this.o.send(await this.hs.writeMessage(payload1()));
      this.hsStep = 1;
    });
  }

  /** One Noise message from the peer (a de-framed TCP frame, or a relay `RECV` body). */
  receive(noise: Uint8Array): Promise<void> {
    return this.run(async () => {
      if (this.phase === "closed") return;
      if (this.phase === "hs") await this.onHandshake(noise);
      else await this.onTransport(noise);
    });
  }

  /** Send one message of the host's, split into records. Only once the session is open. */
  sendRecord(type: number, body: Uint8Array): Promise<void> {
    const ready =
      this.phase === "open" ||
      (this.phase === "sas" &&
        (type === RECORD.SAS_COMMIT ||
          type === RECORD.SAS_NONCE ||
          type === RECORD.SAS_REVEAL));
    if (!ready) return Promise.reject(new Error("session not open"));
    if (type === RECORD.HELLO || type === RECORD.CLOSE || type === RECORD.REKEY)
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
      const keys: (Uint8Array | undefined)[] =
        mode === "a" ? this.o.account!.discKeys.slice(0, 2) : [undefined];
      let payload: Uint8Array | null = null;
      for (const k of keys) {
        const h = await this.newHandshake(k);
        try {
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
      const adm = await admitPeer(verdict.cert!, held?.jws ?? null, {
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
      if (!adm.admit)
        throw new SessionFail(
          adm.reason === "peer_revoked" ? "peer_revoked" : "handshake_failed",
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
    this.keyedAt = this.now();
    this.phase = "hello";
    this.pending = { remote, peerDeviceId };
    await this.sendHello();
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
      const caps = capsIntersection(this.caps, this.peerCaps);
      this.caps = caps;
      const p = this.pending!;
      this.pending = null;
      this.phase = this.o.mode === "a" ? "open" : "sas";
      this.o.onEvent({
        type: "established",
        caps,
        hello,
        remoteStatic: p.remote,
        peerDeviceId: p.peerDeviceId,
      });
      if (this.o.mode === "a") await this.pushRing();
      else if (this.o.role === "initiator") {
        // D commits first.
        this.nD = this.ports.random(32);
        await this.emitRecords(
          RECORD.SAS_COMMIT,
          sasBody("c", await sasCommit(this.nD)),
        );
        this.sasStep = 1;
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
        this.o.onEvent({
          type: "closed",
          code: /^peer_[a-z_]+$/.test(code)
            ? (code as PeerCloseCode)
            : "peer_bye",
          byPeer: true,
        });
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
    if (this.phase !== "open") throw new SessionFail("peer_not_allowed");
    this.o.onEvent({ type: "record", recordType: type, body });
  }

  private parseHello(body: Uint8Array): PeerHello | null {
    const o = parseStrictObject(body);
    if (o === null) return null;
    if (typeof o.platform !== "string" || typeof o.app !== "string")
      return null;
    if (o.label !== undefined && typeof o.label !== "string") return null;
    if (
      typeof o.maxMessage !== "number" ||
      !Number.isSafeInteger(o.maxMessage) ||
      o.maxMessage < 1
    )
      return null;
    return {
      ...(o.label !== undefined ? { label: o.label } : {}),
      platform: o.platform,
      app: o.app,
      maxMessage: o.maxMessage,
    };
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
    this.phase = "open";
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
    if (r.replace) this.o.onEvent({ type: "ring", jws: o.ring });
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
      this.now() - this.keyedAt >= (this.o.rekeySeconds ?? 3600);
    if (!byCount && !bySeconds) return;
    this.o.send(
      await tp.send.encrypt(
        NONE,
        encodeRecord({ type: RECORD.REKEY, flags: 0, body: NONE }),
      ),
    );
    await tp.send.rekey();
    this.sentCount = 0;
    this.keyedAt = this.now();
  }
}

/** The approver's limit: at most `max` handshakes a minute per advert (default 5). */
export class HandshakeLimiter {
  private stamps: number[] = [];
  constructor(
    private readonly max = 5,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}
  /** True when one more handshake may start now. */
  allow(): boolean {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(t);
    return true;
  }
}
