// The approver half of nearby approval (CC-15.N2; WIRE-CONTRACT-V5 §15.4, §15.6.1): a signed-in
// device (M) advertises under a random instance, lets a nearby device (D) with no sign-in connect
// in mode v, shows three codes and, when the person picks the one D shows, hands the verified
// `VOUCH_REQ` to the host. The host calls `nearby/approve` and gives the answer back; this module
// maps it to `VOUCH_RESULT`. It calls no route.
//
// Rules this module keeps:
//  - the advert is `p1-` + 10 random bytes in base32 with `v=1`, `m=v` and the product tag; it has
//    a listener of its own, and the instance and the port are both new at every listen and every
//    300 s (the old listener closes at once; a session past the transport stays);
//  - it stands only while the device is signed in, discovery names `nearby` and `nearbyApprove`,
//    and the host opened the prompt or allowed background approval (`background: true`, required
//    with `prompt: false`); it stops on `pause()`, on `stop()`, when the device signs out, when
//    discovery loses `nearby`, when a renewal fails and when the failure budget is spent (two
//    prompted failures in 10 minutes). `stop()`, a sign-out, a lost discovery and a failed renewal
//    are final: no later call brings the advert back. A budget stop is cleared by `reopen()` or
//    `setPrompt(true)` only; `pause()` works from `advertising` only, and `resume()` only from the
//    host's own pause, after signedIn and discovery are read again;
//  - `stop()` and the sign-out do not wait for a renewal or a queued call: the state, the
//    listener, the advert and the sessions go down at once, and `destroy()` drops the sockets;
//  - accept is the mode-a gate (lanGate.ts): the same verdict on the socket's own addresses, the
//    same pending limits, and here one waiting session per source address;
//  - one prompt at a time, held until the picked session finishes or closes. A session that
//    reaches the code stage meanwhile waits with no code shown and its 120 s deadline running.
//    With the prompt closed a session only raises a notice. A prompt that was shown and whose peer
//    then closes before the person answered counts as a failure;
//  - the host's callbacks (`onNotice`, `onStopped`, `onClose`) are called inside a guard: a throw
//    cannot skip the cleanup that follows;
//  - a wrong pick, "None of these match", the host's close and the deadline end the session before
//    `VOUCH_REQ` is delivered, and no route is called;
//  - `finish()` is refused unless the person picked the right code on this session and
//    `VOUCH_REQ` verified (no silent approval); records for Sync go out only after `approved`;
//  - the request handle, `sig`, `h`, the nonces and the one-time keys are in no message, repr or
//    error; the one-time static key is wiped when the handshake ends.

import type { Server, Socket } from "node:net";
import {
  HandshakeLimiter,
  RECORD,
  VOUCH_REQ_MAX,
  VouchFailureBudget,
  VouchFlow,
  advertEpoch,
  approverInstance,
  buildVouchResult,
  decoyCodes,
  finishMap,
  productTag,
  sasDisplay,
  verifyVouchRequest,
  type AbandonReason,
  type PeerChannel,
  type PeerCloseCode,
  type PeerHello,
  type SessionEvent,
  type VouchRequest,
  type VouchStatus,
} from "@polaris-key/client-core/peer";
import { printAs } from "../core/redact.js";
import { defaultTimer } from "./channel.js";
import { AcceptGate, listenTcp, type GateSlot } from "./lanGate.js";
import {
  MulticastDnsAdapter,
  type MdnsAdapter,
  type MdnsHandle,
} from "./mdns.js";
import {
  LanError,
  SocketLink,
  guarded,
  nearbyHello,
  type SessionClosed,
} from "./session.js";

/** What the approver reads of the client, at start and at each renewal. */
export interface ApproverSource {
  slug: string;
  /** Seconds since the epoch. */
  now(): number;
  /** This device is signed in on the product. */
  signedIn(): Promise<boolean>;
  /** A fresh read of discovery: it names `nearby` and `nearbyApprove` (§12.11.6). */
  nearbyServed(): Promise<boolean>;
}

export interface NearbyApproverOptions {
  /** The "Approve a nearby device" screen is open. Without it a session raises `onNotice` only. */
  prompt: boolean;
  /**
   * The person allowed background approval (and the system permission is granted). Required with
   * `prompt: false`; with it the advert stands while the screen is closed and a session raises
   * `onNotice`. Without it, closing the screen (`setPrompt(false)`) pauses the advert.
   */
  background?: boolean;
  /**
   * This device's label in `HELLO` (display data; optional). It is shown on the other device, so
   * name the device (`"Ana's laptop"`); never use an account identifier (an email address, a user
   * id) as the label.
   */
  label?: string;
  /** Called with a session that wants approval while the prompt is closed: no code, no pick. */
  onNotice?: (n: ApprovalNotice) => void;
  /** Called when the advert stops on its own (everything but the host's own `pause`/`stop`). */
  onStopped?: (why: NearbyStopReason) => void;
  mdns?: MdnsAdapter;
  /** Where to listen. Default `::` (both families on one port), or 0.0.0.0. */
  host?: string;
  /** Accept loopback peers. For tests and same-host use only. */
  allowLoopback?: boolean;
  handshakeMs?: number;
  /** Seconds between advert renewals (default 300). */
  renewSeconds?: number;
  /** Seconds a session stays open after the person's pick (default 300, rule 8). */
  keepOpenSeconds?: number;
  /** Seconds to wait for `VOUCH_REQ` after the right pick (default 30). */
  requestWaitSeconds?: number;
  /** Sessions at once (default 8). */
  maxSessions?: number;
  /** Waiting sessions from one source address (default 1, rule 2). For tests that share one. */
  maxPendingPerAddress?: number;
  /** Schedule `fn` after `ms`; returns the cancel. Default `setTimeout`, unref'd. */
  timer?: (fn: () => void, ms: number) => () => void;
  /** Monotonic seconds (limiter, failure budget). */
  mono?: () => number;
  /** CSPRNG bytes (instance, decoys, one-time keys). */
  random?: (n: number) => Uint8Array;
}

export interface ApprovalNotice {
  label: string | null;
  platform: string;
}

export type NearbyStopReason = "budget" | "signed-out" | "discovery" | "host";

export interface NearbyApproverStatus {
  state: "advertising" | "paused" | "stopped";
  /** Why it stopped, when it did. */
  reason: NearbyStopReason | null;
  prompt: boolean;
}

/** The answer of `nearby/approve` as the host read it (§15.6.1 rule 6). */
export interface ApproveAnswerInput {
  /** The HTTP status, or null when there was no answer. */
  http: number | null;
  /** The body text, or null. */
  body: string | null;
  /** The host's fresh read of discovery: does it still name `nearby` and `nearbyApprove`? */
  discoveryNearby: boolean;
}

export type FinishOutcome =
  /** `VOUCH_RESULT` went out with this status. After `approved` the session stays open for records. */
  | { sent: VouchStatus }
  /** Nothing sent yet: show the choice, or register this device's keys, then call `finish` again. */
  | { wait: "choice" | "keys" }
  /** Nothing sent; the session closed `peer_bye`. */
  | { closed: true };

/** One session asking for approval, as the host's handler sees it. */
export interface NearbyApproval {
  /**
   * What D's `HELLO` showed. Unauthenticated display data: any device on the network can send any
   * label, and the cleaning leaves some invisible blanks, so a label can look empty or like
   * another device's. Show it as "reported by the device" beside the platform and the codes,
   * never as proof of who is asking; the person's pick of the matching code is the only check.
   */
  readonly label: string | null;
  readonly platform: string;
  /** The three codes, in the order to show them, each like `123 456`. */
  readonly codes: readonly string[];
  /**
   * The person picked this code. The right one delivers D's `VOUCH_REQ`, which is verified here:
   * the result is exactly what `nearby/approve` gets. A wrong code closes the session, calls no
   * route and answers `mismatch`; a request that does not verify closes it and answers `invalid`.
   */
  pick(code: string): Promise<VouchRequest | "mismatch" | "invalid">;
  /** "None of these match": the session closes, nothing is delivered and no route is called. */
  decline(): Promise<void>;
  /** Give the answer of `nearby/approve` back; sends `VOUCH_RESULT` (rule 6). */
  finish(answer: ApproveAnswerInput): Promise<FinishOutcome>;
  /** After `approved`: a Sync record (`0x0030` to `0x003F`) to D. */
  sendRecord(type: number, body: Uint8Array): Promise<void>;
  /** The host leaves: the session closes `peer_bye`. Before a pick this counts for nothing. */
  close(): Promise<void>;
  /** Called once when the session ends. */
  onClose(fn: (c: SessionClosed) => void): () => void;
}

export interface NearbyApproverHandle {
  /** Stop for good: the advert, the listener and every session. Nothing brings them back. */
  stop(): Promise<void>;
  /** Stop advertising and close live sessions until `resume()`. Works from `advertising` only. */
  pause(): Promise<void>;
  /**
   * Start again after the host's own `pause()`. It reads sign-in and discovery again first, and
   * does nothing after a stop, a sign-out or a spent budget.
   */
  resume(): Promise<void>;
  /**
   * The "Approve a nearby device" screen opens (true) or closes (false). Opening it also counts
   * the failure budget from zero and starts a stopped (budget) or paused advert again; closing it
   * ends the prompt that is showing and, without `background`, pauses the advert.
   */
  setPrompt(open: boolean): Promise<void>;
  /** Count the failure budget from zero and start a budget-stopped advert again. */
  reopen(): Promise<void>;
  status(): NearbyApproverStatus;
}

const HELD_REQUEST_S = 30;
const KEEP_OPEN_S = 300;
const RENEW_S = 300;
/** The most a renewal waits on the host's sign-in or discovery read. */
const CHECK_MS = 15_000;
/** Waiting sessions from one /24 or /64 (§15.6.1 rule 2). */
const PER_GROUP = 2;
const MAX_SESSIONS = 8;
/** Waiting sessions at once, and handshakes a minute (§15.6.1 rule 2). */
const WAITING = 4;
const PER_MINUTE = 5;

const systemRandom = (n: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A code the person picked: `123 456`, `123456` or the number; null when it is none of those. */
function codeValue(code: unknown): number | null {
  if (typeof code === "number")
    return Number.isInteger(code) && code >= 0 && code < 1_000_000
      ? code
      : null;
  if (typeof code !== "string") return null;
  const digits = code.replace(/\s/g, "");
  return /^\d{6}$/.test(digits) ? Number(digits) : null;
}

interface Generation {
  server: Server;
  gate: AcceptGate;
  limiter: HandshakeLimiter;
  adv: MdnsHandle;
  retired: boolean;
}

/** One inbound session of the approver. */
class Live {
  hello: PeerHello | null = null;
  sas: number | null = null;
  ready = false;
  noticed = false;
  shown = false;
  picked = false;
  keysRetried = false;
  dead = false;
  /** This module ended the session (a pick, a close, the host, a pause): not the peer's doing. */
  local = false;
  pick: Promise<VouchRequest | "mismatch" | "invalid"> | null = null;
  readonly request = deferred<VouchRequest | "invalid">();
  readonly closers = new Set<(c: SessionClosed) => void>();
  readonly cancels: (() => void)[] = [];
  closed: SessionClosed | null = null;
  constructor(
    readonly link: SocketLink,
    readonly slot: GateSlot,
    readonly key: Uint8Array,
    readonly gen: Generation,
    readonly flow: VouchFlow,
  ) {}
  get channel(): PeerChannel {
    return this.link.channel;
  }
}

export class NearbyApprover implements NearbyApproverHandle {
  readonly #src: ApproverSource;
  readonly #handler: (a: NearbyApproval) => void;
  readonly #o: NearbyApproverOptions;
  readonly #mdns: MdnsAdapter;
  readonly #random: (n: number) => Uint8Array;
  readonly #timer: (fn: () => void, ms: number) => () => void;
  readonly #mono: () => number;
  readonly #budget: VouchFailureBudget;
  readonly #live = new Set<Live>();
  #queue: Live[] = [];
  #active: Live | null = null;
  #gen: Generation | null = null;
  #cancelRenew: (() => void) | null = null;
  #prompt: boolean;
  readonly #background: boolean;
  #state: NearbyApproverStatus["state"] = "stopped";
  #reason: NearbyStopReason | null = null;
  #work: Promise<unknown> = Promise.resolve();
  /** A stop that nothing undoes: `stop()`, a sign-out, lost discovery, a failed renewal. */
  #final = false;
  /** Bumped by every halt; an `#advertise` or a check that began before it gives up. */
  #epoch = 0;

  private constructor(
    src: ApproverSource,
    handler: (a: NearbyApproval) => void,
    o: NearbyApproverOptions,
  ) {
    this.#src = src;
    this.#handler = handler;
    this.#o = o;
    this.#prompt = o.prompt;
    this.#background = o.background === true;
    this.#random = o.random ?? systemRandom;
    this.#timer = o.timer ?? defaultTimer;
    this.#mono = o.mono ?? ((): number => performance.now() / 1000);
    this.#budget = new VouchFailureBudget(this.#mono);
    this.#mdns =
      o.mdns ?? new MulticastDnsAdapter({ allowLoopback: o.allowLoopback });
    printAs(this, () => ({ service: "NearbyApprover", state: this.#state }));
  }

  /**
   * Start advertising. The caller has checked that the device is signed in and that discovery
   * names `nearby`; both are read again at every renewal.
   */
  static async start(
    src: ApproverSource,
    handler: (a: NearbyApproval) => void,
    o: NearbyApproverOptions,
  ): Promise<NearbyApprover> {
    if (!o.prompt && o.background !== true)
      throw new LanError(
        "bad_input",
        "Without the prompt, background approval must be allowed (background: true).",
      );
    const a = new NearbyApprover(src, handler, o);
    await a.#advertise();
    return a;
  }

  status(): NearbyApproverStatus {
    return { state: this.#state, reason: this.#reason, prompt: this.#prompt };
  }

  // ── The handle ──────────────────────────────────────────────────────────────────────────────

  /**
   * Final, and not queued: the state, the listener, the advert and the sessions go down at once,
   * so a renewal that hangs on the host's reads cannot hold a sign-out back.
   */
  stop(): Promise<void> {
    this.#final = true;
    return this.#halt("stopped", "host");
  }

  /** Drop everything now, with no goodbye (the sign-out bound's force path). */
  destroy(): void {
    this.#final = true;
    void this.#halt("stopped", "host").catch(() => undefined);
    for (const l of [...this.#live]) l.link.destroy();
  }

  pause(): Promise<void> {
    return this.#serial(async () => {
      if (this.#final || this.#state !== "advertising") return;
      await this.#halt("paused", "host");
    });
  }

  resume(): Promise<void> {
    return this.#serial(async () => {
      if (this.#final || this.#state !== "paused" || this.#reason !== "host")
        return;
      await this.#restart();
    });
  }

  setPrompt(open: boolean): Promise<void> {
    return this.#serial(async () => {
      if (this.#final || open === this.#prompt) return;
      this.#prompt = open;
      if (!open) {
        // The screen closed: the prompt that is showing ends, and the others go passive.
        const live = this.#active;
        this.#active = null;
        if (live !== null && !live.picked) await this.#end(live, "peer_bye");
        for (const l of this.#queue) l.noticed = false;
        // Without background approval nothing stands for a closed screen.
        if (!this.#background && this.#state === "advertising")
          await this.#halt("paused", "host");
        this.#pump();
        return;
      }
      this.#budget.reopen();
      if (
        (this.#state === "stopped" && this.#reason === "budget") ||
        (this.#state === "paused" && this.#reason === "host")
      )
        await this.#restart();
      this.#pump();
    });
  }

  reopen(): Promise<void> {
    return this.#serial(async () => {
      if (this.#final) return;
      this.#budget.reopen();
      if (this.#state === "stopped" && this.#reason === "budget")
        await this.#restart();
    });
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#work.then(fn, fn);
    this.#work = run.catch(() => undefined);
    return run;
  }

  /** A host read that may hang or fail: past `CHECK_MS`, or on a throw, it reads as "no". */
  #check(read: () => Promise<boolean>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const cancel = this.#timer(() => resolve(false), CHECK_MS);
      read().then(
        (v) => {
          cancel();
          resolve(v);
        },
        () => {
          cancel();
          resolve(false);
        },
      );
    });
  }

  /**
   * Start the advert again from a pause or a budget stop, after reading sign-in and discovery
   * again. A stop, or a halt that landed meanwhile, wins.
   */
  async #restart(): Promise<void> {
    if (this.#budget.stopped) {
      if (this.#state === "paused") await this.#halt("stopped", "budget");
      return;
    }
    const epoch = this.#epoch;
    const signed = await this.#check(() => this.#src.signedIn());
    if (this.#final || epoch !== this.#epoch) return;
    if (!signed) return this.#halt("stopped", "signed-out");
    const served = await this.#check(() => this.#src.nearbyServed());
    if (this.#final || epoch !== this.#epoch) return;
    if (!served) return this.#halt("stopped", "discovery");
    await this.#advertise();
  }

  // ── The advert ──────────────────────────────────────────────────────────────────────────────

  /** A new listener, port and instance; the old generation retires. Starts the renewal clock. */
  async #advertise(): Promise<void> {
    const o = this.#o;
    const epoch = this.#epoch;
    const gate = new AcceptGate({
      allowLoopback: o.allowLoopback,
      // One waiting session per source address (rule 2); the limiter below caps the waiting ones.
      maxPending: WAITING * 2,
      maxPendingPerAddress: o.maxPendingPerAddress ?? 1,
      maxPendingPer64: PER_GROUP,
      handshakeMs: o.handshakeMs,
    });
    const limiter = new HandshakeLimiter(PER_MINUTE, WAITING, this.#mono);
    let gen: Generation | null = null;
    const server = await listenTcp(o.host, 0, (s) => {
      if (gen !== null) this.#accept(gen, s);
      else s.destroy();
    });
    let adv: MdnsHandle | null = null;
    try {
      const port = (server.address() as { port: number }).port;
      const instance = approverInstance(this.#random);
      const h = await productTag(this.#src.slug, advertEpoch(this.#src.now()));
      adv = await this.#mdns.advertise({
        instance,
        port,
        txt: ["v=1", "m=v", `h=${h}`],
      });
      gen = { server, gate, limiter, adv, retired: false };
    } catch (e) {
      server.close();
      throw e;
    }
    if (epoch !== this.#epoch) {
      // A stop landed while this was starting: what it made is torn down, not kept.
      gen.retired = true;
      server.close();
      gate.destroyPending();
      await adv.stop().catch(() => undefined);
      return;
    }
    const old = this.#gen;
    this.#gen = gen;
    this.#state = "advertising";
    this.#reason = null;
    if (old !== null) await this.#retire(old);
    this.#cancelRenew?.();
    this.#cancelRenew = this.#timer(
      () => void this.#renew().catch(() => undefined),
      (o.renewSeconds ?? RENEW_S) * 1000,
    );
  }

  async #renew(): Promise<void> {
    await this.#serial(async () => {
      if (this.#state !== "advertising") return;
      const epoch = this.#epoch;
      const signed = await this.#check(() => this.#src.signedIn());
      if (epoch !== this.#epoch) return;
      if (!signed) return this.#halt("stopped", "signed-out");
      const served = await this.#check(() => this.#src.nearbyServed());
      if (epoch !== this.#epoch) return;
      if (!served) return this.#halt("stopped", "discovery");
      try {
        await this.#advertise();
      } catch {
        // The advert cannot be renewed (the network interface went away, the port is gone): it
        // must not stand on, unrenewed and unchecked. It stops, and the host hears why.
        if (epoch === this.#epoch) await this.#halt("stopped", "discovery");
      }
    });
  }

  /** The old listener accepts nothing more; a connection short of the transport is closed. */
  async #retire(g: Generation): Promise<void> {
    g.retired = true;
    g.server.close();
    g.gate.destroyPending({ keepUp: true });
    await g.adv.stop().catch(() => undefined);
  }

  /**
   * Take everything down. The state, the listener and the session closes happen before the first
   * await, so a caller that does not wait still has them done.
   */
  #halt(state: "stopped" | "paused", reason: NearbyStopReason): Promise<void> {
    this.#epoch++;
    if (state === "stopped" && reason !== "budget") this.#final = true;
    this.#cancelRenew?.();
    this.#cancelRenew = null;
    const g = this.#gen;
    this.#gen = null;
    this.#state = state;
    this.#reason = reason;
    const work: Promise<unknown>[] = [];
    if (g !== null) {
      g.retired = true;
      g.server.close();
      // A connection short of the transport is dropped; the sessions past it hear `peer_bye`.
      g.gate.destroyPending({ keepUp: true });
      work.push(g.adv.stop().catch(() => undefined));
    }
    for (const l of [...this.#live]) work.push(this.#end(l, "peer_bye"));
    this.#queue = [];
    this.#active = null;
    return Promise.all(work).then(() => {
      // The host's own stop and pause need no word back.
      if (reason !== "host") guarded(() => this.#o.onStopped?.(reason));
    });
  }

  // ── Sessions ────────────────────────────────────────────────────────────────────────────────

  #accept(gen: Generation, socket: Socket): void {
    const slot = gen.gate.admit(
      socket,
      gen.retired ||
        this.#state !== "advertising" ||
        this.#live.size >= (this.#o.maxSessions ?? MAX_SESSIONS),
    );
    if (slot === null) return;
    const key = this.#random(32);
    const flowRef: { live: Live | null } = { live: null };
    const link: SocketLink = new SocketLink({
      socket,
      handshakeMs: this.#o.handshakeMs,
      channel: {
        mode: "v",
        role: "responder",
        slug: this.#src.slug,
        staticKey: key,
        admission: gen.limiter,
        hello: nearbyHello(this.#src.slug, this.#o.label),
        timer: this.#timer,
      },
      onEvent: (e) => {
        if (flowRef.live !== null) this.#event(flowRef.live, e);
      },
      onClosed: (c) => {
        if (flowRef.live !== null) this.#closed(flowRef.live, c);
      },
    });
    const flow = link.channel.vouch;
    if (flow === null) {
      socket.destroy();
      return;
    }
    const live = new Live(link, slot, key, gen, flow);
    flowRef.live = live;
    this.#live.add(live);
    socket.resume();
  }

  #event(live: Live, e: SessionEvent): void {
    switch (e.type) {
      case "established":
        live.slot.established();
        // The one-time static key has done its work.
        live.key.fill(0);
        live.hello = e.hello;
        break;
      case "sas":
        live.sas = e.code;
        live.ready = true;
        this.#queue.push(live);
        this.#pump();
        break;
      case "record":
        this.#record(live, e.recordType, e.body);
        break;
      default:
        break;
    }
  }

  #record(live: Live, type: number, body: Uint8Array): void {
    const v = live.flow.receive({ type, body });
    if (!v.ok) {
      void this.#end(live, v.close);
      return;
    }
    for (const r of v.deliver) {
      if (r.type === RECORD.VOUCH_REQ) void this.#verify(live, r.body);
      else if (r.type >= 0x8100 && r.type <= 0xfffd)
        void this.#end(live, "peer_unknown_critical");
    }
  }

  async #verify(live: Live, body: Uint8Array): Promise<void> {
    const hello = live.hello;
    let ok: VouchRequest | null = null;
    if (hello !== null && body.length <= VOUCH_REQ_MAX) {
      try {
        ok = await verifyVouchRequest({
          slug: this.#src.slug,
          h: live.channel.handshakeHash(),
          hello: {
            ...(hello.label !== undefined ? { label: hello.label } : {}),
            platform: hello.platform,
          },
          // `HELLO` was cleaned when the session read it; cleaning it again is not idempotent.
          helloCleaned: true,
          body,
        });
      } catch {
        ok = null;
      }
    }
    if (ok === null) {
      live.request.resolve("invalid");
      await this.#end(live, "peer_bad_frame");
      return;
    }
    live.flow.verified();
    live.request.resolve(ok);
  }

  #closed(live: Live, c: SessionClosed): void {
    if (live.dead) return;
    live.dead = true;
    live.closed = c;
    live.key.fill(0);
    live.slot.settle();
    for (const f of live.cancels.splice(0)) f();
    this.#live.delete(live);
    this.#queue = this.#queue.filter((l) => l !== live);
    live.request.resolve("invalid");
    // A prompt that was shown and ended before the person answered, by anything but this module
    // (the 120 s deadline, the peer closing or the connection dropping), counts (rule 2).
    if (live.shown && !live.picked && !live.local) this.#failure();
    for (const f of [...live.closers]) guarded(() => f(c));
    if (this.#active === live) {
      this.#active = null;
      this.#pump();
    }
  }

  /** Close a session with `code`; resolves when it is down. */
  async #end(live: Live, code: PeerCloseCode): Promise<void> {
    if (live.dead) return;
    live.local = true;
    await live.channel.close(code).catch(() => undefined);
  }

  /** Count one prompted failure; the second in the window stops the advert. */
  #failure(): void {
    if (!this.#budget.fail()) return;
    void this.#serial(async () => {
      if (this.#state === "advertising") await this.#halt("stopped", "budget");
    });
  }

  // ── The prompt, one at a time ───────────────────────────────────────────────────────────────

  #pump(): void {
    if (this.#state !== "advertising") return;
    if (!this.#prompt) {
      for (const l of this.#queue)
        if (!l.noticed) {
          l.noticed = true;
          guarded(() =>
            this.#o.onNotice?.({
              label: l.hello?.label ?? null,
              platform: l.hello?.platform ?? "",
            }),
          );
        }
      return;
    }
    if (this.#active !== null) return;
    const next = this.#queue.find((l) => !l.shown && !l.dead);
    if (next === undefined) return;
    this.#active = next;
    next.shown = true;
    next.flow.codeShown();
    const { codes } = decoyCodes(next.sas!, this.#random);
    const approval = this.#approval(next, codes.map(sasDisplay));
    try {
      this.#handler(approval);
    } catch {
      void this.#end(next, "peer_bye");
    }
  }

  #approval(live: Live, codes: string[]): NearbyApproval {
    return {
      label: live.hello?.label ?? null,
      platform: live.hello?.platform ?? "",
      codes,
      pick: (code) => (live.pick ??= this.#pick(live, code)),
      decline: () => this.#decline(live),
      finish: (a) => this.#finish(live, a),
      sendRecord: (type, body) => this.#send(live, type, body),
      close: () => this.#end(live, "peer_bye"),
      onClose: (fn) => {
        live.closers.add(fn);
        if (live.closed !== null) fn(live.closed);
        return () => live.closers.delete(fn);
      },
    };
  }

  /** The prompt is over (a pick, a decline): the next waiting session may show its codes. */
  #release(live: Live): void {
    this.#queue = this.#queue.filter((l) => l !== live);
    if (this.#active === live) this.#active = null;
    this.#pump();
  }

  /** A session ended before the right pick: nothing is delivered and no route is called. */
  async #abandon(live: Live, reason: AbandonReason): Promise<void> {
    const v = live.flow.abandon(reason);
    this.#release(live);
    if (live.dead) return;
    // `abandon` always closes: peer_bye here (timeouts come from the engine).
    await this.#end(live, v.ok ? "peer_bye" : v.close);
  }

  async #pick(
    live: Live,
    code: string,
  ): Promise<VouchRequest | "mismatch" | "invalid"> {
    if (live.dead) throw new LanError("closed", "The session is closed.");
    if (live.sas === null || live.picked)
      throw new LanError("not_picked", "There is no code to pick.");
    if (codeValue(code) !== live.sas) {
      this.#failure();
      await this.#abandon(live, "wrong-pick");
      return "mismatch";
    }
    const v = live.flow.picked();
    if (!v.ok) {
      await this.#end(live, v.close);
      return "invalid";
    }
    live.picked = true;
    live.slot.settle();
    // The prompt slot stays with this session until it finishes or closes: the next waiting
    // session shows no code meanwhile.
    // The session stays for records after `approved`, and no longer than 300 s past the pick.
    live.cancels.push(
      this.#timer(
        () => void this.#end(live, "peer_bye"),
        (this.#o.keepOpenSeconds ?? KEEP_OPEN_S) * 1000,
      ),
    );
    // The person's pick is M's confirmation; the held `VOUCH_REQ` is delivered from here on.
    await live.channel.confirmSas();
    if (live.dead) return "invalid";
    const wait = this.#timer(
      () => void this.#end(live, "peer_timeout"),
      (this.#o.requestWaitSeconds ?? HELD_REQUEST_S) * 1000,
    );
    try {
      return await live.request.promise;
    } finally {
      wait();
    }
  }

  async #decline(live: Live): Promise<void> {
    if (live.dead || live.picked) return;
    this.#failure();
    await this.#abandon(live, "none-match");
  }

  async #finish(live: Live, a: ApproveAnswerInput): Promise<FinishOutcome> {
    if (live.dead) throw new LanError("closed", "The session is closed.");
    // No silent approval: the right pick on this session and a verified request, or nothing.
    if (!live.flow.mayFinish)
      throw new LanError(
        "not_picked",
        "The person has not picked the code on this session.",
      );
    const act = finishMap({
      http: a.http,
      body: a.body,
      discoveryNearby: a.discoveryNearby,
      keysRetried: live.keysRetried,
    });
    if ("send" in act) {
      const rec = {
        type: RECORD.VOUCH_RESULT,
        body: buildVouchResult(act.send),
      };
      const v = live.flow.send(rec);
      if (!v.ok) {
        await this.#end(live, v.close);
        throw new LanError("closed", "The session is closed.");
      }
      await live.channel.sendRecord(rec.type, rec.body).catch(() => {
        throw new LanError("closed", "The session is closed.");
      });
      // Finished: the next waiting session may show its codes.
      this.#release(live);
      if (act.send !== "approved") await this.#end(live, "peer_bye");
      return { sent: act.send };
    }
    if ("wait" in act) {
      if (act.wait === "keys") live.keysRetried = true;
      return act;
    }
    this.#release(live);
    await this.#end(live, "peer_bye");
    if (act.stopAdvert)
      void this.#serial(() => this.#halt("stopped", "discovery"));
    return { closed: true };
  }

  async #send(live: Live, type: number, body: Uint8Array): Promise<void> {
    if (live.dead) throw new LanError("closed", "The session is closed.");
    if (!Number.isInteger(type) || type < 0x0030 || type > 0x003f)
      throw new LanError("bad_type", "Sync records are 0x0030 to 0x003F.");
    const v = live.flow.send({ type, body });
    if (!v.ok) {
      await this.#end(live, v.close);
      throw new LanError("not_picked", "A record needs an approved vouch.");
    }
    await live.channel.sendRecord(type, body).catch((e: unknown) => {
      throw e instanceof Error && e.message === "message too large"
        ? new LanError("too_large", "The message is larger than D accepts.")
        : new LanError("closed", "The session is closed.");
    });
  }
}
