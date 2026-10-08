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
// opt-in, device-confirmed attach (P1-07) is two optional fields on the same poll
// (`confirmIdentity`, then `attachLicense` with the device's bearer). This client sends them only
// when the host asks (`pollSignIn(prompt, {confirmIdentity, attachLicense})`, or
// `waitForSignIn(prompt, {confirm})`), never by default (SDK parity pass §3.12).
//
// `signInWithBrowser()` is device code opened in the system browser, the interim for native hosts
// until I-15's redirect token route (it needs no new route: it polls `/identity/auth/device/poll`
// like any device-code sign-in; the old `/identity/auth/poll` is retired and the Worker no longer
// serves it). `signOut()` deactivates and forgets the signed-in identity; `current()` reads it.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { PolarisError } from "@polaris-key/client-core";
import { readJson, writeJson } from "../core/jsonFile.js";
import { Feature } from "../constants.generated.js";
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
  /**
   * The device label the sign-in page shows (WIRE-CONTRACT-V4 §12.7.1): the Worker's echo of the
   * label it stored, else (an older Worker) the label this client sent; `null` when there is none.
   * Show it under the code: "The sign-in page will show '<label>'".
   */
  deviceName: string | null;
}

/** One poll's answer. */
export type SignInPoll =
  /** The player has not finished yet. */
  | { status: "pending" }
  /** Polled too fast: wait `interval` seconds before the next poll (RFC 8628 §3.5). */
  | { status: "slow-down"; interval: number }
  /** Signed in: the device token is stored and the post-acquisition sync has run. `identity`
   *  is who the device is now signed in as; `attached` says whether its anonymous enrolled
   *  licence was claimed or migrated into the account (only after an attach opt-in). */
  | {
      status: "ready";
      identity?: ShownIdentity;
      attached?: "claimed" | "migrated";
    }
  /** The attach opt-in (P1-07): the device must show `identity` and send the player's decision
   *  (`attachLicense`) on the next poll; `attachable` says whether there is a licence to attach. */
  | { status: "confirm"; identity: ShownIdentity; attachable: boolean }
  /** The code expired (or the server no longer knows it). Begin again. */
  | { status: "expired" }
  /** The sign-in failed or was refused. Begin again. */
  | { status: "error"; message: string };

/** The name and verified e-mail of a signed-in identity, as the Worker shows them. */
export interface ShownIdentity {
  name?: string;
  email?: string;
}

/** `identity.current()`: who this device is signed in as. */
export interface CurrentIdentity extends ShownIdentity {
  /** Epoch seconds of the sign-in on this device. */
  signedInAt: number;
}

/** The attach opt-in a poll sends (P1-07). */
export interface AttachOptIn {
  /** Hold the flow at the identity so the device can show it first. */
  confirmIdentity?: boolean;
  /** The player's decision after seeing the identity: attach this device's anonymous licence. */
  attachLicense?: boolean;
}

/** How a `waitForSignIn` ended. Cancellation rejects with the signal's reason instead. */
export type SignInResult =
  | {
      status: "ready";
      identity?: ShownIdentity;
      attached?: "claimed" | "migrated";
    }
  | { status: "expired" }
  | { status: "error"; message: string };

export interface WaitForSignInOptions {
  /** Abort to stop polling; `waitForSignIn` then rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Opt in to the device-confirmed attach (P1-07): the wait first asks the server to hold at the
   * identity, calls `confirm` with it, and sends the answer as `attachLicense`. Without it no
   * opt-in is sent and the sign-in yields the identity's own licence only.
   */
  confirm?: (identity: ShownIdentity, attachable: boolean) => Promise<boolean>;
}

export interface SignInWithBrowserOptions extends WaitForSignInOptions {
  deviceName?: string;
  /** Shown before the browser opens: render the code and the QR (`qr.terminal`) beside it. */
  onPrompt?: (prompt: SignInPrompt) => void;
  /** Open a URL; default the OS opener (`open`, `xdg-open`, `rundll32 url.dll`). Return false
   *  when it could not, and the host's prompt is the fallback. */
  openUrl?: (url: string) => Promise<boolean> | boolean;
}

/** The process spawner `openInBrowser` uses (a test passes a fake). */
export type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { detached: boolean; stdio: "ignore" },
) => {
  once(event: "error" | "spawn", fn: () => void): unknown;
  unref(): void;
};

/** The OS command and arguments that open `url` with the default handler, per platform. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  // Windows: rundll32 hands the URL to the protocol handler as one argument. `cmd /c start`
  // would run it through cmd.exe's parser, where `&`, `|` and `^` in a URL split the command.
  if (platform === "win32")
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

/**
 * Open `url` with the OS's default handler. Best-effort: false when no opener ran. Only an
 * absolute http(s) URL with no whitespace or control character is opened.
 */
export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: SpawnLike = spawn as unknown as SpawnLike,
): Promise<boolean> {
  if (!/^https?:\/\//.test(url) || /[\s\u0000-\u001f\u007f-\u009f]/.test(url))
    return Promise.resolve(false);
  const [cmd, args] = browserCommand(url, platform);
  return new Promise((resolve) => {
    try {
      const child = spawnImpl(cmd, args, {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
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
/** A server's seconds rounded UP, so a 0.5 is one second rather than a sub-second spin. Same as
 *  the Python and Swift SDKs. */
const wholeSeconds = (v: number): number => Math.ceil(v);

export class IdentityClient {
  private readonly identityFile: string;

  constructor(
    private readonly ctx: CoreContext,
    private readonly tokens: TokenManager,
    private readonly onAcquired: SignInAcquiredListener,
    /** `license.deactivate()`, for `signOut()`. */
    private readonly deactivate: () => Promise<void> = async () => undefined,
  ) {
    this.identityFile = join(ctx.dirs.state, "identity.json");
  }

  /** Who this device is signed in as (from the last `ready`), or null. */
  async current(): Promise<CurrentIdentity | null> {
    if (this.tokens.current === null) return null;
    const v = await readJson<CurrentIdentity | null>(this.identityFile, null);
    return v && typeof v.signedInAt === "number" ? v : null;
  }

  /** Sign out: deactivate this device (release its seat, wipe credentials) and forget the
   *  identity. The local wipe happens even when the server cannot be reached. */
  async signOut(): Promise<void> {
    await this.deactivate();
    await this.forget();
  }

  /** Forget the stored identity (the facade calls it on every deactivation). */
  async forget(): Promise<void> {
    await rm(this.identityFile, { force: true }).catch(() => undefined);
  }

  /**
   * "Sign in with browser": begin a device-code sign-in, open its `verificationUriComplete` in
   * the system browser, and wait (SDK parity pass §3.12). The interim for native hosts until
   * I-15; `onPrompt` shows the code and QR in case the browser is on another device.
   */
  async signInWithBrowser(
    opts: SignInWithBrowserOptions = {},
  ): Promise<SignInResult> {
    const prompt = await this.beginSignIn(
      opts.deviceName ? { deviceName: opts.deviceName } : {},
    );
    opts.onPrompt?.(prompt);
    await Promise.resolve(
      (opts.openUrl ?? openInBrowser)(prompt.verificationUriComplete),
    ).catch(() => false);
    return this.waitForSignIn(prompt, opts);
  }

  /**
   * Begin a device-code sign-in. Throws `PolarisError("service-unavailable")` before any request
   * when this product does not run Identity (D-21).
   *
   * No bearer is sent even when the device holds a token: a sign-in asks for the IDENTITY's
   * credential, and the server binds the flow to this device by its id.
   */
  async beginSignIn(opts: { deviceName?: string } = {}): Promise<SignInPrompt> {
    this.ctx.requireService("identity", Feature.identityDevicecode);
    const body: Record<string, string> = { deviceId: this.ctx.deviceId };
    // §12.7.1: the per-call name, else the client's `deviceName`, else the platform default,
    // normalised exactly as the Worker will store it. `""` sends none.
    const label = this.ctx.deviceLabel(opts.deviceName);
    if (label) body.deviceName = label;
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
        // The echo is what the page shows; an older Worker sends none, so show what was sent.
        deviceName:
          "deviceName" in b
            ? typeof b.deviceName === "string"
              ? b.deviceName
              : null
            : label,
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
  async pollSignIn(
    prompt: SignInPrompt,
    optIn: AttachOptIn = {},
  ): Promise<SignInPoll> {
    return this.poll(prompt, prompt.interval, optIn);
  }

  /** One poll, where an interval-less `slow_down` lengthens `current` — the interval the caller
   *  is pacing at — rather than the prompt's original one. */
  private async poll(
    prompt: SignInPrompt,
    current: number,
    optIn: AttachOptIn = {},
  ): Promise<SignInPoll> {
    this.ctx.requireService("identity", Feature.identityDevicecode);
    const body: Record<string, unknown> = {
      deviceCode: prompt.deviceCode,
      deviceId: this.ctx.deviceId,
    };
    if (optIn.confirmIdentity) body.confirmIdentity = true;
    if (typeof optIn.attachLicense === "boolean")
      body.attachLicense = optIn.attachLicense;
    // The attach names the licence by the device's own bearer; an ordinary poll sends none.
    const token =
      optIn.confirmIdentity || typeof optIn.attachLicense === "boolean"
        ? this.tokens.current
        : null;
    const res = await this.post(
      "identity/auth/device/poll",
      body,
      token ? { authorization: `Bearer ${token}` } : {},
    );
    if (res.status >= 500) {
      throw new PolarisError(
        "server-error",
        `device sign-in poll failed with status ${res.status}.`,
      );
    }
    const answer = (await res.json().catch(() => ({}))) as {
      status?: unknown;
      interval?: unknown;
      token?: unknown;
      identity?: unknown;
      attachable?: unknown;
      attached?: unknown;
    };
    if (res.status === 429) {
      // The Worker's own `slow_down` carries the interval; a rate limiter in front of it may
      // answer 429 without one, which RFC 8628 §3.5 treats the same way.
      return {
        status: "slow-down",
        interval: isSeconds(answer.interval)
          ? wholeSeconds(answer.interval)
          : current + SLOW_DOWN_STEP_SECONDS,
      };
    }
    if (res.status !== 200) {
      return {
        status: "error",
        message: `device sign-in poll refused (status ${res.status}).`,
      };
    }
    const identity = shown(answer.identity);
    switch (answer.status) {
      case "pending":
        return { status: "pending" };
      case "timeout":
        return { status: "expired" };
      case "confirm":
        return {
          status: "confirm",
          identity: identity ?? {},
          attachable: answer.attachable === true,
        };
      case "ready": {
        if (!isString(answer.token))
          return { status: "error", message: "ready without a token." };
        await this.tokens.set(answer.token, "signin");
        if (identity)
          await writeJson(this.identityFile, {
            ...identity,
            signedInAt: this.ctx.now(),
          }).catch(() => undefined);
        else await this.forget();
        await this.onAcquired();
        const attached =
          answer.attached === "claimed" || answer.attached === "migrated"
            ? answer.attached
            : undefined;
        return {
          status: "ready",
          ...(identity ? { identity } : {}),
          ...(attached ? { attached } : {}),
        };
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
    this.ctx.requireService("identity", Feature.identityDevicecode);
    const { signal } = opts;
    let interval = prompt.interval;
    // The attach opt-in: hold at the identity first, then send the player's decision.
    let optIn: AttachOptIn = opts.confirm ? { confirmIdentity: true } : {};
    for (;;) {
      signal?.throwIfAborted();
      if (this.ctx.now() >= prompt.expiresAt) return { status: "expired" };
      await sleep(pollDelay(interval, prompt.expiresIn), signal);
      if (this.ctx.now() >= prompt.expiresAt) return { status: "expired" };
      let poll: SignInPoll;
      try {
        poll = await this.poll(prompt, interval, optIn);
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
        case "confirm": {
          const attach = opts.confirm
            ? await opts.confirm(poll.identity, poll.attachable)
            : false;
          optIn = { attachLicense: attach && poll.attachable };
          continue;
        }
        default:
          return poll;
      }
    }
  }

  private async post(
    path: string,
    body: unknown,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const f = this.ctx.fetcher();
    try {
      return await f(this.ctx.url(path), {
        method: "POST",
        headers: this.ctx.headers({
          "content-type": "application/json",
          ...extra,
        }),
        body: JSON.stringify(body),
        signal: this.ctx.deadline(),
      });
    } catch (e) {
      throw new PolarisError("network-error", (e as Error).message);
    }
  }
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
