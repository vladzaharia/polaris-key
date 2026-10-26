// The authorization-code redirect core (I-08 WIRE-CONTRACT-V4 §12.4, §12.5; I-10a.7): everything
// an SDK does around the browser hop, with no I/O of its own.
//
//   1. `startRedirect`    S256 PKCE, the `state`, and the authorize URL the host opens.
//   2. `checkCallback`    the redirect back to the app: `state`, then `iss` (RFC 9207), then
//                         `error`, then `code`. A refusal here never reaches the token endpoint.
//   3. `tokenForm`        the form body of `POST /<p>/identity/token`.
//   4. `parseTokenAnswer` the answer: a token response, `choose` (by its `status` member alone),
//                         or a refusal carrying the Worker's OAuth `error`.
//
// It is the one implementation Node and React share, and its test vectors
// (`test/identityRedirect.test.ts`) are the ones the Python, Swift, Kotlin and Godot redirect
// cores port. It is additive: it touches nothing on the signed verify / trust / gate / clock floor.
//
// Safety rules the SDK layer relies on:
//   - S256 only. There is no `plain` path and no option to send one.
//   - `state` and the verifier are 32 random bytes each unless a test injects them; the verifier
//     is returned to the caller, which keeps it for ONE `checkCallback` + token request and then
//     drops it (`RedirectPending` is single-use by contract: the SDK clears it on first use).
//   - The verifier, the code and the token are never put in a URL or a log by this module; the
//     authorize URL carries only the challenge.

import { base64UrlEncodeBytes, sha256Base64Url } from "@polaris-key/jws";
import {
  AUTHORIZE_STATE_MAX,
  AUTHORIZE_STATE_MIN,
  CHOICE_GRANT_PATTERN,
  type AuthorizeLicenseChoice,
  type AuthorizePurpose,
} from "@polaris-key/protocol/identity";
import { PolarisError } from "./errors.js";
import { manageFormEncode } from "./manage.js";

/** RFC 7636 §4.1: the verifier is 43 to 128 characters of `A-Z a-z 0-9 - . _ ~`. */
export const PKCE_VERIFIER_MIN = 43;
export const PKCE_VERIFIER_MAX = 128;
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]+$/;
/** `state` is any printable ASCII of the §12.4 length (no space, no control). */
const STATE_PATTERN = /^[\x21-\x7e]+$/;

/** The scope a sign-in asks for when the host names none (§12.4: a subset of `profile email
 *  cloudSync`; `openid` is `invalid_scope` until I-21). */
export const DEFAULT_REDIRECT_SCOPE = "profile email";

/** Random bytes. Default `crypto.getRandomValues`; a test injects a fixed source. */
export type RandomBytes = (length: number) => Uint8Array;

function defaultRandom(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** A fresh PKCE verifier: 32 random bytes, 43 base64url characters. */
export function generateCodeVerifier(
  random: RandomBytes = defaultRandom,
): string {
  return base64UrlEncodeBytes(random(32));
}

/** A fresh `state`: 32 random bytes, 43 base64url characters. */
export function generateState(random: RandomBytes = defaultRandom): string {
  return base64UrlEncodeBytes(random(32));
}

/** The S256 challenge: `base64url(SHA-256(ASCII(verifier)))`, unpadded (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string): Promise<string> {
  return sha256Base64Url(new TextEncoder().encode(verifier));
}

export interface StartRedirectOptions {
  /** `identity.endpoints.authorize` from discovery. Never built by the SDK. */
  authorizeEndpoint: string;
  /** `identity.endpoints.token` from discovery. */
  tokenEndpoint: string;
  /** Discovery's `identity.issuer`: the `iss` the callback must carry (RFC 9207). */
  issuer: string;
  /** The product slug (the one public client per product, I-08). */
  clientId: string;
  /** The host's registered `https:` redirect URI. */
  redirectUri: string;
  /** Space-delimited scope, or a list; default {@link DEFAULT_REDIRECT_SCOPE}. */
  scope?: string | readonly string[];
  loginHint?: string;
  nameHint?: string;
  purpose?: AuthorizePurpose;
  /** `"app"` asks the Worker to hand the licence choice back to the app (I-08b). Sent only when
   *  `choiceAvailable` (discovery has the `choice*` endpoints); otherwise the card chooses and
   *  nothing is sent. */
  licenseChoice?: AuthorizeLicenseChoice;
  choiceAvailable?: boolean;
  /** Test hooks: the entropy, or the exact `state` and verifier of a recorded conversation. */
  random?: RandomBytes;
  state?: string;
  codeVerifier?: string;
}

/**
 * One pending redirect sign-in. The SDK holds it between the navigation and the callback, uses
 * it for ONE `checkCallback` (and one token request), then drops it. `codeVerifier` is a secret:
 * never log it, never put it in a URL.
 */
export interface RedirectPending {
  /** The URL to open in the browser. Carries the challenge, never the verifier. */
  authorizeUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  issuer: string;
  tokenEndpoint: string;
}

function invalid(message: string): PolarisError {
  return new PolarisError("invalid-argument", message);
}

/** The shared rule for a host-supplied redirect URI: absolute `https:`, no userinfo, no
 *  fragment, no whitespace or control characters. (Loopback, scheme and claimed-HTTPS URIs are
 *  I-15's.) */
export function isRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048)
    return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(raw)) return false;
  const m = /^https:\/\/([^/?#]*)([^#]*)$/.exec(raw);
  if (!m || m[1] === "" || m[1]!.includes("@")) return false;
  return !raw.includes("#");
}

function scopeString(scope: string | readonly string[] | undefined): string {
  if (scope === undefined) return DEFAULT_REDIRECT_SCOPE;
  const text = typeof scope === "string" ? scope : scope.join(" ");
  const parts = text.split(" ").filter((p) => p !== "");
  if (parts.length === 0 || parts.some((p) => !/^[\x21-\x7e]+$/.test(p)))
    throw invalid("scope must be a space-delimited list of printable scopes.");
  return parts.join(" ");
}

/**
 * Build the authorize request. Query order is fixed so every SDK emits the same bytes:
 * `response_type client_id redirect_uri state code_challenge code_challenge_method scope
 * [login_hint] [name_hint] [purpose] [license_choice]`, each value form-encoded by
 * `manageFormEncode` (space as `+`). A hint that is empty is not sent; a hint is sent verbatim
 * (the Worker normalises, and drops a login hint that is not an email).
 */
export async function startRedirect(
  opts: StartRedirectOptions,
): Promise<RedirectPending> {
  if (!isRedirectUri(opts.redirectUri))
    throw invalid(
      "redirectUri must be an absolute https URL with no fragment.",
    );
  for (const [name, value] of [
    ["authorize", opts.authorizeEndpoint],
    ["token", opts.tokenEndpoint],
  ] as const)
    if (typeof value !== "string" || !/^https?:\/\/[^\s]+$/.test(value))
      throw invalid(`the ${name} endpoint is not an absolute URL.`);
  if (typeof opts.issuer !== "string" || opts.issuer === "")
    throw invalid("discovery names no issuer.");
  if (typeof opts.clientId !== "string" || opts.clientId === "")
    throw invalid("clientId is empty.");
  const random = opts.random ?? defaultRandom;
  const state = opts.state ?? generateState(random);
  if (
    state.length < AUTHORIZE_STATE_MIN ||
    state.length > AUTHORIZE_STATE_MAX ||
    !STATE_PATTERN.test(state)
  )
    throw invalid("state must be 16 to 512 printable characters.");
  const codeVerifier = opts.codeVerifier ?? generateCodeVerifier(random);
  if (
    codeVerifier.length < PKCE_VERIFIER_MIN ||
    codeVerifier.length > PKCE_VERIFIER_MAX ||
    !VERIFIER_PATTERN.test(codeVerifier)
  )
    throw invalid("the PKCE verifier must be 43 to 128 unreserved characters.");

  const pairs: [string, string][] = [
    ["response_type", "code"],
    ["client_id", opts.clientId],
    ["redirect_uri", opts.redirectUri],
    ["state", state],
    ["code_challenge", await pkceChallenge(codeVerifier)],
    ["code_challenge_method", "S256"],
    ["scope", scopeString(opts.scope)],
  ];
  if (opts.loginHint) pairs.push(["login_hint", opts.loginHint]);
  if (opts.nameHint) pairs.push(["name_hint", opts.nameHint]);
  if (opts.purpose) pairs.push(["purpose", opts.purpose]);
  if (opts.licenseChoice === "app" && opts.choiceAvailable === true)
    pairs.push(["license_choice", "app"]);
  const query = formBody(pairs);
  const base = opts.authorizeEndpoint;
  return {
    authorizeUrl: `${base}${base.includes("?") ? "&" : "?"}${query}`,
    state,
    codeVerifier,
    redirectUri: opts.redirectUri,
    clientId: opts.clientId,
    issuer: opts.issuer,
    tokenEndpoint: opts.tokenEndpoint,
  };
}

function formBody(pairs: readonly (readonly [string, string])[]): string {
  return pairs
    .map(([k, v]) => `${manageFormEncode(k)}=${manageFormEncode(v)}`)
    .join("&");
}

/** Why a callback was refused before any token request. The strings are the shared vector
 *  vocabulary; every SDK reports the same one for the same URL. */
export type CallbackFailure =
  | "malformed" // not an absolute URL, or a repeated parameter
  | "redirect-mismatch" // the callback is not at the redirect URI the request named
  | "state-mismatch" // `state` absent or not this request's
  | "issuer-mismatch" // `iss` absent or not the discovery issuer (RFC 9207)
  | "authorization-error" // `error` other than `access_denied`
  | "missing-code";

export type CallbackResult =
  /** The code to redeem. */
  | { kind: "code"; code: string }
  /** The person pressed Cancel on the card (`error=access_denied`). */
  | { kind: "cancelled" }
  /** Anything else: `code` is the registry's `sign-in-failed`; `error` is the callback's own
   *  `error` value when it carried one. */
  | {
      kind: "failed";
      code: "sign-in-failed";
      reason: CallbackFailure;
      error?: string;
    };

function fail(reason: CallbackFailure, error?: string): CallbackResult {
  return {
    kind: "failed",
    code: "sign-in-failed",
    reason,
    ...(error !== undefined ? { error } : {}),
  };
}

/** The query pairs of `url` (before any `#`), raw and un-decoded names compared decoded; `null`
 *  when a name repeats. A `+` is a space. */
function queryOf(url: string): Map<string, string> | null {
  const q = url.indexOf("?");
  if (q === -1) return new Map();
  const end = url.indexOf("#");
  const text = url.slice(q + 1, end === -1 ? undefined : end);
  const out = new Map<string, string>();
  for (const part of text.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const raw = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, " "));
      } catch {
        return null;
      }
    };
    const name = raw(eq === -1 ? part : part.slice(0, eq));
    const value = raw(eq === -1 ? "" : part.slice(eq + 1));
    if (name === null || value === null || out.has(name)) return null;
    out.set(name, value);
  }
  return out;
}

/** `scheme://authority/path`, lower-cased scheme and host, no query or fragment. */
function originPath(url: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(url);
  if (!m) return null;
  return `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}${m[3]}`;
}

/**
 * Check the redirect back to the app. The order is fixed and the first failure wins:
 * the callback is at the redirect URI; no parameter repeats; `state` is this request's; `iss` is
 * the discovery issuer (a callback with no `iss` is refused: the Worker always sends it); then
 * `error` (`access_denied` is `cancelled`, any other is `failed`); then `code`.
 *
 * Pure: the caller drops the pending request after the first call, whatever the result.
 */
export function checkCallback(
  pending: Pick<RedirectPending, "state" | "redirectUri" | "issuer">,
  callbackUrl: string,
): CallbackResult {
  if (typeof callbackUrl !== "string") return fail("malformed");
  const got = originPath(callbackUrl);
  const want = originPath(pending.redirectUri);
  if (got === null || want === null) return fail("malformed");
  if (got !== want) return fail("redirect-mismatch");
  const q = queryOf(callbackUrl);
  if (q === null) return fail("malformed");
  if (q.get("state") !== pending.state) return fail("state-mismatch");
  if (q.get("iss") !== pending.issuer) return fail("issuer-mismatch");
  const error = q.get("error");
  if (error !== undefined)
    return error === "access_denied"
      ? { kind: "cancelled" }
      : fail("authorization-error", error);
  const code = q.get("code");
  if (code === undefined || code === "") return fail("missing-code");
  return { kind: "code", code };
}

/** The `Content-Type` of the token request. */
export const TOKEN_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** The form body of `POST /<p>/identity/token` (§12.5). Member order is fixed:
 *  `grant_type client_id code code_verifier redirect_uri [device_name]`. */
export function tokenForm(
  pending: Pick<RedirectPending, "clientId" | "codeVerifier" | "redirectUri">,
  code: string,
  deviceName?: string,
): string {
  const pairs: [string, string][] = [
    ["grant_type", "authorization_code"],
    ["client_id", pending.clientId],
    ["code", code],
    ["code_verifier", pending.codeVerifier],
    ["redirect_uri", pending.redirectUri],
  ];
  if (deviceName) pairs.push(["device_name", deviceName]);
  return formBody(pairs);
}

export type TokenAnswer =
  /** `200` with an `access_token`: the activation response under its OAuth names. */
  | {
      kind: "token";
      accessToken: string;
      scope: string;
      subject: string;
      schemaVersion: number;
      device: Record<string, unknown>;
      license: Record<string, unknown> | null;
    }
  /** `200` with `status: "choose"` (I-08b): the app shows the licence choice, then calls
   *  `choice/complete` with `grant`. */
  | {
      kind: "choose";
      grant: string;
      expiresIn: number;
      choices: Record<string, unknown>;
    }
  /** The Worker refused: `error` is its flat OAuth / Polaris code (`invalid_grant`, `rate_limited`
   *  …), `retryAfterSeconds` when it named one. A 5xx or a body with no `error` is
   *  `server_error`. */
  | {
      kind: "refused";
      error: string;
      status: number;
      retryAfterSeconds?: number;
    }
  /** A `200` that is neither of the above, or lacks a member the call needs. */
  | { kind: "malformed" };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Read the token endpoint's answer. `choose` is decided by the `status` member alone, never by
 *  the absence of `access_token`. */
export function parseTokenAnswer(status: number, body: unknown): TokenAnswer {
  if (status !== 200) {
    const b = isRecord(body) ? body : {};
    const error =
      typeof b.error === "string" && b.error !== "" ? b.error : "server_error";
    const retry = b.retryAfter;
    return {
      kind: "refused",
      error,
      status,
      ...(typeof retry === "number" && Number.isFinite(retry) && retry > 0
        ? { retryAfterSeconds: Math.ceil(retry) }
        : {}),
    };
  }
  if (!isRecord(body)) return { kind: "malformed" };
  if (body.status === "choose") {
    const { grant, expiresIn, choices } = body;
    if (
      typeof grant !== "string" ||
      !new RegExp(CHOICE_GRANT_PATTERN).test(grant) ||
      typeof expiresIn !== "number" ||
      !isRecord(choices)
    )
      return { kind: "malformed" };
    return { kind: "choose", grant, expiresIn, choices };
  }
  const { access_token, scope, subject, schemaVersion, device, license } = body;
  if (
    typeof access_token !== "string" ||
    access_token === "" ||
    typeof scope !== "string" ||
    typeof subject !== "string" ||
    subject === "" ||
    !isRecord(device) ||
    (license !== null && !isRecord(license))
  )
    return { kind: "malformed" };
  return {
    kind: "token",
    accessToken: access_token,
    scope,
    subject,
    schemaVersion: typeof schemaVersion === "number" ? schemaVersion : 1,
    device,
    license: license as Record<string, unknown> | null,
  };
}
