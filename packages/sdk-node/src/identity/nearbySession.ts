// `identity.signIn.start({channel: "nearby"})` (I-47.6; WIRE-CONTRACT-V5 §12.11.5, §15.6.1): the
// new device D signs in because a signed-in device M nearby approves it. The session joins the
// two halves: the HTTP routes (nearby.ts: `start`, `poll`) and the LAN request CC-15 built
// (`cloudConnect.nearby.request`: the approvers D lists, the code D shows, `VOUCH_REQ`).
//
//   approvers / onApprovers(fn)   who answered nearby: `{id, label, platform}`, label cleaned
//   choose(id)                    the person tapped one; answers `{code}` to show (`482 913`)
//   code                          the code on screen once chosen
//   result / onResult(fn)         what `VOUCH_RESULT` said. Display only
//   wait({once?, signal?})        the paced poll: `signedIn | expired | cancelled` (or `pending`
//                                 with `once`); a refusal throws `sign-in-denied`
//   confirmAccount()              the person saw the signed-in account and says it is theirs
//   declineAccount()              it is not: the wrap is dropped and the device signs out
//   cancel()                      stop; the LAN request closes
//   ended / onEnd(fn)             the sign-in ended unconfirmed (decline, cancel, the 300 s screen
//                                 deadline): the device is signed out and holds no token
//
// Rules this module keeps:
//  - the order is `start`, then the LAN request, and the poll is paced from `start`: the first
//    poll is one interval after it. The poll decides the outcome: a token is `signedIn`,
//    `timeout` is `expired`, `access_denied` throws `sign-in-denied`. `VOUCH_RESULT` never signs
//    anyone in and never ends the wait;
//  - one answer: a token comes once, so the first terminal outcome (or error) is kept and every
//    later `wait()` gets the same;
//  - the LAN half stays open after `signedIn` so a Sync record can still arrive (the wrap, I-47.10),
//    until the person confirms or declines the account, the request expires (300 s), or `cancel()`;
//  - unconfirmed until `confirmAccount()` (V5 §15.6.1 rule 12, D-21): the token is held under the
//    unconfirmed mark; a decline, a `cancel()` (the abort signal included) or the `expiresIn`-second
//    screen deadline discards the session: the wrap and every held record are dropped, the device
//    signs out (a best effort) and the token goes locally whatever the Worker answered. A `ready`
//    poll that lands after such an end does the same at once. The stored subject, the `signedIn`
//    event (and so Sync and Connect) wait for `confirmAccount()`. `req.onClose` is deliberately
//    NOT an end: M closing the LAN session after `approved` leaves the sign-in awaiting the person
//    (rule 8: the server copy is the fallback, and M's CLI stops its listener right after approving);
//  - records `0x0030` to `0x003F` reach `onRecord` only after `confirmAccount()` (the engine holds
//    them: rule 12). `KEYRING_WRAP` (0x0030) is kept; the others are not this session's;
//  - the request handle, the proofs, the token, the code and the wrap are in no print, repr or
//    error. The session prints as its shape only;
//  - every approver label is cleaned again before it is listed: it comes from an unverified peer.

import { PolarisError, UnsupportedError } from "@polaris-key/client-core";
import { guarded } from "../connect/session.js";
import { cleanLabel, type VouchStatus } from "@polaris-key/client-core/peer";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import { printAs } from "../core/redact.js";
import type {
  NearbyApproverInfo,
  NearbyRequest,
  NearbyRequestOptions,
} from "../connect/nearbyRequester.js";
import { lanRuntimeSupported } from "./autoSignIn.js";
import type { NearbyPoll, NearbyRoutes, NearbyStarted } from "./nearby.js";
import {
  sleep,
  TRANSIENT,
  type ShownIdentity,
  type SignInOutcome,
  type WaitOptions,
} from "./signIn.js";

/** What `signIn.start({channel: "nearby"})` takes. */
export interface NearbySignInOptions {
  channel: "nearby";
  /** The device label the approver is shown (§12.7.1 and `HELLO`), else the client's default. */
  deviceName?: string;
  /** Aborting cancels the session. */
  signal?: AbortSignal;
}

/** One approver D can pick. Display data from an unverified peer: any device on the network can
 *  list itself under any label. */
export interface NearbyApprover {
  id: string;
  label: string | null;
  platform: string;
}

/** The LAN half, as the session reads it (`cloudConnect.nearby`). */
export interface NearbyLan {
  request(o: NearbyRequestOptions): Promise<NearbyRequest>;
}

/** The key ring, as the session uses it: it takes the wrap a nearby approver sent. */
export interface NearbyKeyring {
  adoptWrap(record: Uint8Array): Promise<{ kind: string }>;
}

/** What became of the `KEYRING_WRAP` M sent over the LAN. */
export type NearbyWrapState = "none" | "applied" | "refused";

export interface NearbySessionDeps {
  ctx: CoreContext;
  /** Where the wrap goes (absent: a wrap is dropped, the normal `unlock()` works later). */
  keyring?: NearbyKeyring;
  routes: NearbyRoutes;
  lan: () => NearbyLan;
  /** `identity.signOut()`: a declined account signs the device out again. */
  signOut: () => Promise<unknown>;
  /** The person confirmed the account: the token becomes a sign-in, the subject is stored and the
   *  `signedIn` event is raised (Sync and Connect start only now). */
  confirm: (subject: string) => Promise<void>;
  /** Drop the unconfirmed sign-in locally, whatever the Worker answered: the token, its mark and
   *  the stored identity. */
  dropLocal: () => Promise<void>;
  /** @internal Test seam: whether this runtime can browse the LAN (default: the optional
   *  `multicast-dns` dependency loads). */
  runtime?: () => Promise<boolean>;
  /** @internal Test seam: the wait between polls (default: a timer that honours the signals). */
  pause?: typeof sleep;
}

const KEYRING_WRAP = 0x0030;
/** Reasons the poll gives up on `retryAfterSeconds` it cannot honour. */
const MAX_RETRY_S = 60;

type Final =
  | { ok: Exclude<SignInOutcome, { kind: "pending" }> }
  | { err: unknown };

export class NearbySignInSession {
  readonly channel = "nearby" as const;
  /** Seconds the request lives, as the Worker said (300). */
  readonly expiresIn: number;
  /** The minimum seconds between polls; a `slow_down` lengthens it. */
  interval: number;
  /** When the request lapses on THIS client's clock (epoch seconds). */
  readonly expiresAt: number;
  /** The label D sent, or null. */
  readonly deviceName: string | null;

  readonly #deps: NearbySessionDeps;
  readonly #started: NearbyStarted;
  readonly #req: NearbyRequest;
  #code: string | null = null;
  #cancelled = false;
  #final: Final | null = null;
  #signedIn = false;
  #confirmed = false;
  #ended = false;
  #subject: string | null = null;
  #deadline: ReturnType<typeof setTimeout> | null = null;
  #discarding: Promise<void> = Promise.resolve();
  readonly #onEnd = new Set<() => void>();
  #wrap: Uint8Array | null = null;
  #wrapState: NearbyWrapState = "none";
  #applying: Promise<void> = Promise.resolve();
  readonly #onWrap = new Set<(s: NearbyWrapState) => void>();
  #lanOpen = true;
  /** The next poll is not before this (epoch ms): the pacing starts at `start`. */
  #notBefore: number;
  #chain: Promise<unknown> = Promise.resolve();
  readonly #abort = new AbortController();
  readonly #unsub: (() => void)[] = [];

  constructor(
    deps: NearbySessionDeps,
    started: NearbyStarted,
    req: NearbyRequest,
    label: string | null,
  ) {
    this.#deps = deps;
    this.#started = started;
    this.#req = req;
    this.expiresIn = started.expiresIn;
    this.interval = started.interval;
    this.expiresAt = deps.ctx.now() + started.expiresIn;
    this.deviceName = label;
    this.#notBefore = Date.now() + started.interval * 1000;
    this.#unsub.push(
      req.onRecord((r) => {
        if (r.type !== KEYRING_WRAP) return;
        this.#wrap = new Uint8Array(r.body);
        // The engine hands records over only after `confirmAccount()`; a wrap that comes later
        // than the confirmation is taken as it arrives.
        if (this.#confirmed) this.#apply();
      }),
    );
    printAs(this, () => ({
      channel: this.channel,
      approvers: this.approvers.length,
      chosen: this.#code !== null,
      expiresIn: this.expiresIn,
      interval: this.interval,
      expiresAt: this.expiresAt,
      deviceName: this.deviceName,
    }));
  }

  /** The approvers that answered, at most 8, labels cleaned. */
  get approvers(): readonly NearbyApprover[] {
    return clean(this.#req.approvers);
  }

  /** Called with the list whenever it changes. Returns the remover. */
  onApprovers(fn: (list: readonly NearbyApprover[]) => void): () => void {
    return this.#req.onApprovers((l) => fn(clean(l)));
  }

  /** The code on screen (`482 913`) once an approver is chosen, else null. */
  get code(): string | null {
    return this.#code;
  }

  /** What `VOUCH_RESULT` said, for display only: the poll is the authority. */
  get result(): VouchStatus | null {
    return this.#req.result;
  }

  onResult(fn: (status: VouchStatus) => void): () => void {
    return this.#req.onResult(fn);
  }

  /** The person tapped this approver. Answers the code to show; the request goes out once shown. */
  async choose(id: string): Promise<{ code: string }> {
    if (this.#final !== null || this.#cancelled)
      throw new PolarisError(ErrorCode.signInFailed, "The sign-in is over.");
    const r = await this.#req.choose(id);
    this.#code = r.code;
    return r;
  }

  /** Stop. A running `wait()` answers `cancelled`; the request simply lapses on the Worker. After
   *  `signedIn` and before the confirmation it also signs the device out (D-21). */
  cancel(): void {
    this.#halt();
    void this.#closeLan();
    if (this.#signedIn && !this.#confirmed) void this.#discard();
  }

  /** True once the sign-in ended unconfirmed (a decline, a cancel, the screen deadline). */
  get ended(): boolean {
    return this.#ended;
  }

  /** Called once when the sign-in ends unconfirmed, so a screen can leave. Returns the remover;
   *  called at once when it already ended. */
  onEnd(fn: () => void): () => void {
    if (this.#ended) {
      guarded(fn);
      return () => undefined;
    }
    this.#onEnd.add(fn);
    return () => this.#onEnd.delete(fn);
  }

  /** The end of this sign-in: no further poll is honoured, the deadline stops and listeners hear
   *  of it (once, and only while unconfirmed). */
  #halt(): void {
    this.#cancelled = true;
    this.#abort.abort();
    if (this.#deadline !== null) clearTimeout(this.#deadline);
    this.#deadline = null;
    if (this.#ended || this.#confirmed) return;
    this.#ended = true;
    for (const f of [...this.#onEnd]) guarded(f);
    this.#onEnd.clear();
  }

  /** The confirm screen's deadline: `expiresIn` seconds from the moment the poll answered, on the
   *  timer clock (monotonic), not on a wall-clock the host could move. */
  #armDeadline(): void {
    const t = setTimeout(() => {
      if (this.#confirmed) return;
      this.#halt();
      void this.#discard();
    }, this.expiresIn * 1000);
    t.unref?.();
    this.#deadline = t;
  }

  /**
   * The one end path for an unconfirmed sign-in; idempotent and serialized. The held wrap is
   * zeroed and dropped, the LAN request declines and closes, the Worker is asked to sign out as a
   * best effort, and whatever it answered the token, its mark and the stored identity go.
   */
  #discard(): Promise<void> {
    const run = this.#discarding.then(async () => {
      this.#wrap?.fill(0);
      this.#wrap = null;
      await this.#req.declineAccount().catch(() => undefined);
      await this.#closeLan();
      if (!this.#signedIn) return;
      await this.#deps.signOut().catch(() => undefined);
      await this.#deps.dropLocal().catch(() => undefined);
      this.#signedIn = false;
    });
    this.#discarding = run.catch(() => undefined);
    return run;
  }

  /**
   * Poll until the sign-in settles. `{once: true}` polls exactly once (no leading pause) and may
   * answer `pending`; otherwise it is the paced loop. The first terminal answer is kept: a later
   * call gets the same one (the token is handed over once). Throws `sign-in-denied` when M
   * refused, `service-unavailable` when the routes went away, and the taxonomy's error for a
   * failure that is not transient.
   */
  wait(opts: WaitOptions = {}): Promise<SignInOutcome> {
    const run = this.#chain.then(() => this.#wait(opts));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #wait(opts: WaitOptions): Promise<SignInOutcome> {
    for (;;) {
      if (this.#final !== null) return this.#settled(this.#final);
      if (!opts.once) {
        const over = await this.#pace(opts.signal);
        if (over !== null) return over;
      } else if (this.#cancelled) return { kind: "cancelled" };
      opts.signal?.throwIfAborted();
      let p: NearbyPoll;
      try {
        p = await this.#deps.routes.poll(this.#started);
      } catch (e) {
        if (!opts.once && e instanceof PolarisError && TRANSIENT.has(e.code)) {
          // Ride out a transient failure at the current interval, or the Worker's Retry-After.
          const retry = Math.min(e.retryAfterSeconds ?? 0, MAX_RETRY_S);
          this.#notBefore = Date.now() + Math.max(this.interval, retry) * 1000;
          continue;
        }
        throw e;
      }
      this.#notBefore = Date.now() + this.interval * 1000;
      if (p.kind === "ready") {
        // The routes stored the token (unconfirmed). A decline or cancel that got in before this
        // answer discards it at once; nothing is handed to the caller (D-21).
        this.#signedIn = true;
        this.#subject = p.subject;
        if (this.#cancelled) {
          await this.#discard();
          return { kind: "cancelled" };
        }
        this.#armDeadline();
      } else if (this.#cancelled) return { kind: "cancelled" };
      switch (p.kind) {
        case "ready":
          return this.#end({
            kind: "signedIn",
            subject: p.subject,
            activation: { licenseId: p.licenseId },
            ...(hasIdentity(p.identity) ? { identity: p.identity } : {}),
          });
        case "timeout":
          return this.#end({ kind: "expired" });
        case "denied":
          return this.#fail(
            new PolarisError(
              ErrorCode.signInDenied,
              "nearby sign-in was refused.",
            ),
          );
        case "unavailable":
          return this.#fail(
            new PolarisError(
              ErrorCode.serviceUnavailable,
              "this product no longer serves nearby sign-in.",
            ),
          );
        case "slow-down":
          this.interval = Math.max(this.interval, p.interval);
          this.#notBefore = Date.now() + this.interval * 1000;
          if (opts.once)
            return {
              kind: "pending",
              interval: this.interval,
              slowDown: true,
            };
          continue;
        case "pending":
          if (opts.once) return { kind: "pending", interval: this.interval };
          continue;
      }
    }
  }

  /** The outcome that ends the session before a poll (cancelled, lapsed), else null. */
  #over(): SignInOutcome | null {
    if (this.#cancelled) return { kind: "cancelled" };
    return this.#deps.ctx.now() >= this.expiresAt
      ? this.#end({ kind: "expired" })
      : null;
  }

  /** Wait out the interval, which runs from `start` (a `wait()` called late polls at once). */
  async #pace(signal: AbortSignal | undefined): Promise<SignInOutcome | null> {
    signal?.throwIfAborted();
    const early = this.#over();
    if (early !== null) return early;
    const lead = Math.max(0, this.#notBefore - Date.now()) / 1000;
    try {
      await (this.#deps.pause ?? sleep)(
        Math.min(lead, this.expiresIn),
        signal,
        this.#abort.signal,
      );
    } catch (e) {
      if (this.#cancelled) return { kind: "cancelled" };
      throw e;
    }
    return this.#over();
  }

  #settled(f: Final): SignInOutcome {
    if ("err" in f) throw f.err;
    return f.ok;
  }

  /** Keep a terminal outcome; everything but a sign-in closes the LAN half now. */
  #end(o: Exclude<SignInOutcome, { kind: "pending" }>): SignInOutcome {
    this.#final = { ok: o };
    if (o.kind !== "signedIn") void this.#closeLan();
    return o;
  }

  #fail(e: unknown): never {
    this.#final = { err: e };
    void this.#closeLan();
    throw e;
  }

  async #closeLan(): Promise<void> {
    if (!this.#lanOpen) return;
    this.#lanOpen = false;
    for (const u of this.#unsub.splice(0)) u();
    await this.#req.close().catch(() => undefined);
  }

  /** What became of the wrap M sent: `none` until one arrives and is taken (or refused). */
  get wrap(): NearbyWrapState {
    return this.#wrapState;
  }

  onWrap(fn: (s: NearbyWrapState) => void): () => void {
    this.#onWrap.add(fn);
    return () => this.#onWrap.delete(fn);
  }

  /** Open the held wrap through the key ring (once), never throwing into the LAN callback. */
  #apply(): void {
    const body = this.#wrap;
    const ring = this.#deps.keyring;
    this.#wrap = null;
    if (body === null) return;
    // No key ring here: the wrap is dropped, and the normal `unlock()` works later.
    if (ring === undefined) return void body.fill(0);
    this.#applying = this.#applying.then(async () => {
      let state: NearbyWrapState = "refused";
      try {
        state =
          (await ring.adoptWrap(body)).kind === "unlocked"
            ? "applied"
            : "refused";
      } catch {
        // The ring refused or the Worker could not be asked: the device stays locked.
      } finally {
        body.fill(0);
      }
      this.#wrapState = state;
      for (const f of [...this.#onWrap]) guarded(() => f(state));
      // Nothing else is expected on the channel once the wrap is in.
      if (state === "applied") await this.#closeLan();
    });
  }

  /**
   * The person has seen the signed-in account (`wait()` answered `identity`) and says it is theirs
   * (§15.6.1 rule 12). Only now does the engine hand over the records M sent. Throws when the
   * device is not signed in. If the LAN session already ended there is no channel copy; the device
   * is still signed in and the normal unlock works later.
   */
  async confirmAccount(): Promise<void> {
    if (this.#ended)
      throw new PolarisError(
        ErrorCode.signInFailed,
        "The sign-in ended before it was confirmed.",
      );
    if (!this.#signedIn || this.#subject === null)
      throw new PolarisError(
        ErrorCode.signInFailed,
        "Nothing to confirm: the device is not signed in.",
      );
    if (this.#confirmed) return;
    this.#confirmed = true;
    if (this.#deadline !== null) clearTimeout(this.#deadline);
    this.#deadline = null;
    try {
      await this.#deps.confirm(this.#subject);
    } catch (e) {
      this.#confirmed = false;
      throw e;
    }
    try {
      await this.#req.confirmAccount();
    } catch {
      // The chosen session is gone: no records, the server copy is the fallback.
    }
    // A wrap held until now is taken (the key ring checks it against a fresh read of the ring).
    this.#apply();
    await this.#applying;
  }

  /**
   * The account is not the person's: every held record is dropped, the LAN half closes and the
   * device signs out (rule 12). Safe to call more than once.
   */
  async declineAccount(): Promise<void> {
    this.#halt();
    await this.#discard();
  }
}

function clean(list: readonly NearbyApproverInfo[]): NearbyApprover[] {
  return list.map((a) => ({
    id: a.id,
    label: a.label === null ? null : cleanLabel(a.label),
    platform: a.platform,
  }));
}

const hasIdentity = (v: ShownIdentity): boolean =>
  v.name !== undefined || v.email !== undefined;

/**
 * Begin a nearby sign-in. The Worker request first (`nearby/start`), then the LAN request with
 * the handle it answered. Throws the typed N/A when the product serves no nearby approval, and
 * `nearby-unsupported` when this runtime cannot browse the network.
 */
export async function startNearbySignIn(
  deps: NearbySessionDeps,
  opts: NearbySignInOptions,
): Promise<NearbySignInSession> {
  if (opts.signal?.aborted) throw opts.signal.reason;
  // An unsupported runtime never calls a route for it (V5 §15.6.1 rule 10): the dependency is
  // checked before `nearby/start` makes a Worker request that nothing could answer.
  if (!(await (deps.runtime ?? lanRuntimeSupported)()))
    throw new UnsupportedError(
      {
        supported: false,
        feature: Feature.identityNearby,
        reason: "dependency",
        detail: "multicast-dns is not installed; LAN discovery is off.",
      },
      ErrorCode.nearbyUnsupported,
    );
  const started = await deps.routes.start(
    opts.deviceName !== undefined ? { deviceName: opts.deviceName } : {},
  );
  const label = deps.ctx.deviceLabel(opts.deviceName);
  const req = await deps.lan().request({
    request: started.request,
    ...(label ? { label } : {}),
    expiresIn: started.expiresIn,
  });
  const session = new NearbySignInSession(deps, started, req, label);
  if (opts.signal) {
    const stop = (): void => session.cancel();
    if (opts.signal.aborted) stop();
    else opts.signal.addEventListener("abort", stop, { once: true });
  }
  return session;
}
