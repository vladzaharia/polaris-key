// The native redirect helpers (WIRE-CONTRACT-V5 §12.12; I-15b.1): everything an SDK does around
// a pushed authorization request, with no I/O of its own. Node, Python, Swift, Kotlin and Godot
// build their loopback listener, scheme or claimed-HTTPS delivery on these shapes.
//
//   1. `chooseRedirectClass`   loopback, then scheme, then claimed HTTPS, else the fallback.
//   2. `nativeRedirectUri`     the redirect URI of a class; `classifyNativeRedirectUri` reads one.
//   3. `pushRequest`           the form body of `POST /<p>/identity/request`, PKCE and state.
//   4. `parsePushedAnswer`     the `201` answer, or the flat refusal.
//   5. `startNativeSession`    the authorize URL (`client_id` + `request_uri` only) and `reopen`.
//   6. `parseNativeCallback`   the redirect back: iss, state, code (and `request=` on loopback);
//                              any other parameter is refused.
//   7. `nativeTokenRequest`    the token request, with the `X-PKey-Device` header.
//
// Safety rules the SDK layer relies on (same as identityRedirect.ts): S256 only; the verifier,
// the code and the token are never put in a URL or a log by this module; a pending request is
// used for ONE callback check and one token request, then dropped.

import type {
  AuthorizeLicenseChoice,
  AuthorizePurpose,
  NativeRedirectClass,
  NativeRedirectDiscovery,
  PushedRequestResponse,
} from "@polaris-key/protocol/identity";
import {
  AUTHORIZE_STATE_MAX,
  AUTHORIZE_STATE_MIN,
  KEY_RETURN_ALLOW,
  NATIVE_REDIRECT_PATH,
  PUSHED_REQUEST_TTL_SECONDS,
  REQUEST_HANDLE_PATTERN,
  REQUEST_URI_PATTERN,
} from "@polaris-key/protocol/identity";
import { PolarisError } from "./errors.js";
import {
  PKCE_VERIFIER_MAX,
  PKCE_VERIFIER_MIN,
  TOKEN_CONTENT_TYPE,
  formBody,
  generateCodeVerifier,
  generateState,
  pkceChallenge,
  queryOf,
  tokenForm,
  type RandomBytes,
} from "./identityRedirect.js";
import { manageFormEncode } from "./manage.js";

/** The registry's client code for "no native redirect can start here" (`redirect-unavailable`). */
export const REDIRECT_UNAVAILABLE = "redirect-unavailable";

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]+$/;
const PRINTABLE = /^[\x21-\x7e]+$/;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;
/** A URL scheme a native redirect never uses: the web's own. */
const RESERVED_SCHEMES = new Set([
  "http",
  "https",
  "javascript",
  "data",
  "file",
]);

function invalid(message: string): PolarisError {
  return new PolarisError("invalid-argument", message);
}

// --- 1. the class ----------------------------------------------------------------------------

export interface ChooseRedirectClassOptions {
  /** `identity.endpoints.request` from discovery, or absent when the Worker does not serve it. */
  requestEndpoint?: string | undefined;
  /** `identity.nativeRedirect` from discovery. */
  discovery?: NativeRedirectDiscovery | undefined;
  /** The host can bind a loopback listener and open a browser (a desktop host). */
  canListen: boolean;
  /** The redirect URIs (full, `<scheme>:/pkey/callback`) this build has registered with the OS. */
  registeredSchemes?: readonly string[];
  /** The claimed HTTPS redirect URIs (full) this build has associated with the OS. */
  registeredClaimed?: readonly string[];
}

export type RedirectChoice =
  | { kind: "loopback" }
  | { kind: "scheme"; redirectUri: string }
  | { kind: "claimed"; redirectUri: string }
  /** No native class applies: the SDK reports `redirect-unavailable` and the kit offers a code
   *  (device code). `reason` is the shared vector vocabulary. */
  | {
      kind: "unavailable";
      code: typeof REDIRECT_UNAVAILABLE;
      reason: "request-not-served" | "no-class";
    };

/**
 * The order is fixed: loopback (desktop), the registered scheme, claimed HTTPS, else the
 * fallback. A class is used only when discovery lists it AND the host has it; discovery that
 * lacks `request` or `nativeRedirect` is `request-not-served` (device code).
 */
export function chooseRedirectClass(
  opts: ChooseRedirectClassOptions,
): RedirectChoice {
  const d = opts.discovery;
  if (!opts.requestEndpoint || !d)
    return {
      kind: "unavailable",
      code: REDIRECT_UNAVAILABLE,
      reason: "request-not-served",
    };
  if (opts.canListen && d.loopback === true) return { kind: "loopback" };
  const scheme = (opts.registeredSchemes ?? []).find((u) =>
    d.schemes.includes(u),
  );
  if (scheme !== undefined) return { kind: "scheme", redirectUri: scheme };
  const claimed = (opts.registeredClaimed ?? []).find((u) =>
    d.claimedHttps.includes(u),
  );
  if (claimed !== undefined) return { kind: "claimed", redirectUri: claimed };
  return {
    kind: "unavailable",
    code: REDIRECT_UNAVAILABLE,
    reason: "no-class",
  };
}

// --- 2. the redirect URI ----------------------------------------------------------------------

/** The class of a native redirect URI, or `null` when it is none (§12.12: `localhost`, another
 *  path, a query, a fragment, userinfo, port 80 or no port are all refused). */
export function classifyNativeRedirectUri(
  uri: unknown,
): NativeRedirectClass | null {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048)
    return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(uri)) return null;
  const loop = /^http:\/\/(127\.0\.0\.1|\[::1\]):([0-9]{1,5})(\/.*)$/.exec(uri);
  if (loop) {
    const port = Number(loop[2]);
    return port >= 1 &&
      port <= 65535 &&
      port !== 80 &&
      loop[3] === NATIVE_REDIRECT_PATH &&
      !(loop[2]!.length > 1 && loop[2]!.startsWith("0"))
      ? "loopback"
      : null;
  }
  const https = /^https:\/\/([^/?#@]+)(\/[^?#]*)$/.exec(uri);
  if (https && https[2] !== "/") return "claimed";
  const scheme = /^([a-z][a-z0-9+.-]*):(\/[^?#]*)$/.exec(uri);
  if (scheme)
    return !RESERVED_SCHEMES.has(scheme[1]!) &&
      scheme[2] === NATIVE_REDIRECT_PATH
      ? "scheme"
      : null;
  return null;
}

/** The loopback redirect URI for a listener's OS-assigned port. `host` defaults to IPv4. */
export function nativeRedirectUri(
  cls: "loopback",
  opts: { port: number; host?: "127.0.0.1" | "[::1]" },
): string;
/** The redirect URI of a registered scheme: `<scheme>:/pkey/callback`. */
export function nativeRedirectUri(
  cls: "scheme",
  opts: { scheme: string },
): string;
export function nativeRedirectUri(
  cls: "loopback" | "scheme",
  opts: { port?: number; host?: "127.0.0.1" | "[::1]"; scheme?: string },
): string {
  let uri: string;
  if (cls === "loopback") {
    const { port } = opts;
    if (!Number.isInteger(port) || port! < 1 || port! > 65535 || port === 80)
      throw invalid(
        "the loopback port must be an explicit port other than 80.",
      );
    uri = `http://${opts.host ?? "127.0.0.1"}:${port}${NATIVE_REDIRECT_PATH}`;
  } else {
    const scheme = opts.scheme ?? "";
    if (!SCHEME_PATTERN.test(scheme) || RESERVED_SCHEMES.has(scheme))
      throw invalid("the scheme is not a registrable URL scheme.");
    uri = `${scheme}:${NATIVE_REDIRECT_PATH}`;
  }
  if (classifyNativeRedirectUri(uri) !== cls)
    throw invalid("not a native redirect URI.");
  return uri;
}

// --- 3. the pushed request --------------------------------------------------------------------

export interface PushRequestOptions {
  /** `identity.endpoints.request` from discovery. Never built by the SDK. */
  requestEndpoint: string;
  /** `identity.endpoints.authorize`. */
  authorizeEndpoint: string;
  /** `identity.endpoints.token`. */
  tokenEndpoint: string;
  /** Discovery's `identity.issuer`: the `iss` the callback must carry (RFC 9207). */
  issuer: string;
  /** The product slug. */
  clientId: string;
  /** A native redirect URI ({@link nativeRedirectUri}, or a registered full URI). */
  redirectUri: string;
  /** The device label (§12.7.1, D-73). Sent when non-empty. */
  deviceName?: string;
  /** A registered scheme's redirect URI for "Return to <App>". Never carries a code. */
  returnUri?: string;
  /** Space-delimited scope or a list. Omitted from the request when not given (the Worker
   *  defaults it). */
  scope?: string | readonly string[];
  nonce?: string;
  loginHint?: string;
  nameHint?: string;
  purpose?: AuthorizePurpose;
  /** `"app"` is sent only when `choiceAvailable` (I-08b), as in {@link startRedirect}. */
  licenseChoice?: AuthorizeLicenseChoice;
  choiceAvailable?: boolean;
  keyReturn?: boolean;
  /** Test hooks: the entropy, or the exact `state` and verifier of a recorded conversation. */
  random?: RandomBytes;
  state?: string;
  codeVerifier?: string;
}

/** One pending native sign-in. A secret holder: `codeVerifier` is never logged or put in a URL. */
export interface NativePending {
  redirectClass: NativeRedirectClass;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  clientId: string;
  issuer: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  keyReturn?: true;
}

export interface PushedRequest {
  /** `POST` here. */
  url: string;
  /** `Content-Type` of the body. The caller adds `X-PKey-Device` and the SDK headers. */
  contentType: typeof TOKEN_CONTENT_TYPE;
  /** The form body. Member order: `response_type client_id redirect_uri state code_challenge
   *  code_challenge_method [scope] [nonce] [login_hint] [name_hint] [purpose] [license_choice]
   *  [key_return] [device_name] [return_uri]`. */
  body: string;
  pending: NativePending;
}

function scopeText(scope: string | readonly string[]): string {
  const text = typeof scope === "string" ? scope : scope.join(" ");
  const parts = text.split(" ").filter((p) => p !== "");
  if (parts.length === 0 || parts.some((p) => !PRINTABLE.test(p)))
    throw invalid("scope must be a space-delimited list of printable scopes.");
  return parts.join(" ");
}

/** Build the pushed request (§12.12). Nothing here touches the network. */
export async function pushRequest(
  opts: PushRequestOptions,
): Promise<PushedRequest> {
  const redirectClass = classifyNativeRedirectUri(opts.redirectUri);
  if (redirectClass === null)
    throw invalid("redirectUri is not a native redirect URI.");
  if (
    opts.returnUri !== undefined &&
    classifyNativeRedirectUri(opts.returnUri) !== "scheme"
  )
    throw invalid("returnUri must be a registered scheme's redirect URI.");
  for (const [name, value] of [
    ["request", opts.requestEndpoint],
    ["authorize", opts.authorizeEndpoint],
    ["token", opts.tokenEndpoint],
  ] as const)
    if (typeof value !== "string" || !/^https?:\/\/[^\s]+$/.test(value))
      throw invalid(`the ${name} endpoint is not an absolute URL.`);
  if (typeof opts.issuer !== "string" || opts.issuer === "")
    throw invalid("discovery names no issuer.");
  if (typeof opts.clientId !== "string" || opts.clientId === "")
    throw invalid("clientId is empty.");
  const state = opts.state ?? generateState(opts.random);
  if (
    state.length < AUTHORIZE_STATE_MIN ||
    state.length > AUTHORIZE_STATE_MAX ||
    !PRINTABLE.test(state)
  )
    throw invalid("state must be 16 to 512 printable characters.");
  const codeVerifier = opts.codeVerifier ?? generateCodeVerifier(opts.random);
  if (
    codeVerifier.length < PKCE_VERIFIER_MIN ||
    codeVerifier.length > PKCE_VERIFIER_MAX ||
    !VERIFIER_PATTERN.test(codeVerifier)
  )
    throw invalid("the PKCE verifier must be 43 to 128 unreserved characters.");
  if (opts.nonce !== undefined && !PRINTABLE.test(opts.nonce))
    throw invalid("nonce must be printable characters.");

  const pairs: [string, string][] = [
    ["response_type", "code"],
    ["client_id", opts.clientId],
    ["redirect_uri", opts.redirectUri],
    ["state", state],
    ["code_challenge", await pkceChallenge(codeVerifier)],
    ["code_challenge_method", "S256"],
  ];
  if (opts.scope !== undefined) pairs.push(["scope", scopeText(opts.scope)]);
  if (opts.nonce) pairs.push(["nonce", opts.nonce]);
  if (opts.loginHint) pairs.push(["login_hint", opts.loginHint]);
  if (opts.nameHint) pairs.push(["name_hint", opts.nameHint]);
  if (opts.purpose) pairs.push(["purpose", opts.purpose]);
  if (opts.licenseChoice === "app" && opts.choiceAvailable === true)
    pairs.push(["license_choice", "app"]);
  if (opts.keyReturn === true) pairs.push(["key_return", KEY_RETURN_ALLOW]);
  if (opts.deviceName) pairs.push(["device_name", opts.deviceName]);
  if (opts.returnUri) pairs.push(["return_uri", opts.returnUri]);
  return {
    url: opts.requestEndpoint,
    contentType: TOKEN_CONTENT_TYPE,
    body: formBody(pairs),
    pending: {
      redirectClass,
      redirectUri: opts.redirectUri,
      state,
      codeVerifier,
      clientId: opts.clientId,
      issuer: opts.issuer,
      authorizeEndpoint: opts.authorizeEndpoint,
      tokenEndpoint: opts.tokenEndpoint,
      ...(opts.keyReturn === true ? { keyReturn: true as const } : {}),
    },
  };
}

export type PushedAnswer =
  | { kind: "pushed"; requestUri: string; expiresIn: number }
  /** The Worker refused (`invalid_request`, `invalid_client`, `redirect_uri_mismatch`,
   *  `invalid_scope`, `rate_limited`; a 5xx or a body with no `error` is `server_error`). */
  | {
      kind: "refused";
      error: string;
      status: number;
      retryAfterSeconds?: number;
    }
  | { kind: "malformed" };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Read the answer of `POST /<p>/identity/request`: `201 {request_uri, expires_in}`. */
export function parsePushedAnswer(status: number, body: unknown): PushedAnswer {
  if (status !== 201) {
    const b = isRecord(body) ? body : {};
    const retry = b.retryAfter;
    return {
      kind: "refused",
      error:
        typeof b.error === "string" && b.error !== ""
          ? b.error
          : "server_error",
      status,
      ...(typeof retry === "number" && Number.isFinite(retry) && retry > 0
        ? { retryAfterSeconds: Math.min(Math.ceil(retry), 3600) }
        : {}),
    };
  }
  if (!isRecord(body)) return { kind: "malformed" };
  const { request_uri, expires_in } = body as Partial<PushedRequestResponse>;
  if (
    typeof request_uri !== "string" ||
    !new RegExp(REQUEST_URI_PATTERN).test(request_uri) ||
    typeof expires_in !== "number" ||
    !Number.isInteger(expires_in) ||
    expires_in < 1 ||
    expires_in > PUSHED_REQUEST_TTL_SECONDS
  )
    return { kind: "malformed" };
  return { kind: "pushed", requestUri: request_uri, expiresIn: expires_in };
}

// --- 5. the authorize URL and reopen ----------------------------------------------------------

/** `authorize?client_id=<id>&request_uri=<uri>`: the only parameters a pushed request takes. */
export function authorizeUrlFor(
  authorizeEndpoint: string,
  clientId: string,
  requestUri: string,
): string {
  if (!new RegExp(REQUEST_URI_PATTERN).test(requestUri))
    throw invalid("not a pushed request URI.");
  return (
    `${authorizeEndpoint}${authorizeEndpoint.includes("?") ? "&" : "?"}` +
    `client_id=${manageFormEncode(clientId)}&request_uri=${manageFormEncode(requestUri)}`
  );
}

/** A started native sign-in. `reopen` hands back the same URL while the request lives. */
export interface NativeSession {
  readonly authorizeUrl: string;
  /** Epoch milliseconds after which the pushed request is gone (600 s). */
  readonly expiresAtMs: number;
  /** Set by {@link closeNativeSession} once a callback was accepted, or on Cancel. */
  closed: boolean;
}

export function startNativeSession(
  pending: Pick<NativePending, "authorizeEndpoint" | "clientId">,
  answer: Extract<PushedAnswer, { kind: "pushed" }>,
  nowMs: number,
): NativeSession {
  return {
    authorizeUrl: authorizeUrlFor(
      pending.authorizeEndpoint,
      pending.clientId,
      answer.requestUri,
    ),
    expiresAtMs: nowMs + answer.expiresIn * 1000,
    closed: false,
  };
}

export type ReopenResult =
  | { kind: "open"; url: string }
  /** The pushed request lapsed: begin again (`sign-in-expired`). */
  | { kind: "expired" }
  /** Cancelled or already completed: nothing to reopen. */
  | { kind: "closed" };

/** SIGN-IN §3.17 "Open browser again": the SAME authorize URL, no new push, no new state or
 *  verifier. The request stays resolvable until Continue or Cancel takes it (§12.12 Storage). */
export function reopen(session: NativeSession, nowMs: number): ReopenResult {
  if (session.closed) return { kind: "closed" };
  if (nowMs >= session.expiresAtMs) return { kind: "expired" };
  return { kind: "open", url: session.authorizeUrl };
}

export function closeNativeSession(session: NativeSession): void {
  session.closed = true;
}

// --- 6. the redirect back ---------------------------------------------------------------------

export type NativeCallbackFailure =
  | "malformed"
  | "redirect-mismatch"
  | "state-mismatch"
  | "issuer-mismatch"
  | "authorization-error"
  | "missing-code"
  /** A parameter beyond `code state iss request` (or `error error_description …`). */
  | "unexpected-parameter"
  /** Loopback only: `request=` absent or not an `rq_` handle. */
  | "request-invalid";

export type NativeCallbackResult =
  /** `request` is the `rq_` handle, present on a loopback delivery. */
  | { kind: "code"; code: string; request?: string }
  | { kind: "cancelled"; request?: string }
  | {
      kind: "failed";
      code: "sign-in-failed";
      reason: NativeCallbackFailure;
      error?: string;
    };

function fail(
  reason: NativeCallbackFailure,
  error?: string,
): NativeCallbackResult {
  return {
    kind: "failed",
    code: "sign-in-failed",
    reason,
    ...(error !== undefined ? { error } : {}),
  };
}

/** Constant-time string equality (no early exit on the first differing character). */
export function constantTimeEqual(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** `scheme:` + authority lower-cased, path as given. `null` for anything not an absolute URL. */
function baseOf(url: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(\/\/[^/?#]*)?([^?#]*)/.exec(url);
  return m
    ? `${m[1]!.toLowerCase()}:${(m[2] ?? "").toLowerCase()}${m[3]}`
    : null;
}

const SUCCESS_PARAMS = new Set(["code", "state", "iss", "request"]);
const ERROR_PARAMS = new Set([
  "error",
  "error_description",
  "state",
  "iss",
  "request",
]);

/**
 * Check the redirect back to the app. The first failure wins, in this order: absolute URL with no
 * fragment; at the redirect URI the request named; no repeated parameter; `state` (constant
 * time); `iss` (RFC 9207: a callback with no `iss` is refused); `error` (`access_denied` is
 * `cancelled`); `code`; no parameter beyond the set below; on loopback, `request=` an `rq_`
 * handle. The set is `code state iss request` for a code and `error error_description state iss
 * request` for an error; a scheme or claimed delivery has no `request`, and one that carries it
 * must still hold a valid handle.
 */
export function parseNativeCallback(
  pending: Pick<NativePending, "state" | "issuer" | "redirectUri"> &
    Partial<Pick<NativePending, "redirectClass">>,
  callbackUrl: unknown,
): NativeCallbackResult {
  if (typeof callbackUrl !== "string" || callbackUrl.includes("#"))
    return fail("malformed");
  const got = baseOf(callbackUrl);
  const want = baseOf(pending.redirectUri);
  if (got === null || want === null) return fail("malformed");
  if (got !== want) return fail("redirect-mismatch");
  const q = queryOf(callbackUrl);
  if (q === null) return fail("malformed");
  const state = q.get("state");
  if (state === undefined || !constantTimeEqual(state, pending.state))
    return fail("state-mismatch");
  const iss = q.get("iss");
  if (iss === undefined || !constantTimeEqual(iss, pending.issuer))
    return fail("issuer-mismatch");
  const error = q.get("error");
  const code = q.get("code");
  if (error === undefined && (code === undefined || code === ""))
    return fail("missing-code");
  const allowed = error !== undefined ? ERROR_PARAMS : SUCCESS_PARAMS;
  for (const name of q.keys())
    if (!allowed.has(name)) return fail("unexpected-parameter");
  const request = q.get("request");
  const loopback =
    (pending.redirectClass ??
      classifyNativeRedirectUri(pending.redirectUri)) === "loopback";
  if (
    request !== undefined
      ? !new RegExp(REQUEST_HANDLE_PATTERN).test(request)
      : loopback && error === undefined
  )
    return fail("request-invalid");
  const tail = request !== undefined ? { request } : {};
  if (error !== undefined)
    return error === "access_denied"
      ? { kind: "cancelled", ...tail }
      : fail("authorization-error", error);
  return { kind: "code", code: code!, ...tail };
}

// --- 7. the token request ---------------------------------------------------------------------

export interface NativeTokenRequest {
  /** `POST` here. */
  url: string;
  headers: { "X-PKey-Device": string; "Content-Type": string };
  body: string;
}

/**
 * `POST /<p>/identity/token` for a code from a pushed request (§12.5): the form of
 * {@link tokenForm} and the pusher's `X-PKey-Device` (a different device is `invalid_grant`).
 * The caller adds the SDK headers.
 */
export function nativeTokenRequest(
  pending: Pick<
    NativePending,
    "tokenEndpoint" | "clientId" | "codeVerifier" | "redirectUri"
  >,
  code: string,
  deviceId: string,
  deviceName?: string,
): NativeTokenRequest {
  if (typeof deviceId !== "string" || !PRINTABLE.test(deviceId))
    throw invalid("deviceId is empty or not printable.");
  return {
    url: pending.tokenEndpoint,
    headers: { "X-PKey-Device": deviceId, "Content-Type": TOKEN_CONTENT_TYPE },
    body: tokenForm(pending, code, deviceName),
  };
}
