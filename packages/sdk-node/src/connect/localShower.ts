// The shower of a pairing window, `client.cloudConnect.localLinks.pair` (CC-29.7; WIRE-CONTRACT-V5
// §15.12, "The pairing window"): it shows the code and the QR, advertises `m=q` on a listener of
// its own and answers one CPace attempt at a time. The window's accounting is client-core's
// `PairingWindow`; this file wires it:
//  - the session is given `window.beginGuess` as its required permit, so a guess is counted before
//    its tag is tried, and the session's `guess` event is the verdict (`guessOpened` /
//    `guessFailed`);
//  - `rotated` is told only after the new password, the new QR secret and both generators exist;
//  - the password, the QR secret, the generators, the scalars and the ISK are wiped when the
//    attempt or the window ends. (A password is a short string and is dropped, not overwritten.)
//  - the nameplate of a window that closes goes into the product's `NameplateMemory`, and the next
//    window's draw skips it for 300 s (a renewed window is new in every respect);
//  - `onEnd` is told once per window, after the advert is withdrawn; a window a `renew()` replaces
//    ends silently (`close(null)`).

import type { Server, Socket } from "node:net";
import {
  FrameReader,
  LOCAL_ATTEMPT_SECONDS,
  LOCAL_PAIR_SECONDS,
  PairingWindow,
  advertEpoch,
  cpaceGenerator,
  cpaceIsk,
  cpacePrsCode,
  cpacePrsQr,
  cpacePsk,
  cpaceScalar,
  cpaceShare,
  displayCode,
  drawNameplate,
  drawPassword,
  encodeC2,
  encodeFrame,
  makeQr,
  pairingInstance,
  parseC1,
  parseTxt,
  peerPrologue,
  productTag,
  type DrawSource,
  type LocalCodeReason,
  type LocalWindowEnd,
  type NameplateMemory,
  type SessionEvent,
  type WindowOutcome,
} from "@polaris-key/client-core/peer";
import { printAs } from "../core/redact.js";
import { AcceptGate, listenTcp } from "./lanGate.js";
import {
  Attempt,
  envOf,
  offerOf,
  storeLink,
  type Env,
  type LocalCode,
  type LocalPairOptions,
  type LocalSource,
} from "./localCommon.js";
import type { MdnsFound, MdnsHandle } from "./mdns.js";
import {
  LanError,
  SocketLink,
  guarded,
  pairingHello,
  type SessionClosed,
} from "./session.js";

const WAITING = 4;

interface Gens {
  code: Uint8Array;
  qr: Uint8Array;
}

export class Shower {
  readonly #src: LocalSource;
  readonly #o: LocalPairOptions;
  readonly #cats: string[];
  readonly #env: Env;
  readonly #draw: DrawSource;
  readonly #window = new PairingWindow();
  readonly #attempts = new Set<Attempt>();
  readonly #inUse = new Map<string, string>();
  readonly #sid: Uint8Array;
  readonly #instance: string;
  readonly #ci: Uint8Array;
  readonly #memory: NameplateMemory;
  #expiresAt = 0;
  /** Connections closed without counting a guess since the code last changed (`onInterrupted`). */
  #interrupted = 0;
  #nameplate = "";
  #password: string | null = null;
  #qrSecret: Uint8Array | null = null;
  #gens: Gens | null = null;
  #shown: LocalCode | null = null;
  #server: Server | null = null;
  #gate: AcceptGate | null = null;
  #adv: MdnsHandle | null = null;
  #browse: MdnsHandle | null = null;
  #cancel: (() => void) | null = null;
  #stopped = false;
  #onEnd: (() => void) | null = null;

  private constructor(
    src: LocalSource,
    o: LocalPairOptions,
    memory: NameplateMemory,
  ) {
    this.#src = src;
    this.#o = o;
    this.#memory = memory;
    this.#cats = [...o.categories];
    this.#env = envOf(o);
    this.#draw = (n) => this.#env.random(n);
    this.#sid = this.#env.random(10);
    this.#instance = pairingInstance(this.#sid);
    this.#ci = peerPrologue(src.slug, "q");
    printAs(this, () => ({ service: "LocalPairing", open: !this.#stopped }));
  }

  static async start(
    src: LocalSource,
    o: LocalPairOptions,
    memory: NameplateMemory,
    onEnd: () => void,
  ): Promise<Shower> {
    const s = new Shower(src, o, memory);
    s.#onEnd = onEnd;
    try {
      await s.#open();
    } catch (e) {
      await s.close(null).catch(() => undefined);
      throw e;
    }
    return s;
  }

  get open(): boolean {
    return !this.#stopped;
  }

  code(): LocalCode | null {
    return this.#stopped ? null : this.#shown;
  }

  async #open(): Promise<void> {
    const o = this.#o;
    const t = this.#env.mono();
    this.#window.open(t);
    // The nameplates other windows of this product are using on the link: best effort, from what
    // the browse has seen so far.
    const tags = await this.#tags();
    this.#browse = await this.#env.mdns.browse(
      (f) => this.#seen(f, tags),
      (instance) => void this.#inUse.delete(instance),
    );
    // Skipped too: the nameplates this device's windows of the product closed with in the last 300 s.
    const np = drawNameplate(this.#draw, [
      ...this.#inUse.values(),
      ...this.#memory.recent(this.#env.mono()),
    ]);
    if (np === null) throw new LanError("bad_input", "No random source.");
    this.#nameplate = np;
    await this.#renew();
    this.#gate = new AcceptGate({
      allowLoopback: o.allowLoopback,
      maxPending: WAITING * 2,
      maxPendingPerAddress: 1,
      maxPendingPer64: 2,
      handshakeMs: o.handshakeMs,
    });
    this.#server = await listenTcp(o.host, 0, (s) => this.#accept(s));
    const port = (this.#server.address() as { port: number }).port;
    const h = (await this.#tags())[0]!;
    this.#adv = await this.#env.mdns.advertise({
      instance: this.#instance,
      port,
      txt: ["v=1", "m=q", `h=${h}`, `n=${this.#nameplate}`],
    });
    const seconds = Math.min(
      o.seconds ?? LOCAL_PAIR_SECONDS,
      LOCAL_PAIR_SECONDS,
    );
    this.#cancel = this.#env.timer(() => void this.#expire(), seconds * 1000);
    this.#expiresAt = Math.floor(this.#src.now() + seconds);
    this.#show("opened");
  }

  async #tags(): Promise<string[]> {
    const epoch = advertEpoch(this.#src.now());
    return Promise.all(
      [epoch, epoch - 1].map((e) => productTag(this.#src.slug, e)),
    );
  }

  #seen(f: MdnsFound, tags: readonly string[]): void {
    if (this.#stopped || f.instance === this.#instance) return;
    const txt = parseTxt(f.txt);
    if (!txt.ok || txt.mode !== "q" || !tags.includes(txt.h)) return;
    if (this.#inUse.size < 64) this.#inUse.set(f.instance, txt.n);
  }

  /** A new password and QR secret, and both generators made from them. */
  async #renew(): Promise<void> {
    const password = drawPassword(this.#draw);
    const secret = this.#env.random(16);
    if (password === null) throw new LanError("bad_input", "No random source.");
    const gens: Gens = {
      code: await cpaceGenerator(cpacePrsCode(password), this.#ci, this.#sid),
      qr: await cpaceGenerator(cpacePrsQr(secret), this.#ci, this.#sid),
    };
    // Stopped while the generators were made: nothing new is kept.
    if (this.#stopped) {
      secret.fill(0);
      gens.code.fill(0);
      gens.qr.fill(0);
      return;
    }
    this.#qrSecret?.fill(0);
    this.#gens?.code.fill(0);
    this.#gens?.qr.fill(0);
    this.#password = password;
    this.#qrSecret = secret;
    this.#gens = gens;
  }

  #show(reason: LocalCodeReason): void {
    if (this.#stopped || this.#password === null || this.#qrSecret === null)
      return;
    const c: LocalCode = {
      code: displayCode(this.#nameplate, this.#password),
      qr: makeQr(this.#src.slug, this.#instance, this.#qrSecret),
      nameplate: this.#nameplate,
      reason,
      expiresAt: this.#expiresAt,
      failures: this.#window.state.failures,
    };
    this.#shown = c;
    this.#interrupted = 0;
    guarded(() => this.#o.onCode(c));
  }

  /**
   * Make the next code, then tell the window. `rotated` comes only after the new password, the new
   * QR secret and both generators exist; until then a C1 meets a busy window.
   */
  async #rotate(why: LocalCodeReason): Promise<void> {
    try {
      await this.#renew();
    } catch {
      await this.close("person").catch(() => undefined);
      return;
    }
    if (this.#stopped) return;
    this.#show(why);
    this.#window.rotated(this.#env.mono());
  }

  /** `why` is the reason the next code carries when the outcome rotates it. */
  #apply(out: WindowOutcome, why: LocalCodeReason): void {
    if (out.rotate) void this.#rotate(why);
    if (out.result === "too-many-tries") {
      guarded(() => this.#o.onFailed?.({ reason: "too-many-tries" }));
      void this.#shutdown(false, "too-many-tries");
    }
  }

  /** A connection closed without counting a guess. */
  #interrupt(): void {
    if (this.#stopped) return;
    this.#interrupted++;
    guarded(() => this.#o.onInterrupted?.(this.#interrupted));
  }

  async #expire(): Promise<void> {
    // The window's 300 s: the advert and the listener go, a session past the transport runs on.
    await this.#shutdown(true, "expired");
  }

  async stop(): Promise<void> {
    await this.#shutdown(false, "person");
  }

  /**
   * Close the window, telling `onEnd` why (`null`: tell no one, for a window a renewal replaces).
   * The nameplate, the secrets and the advert go either way.
   */
  async close(end: LocalWindowEnd | null): Promise<void> {
    await this.#shutdown(false, end);
  }

  /** Close the window: the advert, the listener and the connections (`keepSessions` spares those past the transport). */
  async #shutdown(
    keepSessions: boolean,
    end: LocalWindowEnd | null,
  ): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = null;
    const t = this.#env.mono();
    this.#window.close(t);
    // The next window of this product does not draw this nameplate for 300 s.
    if (this.#nameplate !== "") this.#memory.shown(this.#nameplate, t);
    this.#server?.close();
    this.#gate?.destroyPending({ keepUp: keepSessions });
    const gone: Promise<unknown>[] = [
      this.#adv?.stop().catch(() => undefined) ?? Promise.resolve(),
      this.#browse?.stop().catch(() => undefined) ?? Promise.resolve(),
    ];
    const work: Promise<unknown>[] = [];
    this.#adv = null;
    this.#browse = null;
    for (const a of [...this.#attempts])
      if (!keepSessions || a.phase !== "session")
        work.push(this.#end(a, "peer_bye"));
    // The code, the QR secret and the generators are of no use to anyone now.
    this.#qrSecret?.fill(0);
    this.#gens?.code.fill(0);
    this.#gens?.qr.fill(0);
    this.#qrSecret = null;
    this.#gens = null;
    this.#password = null;
    this.#shown = null;
    this.#inUse.clear();
    this.#onEnd?.();
    // The host hears the end once the advert is withdrawn and the listener has stopped.
    await Promise.all(gone);
    if (end !== null) guarded(() => this.#o.onEnd?.({ reason: end }));
    await Promise.all(work);
  }

  // ── Connections ──────────────────────────────────────────────────────────────────────────────

  #accept(socket: Socket): void {
    const gate = this.#gate;
    const slot =
      gate === null
        ? null
        : gate.admit(socket, this.#stopped || !this.#src.allowed());
    if (slot === null) {
      socket.destroy();
      this.#interrupt();
      return;
    }
    const at = this.#env.mono();
    const a = new Attempt();
    a.socket = socket;
    this.#attempts.add(a);
    const reader = new FrameReader();
    socket.on("error", () => undefined);
    socket.once("close", () => {
      slot.settle();
      // Closed before a session took the socket: a permitted guess has none, so nothing is counted
      // unless the attempt's own C1 was admitted (then the window frees it).
      if (a.link === null) this.#over(a, true);
    });
    const onData = (chunk: Buffer): void => {
      const frames = reader.push(chunk);
      // A zero-length frame, or a peer that sent past its C1 before it had C2: closed silently.
      if (frames === null || frames.length > 1) return void socket.destroy();
      if (frames.length === 0) return;
      socket.off("data", onData);
      socket.pause();
      void this.#c1(a, socket, slot, frames[0]!, at).catch(() =>
        socket.destroy(),
      );
    };
    socket.on("data", onData);
    socket.resume();
  }

  async #c1(
    a: Attempt,
    socket: Socket,
    slot: { established(): void; settle(): void },
    frame: Uint8Array,
    at: number,
  ): Promise<void> {
    const v = parseC1(frame);
    const out = this.#window.c1(this.#env.mono(), v.ok);
    // Closed, busy, limited and refused: closed silently; none of them counts a failure.
    if (out.result !== "attempt" || !v.ok || v.kind === undefined) {
      socket.destroy();
      this.#interrupt();
      return;
    }
    a.id = out.id!;
    const gens = this.#gens;
    if (gens === null) return void socket.destroy();
    const g = v.kind === "code" ? gens.code : gens.qr;
    const y = cpaceScalar(this.#env.random);
    const yb = await cpaceShare(y, g);
    if (yb === null || socket.destroyed) return void socket.destroy();
    socket.write(encodeFrame(encodeC2(yb)));
    const isk = await cpaceIsk({
      sid: this.#sid,
      scalar: y,
      ya: v.share,
      yb,
      role: "responder",
    });
    if (isk === null || socket.destroyed) return void socket.destroy();
    const psk = await cpacePsk(isk, this.#src.slug);
    const held = await this.#src.store.count();
    if (socket.destroyed || this.#stopped) {
      isk.fill(0);
      psk.fill(0);
      return void socket.destroy();
    }
    const key = this.#env.random(32);
    a.linkKey = key;
    const id = a.id;
    const elapsed = this.#env.mono() - at;
    a.link = new SocketLink({
      socket,
      handshakeMs: Math.max(1, (LOCAL_ATTEMPT_SECONDS - elapsed) * 1000),
      channel: {
        mode: "q",
        role: "responder",
        slug: this.#src.slug,
        staticKey: key,
        caps: [],
        pair: {
          psk,
          isk,
          held,
          cats: this.#cats,
          ...(this.#o.label !== undefined ? { label: this.#o.label } : {}),
          elapsed,
          // The required permit: it counts the guess before the tag is tried.
          permit: () => {
            const ok = this.#window.beginGuess(id, this.#env.mono());
            if (ok) a.permitted = true;
            return ok;
          },
        },
        hello: pairingHello(this.#src.slug, this.#o.label),
        timer: this.#env.timer,
      },
      onEvent: (e) => this.#event(a, e, slot),
      onClosed: (c) => void this.#closed(a, c),
    });
    socket.resume();
  }

  #event(a: Attempt, e: SessionEvent, slot: { established(): void }): void {
    switch (e.type) {
      case "guess": {
        const t = this.#env.mono();
        // The verdict of the permitted guess: opened (the count is refunded and the attempt is the
        // session) or failed (the code rotates).
        const out =
          a.id === null
            ? null
            : e.opens
              ? this.#window.guessOpened(a.id, t)
              : this.#window.guessFailed(a.id, t);
        a.phase = e.opens ? "session" : "done";
        if (out !== null) this.#apply(out, "wrong-code");
        break;
      }
      case "established":
        slot.established();
        a.hello = e.hello;
        this.#offer(a);
        break;
      case "local-link":
        a.storing = this.#store(a, e);
        break;
      default:
        break;
    }
  }

  #offer(a: Attempt): void {
    if (a.shown || this.#stopped || a.hello === null) return;
    a.shown = true;
    this.#interrupted = 0;
    const offer = offerOf(a, this.#cats, a.hello);
    guarded(() => this.#o.onConfirm(offer));
  }

  async #store(
    a: Attempt,
    e: Extract<SessionEvent, { type: "local-link" }>,
  ): Promise<void> {
    try {
      const paired = await storeLink(this.#src, a, e);
      if (paired !== null) guarded(() => this.#o.onLinked?.(paired));
    } catch {
      a.failure = "closed";
    }
  }

  async #closed(a: Attempt, c: SessionClosed): Promise<void> {
    if (a.closed !== null) return;
    a.closed = c;
    // The store runs beside the close: judge the window on its result.
    await a.storing?.catch(() => undefined);
    const t = this.#env.mono();
    let out: WindowOutcome = { rotate: false };
    // What the next code says when this end rotates it (`LocalCode.reason`).
    let why: LocalCodeReason = "wrong-code";
    const reason =
      a.failure ?? (c.code === "peer_timeout" ? "timeout" : "closed");
    if (a.phase === "session") {
      out = this.#window.sessionEnd(t, a.linked);
      why = reason === "declined" || reason === "timeout" ? reason : "closed";
    } else if (a.id !== null && a.phase !== "done") {
      // A permitted guess that has no verdict is a failed guess; one that never reached its guess counts nothing.
      out = this.#window.abandon(a.id, t);
      if (!a.permitted) this.#interrupt();
    }
    this.#over(a, false);
    for (const f of [...a.closers]) guarded(() => f(c));
    if (a.shown && !a.linked && !this.#stopped)
      guarded(() => this.#o.onFailed?.({ reason, close: c }));
    if (a.linked) await this.#shutdown(false, "stored");
    else this.#apply(out, why);
  }

  /** The attempt is over: its key and its place go; `pre` is a socket that closed before its session began. */
  #over(a: Attempt, pre: boolean): void {
    this.#attempts.delete(a);
    a.linkKey.fill(0);
    if (pre && a.id !== null && a.phase === "c1") {
      this.#apply(this.#window.abandon(a.id, this.#env.mono()), "wrong-code");
      this.#interrupt();
    }
  }

  async #end(a: Attempt, code: "peer_bye"): Promise<void> {
    a.local = true;
    if (a.link !== null)
      await a.link.channel.close(code).catch(() => undefined);
    else a.socket?.destroy();
  }
}
