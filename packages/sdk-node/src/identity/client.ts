// The Identity sub-client — device-code sign-in (RFC 8628) for hosts that cannot complete a
// browser redirect: a CLI, a daemon, a game console, a kiosk.
//
//   beginSignIn()    POST /<p>/identity/auth/device/start → the code the player types, and the
//                    two verification URIs (the complete one, with the code in it, is the QR
//                    payload). The device code — the POLL credential — stays inside the prompt.
//   pollSignIn()     POST /<p>/identity/auth/device/poll, exactly once. The caller paces.
//   waitForSignIn()  the paced loop: at least `interval` between polls, longer after a
//                    `slow_down`, never faster because a poll failed, and stopped by expiry or
//                    by the caller's AbortSignal.
//
// A `ready` poll stores the device token through Core's token manager and raises the same
// acquisition event activation does, so the facade's forced sync runs exactly as it would after
// `license.activateWithKey()`.
//
// A device-code sign-in yields the SIGNED-IN IDENTITY'S OWN licence and nothing else. The
// Worker's callback merges nothing (P1-06): a device that was on an anonymous enrolled licence is
// not attached to the account by signing in, and nothing here offers or implies that it is. The
// opt-in, device-confirmed attach is P1-07's, on a separate call.

import { PolarisError } from "@polaris-key/client-core";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";
import { redactOnPrint } from "../core/redact.js";

/** What the host shows the player, plus the poll credential the SDK keeps using. A prompt from
 *  `beginSignIn` prints (`console.log`, `JSON.stringify`) with `deviceCode` redacted. */
export interface SignInPrompt {
  /** The poll credential. Never show it, never put it in a URL. */
  deviceCode: string;
  /** What the player types on the verification page, e.g. `WDJB-MJHT`. */
  userCode: string;
  /** The page the player opens and types the code into. */
  verificationUri: string;
  /** The same page with the code pre-filled — the payload for a QR code or a link. */
  verificationUriComplete: string;
  /** Seconds the code lives for, as the server advertised it. */
  expiresIn: number;
  /** The minimum seconds between polls, as the server advertised it. */
  interval: number;
  /** When the code expires on THIS client's clock (epoch seconds): `beginSignIn`'s now plus
   *  `expiresIn`. `waitForSignIn` stops here without asking the server again. */
  expiresAt: number;
}

/** One poll's answer. */
export type SignInPoll =
  /** The player has not finished yet. */
  | { status: "pending" }
  /** Polled too fast: wait `interval` seconds before the next poll (RFC 8628 §3.5). */
  | { status: "slow-down"; interval: number }
  /** Signed in: the device token is stored and the post-acquisition sync has run. */
  | { status: "ready" }
  /** The code expired (or the server no longer knows it). Begin again. */
  | { status: "expired" }
  /** The sign-in failed or was refused. Begin again. */
  | { status: "error"; message: string };

/** How a `waitForSignIn` ended. Cancellation rejects with the signal's reason instead. */
export type SignInResult =
  | { status: "ready" }
  | { status: "expired" }
  | { status: "error"; message: string };

export interface WaitForSignInOptions {
  /** Abort to stop polling; `waitForSignIn` then rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** RFC 8628 §3.5: a `slow_down` without an interval adds five seconds to the CURRENT interval,
 *  so repeated interval-less answers keep lengthening it. */
export const SLOW_DOWN_STEP_SECONDS = 5;

/** The longest single `setTimeout` (2^31 - 1 ms); a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The seconds `waitForSignIn` actually sleeps: never under one second (a zero, negative or
 *  non-finite interval would spin) and never past the code's own lifetime. */
function pollDelay(interval: number, expiresIn: number): number {
  const ceiling = Number.isFinite(expiresIn) && expiresIn >= 1 ? expiresIn : 1;
  if (!Number.isFinite(interval)) return interval > 0 ? ceiling : 1;
  return Math.min(Math.max(interval, 1), ceiling);
}

/** Transient failures `waitForSignIn` rides out at the current interval: the network, and a
 *  server that answered 5xx. Anything else ends the wait. */
const TRANSIENT = new Set(["network-error", "server-error"]);

/** Raised after a sign-in mints a credential; the facade syncs. */
export type SignInAcquiredListener = () => Promise<void>;

interface StartBody {
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
/** A server's seconds rounded UP, so a 0.5 is one second rather than a sub-second spin. Same as
 *  the Python and Swift SDKs. */
const wholeSeconds = (v: number): number => Math.ceil(v);

export class IdentityClient {
  constructor(
    private readonly ctx: CoreContext,
    private readonly tokens: TokenManager,
    private readonly onAcquired: SignInAcquiredListener,
  ) {}

  /**
   * Begin a device-code sign-in. Throws `PolarisError("service-unavailable")` before any request
   * when this product does not run Identity (D-21).
   *
   * No bearer is sent even when the device holds a token: a sign-in asks for the IDENTITY's
   * credential, and the server binds the flow to this device by its id.
   */
  async beginSignIn(opts: { deviceName?: string } = {}): Promise<SignInPrompt> {
    this.ctx.requireService("identity");
    const body: Record<string, string> = { deviceId: this.ctx.deviceId };
    const name = opts.deviceName?.trim();
    if (name) body.deviceName = name;
    const res = await this.post("identity/auth/device/start", body);
    if (res.status !== 200) {
      throw new PolarisError(
        await errorCode(res, "sign-in-unavailable"),
        `device sign-in could not start (status ${res.status}).`,
      );
    }
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
    return redactOnPrint<SignInPrompt>(
      {
        deviceCode: b.deviceCode,
        userCode: b.userCode,
        verificationUri: b.verificationUri,
        verificationUriComplete: b.verificationUriComplete,
        expiresIn: wholeSeconds(b.expiresIn),
        interval: wholeSeconds(b.interval),
        expiresAt: this.ctx.now() + wholeSeconds(b.expiresIn),
      },
      ["deviceCode"],
    );
  }

  /**
   * Poll once. On `ready` the token is stored and the post-acquisition sync has completed before
   * this resolves.
   *
   * Throws `PolarisError("network-error")` when the request never got an answer and
   * `PolarisError("server-error")` on a 5xx — neither says anything about the sign-in, so they are
   * not folded into a status. `waitForSignIn` rides both out.
   */
  async pollSignIn(prompt: SignInPrompt): Promise<SignInPoll> {
    return this.poll(prompt, prompt.interval);
  }

  /** One poll, where an interval-less `slow_down` lengthens `current` — the interval the caller
   *  is pacing at — rather than the prompt's original one. */
  private async poll(
    prompt: SignInPrompt,
    current: number,
  ): Promise<SignInPoll> {
    this.ctx.requireService("identity");
    const res = await this.post("identity/auth/device/poll", {
      deviceCode: prompt.deviceCode,
      deviceId: this.ctx.deviceId,
    });
    if (res.status >= 500) {
      throw new PolarisError(
        "server-error",
        `device sign-in poll failed with status ${res.status}.`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as {
      status?: unknown;
      interval?: unknown;
      token?: unknown;
    };
    if (res.status === 429) {
      // The Worker's own `slow_down` carries the interval; a rate limiter in front of it may
      // answer 429 without one, which RFC 8628 §3.5 treats the same way.
      return {
        status: "slow-down",
        interval: isSeconds(body.interval)
          ? wholeSeconds(body.interval)
          : current + SLOW_DOWN_STEP_SECONDS,
      };
    }
    if (res.status !== 200) {
      return {
        status: "error",
        message: `device sign-in poll refused (status ${res.status}).`,
      };
    }
    switch (body.status) {
      case "pending":
        return { status: "pending" };
      case "timeout":
        return { status: "expired" };
      case "ready": {
        if (!isString(body.token))
          return { status: "error", message: "ready without a token." };
        await this.tokens.set(body.token);
        await this.onAcquired();
        return { status: "ready" };
      }
      default:
        return { status: "error", message: "device sign-in failed." };
    }
  }

  /**
   * Poll until the sign-in settles. The first poll waits one `interval` after the prompt was
   * issued; a `slow_down` lengthens the interval for every later poll and never shortens it; a
   * transient failure is retried at the SAME interval. Resolves `expired` once the prompt's
   * `expiresAt` has passed, without asking the server, and rejects with the signal's reason when
   * `signal` aborts.
   */
  async waitForSignIn(
    prompt: SignInPrompt,
    opts: WaitForSignInOptions = {},
  ): Promise<SignInResult> {
    this.ctx.requireService("identity");
    const { signal } = opts;
    let interval = prompt.interval;
    for (;;) {
      signal?.throwIfAborted();
      if (this.ctx.now() >= prompt.expiresAt) return { status: "expired" };
      await sleep(pollDelay(interval, prompt.expiresIn), signal);
      if (this.ctx.now() >= prompt.expiresAt) return { status: "expired" };
      let poll: SignInPoll;
      try {
        poll = await this.poll(prompt, interval);
      } catch (e) {
        if (e instanceof PolarisError && TRANSIENT.has(e.code)) continue;
        throw e;
      }
      switch (poll.status) {
        case "pending":
          continue;
        case "slow-down":
          interval = Math.max(interval, poll.interval);
          continue;
        default:
          return poll;
      }
    }
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const f = this.ctx.fetcher();
    try {
      return await f(this.ctx.url(path), {
        method: "POST",
        headers: this.ctx.headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
        signal: this.ctx.deadline(),
      });
    } catch (e) {
      throw new PolarisError("network-error", (e as Error).message);
    }
  }
}

/** The Worker's flat (`{"error":"x"}`) or nested (`{"error":{"code":"x"}}`) code, else `fallback`. */
async function errorCode(res: Response, fallback: string): Promise<string> {
  const b = (await res.json().catch(() => ({}))) as {
    error?: string | { code?: string };
  };
  if (typeof b.error === "string") return b.error;
  return b.error?.code ?? fallback;
}

/** Wait `seconds`, or reject with the signal's reason when it aborts first. A wait longer than
 *  one timer can hold is chained, so it never collapses into Node's 1 ms overflow fallback. */
function sleep(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    let remaining = Math.max(0, seconds * 1000);
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const arm = () => {
      const step = Math.min(remaining, MAX_TIMER_MS);
      remaining -= step;
      timer = setTimeout(() => {
        if (remaining > 0) return arm();
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, step);
    };
    arm();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
