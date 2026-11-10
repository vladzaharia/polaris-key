// WIRE-CONTRACT-V5 §15.5 and §15.6: one `pkey-peer/1` session, per mode (a account, v approver,
// p pair, c contact). It owns no socket: Noise messages come in through `receive` (already de-framed) and go
// out through the `send` callback, so the same machine runs over TCP, the relay or memory.
//
// Order: Noise XX (XXpsk0 in mode a) with the payload rules of §15.5; in mode a each side verifies
// the other's certificate against the remote static key and the held ring; then HELLO each way,
// which must be the first record; then, in modes v and p, the commit-reveal SAS. Nothing is
// delivered to the host (`record` events) before that. Every failure ends the session; before the
// transport exists nothing is sent, after it a CLOSE record names the code.
//
// Mode c (§15.10) is mode a without a certificate: XXpsk0 under a contact's secret, the device's
// agreeKey as the static key, no code. The remote static key must equal the contact's agreeKey. A
// mode-p session can also run the contact exchange (`exchange`): after both CONFIRMs each side
// sends CONTACT, and the session answers with a `contact` event carrying the new secret.
//
// Modes q and l (§15.12) are the account-free local links. Mode q is the pairing: XXpsk0 under a
// PSK from CPace (`cpace.ts`, run by the caller before message 1), a fresh link key as the static
// key, then HELLO, the person's consent, CONFIRM each way and one LOCAL_LINK each way
// (`LocalExchange`); a side that reads the peer's LOCAL_LINK reports a `local-link` event and closes
// `peer_bye`. Mode l is a later session: XXpsk0 under a link's secret, the link's own key as the
// static key, and the remote static key pinned to the stored peer link key. A responder that holds
// local links tries them after the account keys and the contacts, behind the same limiter.

import {
  base64UrlDecode,
  base64UrlEncodeBytes,
  type TrustSet,
} from "@polaris-key/jws";
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
import { XFER_CAP, isXferType } from "./xfer.js";
import {
  LOCAL_CAP,
  LocalExchange,
  MAX_LOCAL_LINKS,
  buildLocalLink,
  listenerTrialOrder,
  localLinkSecret,
  trialPadding,
  localPin,
  negotiateLocalCaps,
  pairingRemoteOk,
  type LocalExchangeEvent,
} from "./local.js";
import {
  CONTACT_EXCHANGE_SECONDS,
  ContactExchange,
  MAX_CONTACT_SECRETS,
  buildContact,
  contactPin,
  contactSecret,
  type ContactBody,
  type ExchangeEvent,
  type ExchangeStep,
} from "./contact.js";

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

/** A contact the device holds (mode c): its secret and the peer's agreeKey. */
export interface ContactLink {
  /** The 32-byte contact secret, the PSK. */
  secret: Uint8Array;
  /** The peer's agreeKey, 43 canonical base64url characters: the remote static key must equal it. */
  agreeKey: string;
}

/** A local link the device holds (mode l, §15.12): the link's secret and both link keys. */
export interface LocalLink {
  /** The 32-byte link secret, the PSK. */
  secret: Uint8Array;
  /** This device's private key for the link, the static key of every session under it. */
  ownKey: Uint8Array;
  /** The peer's link public key: the remote static key must equal it. */
  peerKey: Uint8Array;
}

/** What a mode-`q` session needs (§15.12): the CPace outputs and this side's part of the exchange. */
export interface PairingOptions {
  /** `HKDF-SHA256(ISK)`, the Noise PSK (`cpacePsk`). Overwritten once the handshake is done. */
  psk: Uint8Array;
  /** The CPace ISK, 64 bytes: it makes the link secret. Overwritten when the session ends. */
  isk: Uint8Array;
  /** The number of local links the device holds for the product (`MAX_LOCAL_LINKS` refuses a link). */
  held: number;
  /** The categories this side's person approved. */
  cats: readonly string[];
  /** This device's label for the peer to show. */
  label?: string;
  /**
   * Seconds already spent since the first byte (C1 and C2 ran before the session). At 30 or more
   * the session starts no handshake and tries no tag.
   */
  elapsed: number;
  /**
   * A responder's permit to try message 1's tag (`PairingWindow.beginGuess`): synchronous, it counts
   * the guess before the tag is tried. The session never tries a tag without one, and the
   * constructor refuses a mode-q responder without it.
   */
  permit?: () => boolean;
}

/** This device's side of the contact exchange (mode p, §15.10). */
export interface ContactOffer {
  /** This device's own agreeKey, 43 canonical base64url characters. */
  agreeKey: string;
  /** The agreeKey of every active contact the host holds for the product (`ContactExchange`). */
  held?: readonly string[];
  label?: string;
  /** The data categories this side's person approved (at most 8, `^[a-z0-9-]{1,32}$`). */
  cats: readonly string[];
}

export interface PeerSessionOptions {
  mode: PeerMode;
  role: "initiator" | "responder";
  slug: string;
  /**
   * The X25519 private key: the device's agreeKey in modes a and c, a one-time key in v and p, the
   * new link key in mode q. Mode l takes each link's own key from `locals` instead.
   */
  staticKey?: Uint8Array;
  /** Mode a only. */
  account?: AccountContext;
  /**
   * Mode c, and a mode-a responder that also serves contacts (the shared listener, §15.10): the
   * contacts the device holds for the product in `contactTrialOrder`, at most 72. A mode-c
   * initiator names exactly one. A responder first tries the account's keys (mode a only), then
   * each secret in order; the first tag that verifies decides the mode. It needs `admission`.
   */
  contacts?: readonly ContactLink[];
  /**
   * Mode l, and a responder that also serves local links (§15.12): the links the device holds in
   * held order, at most 32. A mode-l initiator names exactly one. A responder tries them after the
   * account's keys and the contacts, behind the same `admission` limiter.
   */
  locals?: readonly LocalLink[];
  /** Mode q only. */
  pair?: PairingOptions;
  /**
   * Mode p only: take part in the contact exchange. The session then owns `CONFIRM` and
   * `CONTACT` and ends it with a `contact` event; without it the host sees both as records.
   */
  exchange?: ContactOffer;
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
   * Required for a responder in modes v and p (the approver) and for a responder that serves
   * contacts: the limiter that admits a new handshake and caps the sessions waiting on a code (v,
   * p) or on message 3 (the contact trial). The constructor refuses without it.
   */
  admission?: HandshakeLimiter;
  /**
   * A responder that holds no account key (a local-links-only listener): the source group of the
   * connection (the accept gate's own key). With it, the trial is admitted by the group's budget
   * first and only a failed trial spends the shared one (§15.10, "Admission"). Without it, or
   * with an account key tried, the shared limiter admits as before.
   */
  admissionGroup?: string;
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
      /** Mode c: the index, in `contacts`, of the contact the peer is. */
      contactIndex?: number;
      /** Mode l: the index, in `locals`, of the link the peer is. */
      localIndex?: number;
    }
  /**
   * Mode q, responder: its message 1 was judged (§15.12, "Failure accounting"). `opens` false is one
   * failed guess: the window rotates the code, and the session closes silently.
   */
  | { type: "guess"; opens: boolean }
  /**
   * Mode q: the peer's valid `LOCAL_LINK`, read in order. `secret` is the link secret (key
   * material: store it, never log it) with `ownKey`, `peerKey` the two link public keys and `cats`
   * the categories both sides listed. The host stores the link; the session closes `peer_bye`.
   */
  | {
      type: "local-link";
      secret: Uint8Array;
      ownKey: Uint8Array;
      peerKey: Uint8Array;
      label?: string;
      cats: string[];
    }
  /** Modes v and p: the code both screens show; the host calls `confirmSas()` when the person agrees. */
  | { type: "sas"; code: number; display: string }
  /**
   * A record the host owns, delivered only once the session is open (in modes v and p, after
   * `confirmSas()`). The host must close on an APP_CRITICAL type (0x8100 to 0xFFFD) it does not
   * understand.
   */
  | { type: "record"; recordType: number; body: Uint8Array }
  /**
   * Mode p with `exchange`: the peer's valid `CONTACT`, read in order. `secret` is the new contact
   * secret (key material: store it, never log it). The host stores the contact (`storeContact`:
   * `pending` is true for a peer it already holds) and closes `peer_bye`.
   */
  | ({ type: "contact"; secret: Uint8Array; pending: boolean } & ContactBody)
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
  private asm: RecordAssembler;
  /** The session's mode: `o.mode`, or `c` once a shared-listener responder matched a contact. */
  private mode: PeerMode;
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
  private xfer: ((type: number, body: Uint8Array) => void) | null = null;
  private hash: Uint8Array | null = null;
  private contactIdx = -1;
  private localIdx = -1;
  private readonly xchg: ContactExchange | null;
  /** Mode q: the pairing's order guard, and the clock that runs once both CONFIRMs are done. */
  private readonly lx: LocalExchange | null;
  private lxTimer = false;
  private ownPub: Uint8Array | null = null;

  constructor(private readonly o: PeerSessionOptions) {
    if ((o.mode === "a") !== (o.account !== undefined))
      throw new RangeError("account context");
    this.mode = o.mode;
    const nC = o.contacts?.length ?? 0;
    const nL = o.locals?.length ?? 0;
    const bad32 = (list: readonly Uint8Array[]): boolean =>
      list.some((k) => k.length !== 32);
    if (o.mode !== "l" && o.staticKey === undefined)
      throw new RangeError("static key");
    if (o.mode === "c") {
      if (
        nC < 1 ||
        nC > MAX_CONTACT_SECRETS ||
        (o.role === "initiator" && nC !== 1)
      )
        throw new RangeError("contacts");
      if (o.role === "responder" && o.admission === undefined)
        throw new RangeError("a contact responder needs an admission limiter");
      if (
        o.locals !== undefined &&
        (o.role !== "responder" || nL < 1 || nL > MAX_LOCAL_LINKS)
      )
        throw new RangeError("locals");
    } else if (o.mode === "l") {
      if (
        nL < 1 ||
        nL > MAX_LOCAL_LINKS ||
        (o.role === "initiator" && nL !== 1)
      )
        throw new RangeError("locals");
      if (
        o.contacts !== undefined &&
        (o.role !== "responder" || nC < 1 || nC > MAX_CONTACT_SECRETS)
      )
        throw new RangeError("contacts");
      if (o.role === "responder" && o.admission === undefined)
        throw new RangeError(
          "a local-link responder needs an admission limiter",
        );
    } else if (o.contacts !== undefined || o.locals !== undefined) {
      // The shared listener: a mode-a responder that also serves contacts and local links.
      if (
        o.mode !== "a" ||
        o.role !== "responder" ||
        (o.contacts !== undefined && (nC < 1 || nC > MAX_CONTACT_SECRETS)) ||
        (o.locals !== undefined && (nL < 1 || nL > MAX_LOCAL_LINKS))
      )
        throw new RangeError("contacts");
      if (o.admission === undefined)
        throw new RangeError("a contact responder needs an admission limiter");
    }
    if (
      bad32((o.contacts ?? []).map((c) => c.secret)) ||
      bad32((o.locals ?? []).flatMap((l) => [l.secret, l.ownKey, l.peerKey]))
    )
      throw new RangeError("secrets");
    if (o.mode === "q") {
      if (
        o.pair === undefined ||
        o.pair.psk.length !== 32 ||
        o.pair.isk.length !== 64 ||
        o.pair.held < 0 ||
        !(o.pair.elapsed >= 0) ||
        (o.role === "responder" && o.pair.permit === undefined)
      )
        throw new RangeError("pairing");
    } else if (o.pair !== undefined)
      throw new RangeError("pairing is for mode q");
    this.lx =
      o.pair !== undefined ? new LocalExchange(o.pair.held, o.pair.cats) : null;
    if (o.exchange !== undefined && o.mode !== "p")
      throw new RangeError("exchange is for mode p");
    this.xchg =
      o.exchange !== undefined
        ? new ContactExchange(o.exchange.agreeKey, o.exchange.held)
        : null;
    if (o.holdSas === true && (o.mode !== "v" || o.role !== "initiator"))
      throw new RangeError("holdSas is for the mode v initiator");
    if (
      (o.mode === "v" || o.mode === "p") &&
      o.role === "responder" &&
      o.admission === undefined
    )
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
    // Mode q needs `local/1` on both sides (§15.12): the host cannot leave it out of its payload.
    if (o.mode === "q" && !this.caps.includes(LOCAL_CAP))
      this.caps.push(LOCAL_CAP);
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
   * Mode v, `holdSas` initiator: the person chose this approver; send `SAS_COMMIT` now and start
   * the 120 s code deadline over. Only once, only after `established`; any other call closes the
   * session `peer_not_allowed`.
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
      // The code deadline counts from the person's choice, not from the first byte: a session
      // held while the person looked at the list keeps its whole 120 s.
      this.sasCancel?.();
      this.sasCancel = this.guard(SAS_DEADLINE_SECONDS);
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
      if (this.mode === "p") await this.emitRecords(RECORD.CONFIRM, utf8("{}"));
      if (this.xchg !== null) {
        // The peer's CONTACT must follow within CONTACT_EXCHANGE_SECONDS of this CONFIRM.
        this.cancels.push(
          this.timer(
            () => void this.run(() => this.exchangeStep({ event: "timeout" })),
            CONTACT_EXCHANGE_SECONDS * 1000,
          ),
        );
        await this.exchangeStep({ event: "own-confirm" });
      }
      const q = this.queued;
      this.queued = [];
      for (const m of q)
        this.o.onEvent({ type: "record", recordType: m.type, body: m.body });
    });
  }

  /**
   * Mode q: the person agreed to pair. Sends `CONFIRM`, and `LOCAL_LINK` once the peer's `CONFIRM`
   * has been read. Only once, only after `established`; any other call closes the session
   * `peer_not_allowed`.
   */
  confirmPairing(): Promise<void> {
    return this.run(async () => {
      if (this.lx === null || this.phase !== "sas-shown")
        throw new SessionFail("peer_not_allowed");
      this.phase = "open";
      await this.localStep({ event: "own-confirm" });
    });
  }

  /** Mode q: the person declined. Closes `peer_bye` (a decline after the person agreed is ignored). */
  declinePairing(): Promise<void> {
    return this.run(async () => {
      if (this.lx === null) throw new SessionFail("peer_not_allowed");
      await this.localStep({ event: "own-decline" });
    });
  }

  /** A deadline that closes the session `peer_timeout` after `sec` seconds. */
  private guard(sec: number): () => void {
    return this.timer(
      () => void this.run(() => this.fail("peer_timeout", false)),
      sec * 1000,
    );
  }

  private startClock(): void {
    if (this.started) return;
    this.started = true;
    // Mode q: C1 and C2 ran before this session, so their time counts against both deadlines.
    const spent = this.o.pair?.elapsed ?? 0;
    this.transportCancel = this.guard(
      Math.max(0, TRANSPORT_DEADLINE_SECONDS - spent),
    );
    if (this.mode === "v" || this.mode === "p")
      this.sasCancel = this.guard(SAS_DEADLINE_SECONDS);
    else if (this.mode === "q")
      // 120 s from the first byte until both CONFIRMs are done (§15.12).
      this.sasCancel = this.timer(
        () => void this.run(() => this.localStep({ event: "timeout-confirm" })),
        Math.max(0, SAS_DEADLINE_SECONDS - spent) * 1000,
      );
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
    // The CPace outputs are key material: gone once the session is over.
    this.o.pair?.psk.fill(0);
    this.o.pair?.isk.fill(0);
  }

  get closed(): boolean {
    return this.phase === "closed";
  }

  /** Initiator only: write message 1. */
  start(): Promise<void> {
    return this.run(async () => {
      if (this.o.role !== "initiator" || this.hs !== null)
        throw new SessionFail("handshake_failed");
      if (
        this.o.pair !== undefined &&
        this.o.pair.elapsed >= TRANSPORT_DEADLINE_SECONDS
      )
        throw new SessionFail("handshake_failed");
      const key = this.o.account?.discKeys[0] ?? undefined;
      if (this.mode === "a" && key === undefined)
        throw new SessionFail("handshake_failed");
      this.startClock();
      if (this.mode === "c") this.contactIdx = 0;
      if (this.mode === "l") this.localIdx = 0;
      this.hs =
        this.mode === "l"
          ? this.newHandshake(
              "l",
              this.o.locals![0]!.secret,
              this.o.locals![0]!.ownKey,
            )
          : this.newHandshake(
              this.mode,
              this.mode === "c"
                ? this.o.contacts![0]!.secret
                : this.mode === "q"
                  ? this.o.pair!.psk
                  : await this.pskOf(this.mode, key),
            );
      this.o.send(await this.hs.writeMessage(payload1()));
      this.hsStep = 1;
    });
  }

  /** One Noise message from the peer (a de-framed TCP frame, or a relay `RECV` body). */
  receive(noise: Uint8Array): Promise<void> {
    return this.run(async () => {
      if (this.phase === "closed") return;
      if (!this.started && this.o.role === "responder") {
        // An approver counts the attempt only now that a session starts. A contact responder is
        // admitted at its contact trial instead (message 1 is tried under the account's keys
        // first).
        if (
          this.o.admission !== undefined &&
          (this.mode === "v" || this.mode === "p")
        ) {
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
    // A pairing carries no host records: the session owns every one it may send (§15.12).
    if (this.mode === "q")
      return Promise.reject(new Error("record owned by the session"));
    if (
      type === RECORD.HELLO ||
      type === RECORD.CLOSE ||
      type === RECORD.REKEY ||
      type === RECORD.SAS_COMMIT ||
      type === RECORD.SAS_NONCE ||
      type === RECORD.SAS_REVEAL ||
      isXferType(type) ||
      (type === RECORD.CONFIRM && this.mode === "p") ||
      (type === RECORD.CONTACT && this.xchg !== null)
    )
      return Promise.reject(new Error("record owned by the session"));
    if (body.length > this.maxSend)
      return Promise.reject(new Error("message too large"));
    return this.emitRecords(type, body);
  }

  /**
   * The transfer port (§15.11): the one reader and writer of the six xfer record types. Records of
   * those types reach `onRecord` instead of the host's `record` event, and `sendRecord` refuses
   * them. Only once the session is `established` with `xfer/1` among its capabilities, and once.
   * Returns the writer.
   */
  attachXfer(
    onRecord: (type: number, body: Uint8Array) => void,
  ): (type: number, body: Uint8Array) => Promise<void> {
    if (
      this.phase !== "open" ||
      this.xfer !== null ||
      !this.caps.includes(XFER_CAP)
    )
      throw new Error("transfers are not available on this session");
    this.xfer = onRecord;
    return (type, body) => {
      if (this.phase !== "open" || !isXferType(type))
        return Promise.reject(new Error("session not open"));
      if (body.length > this.maxSend)
        return Promise.reject(new Error("message too large"));
      return this.emitRecords(type, body);
    };
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

  /** The mode-a PSK of a discovery key; undefined in modes v and p. */
  private async pskOf(
    mode: PeerMode,
    discKey: Uint8Array | undefined,
  ): Promise<Uint8Array | undefined> {
    return mode === "a" ? await peerPsk(discKey!, this.o.slug) : undefined;
  }

  private newHandshake(
    mode: PeerMode,
    psk: Uint8Array | undefined,
    staticKey: Uint8Array | undefined = this.o.staticKey,
  ): NoiseHandshake {
    const { slug } = this.o;
    return new NoiseHandshake({
      role: this.o.role,
      protocol: peerNoiseProtocol(mode),
      prologue: peerPrologue(slug, mode),
      psk,
      staticKey: staticKey!,
      ports: this.ports,
    });
  }

  private ownPayload(): Uint8Array {
    const a = this.o.account;
    if (a === undefined || this.mode !== "a")
      return payload23(this.mode, this.caps);
    const ring = a.heldRing();
    return payload23(this.mode, this.caps, {
      cert: a.certJws,
      ring: ring?.epoch ?? 1,
    });
  }

  private async onHandshake(noise: Uint8Array): Promise<void> {
    const { role } = this.o;
    const mode = this.mode;
    if (role === "responder" && this.hs === null) {
      // Message 1, tried in a fixed order (§15.5, §15.10, §15.12): the account's current then
      // previous discovery key (mode a), then each contact's secret and each local link's secret in
      // the order of `listenerTrialOrder` (no DH happens before the tag). The first tag that
      // verifies decides the mode and the secret; a failed tag on every one closes silently. The
      // contact and local-link trials are admitted by the limiter first, so a refused attempt tries
      // no secret.
      let payload: Uint8Array | null = null;
      let accountTried = 0;
      if (mode === "q") {
        // The pairing window's attempt: one secret, the code's PSK. A tag that fails is one
        // failed guess (§15.12): the host's window rotates the code.
        // The permit counts the guess before the tag is tried; without it, or past the attempt's
        // 30 s, the tag is never tried (§15.12, "Failure accounting").
        if (
          this.o.pair!.elapsed >= TRANSPORT_DEADLINE_SECONDS ||
          !this.o.pair!.permit!()
        )
          throw new SessionFail("handshake_failed");
        const h = this.newHandshake("q", this.o.pair!.psk);
        try {
          payload = await h.readMessage(noise);
          this.hs = h;
        } catch {
          this.o.onEvent({ type: "guess", opens: false });
          throw new SessionFail("handshake_failed");
        }
        this.o.onEvent({ type: "guess", opens: true });
      } else if (mode !== "c" && mode !== "l") {
        const keys: (Uint8Array | null | undefined)[] =
          mode === "a" ? this.o.account!.discKeys.slice(0, 2) : [undefined];
        for (const k of keys) {
          if (k === null) continue;
          accountTried++;
          try {
            const h = this.newHandshake(mode, await this.pskOf(mode, k));
            payload = await h.readMessage(noise);
            this.hs = h;
            break;
          } catch {
            /* try the next key */
          }
        }
      }
      if (
        this.hs === null &&
        (this.o.contacts !== undefined || this.o.locals !== undefined)
      ) {
        // No account key held and a group known: the group's budget, then the shared limiter
        // that only a failed trial spends (§15.10, "Admission"). Otherwise the shared limiter
        // counts the attempt as it begins.
        let attempt: LocalAdmission | null = null;
        if (accountTried === 0 && this.o.admissionGroup !== undefined) {
          const a = this.o.admission!.beginLocal(this.o.admissionGroup);
          if (!a.ok) throw new SessionFail("peer_busy");
          attempt = a;
        } else {
          this.release = this.o.admission!.begin();
          if (this.release === null) throw new SessionFail("peer_busy");
        }
        let tried = 0;
        const plan = listenerTrialOrder(
          null,
          this.o.contacts?.length ?? 0,
          this.o.locals?.length ?? 0,
        );
        for (const t of plan) {
          try {
            const h =
              t.kind === "c"
                ? this.newHandshake("c", this.o.contacts![t.index]!.secret)
                : this.newHandshake(
                    "l",
                    this.o.locals![t.index]!.secret,
                    this.o.locals![t.index]!.ownKey,
                  );
            payload = await h.readMessage(noise);
            this.hs = h;
            if (t.kind === "c") this.contactIdx = t.index;
            else this.localIdx = t.index;
            this.mode = t.kind === "c" ? "c" : "l";
            this.asm = new RecordAssembler(this.mode);
            if (attempt !== null) this.release = attempt.hit();
            break;
          } catch {
            tried++;
          }
        }
        // A miss costs the same whatever the host holds: dummy trials make up the difference.
        if (this.hs === null) {
          attempt?.miss();
          for (let n = trialPadding(tried + accountTried); n > 0; n--) {
            try {
              // On the default ports, so a host's own ports count only the real trials.
              await new NoiseHandshake({
                role: "responder",
                protocol: peerNoiseProtocol("l"),
                prologue: peerPrologue(this.o.slug, "l"),
                psk: webCryptoNoisePorts.random(32),
                staticKey: webCryptoNoisePorts.random(32),
              }).readMessage(noise);
            } catch {
              /* a dummy secret opens nothing */
            }
          }
        }
      }
      if (this.hs === null || payload === null)
        throw new SessionFail("handshake_failed");
      if (!parseHandshakePayload(this.mode, 1, payload).ok)
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
    if (mode === "c") {
      // The pin (§15.10): the peer must be the key the contact was made with. Nothing is sent.
      if (!contactPin(this.o.contacts![this.contactIdx]!.agreeKey, remote))
        throw new SessionFail("peer_revoked");
    }
    if (mode === "l") {
      // The pin (§15.12): the peer must be the key the link was made with. Nothing is sent.
      if (!localPin(this.o.locals![this.localIdx]!.peerKey, remote))
        throw new SessionFail("peer_revoked");
    }
    if (mode === "q") {
      // A reflected handshake (the peer's static key is our own) ends silently, before the
      // transport (§15.12, "Link keys").
      this.ownPub = await this.ports.x25519.publicKey(this.o.staticKey!);
      if (!pairingRemoteOk(this.ownPub, remote))
        throw new SessionFail("handshake_failed");
    }
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
    this.o.pair?.psk.fill(0);
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
      if (this.mode === "q") {
        // `local/1` is mandatory (§15.12): without it, close before any consent prompt.
        const n = negotiateLocalCaps("q", this.caps, this.peerCaps);
        if (n.close !== undefined) throw new SessionFail(n.close);
      }
      this.caps = caps;
      this.asm.xferAllowed = caps.includes(XFER_CAP);
      const p = this.pending!;
      this.pending = null;
      this.hash = this.hs!.handshakeHash.slice();
      const direct =
        this.mode === "a" || this.mode === "c" || this.mode === "l";
      // Mode q has no code to compare: its person's consent follows (`confirmPairing`).
      this.phase = direct ? "open" : this.mode === "q" ? "sas-shown" : "sas";
      // A contact responder's slot among the connections waiting for message 3 ends here.
      if (direct) this.settle();
      this.o.onEvent({
        type: "established",
        caps,
        hello,
        // Only mode a's HELLO is authenticated by a certificate. A contact's is display data from
        // a peer the host knows by its secret and key: the host shows the label it stored.
        helloAuthenticated: this.mode === "a",
        remoteStatic: p.remote,
        peerDeviceId: p.peerDeviceId,
        ...(this.mode === "c" ? { contactIndex: this.contactIdx } : {}),
        ...(this.mode === "l" ? { localIndex: this.localIdx } : {}),
      });
      if (this.mode === "a") await this.pushRing();
      else if (
        !direct &&
        this.mode !== "q" &&
        this.o.role === "initiator" &&
        this.o.holdSas !== true
      ) {
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
        if (this.mode !== "a") throw new SessionFail("peer_not_allowed");
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
      case RECORD.CONFIRM:
      case RECORD.CONTACT:
      case RECORD.LOCAL_LINK:
        if (this.lx !== null) {
          // Mode q: the session owns both records. Only after the transport is up.
          if (this.phase !== "sas-shown" && this.phase !== "open")
            throw new SessionFail("peer_not_allowed");
          await this.localStep(
            type === RECORD.CONFIRM
              ? { event: "peer-confirm" }
              : { event: "peer-link", body },
          );
          return;
        }
        if (this.xchg !== null) {
          // With the exchange on, the session owns both. Only after the code is shown.
          if (this.phase !== "sas-shown" && this.phase !== "open")
            throw new SessionFail("peer_not_allowed");
          await this.exchangeStep(
            type === RECORD.CONFIRM
              ? { event: "peer-confirm" }
              : { event: "peer-contact", body },
          );
          return;
        }
        break;
      case RECORD.RING:
        // Only mode a has a roster; the assembler refuses RING elsewhere, and this keeps it so.
        if (this.mode !== "a") throw new SessionFail("peer_not_allowed");
        await this.onRing(body);
        return;
    }
    if (isXferType(type)) {
      // Direct Transfer: the caps were checked at the assembler; no port attached means the host
      // listed the capability without a transfer layer behind it.
      if (this.xfer === null) throw new SessionFail("peer_not_allowed");
      this.xfer(type, body);
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
    if (this.mode !== "a" && body.length > MAX_UNVERIFIED_HELLO) return null;
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
      // Mode v: the code deadline counts from D's choice, as D's does from `startSas()`; a session
      // held while D's person looked at the list keeps its whole 120 s on this end too.
      if (this.mode === "v") {
        this.sasCancel?.();
        this.sasCancel = this.guard(SAS_DEADLINE_SECONDS);
      }
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
    const code = await sasValue(h, this.nD!, this.nM!, this.mode);
    this.sasDone = true;
    this.phase = "sas-shown";
    this.o.onEvent({ type: "sas", code, display: sasDisplay(code) });
  }

  /** Run one event through the pairing exchange (mode q) and act on what it says. */
  private async localStep(e: LocalExchangeEvent): Promise<void> {
    const x = this.lx!;
    const r = x.step(e);
    if (r.sends.includes("CONFIRM"))
      await this.emitRecords(RECORD.CONFIRM, utf8("{}"));
    if (r.sends.includes("LOCAL_LINK"))
      await this.emitRecords(
        RECORD.LOCAL_LINK,
        buildLocalLink({
          ...(this.o.pair!.label !== undefined
            ? { label: this.o.pair!.label }
            : {}),
          cats: this.o.pair!.cats,
        }),
      );
    // Both CONFIRMs done: the 120 s deadline ends and the exchange's 30 s begins.
    if (x.bothConfirmed && !this.lxTimer) {
      this.lxTimer = true;
      this.settle();
      this.cancels.push(
        this.timer(
          () =>
            void this.run(() => this.localStep({ event: "timeout-exchange" })),
          CONTACT_EXCHANGE_SECONDS * 1000,
        ),
      );
    }
    if (r.stored !== undefined) {
      const own = this.ownPub!;
      const peer = this.hs!.remoteStatic!;
      const secret = await localLinkSecret(
        this.hash!,
        this.o.pair!.isk,
        own,
        peer,
      );
      this.o.onEvent({
        type: "local-link",
        secret,
        ownKey: own.slice(),
        peerKey: peer.slice(),
        ...(r.stored.label !== undefined ? { label: r.stored.label } : {}),
        cats: r.stored.cats,
      });
    }
    if (r.close !== undefined) throw new SessionFail(r.close);
  }

  /** Run one event through the contact exchange and act on what it says. */
  private async exchangeStep(e: ExchangeEvent): Promise<void> {
    const x = this.xchg!;
    const r: ExchangeStep = x.step(e);
    if (r.close !== undefined) throw new SessionFail(r.close);
    // CONFIRM is sent by confirmSas itself; only CONTACT is the exchange's to send.
    if (r.sends.includes("CONTACT"))
      await this.emitRecords(RECORD.CONTACT, buildContact(this.o.exchange!));
    if (r.stored !== undefined) {
      const own = base64UrlDecode(this.o.exchange!.agreeKey);
      const secret = await contactSecret(
        this.hs!.handshakeHash,
        this.nD!,
        this.nM!,
        own,
        base64UrlDecode(r.stored.agreeKey),
      );
      this.o.onEvent({ type: "contact", secret, ...r.stored });
    }
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

/** Message 1s a minute one source group may send a listener that holds no account key (§15.10). */
export const LOCAL_GROUP_PER_MINUTE = 2;

/** What `HandshakeLimiter.beginLocal` answers. */
export type LocalAdmission =
  | { ok: false; by: "group" | "shared" }
  | { ok: true; hit: () => () => void; miss: () => void };

/**
 * The approver's admission: at most `max` handshakes a minute per advert (default 5) and at most
 * `maxPending` sessions waiting on a code (default 4). A monotonic clock. An attempt counts only
 * when `begin()` is called, which a session does when it starts.
 */
export class HandshakeLimiter {
  private stamps: number[] = [];
  private pending = 0;
  /** Per source group, the message 1s of the last minute (`beginLocal`). */
  private groups = new Map<string, number[]>();
  constructor(
    private readonly max = 5,
    private readonly maxPending = 4,
    private readonly now: () => number = () => performance.now() / 1000,
    private readonly groupMax = LOCAL_GROUP_PER_MINUTE,
  ) {}
  /**
   * The admission of a listener that holds no account key (§15.10, "Admission"): the group's
   * budget (`groupMax` a minute, counted as the message 1 arrives) comes first, then the shared
   * limit, which counts only failed trials (and the sessions waiting on message 3). A refusal
   * costs no trial. `hit()` refunds the group's count and takes a waiting slot; `miss()` spends
   * the shared budget.
   */
  beginLocal(group: string): LocalAdmission {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60);
    for (const [g, v] of this.groups) {
      const live = v.filter((s) => t - s < 60);
      if (live.length === 0) this.groups.delete(g);
      else this.groups.set(g, live);
    }
    const mine = this.groups.get(group) ?? [];
    if (mine.length >= this.groupMax) return { ok: false, by: "group" };
    if (this.stamps.length >= this.max || this.pending >= this.maxPending)
      return { ok: false, by: "shared" };
    mine.push(t);
    this.groups.set(group, mine);
    let settled = false;
    return {
      ok: true,
      hit: (): (() => void) => {
        if (settled) return () => undefined;
        settled = true;
        const i = mine.lastIndexOf(t);
        if (i >= 0) mine.splice(i, 1);
        this.pending++;
        let done = false;
        return (): void => {
          if (!done) {
            done = true;
            this.pending--;
          }
        };
      },
      miss: (): void => {
        if (settled) return;
        settled = true;
        this.stamps.push(this.now());
      },
    };
  }
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
