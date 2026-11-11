// The joiner of a pairing, `client.cloudConnect.localLinks.join` (CC-29.7; WIRE-CONTRACT-V5 §15.12,
// "The joiner"): it reads the typed code or the scanned QR, browses for the matching `m=q` advert
// and dials it, at most 2 dials a join and, for a typed code, at most 2 per nameplate in 300 s
// across joins (the host's `DialBudget`, spent when the dial is made). It never retries a failed
// code by itself, and a QR is never limited. The choices over one browse are client-core's
// `JoinPlan`, which also says why a `pairing-code-failed` was one.
//
// Cancelling (`LocalJoinOptions.signal`, the gate going off) closes the dial, stops the browse and
// wipes the QR secret, the generator, the scalar, the ISK and the PSK of the dial in flight. It
// refunds no dial: the budget was spent when the dial was made.

import type { Socket } from "node:net";
import {
  DialBudget,
  FrameReader,
  JoinPlan,
  LOCAL_ATTEMPT_SECONDS,
  LOCAL_JOIN_BROWSE_SECONDS,
  LOCAL_JOIN_CANDIDATES,
  advertEpoch,
  cpaceGenerator,
  cpaceIsk,
  cpacePrsCode,
  cpacePrsQr,
  cpacePsk,
  cpaceScalar,
  cpaceShare,
  encodeC1,
  encodeFrame,
  parseC2,
  parseCode,
  parseQr,
  parseTxt,
  peerPrologue,
  productTag,
  type LocalPairFailureReason,
  type PairingCodeFailedReason,
  type SessionEvent,
} from "@polaris-key/client-core/peer";
import { ErrorCode } from "../constants.generated.js";
import { dialRaceTo } from "./dial.js";
import { textVerdict } from "./lanGate.js";
import {
  Attempt,
  LocalPairingError,
  cancelled,
  envOf,
  full,
  offerOf,
  sidOf,
  storeLink,
  type Env,
  type LocalJoinOptions,
  type LocalPaired,
  type LocalSource,
} from "./localCommon.js";
import type { MdnsFound, MdnsHandle } from "./mdns.js";
import {
  SocketLink,
  guarded,
  pairingHello,
  type SessionClosed,
} from "./session.js";

interface Candidate {
  hosts: string[];
  port: number;
}

export class Joiner {
  readonly #plan: JoinPlan;
  readonly #cands = new Map<string, Candidate>();
  readonly #env: Env;
  readonly #ci: Uint8Array;
  readonly #cats: string[];
  readonly #password: string | null;
  readonly #nameplate: string | null;
  #qr: { instance: string; secret: Uint8Array } | null = null;
  #qrGen: Uint8Array | null = null;
  #browse: MdnsHandle | null = null;
  #cancelTimer: (() => void) | null = null;
  #busy = false;
  #dials = 0;
  #browseOver = false;
  #done = false;
  #current: Attempt | null = null;
  #socket: Socket | null = null;
  #settle!: {
    resolve: (l: LocalPaired) => void;
    reject: (e: Error) => void;
  };
  /** Key material of the dial in flight (the scalar, the generator, the ISK, the PSK): wiped when the join ends. */
  readonly #secrets: Uint8Array[] = [];

  constructor(
    private readonly src: LocalSource,
    private readonly budget: DialBudget,
    private readonly o: LocalJoinOptions,
  ) {
    this.#env = envOf(o);
    this.#ci = peerPrologue(src.slug, "q");
    this.#cats = [...o.categories];
    let input:
      | { kind: "code"; nameplate: string }
      | { kind: "qr"; instance: string }
      | { kind: "other-app" }
      | { kind: "invalid" } = { kind: "invalid" };
    let password: string | null = null;
    let nameplate: string | null = null;
    if (o.code !== undefined) {
      const c = parseCode(o.code);
      if (c.ok) {
        input = { kind: "code", nameplate: c.nameplate };
        password = c.password;
        nameplate = c.nameplate;
      }
    } else {
      const q = parseQr(o.qr!, src.slug);
      if (q.result === "ok") {
        input = { kind: "qr", instance: q.instance };
        this.#qr = { instance: q.instance, secret: q.secret };
      } else if (q.result === "other-app") {
        input = { kind: "other-app" };
      }
    }
    this.#password = password;
    this.#nameplate = nameplate;
    this.#plan = new JoinPlan(input);
  }

  /** Stop the join: `cancelled` is the host's `signal`, `closed` the gate going off. */
  cancel(why: "cancelled" | "closed" = "closed"): void {
    this.#finish(
      why === "cancelled"
        ? cancelled()
        : new LocalPairingError(
            ErrorCode.peerClosed,
            "The pairing was closed.",
            { reason: "closed" },
          ),
    );
  }

  async run(): Promise<LocalPaired> {
    const done = new Promise<LocalPaired>((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    done.catch(() => undefined);
    if (!this.#plan.browses) {
      this.#finish(this.#failed("pairing-code-failed"));
      return done;
    }
    // A code whose dials are spent answers at once and browses nothing; a QR is never limited.
    if (
      this.#nameplate !== null &&
      !this.budget.check(this.#nameplate, this.#env.mono()).allowed
    ) {
      this.#plan.startSpent();
      this.#finish(this.#failed("pairing-code-failed"));
      return done;
    }
    try {
      // A QR's generator is made before anything is dialled.
      if (this.#qr !== null) {
        const sid = sidOf(this.#qr.instance)!;
        this.#qrGen = await cpaceGenerator(
          cpacePrsQr(this.#qr.secret),
          this.#ci,
          sid,
        );
      }
      const epoch = advertEpoch(this.src.now());
      const tags = await Promise.all(
        [epoch, epoch - 1].map((e) => productTag(this.src.slug, e)),
      );
      this.#browse = await this.#env.mdns.browse(
        (f) => this.#found(f, tags),
        (instance) => void this.#cands.delete(instance),
      );
    } catch (e) {
      this.#finish(e instanceof Error ? e : new Error("pairing failed"));
      return done;
    }
    if (this.#done) return done;
    this.#cancelTimer = this.#env.timer(
      () => {
        this.#browseOver = true;
        void this.#browse?.stop().catch(() => undefined);
        this.#browse = null;
        this.#maybeEnd();
      },
      Math.min(
        this.o.browseSeconds ?? LOCAL_JOIN_BROWSE_SECONDS,
        LOCAL_JOIN_BROWSE_SECONDS,
      ) * 1000,
    );
    return done;
  }

  /** The error of a code that did not work, with the plan's reason; or of no device found. */
  #failed(
    code: "pairing-code-failed" | "pairing-not-found",
  ): LocalPairingError {
    if (code === "pairing-not-found")
      return new LocalPairingError(
        ErrorCode.pairingNotFound,
        "The other device was not found on this network.",
      );
    const reason: PairingCodeFailedReason = this.#plan.reason() ?? "wrong";
    return new LocalPairingError(
      ErrorCode.pairingCodeFailed,
      reason === "other-app"
        ? "This code is for another app."
        : reason === "spent"
          ? "That code did not work. Wait a few minutes, or ask the other device for a new code."
          : "That code did not work.",
      { reason },
    );
  }

  /** Browse over and nothing is dialling: the answer is the plan's. */
  #maybeEnd(): void {
    if (this.#done || this.#busy || !this.#browseOver) return;
    const r = this.#plan.result();
    this.#finish(
      this.#failed(r === "pairing-not-found" ? r : "pairing-code-failed"),
    );
  }

  /** Why a session that reached the transport ended without a link (`peer-closed`'s reason). */
  #closeReason(a: Attempt, c: SessionClosed): LocalPairFailureReason {
    // This person said no, or the other device did (a `peer_bye` before any link was exchanged).
    if (a.declined || (c.byPeer && c.code === "peer_bye")) return "declined";
    return c.code === "peer_timeout" ? "timeout" : "closed";
  }

  #found(f: MdnsFound, tags: readonly string[]): void {
    if (this.#done || this.#browseOver) return;
    const txt = parseTxt(f.txt);
    if (!txt.ok || txt.mode !== "q") return;
    const hosts = f.hosts.filter((h) =>
      textVerdict(h, this.o.allowLoopback === true),
    );
    if (hosts.length === 0) return;
    if (this.#plan.see(f.instance, tags.includes(txt.h), txt.n))
      this.#cands.set(f.instance, { hosts, port: f.port });
    this.#pump();
  }

  #pump(): void {
    if (this.#done || this.#busy) return;
    const name = this.#plan.next();
    if (name === null) return this.#maybeEnd();
    const c = this.#cands.get(name);
    if (c === undefined) return;
    if (!this.src.allowed()) return this.cancel();
    this.#busy = true;
    void this.#dial(name, c)
      .catch(() => undefined)
      .finally(() => {
        this.#busy = false;
        // No dial is left: the answer is the plan's, without waiting out the browse.
        // A QR names one instance, so one dial is all there can be.
        if (this.#dials >= LOCAL_JOIN_CANDIDATES || this.#qr !== null)
          this.#browseOver = true;
        if (!this.#done) this.#pump();
        this.#maybeEnd();
      });
  }

  /** One dial. It ends the plan's turn as `before-c2`, `after-c2` or `transport`. */
  async #dial(instance: string, c: Candidate): Promise<void> {
    this.#dials++;
    const t = this.#env.mono();
    if (this.#nameplate !== null) {
      // Spent when the dial is made, so joins that overlap cannot multiply the dials.
      if (!this.budget.check(this.#nameplate, t).allowed) {
        this.#plan.ended("budget");
        this.#browseOver = true;
        return;
      }
      this.budget.spend(this.#nameplate, t, 1);
    }
    const sid = sidOf(instance);
    if (sid === null) return this.#plan.ended("before-c2");
    // A typed code's map runs now, once per dial and at most twice per code in 300 s.
    const gen =
      this.#qrGen !== null
        ? this.#qrGen
        : await cpaceGenerator(cpacePrsCode(this.#password!), this.#ci, sid);
    const y = cpaceScalar(this.#env.random);
    this.#secrets.push(y);
    if (this.#qrGen === null) this.#secrets.push(gen);
    const ya = await cpaceShare(y, gen);
    if (ya === null) return this.#plan.ended("before-c2");
    if (this.#done) return;
    let socket: Socket;
    try {
      ({ socket } = await dialRaceTo(c.hosts, c.port, {
        allowLoopback: this.o.allowLoopback === true,
      }));
    } catch {
      return this.#plan.ended("before-c2");
    }
    if (this.#done) {
      socket.destroy();
      return;
    }
    this.#socket = socket;
    const at = this.#env.mono();
    const reply = await this.#c2(
      socket,
      encodeC1(this.#qr !== null ? "qr" : "code", ya),
    );
    if (reply === null) {
      socket.destroy();
      return this.#plan.ended("before-c2");
    }
    const isk = await cpaceIsk({
      sid,
      scalar: y,
      ya,
      yb: reply,
      role: "initiator",
    });
    if (isk === null || this.#done) {
      socket.destroy();
      return this.#plan.ended("before-c2");
    }
    const psk = await cpacePsk(isk, this.src.slug);
    this.#secrets.push(isk, psk);
    const held = await this.src.store.count();
    if (this.#done) {
      socket.destroy();
      return;
    }
    await this.#session(socket, psk, isk, held, this.#env.mono() - at);
  }

  /** Send C1 and read C2 within the attempt's 30 s; null for anything but a valid C2. */
  #c2(socket: Socket, c1: Uint8Array): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const reader = new FrameReader();
      let over = false;
      const end = (v: Uint8Array | null): void => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("close", onClose);
        socket.pause();
        resolve(v);
      };
      const onData = (chunk: Buffer): void => {
        const frames = reader.push(chunk);
        if (frames === null || frames.length > 1) return end(null);
        if (frames.length === 0) return;
        const v = parseC2(frames[0]!);
        end(v.ok ? v.share : null);
      };
      const onClose = (): void => end(null);
      const timer = setTimeout(() => end(null), LOCAL_ATTEMPT_SECONDS * 1000);
      timer.unref();
      socket.on("error", () => undefined);
      socket.on("data", onData);
      socket.once("close", onClose);
      socket.write(encodeFrame(c1));
      socket.resume();
    });
  }

  #session(
    socket: Socket,
    psk: Uint8Array,
    isk: Uint8Array,
    held: number,
    elapsed: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      const a = new Attempt();
      this.#current = a;
      const key = this.#env.random(32);
      a.linkKey = key;
      let up = false;
      const link = new SocketLink({
        socket,
        handshakeMs: Math.max(1, (LOCAL_ATTEMPT_SECONDS - elapsed) * 1000),
        channel: {
          mode: "q",
          role: "initiator",
          slug: this.src.slug,
          staticKey: key,
          caps: [],
          pair: {
            psk,
            isk,
            held,
            cats: this.#cats,
            ...(this.o.label !== undefined ? { label: this.o.label } : {}),
            elapsed,
          },
          hello: pairingHello(this.src.slug, this.o.label),
          timer: this.#env.timer,
        },
        onEvent: (e) => {
          if (e.type === "established") {
            up = true;
            // The first session that reaches the transport ends the dial.
            this.#plan.ended("transport");
            a.hello = e.hello;
            a.shown = true;
            const offer = offerOf(a, this.#cats, e.hello);
            guarded(() => this.o.onConfirm(offer));
          } else if (e.type === "local-link") {
            a.storing = this.#store(a, e);
          }
        },
        onClosed: (c) => {
          void (async () => {
            a.closed = c;
            await a.storing?.catch(() => undefined);
            a.linkKey.fill(0);
            for (const f of [...a.closers]) guarded(() => f(c));
            if (!up) this.#plan.ended("after-c2");
            if (!a.linked && !this.#done) {
              if (up) {
                const reason = this.#closeReason(a, c);
                this.#finish(
                  a.failure === "full"
                    ? full()
                    : new LocalPairingError(
                        ErrorCode.peerClosed,
                        reason === "declined"
                          ? "The pairing was declined."
                          : "The pairing ended before it finished.",
                        { reason },
                      ),
                );
              }
            }
            resolve();
          })();
        },
      });
      a.link = link;
      socket.resume();
      void link.channel.start().catch(() => undefined);
    });
  }

  async #store(
    a: Attempt,
    e: Extract<SessionEvent, { type: "local-link" }>,
  ): Promise<void> {
    try {
      const paired = await storeLink(this.src, a, e);
      if (paired !== null) this.#finish(undefined, paired);
    } catch (err) {
      a.failure = "closed";
      this.#finish(
        err instanceof Error ? err : new Error("The link was not stored."),
      );
    }
  }

  #finish(err?: Error, ok?: LocalPaired): void {
    if (this.#done) return;
    this.#done = true;
    this.#cancelTimer?.();
    void this.#browse?.stop().catch(() => undefined);
    this.#browse = null;
    this.#qr?.secret.fill(0);
    this.#qrGen?.fill(0);
    for (const k of this.#secrets.splice(0)) k.fill(0);
    if (ok !== undefined) this.#settle.resolve(ok);
    else {
      this.#settle.reject(err ?? new Error("pairing failed"));
      // A connection still in flight is closed; a stored link has closed itself.
      const a = this.#current;
      if (a?.link !== null && a?.link !== undefined && !a.linked)
        void a.link.channel.close("peer_bye").catch(() => undefined);
      this.#socket?.destroy();
    }
  }
}
