// Native redirect sign-in (I-15b.2; WIRE-CONTRACT-V5 §12.12; SIGN-IN §3.17):
// `identity.signIn.start({channel: "redirect"})` with no `redirectUri`. The app pushes its
// request, opens `authorize?client_id&request_uri` in the system browser and takes the redirect
// back on a loopback listener (or, for a registered scheme, from the host's `handleRedirect`).
//
// The rules live in client-core's `redirect.ts`; this file is the Node half: the listener, the
// browser, the HTTP and the stored device token.
//
//   1. bind the listener first (127.0.0.1, an OS-assigned port) and keep the socket until the
//      callback, a cancel or the request's life ends, so no other process can take the port the
//      pushed `redirect_uri` names;
//   2. push the request with the pusher's device header; open the authorize URL;
//   3. one `GET /pkey/callback` whose `Host` is `127.0.0.1:<port>` and whose `state` matches is
//      taken; the browser is answered `303` to the return page; the listener closes;
//   4. the code is redeemed from this device (`X-PKey-Device`) with the PKCE verifier.
//
// A session is single use. No code, verifier or token is written to a log or a URL here.

import http from "node:http";
import {
  NATIVE_REDIRECT_PATH,
  type AuthorizeLicenseChoice,
  type AuthorizePurpose,
  type NativeRedirectClass,
  type NativeRedirectDiscovery,
} from "@polaris-key/protocol/identity";
import {
  PolarisError,
  chooseRedirectClass,
  closeNativeSession,
  constantTimeEqual,
  nativeRedirectUri,
  nativeTokenRequest,
  parseNativeCallback,
  parsePushedAnswer,
  pushRequest,
  reopen,
  startNativeSession,
  type NativePending,
  type NativeSession,
  type PushedAnswer,
} from "@polaris-key/client-core";
import { ErrorCode, Feature } from "../constants.generated.js";
import { printAs } from "../core/redact.js";
import {
  redeemCode,
  type RedirectDeps,
  type RedirectOutcome,
} from "./redirect.js";

/** What `signIn.start({channel: "redirect"})` takes when the host has no `redirectUri` of its
 *  own: the redirect is the loopback listener, or a scheme the host registered. */
export interface NativeRedirectSignInOptions {
  channel: "redirect";
  /** Absent: this is the native redirect. (A string is the web redirect, redirect.ts.) */
  redirectUri?: undefined;
  /** Default `profile email`. */
  scope?: string | readonly string[];
  loginHint?: string;
  nameHint?: string;
  purpose?: AuthorizePurpose;
  licenseChoice?: AuthorizeLicenseChoice;
  /** The device label (§12.7.1, D-73), else the client's default. */
  deviceName?: string;
  keyReturn?: boolean;
  /** Full redirect URIs (`<scheme>:/pkey/callback`) this build has registered with the OS. The
   *  loopback listener is tried first; a scheme is used when no listener can be bound. The host
   *  hands the URL the OS delivered to {@link NativeRedirectSession.handleRedirect}. */
  registeredSchemes?: readonly string[];
  /** A registered scheme's redirect URI for "Return to <App>" (never carries a code). */
  returnUri?: string;
  /** `false`: never bind a listener (a host that delivers the redirect itself). Default true. */
  loopback?: boolean;
  /** The host's browser opener (Electron main: `shell.openExternal`). With it the headless rule
   *  (D-68) is not applied: the host knows whether it can show a window. */
  openUrl?: (url: string) => Promise<boolean> | boolean;
}

/** How a native sign-in ended: a redirect outcome, or the pushed request lapsed (begin again). */
export type NativeRedirectOutcome = RedirectOutcome | { kind: "expired" };

// --- the listener -----------------------------------------------------------------------------

/** What the session arms the listener with once the request is pushed. */
export interface ListenerArming {
  pending: Pick<NativePending, "state" | "issuer" | "redirectUri">;
  /** Discovery's `signinReturn`: where the browser is sent after the callback. */
  signinReturn: string | undefined;
  /** Called once, with the callback URL, after the browser was answered. */
  onCallback: (url: string) => void;
}

/** A bound loopback listener. Until armed it answers `404` to everything. */
export interface CallbackListener {
  readonly port: number;
  arm(arming: ListenerArming): void;
  close(): void;
}

const SOCKET_LIMIT = 8;

function reply(
  res: http.ServerResponse,
  status: number,
  extra: Record<string, string> = {},
): void {
  // No body, no CORS, never cached; the connection is not kept.
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": "0",
    connection: "close",
    ...extra,
  });
  res.end();
}

/** The `303` target: the return page with the card's handle (`&cancelled=1` after Cancel). */
function returnLocation(
  signinReturn: string | undefined,
  request: string,
  cancelled: boolean,
): string | null {
  if (signinReturn === undefined) return null;
  try {
    const u = new URL(signinReturn);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.searchParams.set("request", request);
    if (cancelled) u.searchParams.set("cancelled", "1");
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Bind `127.0.0.1` on an OS-assigned port (never `localhost`, never another interface). The
 * listener takes ONE callback: `GET /pkey/callback` with `Host: 127.0.0.1:<port>` and a `state`
 * that matches (constant time). Anything else is `404` and the listener keeps waiting, so a
 * stray request cannot end the sign-in. A callback that matches `state` but fails the checks of
 * `parseNativeCallback` (`iss`, a stray parameter, no `request=`) is answered `400` and
 * delivered, so the session reports the failure.
 */
export function bindLoopbackListener(): Promise<CallbackListener> {
  return new Promise((resolve, reject) => {
    let armed: ListenerArming | null = null;
    let finished = false;
    let port = 0;
    const server = http.createServer((req, res) => {
      const a = armed;
      const target = req.url ?? "";
      const q = target.indexOf("?");
      const path = q === -1 ? target : target.slice(0, q);
      if (
        a === null ||
        finished ||
        req.method !== "GET" ||
        req.headers.host !== `127.0.0.1:${port}` ||
        path !== NATIVE_REDIRECT_PATH ||
        // A browser navigation only: a page loading it as an image, script or frame is not
        // the redirect back.
        (req.headers["sec-fetch-mode"] !== undefined &&
          req.headers["sec-fetch-mode"] !== "navigate") ||
        (req.headers["sec-fetch-dest"] !== undefined &&
          req.headers["sec-fetch-dest"] !== "document")
      )
        return reply(res, 404);
      const params = new URLSearchParams(q === -1 ? "" : target.slice(q + 1));
      const states = params.getAll("state");
      if (
        states.length !== 1 ||
        !constantTimeEqual(states[0]!, a.pending.state)
      )
        return reply(res, 404);
      const url = `http://127.0.0.1:${port}${target}`;
      const checked = parseNativeCallback(a.pending, url);
      finished = true;
      const done = (): void => {
        server.close();
        server.closeAllConnections();
        a.onCallback(url);
      };
      if (checked.kind === "failed") {
        res.writeHead(400, {
          "cache-control": "no-store",
          "content-length": "0",
          connection: "close",
          "referrer-policy": "no-referrer",
        });
        res.end(done);
        return;
      }
      const where =
        checked.request !== undefined
          ? returnLocation(
              a.signinReturn,
              checked.request,
              checked.kind === "cancelled",
            )
          : null;
      res.writeHead(where !== null ? 303 : 204, {
        "cache-control": "no-store",
        "content-length": "0",
        connection: "close",
        "referrer-policy": "no-referrer",
        ...(where !== null ? { location: where } : {}),
      });
      res.end(done);
    });
    // A slow or idle client cannot hold the port open past the request's life.
    server.maxConnections = SOCKET_LIMIT;
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.keepAliveTimeout = 1;
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string" || addr.port < 1) {
        server.close();
        return reject(new Error("no loopback port"));
      }
      port = addr.port;
      // After listening, an error (a reset socket) must not take the process down.
      server.on("error", () => undefined);
      resolve({
        port,
        arm(arming) {
          armed ??= arming;
        },
        close() {
          finished = true;
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

// --- the headless rule (SIGN-IN D-68) ---------------------------------------------------------

/** No browser can be shown: an SSH session, CI, or Linux with no display. */
export function isHeadless(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.CI) return true;
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

// --- the session ------------------------------------------------------------------------------

/** What the native session needs from the identity client. */
export interface NativeRedirectDeps extends RedirectDeps {
  /** The default browser opener. */
  openUrl: (url: string) => Promise<boolean>;
  /** The environment the headless rule reads. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Conformance replay only: a stand-in listener, and the answer of an already recorded push
   *  (no request is sent). */
  replay?: {
    listen?: () => Promise<CallbackListener>;
    pushed?: Extract<PushedAnswer, { kind: "pushed" }>;
  };
}

function unavailable(message: string): PolarisError {
  return new PolarisError(ErrorCode.redirectUnavailable, message);
}

export class NativeRedirectSession {
  readonly channel = "redirect" as const;
  /** `loopback` or `scheme`. */
  readonly redirectClass: NativeRedirectClass;
  /** Open this in the browser (the session already did). Never the verifier or the code. */
  readonly authorizeUrl: string;
  /** Epoch seconds after which the pushed request is gone. */
  readonly expiresAt: number;
  /** The device label the sign-in page shows (§12.7.1, D-73), or null. */
  readonly deviceName: string | null;
  #pending: NativePending | null;
  readonly #session: NativeSession;
  readonly #deps: NativeRedirectDeps;
  readonly #open: (url: string) => Promise<boolean>;
  readonly #listener: CallbackListener | null;
  readonly #timer: ReturnType<typeof setTimeout>;
  #used = false;
  #resolve!: (o: NativeRedirectOutcome) => void;
  #reject!: (e: unknown) => void;
  readonly #done: Promise<NativeRedirectOutcome>;

  constructor(init: {
    pending: NativePending;
    session: NativeSession;
    listener: CallbackListener | null;
    deviceName: string | null;
    deps: NativeRedirectDeps;
    open: (url: string) => Promise<boolean>;
    signinReturn: string | undefined;
  }) {
    this.redirectClass = init.pending.redirectClass;
    this.authorizeUrl = init.session.authorizeUrl;
    this.expiresAt = Math.floor(init.session.expiresAtMs / 1000);
    this.deviceName = init.deviceName;
    this.#pending = init.pending;
    this.#session = init.session;
    this.#deps = init.deps;
    this.#open = init.open;
    this.#listener = init.listener;
    this.#done = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // A result nobody waits for is not an unhandled rejection.
    this.#done.catch(() => undefined);
    this.#timer = setTimeout(
      () => this.#end({ kind: "expired" }),
      Math.max(0, init.session.expiresAtMs - Date.now()),
    );
    this.#timer.unref?.();
    init.listener?.arm({
      pending: init.pending,
      signinReturn: init.signinReturn,
      onCallback: (url) => void this.handleRedirect(url).catch(() => undefined),
    });
    printAs(this, () => ({
      channel: this.channel,
      redirectClass: this.redirectClass,
      expiresAt: this.expiresAt,
      deviceName: this.deviceName,
    }));
  }

  /** SIGN-IN §3.17 "Open browser again": the SAME authorize URL, no new push. False when the
   *  request lapsed or was finished, or no opener ran. */
  async reopen(): Promise<boolean> {
    const r = reopen(this.#session, Date.now());
    if (r.kind !== "open") return false;
    return this.#open(r.url).catch(() => false);
  }

  /** Stop: the listener closes, the pending request is dropped and `wait()` answers `cancelled`. */
  cancel(): void {
    this.#end({ kind: "cancelled" });
  }

  /** Settle without a redirect (Cancel, or the request lapsed). A finished session ignores it. */
  #end(outcome: NativeRedirectOutcome): void {
    if (this.#used) return;
    this.#used = true;
    this.#drop();
    this.#resolve(outcome);
  }

  #drop(): void {
    this.#pending = null;
    clearTimeout(this.#timer);
    this.#listener?.close();
    closeNativeSession(this.#session);
  }

  /** Wait for the redirect back (the listener's, or `handleRedirect`'s) and its redemption. */
  wait(opts: { signal?: AbortSignal } = {}): Promise<NativeRedirectOutcome> {
    const { signal } = opts;
    if (signal === undefined) return this.#done;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#done.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  /**
   * Take the redirect back to the app: the URL the OS delivered for a registered scheme (the
   * loopback listener calls this itself). Checks `state` and `iss` first (a mismatch is
   * `sign-in-failed`, nothing sent), then redeems the code from this device. ONE use: a second
   * call, after a cancel, or once the request lapsed is refused locally without a request.
   */
  async handleRedirect(callbackUrl: string): Promise<NativeRedirectOutcome> {
    const pending = this.#pending;
    if (this.#used || pending === null)
      throw new PolarisError(
        ErrorCode.signInFailed,
        "this sign-in is already finished or was cancelled; start a new one.",
      );
    // A delivery that is not ours (malformed, another redirect URI, another state) is refused
    // without ending the sign-in: anything able to open the app's scheme could otherwise end it.
    const first = parseNativeCallback(pending, callbackUrl);
    if (
      first.kind === "failed" &&
      (first.reason === "malformed" ||
        first.reason === "redirect-mismatch" ||
        first.reason === "state-mismatch")
    )
      throw new PolarisError(
        ErrorCode.signInFailed,
        `the delivered URL was refused (${first.reason}).`,
      );
    this.#used = true;
    this.#drop();
    try {
      const outcome = await this.#redeem(pending, callbackUrl);
      this.#resolve(outcome);
      return outcome;
    } catch (e) {
      this.#reject(e);
      throw e;
    }
  }

  async #redeem(
    pending: NativePending,
    callbackUrl: string,
  ): Promise<RedirectOutcome> {
    const checked = parseNativeCallback(pending, callbackUrl);
    if (checked.kind === "cancelled") return { kind: "cancelled" };
    if (checked.kind === "failed")
      throw new PolarisError(
        ErrorCode.signInFailed,
        `the sign-in redirect was refused (${checked.reason}).`,
      );
    const req = nativeTokenRequest(
      pending,
      checked.code,
      this.#deps.ctx.deviceId,
      this.deviceName ?? undefined,
    );
    // `ctx.headers` already carries `X-PKey-Device`: the device that pushed the request.
    return redeemCode(
      this.#deps,
      {
        tokenEndpoint: pending.tokenEndpoint,
        keyReturn: pending.keyReturn === true,
      },
      req.body,
      {},
    );
  }
}

/**
 * Begin a native redirect sign-in. Refuses before any request when the product does not run
 * Identity (`service-unavailable`) or its discovery serves no `authorize`, `token` or `issuer`
 * (`sign-in-unavailable`). `redirect-unavailable` when no class can be used here (no
 * `request` endpoint, a headless host, no listener and no registered scheme) or no browser opened:
 * the kit then offers a code.
 */
export async function startNativeRedirectSignIn(
  deps: NativeRedirectDeps,
  opts: NativeRedirectSignInOptions,
): Promise<NativeRedirectSession> {
  const { ctx } = deps;
  ctx.requireService("identity", Feature.identityRedirectNative);
  const doc = await deps.discovery();
  const fragment = doc?.services?.identity as
    | {
        issuer?: unknown;
        endpoints?: Record<string, unknown>;
        nativeRedirect?: NativeRedirectDiscovery;
      }
    | undefined;
  const endpoints = fragment?.endpoints ?? {};
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v : undefined;
  const authorizeEndpoint = str(endpoints.authorize);
  const tokenEndpoint = str(endpoints.token);
  const requestEndpoint = str(endpoints.request);
  const issuer = str(fragment?.issuer);
  if (!authorizeEndpoint || !tokenEndpoint || !issuer)
    throw new PolarisError(
      ErrorCode.signInUnavailable,
      "this product's discovery serves no redirect sign-in.",
    );
  const open = opts.openUrl
    ? async (url: string): Promise<boolean> =>
        (await opts.openUrl!(url)) !== false
    : deps.openUrl;
  // D-68: no browser on this machine. A host with its own opener knows better.
  if (opts.openUrl === undefined && isHeadless(deps.env ?? process.env))
    throw unavailable("no browser can be opened on this machine.");

  // Bind first and keep the socket: the pushed redirect URI names this port.
  const nativeDiscovery = fragment?.nativeRedirect;
  let listener: CallbackListener | null = null;
  if (opts.loopback !== false && nativeDiscovery?.loopback === true) {
    try {
      listener = await (deps.replay?.listen ?? bindLoopbackListener)();
    } catch {
      listener = null;
    }
  }
  const choice = chooseRedirectClass({
    requestEndpoint,
    discovery: nativeDiscovery,
    canListen: listener !== null,
    ...(opts.registeredSchemes !== undefined
      ? { registeredSchemes: opts.registeredSchemes }
      : {}),
  });
  if (choice.kind === "unavailable" || choice.kind === "claimed") {
    listener?.close();
    throw unavailable(
      choice.kind === "unavailable" && choice.reason === "request-not-served"
        ? "this product does not serve native redirect sign-in."
        : "no native redirect can start here.",
    );
  }
  if (choice.kind === "scheme") {
    listener?.close();
    listener = null;
  }
  try {
    const redirectUri =
      choice.kind === "loopback"
        ? nativeRedirectUri("loopback", { port: listener!.port })
        : choice.redirectUri;
    const choiceAvailable = [
      "choiceLicenses",
      "choiceDevices",
      "choiceComplete",
      "choiceCancel",
    ].every((k) => str(endpoints[k]) !== undefined);
    const label = ctx.deviceLabel(opts.deviceName);
    const pushed = await pushRequest({
      requestEndpoint: requestEndpoint!,
      authorizeEndpoint,
      tokenEndpoint,
      issuer,
      clientId: ctx.product,
      redirectUri,
      choiceAvailable,
      ...(label ? { deviceName: label } : {}),
      ...(opts.returnUri !== undefined ? { returnUri: opts.returnUri } : {}),
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts.loginHint !== undefined ? { loginHint: opts.loginHint } : {}),
      ...(opts.nameHint !== undefined ? { nameHint: opts.nameHint } : {}),
      ...(opts.purpose !== undefined ? { purpose: opts.purpose } : {}),
      ...(opts.licenseChoice !== undefined
        ? { licenseChoice: opts.licenseChoice }
        : {}),
      ...(opts.keyReturn === true ? { keyReturn: true } : {}),
      ...(deps.entropy?.state !== undefined
        ? { state: deps.entropy.state }
        : {}),
      ...(deps.entropy?.codeVerifier !== undefined
        ? { codeVerifier: deps.entropy.codeVerifier }
        : {}),
    });
    const answer = deps.replay?.pushed ?? (await post(deps, pushed));
    const session = startNativeSession(pushed.pending, answer, Date.now());
    const native = new NativeRedirectSession({
      pending: pushed.pending,
      session,
      listener,
      deviceName: label,
      deps,
      open,
      signinReturn: str(endpoints.signinReturn),
    });
    listener = null; // the session owns it now
    if (!(await open(session.authorizeUrl).catch(() => false))) {
      native.cancel();
      throw unavailable("no browser could be opened.");
    }
    return native;
  } catch (e) {
    listener?.close();
    throw e;
  }
}

/** `POST request`: the pushed answer, or the Worker's refusal under its own code. */
async function post(
  deps: NativeRedirectDeps,
  pushed: Awaited<ReturnType<typeof pushRequest>>,
): Promise<Extract<PushedAnswer, { kind: "pushed" }>> {
  const res = await deps.ctx.request(
    pushed.url,
    {
      method: "POST",
      headers: deps.ctx.headers({ "content-type": pushed.contentType }),
      body: pushed.body,
    },
    "native redirect request",
  );
  const body: unknown = await res
    .text()
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => null);
  const answer = parsePushedAnswer(res.status, body);
  if (answer.kind === "pushed") return answer;
  if (answer.kind === "malformed")
    throw new PolarisError(
      ErrorCode.badResponse,
      "the request endpoint answered without a pushed request.",
      { status: res.status },
    );
  const retry = res.headers.get("retry-after");
  const retryAfterSeconds =
    answer.retryAfterSeconds ??
    (retry !== null && /^\d+$/.test(retry.trim())
      ? Math.min(Number(retry), 3600)
      : undefined);
  throw new PolarisError(
    answer.status >= 500 ? ErrorCode.serverError : answer.error,
    `the request endpoint refused the sign-in (${answer.error}).`,
    {
      status: answer.status,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(answer.status >= 500 ? { wireCode: answer.error } : {}),
    },
  );
}
