// `identity.signIn.start(opts)`: the one way to sign in (I-10a.5). `channel: "device-code"` is
// RFC 8628 for hosts that cannot complete a browser redirect (a CLI, a daemon, a console, a
// kiosk); `channel: "redirect"` is redirect.ts's PKCE flow. Both answer a session.
//
// The device-code session holds what the person is shown (`userCode`, the two verification URIs,
// `expiresIn`, `interval`, `deviceName`) and keeps the POLL credential (`deviceCode`) private: it
// is a `#` field, so no print or serialisation can reach it.
//
//   reopen()   open `verificationUriComplete` in the host's browser (false when no opener ran)
//   cancel()   stop; `wait()` then answers `cancelled`
//   wait()     the paced loop (at least `interval` between polls, longer after a `slow_down`,
//              never faster because a poll failed) until the sign-in settles:
//              `signedIn | expired | cancelled`. `{once: true}` polls exactly once and may answer
//              `pending` (the caller paces: the Electron bridge). A person's refusal throws
//              `sign-in-denied`, a failure after approval `sign-in-failed`.
//
// A device-code sign-in yields the SIGNED-IN IDENTITY'S OWN licence and nothing else: nothing
// is attached unless the host asks (`wait({confirm})`, then `identity.attach`), P1-07. On `ready`
// the token is stored through Core's token manager, the acquisition sync runs, and the subject
// is read and persisted (`writeStoredSubject`).

import { PolarisError, UnsupportedError } from "@polaris-key/client-core";
import {
  DEVICE_POLL_DENIED,
  type AuthorizePurpose,
} from "@polaris-key/protocol/identity";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import { classifyResponse, errorFrom } from "../core/http.js";
import { printAs } from "../core/redact.js";
import type { TokenManager } from "../core/token.js";
import type { ProductDiscoveryDocument } from "../discovery.js";
import { writeStoredSubject } from "./account.js";
import type { ChooseOutcome } from "./choice.js";

/** The name and verified e-mail of a signed-in identity, as the Worker shows them. */
export interface ShownIdentity {
  name?: string;
  email?: string;
}

/** What `signIn.start({channel: "device-code"})` takes. Hints prefill the sign-in page; they
 *  verify nothing. */
export interface DeviceCodeSignInOptions {
  channel: "device-code";
  /** The device label the sign-in page shows (§12.7.1), else the client's default. */
  deviceName?: string;
  loginHint?: string;
  nameHint?: string;
  purpose?: AuthorizePurpose;
  scope?: string | readonly string[];
  /** `"app"`: the app shows the licence choice itself. Sent as a hint; the card chooses when the
   *  Worker does not serve it. */
  licenseChoice?: "app";
}

/** What `wait()` takes. */
export interface WaitOptions {
  /** Abort to stop polling; `wait` then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Poll exactly once (no leading pause) and answer `pending` while the person is still at it. */
  once?: boolean;
  /**
   * Opt in to the device-confirmed attach (P1-07): the wait first asks the Worker to hold at the
   * identity, calls `confirm` with it, and sends the answer as `attachLicense`. Without it no
   * opt-in is sent.
   */
  confirm?: (identity: ShownIdentity, attachable: boolean) => Promise<boolean>;
}

/** How a sign-in session ended, or (`once`) has not yet. */
export type SignInOutcome =
  /** Not finished. `interval` is the seconds to wait before the next poll; `slowDown` says the
   *  Worker asked for a longer one. Only `wait({once: true})` answers this. */
  | { kind: "pending"; interval: number; slowDown?: true }
  /** `license_choice=app` and a choice is due (redirect channel). No token was stored. */
  | ChooseOutcome
  | {
      kind: "signedIn";
      /** The pairwise account subject (`ps_…`), or null when the product serves none. */
      subject: string | null;
      /** The activation the sign-in produced: the device now holds the identity's token. */
      activation: {
        licenseId: string | null;
        attached?: "claimed" | "migrated";
      };
      identity?: ShownIdentity;
    }
  | { kind: "cancelled" }
  | { kind: "expired" };

/** `client.events` "identity": the signed-in account changed. */
export type IdentityEvent =
  | { kind: "signedIn"; subject: string | null }
  | { kind: "signedOut"; released: boolean }
  | { kind: "subjectChanged"; subject: string | null };

/** RFC 8628 §3.5: a `slow_down` without an interval adds five seconds to the CURRENT interval. */
export const SLOW_DOWN_STEP_SECONDS = 5;

/** The longest single `setTimeout` (2^31 - 1 ms); a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The seconds `wait` actually sleeps: never under one second and never past the code's life. */
function pollDelay(interval: number, expiresIn: number): number {
  const ceiling = Number.isFinite(expiresIn) && expiresIn >= 1 ? expiresIn : 1;
  if (!Number.isFinite(interval)) return interval > 0 ? ceiling : 1;
  return Math.min(Math.max(interval, 1), ceiling);
}

/** Transient failures `wait` rides out at the current interval: the network and a 5xx. */
const TRANSIENT = new Set<string>([
  ErrorCode.networkError,
  ErrorCode.serverError,
]);

interface StartBody {
  deviceName?: unknown;
  deviceCode?: unknown;
  userCode?: unknown;
  verificationUri?: unknown;
  verificationUriComplete?: unknown;
  expiresIn?: unknown;
  interval?: unknown;
}

const isString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const isSeconds = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
/** A server's seconds rounded UP, so a 0.5 is one second rather than a sub-second spin. */
const wholeSeconds = (v: number): number => Math.ceil(v);

/** What the device-code session needs from the identity client. */
export interface DeviceCodeDeps {
  ctx: CoreContext;
  tokens: TokenManager;
  discovery: () => ProductDiscoveryDocument | null;
  /** The post-acquisition sync, as after an activation. */
  onAcquired: () => Promise<void>;
  /** Persist who signed in (`identity.json`), or forget it. */
  storeIdentity: (identity: ShownIdentity | null) => Promise<void>;
  /** The subject of the account now signed in; null when the product serves none. */
  fetchSubject: () => Promise<string | null>;
  /** The licence the device now runs on, after the acquisition sync. */
  licenseId: () => string | null;
  openUrl: (url: string) => Promise<boolean>;
  emit: (e: IdentityEvent) => void;
}

/** One poll's answer, before the session maps it onto an outcome. */
type Poll =
  | { s: "pending" }
  | { s: "slow-down"; interval: number }
  | { s: "ready"; outcome: Extract<SignInOutcome, { kind: "signedIn" }> }
  | { s: "confirm"; identity: ShownIdentity; attachable: boolean }
  | { s: "expired" };

export class DeviceCodeSession {
  readonly channel = "device-code" as const;
  /** What the person types on the verification page, e.g. `WDJB-MJHT`. */
  readonly userCode: string;
  /** The page the person opens and types the code into. */
  readonly verificationUri: string;
  /** The same page with the code pre-filled: the payload for a QR code or a link. */
  readonly verificationUriComplete: string;
  /** Seconds the code lives for, as the Worker advertised it. */
  readonly expiresIn: number;
  /** The minimum seconds between polls, as advertised; a `slow_down` lengthens it. */
  interval: number;
  /** When the code expires on THIS client's clock (epoch seconds). */
  readonly expiresAt: number;
  /** The device label the sign-in page shows (§12.7.1), or null. */
  readonly deviceName: string | null;
  readonly #deviceCode: string;
  readonly #deps: DeviceCodeDeps;
  #cancelled = false;
  #abort = new AbortController();

  constructor(
    start: {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      expiresIn: number;
      interval: number;
      expiresAt: number;
      deviceName: string | null;
    },
    deps: DeviceCodeDeps,
  ) {
    this.#deviceCode = start.deviceCode;
    this.userCode = start.userCode;
    this.verificationUri = start.verificationUri;
    this.verificationUriComplete = start.verificationUriComplete;
    this.expiresIn = start.expiresIn;
    this.interval = start.interval;
    this.expiresAt = start.expiresAt;
    this.deviceName = start.deviceName;
    this.#deps = deps;
    // Never print the poll credential: it is not a field, and the view lists the shown ones.
    printAs(this, () => ({
      channel: this.channel,
      userCode: this.userCode,
      verificationUri: this.verificationUri,
      verificationUriComplete: this.verificationUriComplete,
      expiresIn: this.expiresIn,
      interval: this.interval,
      expiresAt: this.expiresAt,
      deviceName: this.deviceName,
    }));
  }

  /** Open `verificationUriComplete` in the host's browser; false when no opener ran. */
  reopen(): Promise<boolean> {
    return this.#deps.openUrl(this.verificationUriComplete).catch(() => false);
  }

  /** Stop. A running `wait` answers `cancelled`; the code simply expires on the Worker. */
  cancel(): void {
    this.#cancelled = true;
    this.#abort.abort();
  }

  /** Poll until the sign-in settles (see the file header). */
  async wait(opts: WaitOptions = {}): Promise<SignInOutcome> {
    this.#deps.ctx.requireService("identity", Feature.identityDevicecode);
    const { signal } = opts;
    // The attach opt-in: hold at the identity first, then send the person's decision.
    let optIn: AttachOptIn = opts.confirm ? { confirmIdentity: true } : {};
    for (;;) {
      if (this.#cancelled) return { kind: "cancelled" };
      signal?.throwIfAborted();
      if (!opts.once) {
        if (this.#deps.ctx.now() >= this.expiresAt) return { kind: "expired" };
        try {
          await sleep(
            pollDelay(this.interval, this.expiresIn),
            signal,
            this.#abort.signal,
          );
        } catch (e) {
          if (this.#cancelled) return { kind: "cancelled" };
          throw e;
        }
        if (this.#cancelled) return { kind: "cancelled" };
        if (this.#deps.ctx.now() >= this.expiresAt) return { kind: "expired" };
      }
      let poll: Poll;
      try {
        poll = await this.#poll(optIn);
      } catch (e) {
        if (!opts.once && e instanceof PolarisError && TRANSIENT.has(e.code))
          continue;
        throw e;
      }
      if (poll.s === "ready") return poll.outcome;
      if (this.#cancelled) return { kind: "cancelled" };
      switch (poll.s) {
        case "expired":
          return { kind: "expired" };
        case "pending":
          if (opts.once) return { kind: "pending", interval: this.interval };
          continue;
        case "slow-down":
          this.interval = Math.max(this.interval, poll.interval);
          if (opts.once)
            return {
              kind: "pending",
              interval: this.interval,
              slowDown: true,
            };
          continue;
        case "confirm": {
          const attach = opts.confirm
            ? await opts.confirm(poll.identity, poll.attachable)
            : false;
          optIn = { attachLicense: attach && poll.attachable };
          if (opts.once) return { kind: "pending", interval: this.interval };
          continue;
        }
      }
    }
  }

  async #poll(optIn: AttachOptIn): Promise<Poll> {
    const { ctx, tokens } = this.#deps;
    const body: Record<string, unknown> = {
      deviceCode: this.#deviceCode,
      deviceId: ctx.deviceId,
    };
    if (optIn.confirmIdentity) body.confirmIdentity = true;
    if (typeof optIn.attachLicense === "boolean")
      body.attachLicense = optIn.attachLicense;
    // The attach names the licence by the device's own bearer; an ordinary poll sends none.
    const token =
      optIn.confirmIdentity || typeof optIn.attachLicense === "boolean"
        ? tokens.current
        : null;
    const res = await post(
      ctx,
      "identity/auth/device/poll",
      body,
      token ? { authorization: `Bearer ${token}` } : {},
    );
    if (res.status >= 500)
      throw errorFrom(await classifyResponse(res), "device sign-in poll");
    if (res.status !== 200 && res.status !== 429) {
      const c = await classifyResponse(res);
      throw new PolarisError(
        ErrorCode.signInFailed,
        c.message ?? `device sign-in poll refused (status ${res.status}).`,
      );
    }
    const answer = (await res.json().catch(() => ({}))) as {
      status?: unknown;
      interval?: unknown;
      token?: unknown;
      identity?: unknown;
      attachable?: unknown;
      attached?: unknown;
      reason?: unknown;
    };
    if (res.status === 429) {
      // The Worker's own `slow_down` carries the interval; a rate limiter in front of it may
      // answer 429 without one, which RFC 8628 §3.5 treats the same way.
      return {
        s: "slow-down",
        interval: isSeconds(answer.interval)
          ? wholeSeconds(answer.interval)
          : this.interval + SLOW_DOWN_STEP_SECONDS,
      };
    }
    const identity = shown(answer.identity);
    switch (answer.status) {
      case "pending":
        return { s: "pending" };
      case "timeout":
        return { s: "expired" };
      case "error":
        throw answer.reason === DEVICE_POLL_DENIED
          ? new PolarisError(
              ErrorCode.signInDenied,
              "device sign-in was refused.",
            )
          : new PolarisError(ErrorCode.signInFailed, "device sign-in failed.");
      case "confirm":
        return {
          s: "confirm",
          identity: identity ?? {},
          attachable: answer.attachable === true,
        };
      case "ready": {
        if (!isString(answer.token))
          throw new PolarisError(
            ErrorCode.signInFailed,
            "device sign-in answered ready without a token.",
          );
        await tokens.set(answer.token, "signin");
        await this.#deps.storeIdentity(identity);
        await this.#deps.onAcquired();
        const subject = await this.#deps.fetchSubject().catch(() => null);
        await writeStoredSubject(ctx.dirs.state, subject).catch(
          () => undefined,
        );
        const attached =
          answer.attached === "claimed" || answer.attached === "migrated"
            ? answer.attached
            : undefined;
        this.#deps.emit({ kind: "signedIn", subject });
        return {
          s: "ready",
          outcome: {
            kind: "signedIn",
            subject,
            activation: {
              licenseId: this.#deps.licenseId(),
              ...(attached ? { attached } : {}),
            },
            ...(identity ? { identity } : {}),
          },
        };
      }
      default:
        throw new PolarisError(
          ErrorCode.signInFailed,
          "device sign-in failed.",
        );
    }
  }
}

interface AttachOptIn {
  confirmIdentity?: boolean;
  attachLicense?: boolean;
}

/** One POST; a request with no answer throws `network-error` (`CoreContext.request`). */
function post(
  ctx: CoreContext,
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return ctx.request(
    ctx.url(path),
    {
      method: "POST",
      headers: ctx.headers({ "content-type": "application/json", ...extra }),
      body: JSON.stringify(body),
    },
    path,
  );
}

/**
 * Begin a device-code sign-in. Refuses before any request when the product cannot sign in:
 * `service-unavailable` (an `UnsupportedError`) when it does not run Identity (D-21), and
 * `disabled` when this session's discovery says Identity is on but no sign-in provider is set up.
 * Otherwise the one taxonomy (SP-46): `network-error`, `rate_limited` with `retryAfterSeconds`,
 * `server-error`, or the Worker's code (`sign-in-unavailable` when it names none).
 *
 * No bearer is sent even when the device holds a token: a sign-in asks for the IDENTITY's
 * credential, and the Worker binds the flow to this device by its id.
 */
export async function startDeviceCodeSignIn(
  deps: DeviceCodeDeps,
  opts: DeviceCodeSignInOptions,
): Promise<DeviceCodeSession> {
  const { ctx } = deps;
  ctx.requireService("identity", Feature.identityDevicecode);
  if (deps.discovery()?.services?.identity?.configured === false)
    throw new PolarisError(
      ErrorCode.disabled,
      "this product has not set up sign-in, so a device sign-in cannot start.",
    );
  const body: Record<string, unknown> = { deviceId: ctx.deviceId };
  // §12.7.1: the per-call name, else the client's `deviceName`, else the platform default,
  // normalised exactly as the Worker will store it. `""` sends none.
  const label = ctx.deviceLabel(opts.deviceName);
  if (label) body.deviceName = label;
  if (opts.loginHint !== undefined) body.loginHint = opts.loginHint;
  if (opts.nameHint !== undefined) body.nameHint = opts.nameHint;
  if (opts.purpose !== undefined) body.purpose = opts.purpose;
  if (opts.scope !== undefined)
    body.scope =
      typeof opts.scope === "string" ? opts.scope : opts.scope.join(" ");
  if (opts.licenseChoice !== undefined) body.licenseChoice = opts.licenseChoice;
  const res = await post(ctx, "identity/auth/device/start", body);
  // A 404 here means the Worker serves no sign-in for this product (Identity off before
  // discovery said so): the typed N/A, the same answer the Swift and Kotlin sessions give.
  if (res.status === 404)
    throw new UnsupportedError(
      {
        supported: false,
        feature: Feature.identityDevicecode,
        reason: "product",
        detail: "this product does not serve device sign-in",
      },
      ErrorCode.serviceUnavailable,
    );
  if (res.status !== 200)
    throw errorFrom(
      await classifyResponse(res, ErrorCode.signInUnavailable),
      "device sign-in start",
    );
  const b = (await res.json().catch(() => ({}))) as StartBody;
  if (
    !isString(b.deviceCode) ||
    !isString(b.userCode) ||
    !isString(b.verificationUri) ||
    !isString(b.verificationUriComplete) ||
    !isSeconds(b.expiresIn) ||
    !isSeconds(b.interval)
  ) {
    throw new PolarisError(
      "bad_response",
      "device sign-in start answered without a complete prompt.",
    );
  }
  return new DeviceCodeSession(
    {
      deviceCode: b.deviceCode,
      userCode: b.userCode,
      verificationUri: b.verificationUri,
      verificationUriComplete: b.verificationUriComplete,
      expiresIn: wholeSeconds(b.expiresIn),
      interval: wholeSeconds(b.interval),
      expiresAt: ctx.now() + wholeSeconds(b.expiresIn),
      // The echo is what the page shows; an older Worker sends none, so show what was sent.
      deviceName:
        "deviceName" in b
          ? typeof b.deviceName === "string"
            ? b.deviceName
            : null
          : label,
    },
    deps,
  );
}

/** The identity a poll answer shows, or null. Only `name` and `email`, each a string. */
function shown(v: unknown): ShownIdentity | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: ShownIdentity = {};
  if (typeof o.name === "string" && o.name) out.name = o.name;
  if (typeof o.email === "string" && o.email) out.email = o.email;
  return out.name || out.email ? out : null;
}

/** Wait `seconds`, or reject with a signal's reason when it aborts first. A wait longer than
 *  one timer can hold is chained, so it never collapses into Node's 1 ms overflow fallback. */
function sleep(
  seconds: number,
  ...signals: (AbortSignal | undefined)[]
): Promise<void> {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  return new Promise((resolve, reject) => {
    const aborted = live.find((s) => s.aborted);
    if (aborted) return reject(aborted.reason);
    let remaining = Math.max(0, seconds * 1000);
    let timer: ReturnType<typeof setTimeout>;
    const done = () =>
      live.forEach((s) => s.removeEventListener("abort", onAbort));
    const onAbort = (ev: Event) => {
      clearTimeout(timer);
      done();
      reject((ev.target as AbortSignal).reason);
    };
    const arm = () => {
      const step = Math.min(remaining, MAX_TIMER_MS);
      remaining -= step;
      timer = setTimeout(() => {
        if (remaining > 0) return arm();
        done();
        resolve();
      }, step);
    };
    arm();
    live.forEach((s) => s.addEventListener("abort", onAbort, { once: true }));
  });
}
