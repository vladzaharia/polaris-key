// The browser half of the platform sign-in exchange (identity.exchange; WIRE-CONTRACT-V5
// §12.11.2-.3): the nonce, the provider's token for it, and the RFC 8693 token exchange with the
// `exchange` device proof. It takes the provider's token as a function of the nonce, so it names
// no provider (the ladder wires FedCM or GIS); it signs through the bearer engine's
// `DeviceKeyPort`, so the private keys never leave the port.
//
// Every answer maps to one outcome, and nothing else:
//   a token              -> stored like any sign-in               `signedIn`
//   200 confirm          -> consent first                         `pendingConsent`
//   200 choose           -> a licence choice is due               `pendingSignIn`
//   403 interstitial     -> sign in the regular way, then link    `needsSignIn` (+ `linkHandle`)
//   404, no discovery    -> the product serves none               `unavailable`
//   any other refusal    -> a typed `PolarisError`
//
// The subject token, the grant and the link handle never reach a log or a message. The grant and
// the handle are non-enumerable on their outcome, so a stringified or logged outcome omits them.
// A nonce is single use: each attempt asks for its own, keeps it in a local, and never retries
// with it, whether the attempt passes or not.

import {
  parseTokenAnswer,
  signDeviceProof,
  TOKEN_CONTENT_TYPE,
  DeviceKeyUnsupportedError,
  type DeviceKeyPort,
} from "@polaris-key/client-core";
import {
  CHOICE_GRANT_PATTERN,
  EXCHANGE_NONCE_PATTERN,
  EXCHANGE_SUBJECT_TOKEN_TYPE,
  LINK_HANDLE_PATTERN,
  TOKEN_EXCHANGE_GRANT_TYPE,
  type ExchangeConsentView,
  type ExchangeKind,
  type InterstitialReason,
} from "@polaris-key/protocol/identity";
import { ERROR_CODE_VALUES, ErrorCode } from "../../constants.generated.js";
import { bodyCode } from "../../core/activation.js";
import { PolarisError, isSecureTransportUrl } from "../../core/types.js";
import type { PolarisErrorCode } from "../../core/types.js";
import type { ExchangeDiscovery } from "../discovery.js";

export type { ExchangeConsentView, ExchangeKind, InterstitialReason };

export interface ExchangeOptions {
  /** Which platform identity. It must be one of the product's discovered kinds. */
  kind: ExchangeKind;
  /**
   * The provider's ID token for `nonce`: the provider must sign the nonce into the token as it
   * is, with no hashing. Called once per attempt. A rejection ends the attempt; the nonce is
   * not reused.
   */
  subjectToken(nonce: string): Promise<string>;
  /** `app` (default) shows the licence choice in the app; `card` leaves it to the card. */
  licenseChoice?: "app" | "card";
  /** The device label (§12.7.1). */
  deviceName?: string;
  /**
   * Asked just before a token is stored. False abandons the attempt: nothing is stored and the
   * exchange rejects with `ExchangeAborted` (a sign-out happened while it ran).
   */
  mayStore?(): boolean | Promise<boolean>;
}

/** The rejection of an exchange `mayStore` refused; matched by `name`, so no class is shared. */
export const EXCHANGE_ABORTED = "ExchangeAborted";

/** Why an exchange cannot run here. */
export type ExchangeUnavailableReason =
  /** The product serves no platform sign-in (identity off, no `exchange`, or `404`). */
  | "product"
  /** The product does not accept this kind. */
  | "kind"
  /** The device key store cannot sign here, or holds its keys in memory only. */
  | "device-keys"
  /** Discovery named a nonce or token endpoint off the product's origin, or not https. */
  | "endpoint";

/** `200 confirm`: the link exists, the person has not consented to this app (or what it asks
 *  changed). Show `consent`, then `choice.complete(grant, choice, {consent})`. */
export interface PendingConsent {
  readonly kind: "pendingConsent";
  /** The pending sign-in grant. Not enumerable. */
  readonly grant: string;
  readonly expiresIn: number;
  readonly consent: ExchangeConsentView;
}

/** `200 choose`: a licence choice is due and consent stands. `choice.licenses(grant)` reads it. */
export interface PendingSignIn {
  readonly kind: "pendingSignIn";
  /** The pending sign-in grant. Not enumerable. */
  readonly grant: string;
  readonly expiresIn: number;
  readonly choices: Record<string, unknown>;
}

/** `403 interstitial_required`: no link exists for this token (`no_link`) or the terms are
 *  unaccepted (`terms`). Sign in the regular way. */
export interface NeedsSignIn {
  readonly kind: "needsSignIn";
  readonly reason: InterstitialReason;
  /** The sign-in card for this product. */
  readonly url: string;
  /** `no_link` only: spends once on the link offer, so the provider is not asked again. Not
   *  enumerable. */
  readonly linkHandle?: string;
  readonly expiresIn?: number;
}

export type ExchangeOutcome =
  | {
      kind: "signedIn";
      /** The pairwise account subject (`ps_…`). */
      subject: string;
      scope: string;
      activation: { licenseId: string | null };
      /** The token is stored, but the sync that follows failed. */
      syncError?: PolarisError;
    }
  | PendingConsent
  | PendingSignIn
  | NeedsSignIn
  | { kind: "unavailable"; reason: ExchangeUnavailableReason };

/** What `BearerSession.exchange` supplies. */
export interface ExchangeContext {
  product: string;
  deviceId: string;
  /** Discovery's platform sign-in, or `null`. */
  endpoints: ExchangeDiscovery | null;
  identityEnabled: boolean;
  headers(extra: Record<string, string>): Record<string, string>;
  /** The product's origin base (`https://host`); the endpoints must share its origin. */
  baseUrl: string;
  /** POST transport: no ambient credential, the request deadline. */
  send(url: string, init: RequestInit): Promise<Response>;
  /** Store the device token like any sign-in; a sync failure after it is returned, not thrown. */
  accept(token: string, subject: string): Promise<PolarisError | null>;
  now(): number;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Define `value` on `target` as a member a spread, a JSON stringify or a console dump skips. */
export function hidden<T extends object>(
  target: T,
  key: string,
  value: string,
): T {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return target;
}

const b64u = (bytes: Uint8Array): string => {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return b64u(new Uint8Array(digest));
}

export async function readJson(res: Response): Promise<unknown> {
  return res
    .text()
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => null);
}

function retryAfterOf(res: Response, body: unknown): number | undefined {
  const header = res.headers.get("retry-after");
  if (header !== null && /^\d+$/.test(header) && Number(header) > 0)
    return Number(header);
  const b = isRecord(body) ? body : {};
  return typeof b.retryAfter === "number" && b.retryAfter > 0
    ? Math.ceil(b.retryAfter)
    : undefined;
}

/** A refusal as a typed error. The message names the step and the wire code, never a secret. */
export function refusal(
  step: string,
  res: Response,
  body: unknown,
  badResponse?: boolean,
): PolarisError {
  const wire = bodyCode(body) ?? `http_${res.status}`;
  const retryAfterSeconds = retryAfterOf(res, body);
  if (res.status >= 500 || badResponse)
    return new PolarisError(
      badResponse ? ErrorCode.badResponse : ErrorCode.serverError,
      `the ${step} failed with status ${res.status}.`,
      wire,
      undefined,
      { status: res.status },
    );
  const known = (ERROR_CODE_VALUES as readonly string[]).includes(wire);
  return new PolarisError(
    known ? (wire as PolarisErrorCode) : "http-error",
    `the ${step} was refused (${wire}).`,
    wire,
    undefined,
    {
      status: res.status,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    },
  );
}

export async function post(
  ctx: Pick<ExchangeContext, "headers" | "send">,
  url: string,
  contentType: string,
  body: string,
): Promise<Response> {
  try {
    return await ctx.send(url, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: ctx.headers({ "content-type": contentType }),
      body,
    });
  } catch (e) {
    throw new PolarisError(ErrorCode.networkError, (e as Error).message);
  }
}

export function sameOrigin(base: string, endpoint: string): boolean {
  try {
    return (
      isSecureTransportUrl(endpoint) &&
      new URL(endpoint).origin === new URL(base).origin
    );
  } catch {
    return false;
  }
}

const unavailable = (reason: ExchangeUnavailableReason): ExchangeOutcome => ({
  kind: "unavailable",
  reason,
});

const grantOk = (v: unknown): v is string =>
  typeof v === "string" && new RegExp(CHOICE_GRANT_PATTERN).test(v);

function consentViewOf(v: unknown): ExchangeConsentView | null {
  if (!isRecord(v)) return null;
  const { client, as, items, scopeHash, firstTime, changed } = v;
  if (
    !isRecord(client) ||
    typeof client.appName !== "string" ||
    !isRecord(as) ||
    (as.provider !== "google" && as.provider !== "apple") ||
    !Array.isArray(items) ||
    typeof scopeHash !== "string" ||
    typeof firstTime !== "boolean" ||
    typeof changed !== "boolean"
  )
    return null;
  return v as unknown as ExchangeConsentView;
}

/** `POST nonce` for this device's keys: the nonce, or `null` on 404 (the product without the
 *  service). Any other refusal throws, naming `step`. Shared with the link offer. */
export async function requestNonce(
  ctx: Pick<ExchangeContext, "headers" | "send">,
  endpoint: string,
  keys: { signKey: string; agreeKey: string },
  step: string,
): Promise<string | null> {
  const res = await post(
    ctx,
    endpoint,
    "application/json",
    JSON.stringify({ signKey: keys.signKey, agreeKey: keys.agreeKey }),
  );
  const body = await readJson(res);
  if (res.status === 404) return null;
  if (res.status !== 200) throw refusal(`${step} nonce request`, res, body);
  const nonce = isRecord(body) ? body.nonce : undefined;
  if (
    typeof nonce !== "string" ||
    !new RegExp(EXCHANGE_NONCE_PATTERN).test(nonce)
  )
    throw refusal(`${step} nonce request`, res, body, true);
  return nonce;
}

/** Run one exchange attempt: one nonce, one provider token, one token request. */
export async function runExchange(
  ctx: ExchangeContext,
  port: DeviceKeyPort,
  opts: ExchangeOptions,
): Promise<ExchangeOutcome> {
  const found = ctx.endpoints;
  if (!ctx.identityEnabled || found === null) return unavailable("product");
  if (!found.kinds.includes(opts.kind)) return unavailable("kind");
  // Discovery is data the network supplied: the nonce and the proof go only to the product's own
  // origin, over https (or loopback), so a poisoned document cannot aim them elsewhere.
  if (
    !sameOrigin(ctx.baseUrl, found.nonceEndpoint) ||
    !sameOrigin(ctx.baseUrl, found.tokenEndpoint)
  )
    return unavailable("endpoint");

  let keys;
  try {
    if ((await port.persistence?.()) === "memory")
      return unavailable("device-keys");
    keys = await port.ensure();
  } catch (e) {
    // No Ed25519 or X25519 here: the exchange cannot bind a device. An unreadable record is a
    // real error and propagates.
    if (e instanceof DeviceKeyUnsupportedError)
      return unavailable("device-keys");
    throw e;
  }

  // The nonce. A 404 is the product without the service.
  const nonce = await requestNonce(ctx, found.nonceEndpoint, keys, "sign-in");
  if (nonce === null) return unavailable("product");

  // The provider signs the nonce into its token. This attempt's nonce goes nowhere else.
  const subjectToken = await opts.subjectToken(nonce);
  if (typeof subjectToken !== "string" || subjectToken === "")
    throw new PolarisError(
      ErrorCode.signInFailed,
      "the platform provider returned no token.",
    );

  let proof;
  try {
    proof = await signDeviceProof(port, {
      purpose: "exchange",
      product: ctx.product,
      deviceId: ctx.deviceId,
      value: `${nonce}.${keys.signKey}`,
      tokenHash: await sha256Base64Url(subjectToken),
      now: ctx.now(),
    });
  } catch (e) {
    if (e instanceof PolarisError) throw e;
    throw new PolarisError(
      ErrorCode.signInFailed,
      "the device proof could not be signed.",
    );
  }

  const form = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    client_id: ctx.product,
    subject_token: subjectToken,
    subject_token_type: EXCHANGE_SUBJECT_TOKEN_TYPE,
    nonce,
    device_key: proof.signKey,
    proof: proof.sig,
    ...(opts.licenseChoice ? { license_choice: opts.licenseChoice } : {}),
    ...(opts.deviceName ? { device_name: opts.deviceName } : {}),
  });
  const res = await post(
    ctx,
    found.tokenEndpoint,
    TOKEN_CONTENT_TYPE,
    form.toString(),
  );
  const body = await readJson(res);
  return answer(ctx, res, body);
}

async function answer(
  ctx: ExchangeContext,
  res: Response,
  body: unknown,
): Promise<ExchangeOutcome> {
  const bad = () => refusal("sign-in exchange", res, body, true);
  if (res.status === 404) return unavailable("product");

  if (res.status === 403 && bodyCode(body) === ErrorCode.interstitialRequired) {
    const b = isRecord(body) ? body : {};
    const reason: InterstitialReason =
      b.reason === "terms" ? "terms" : "no_link";
    if (typeof b.url !== "string" || !isSecureTransportUrl(b.url)) throw bad();
    const out: NeedsSignIn = {
      kind: "needsSignIn",
      reason,
      url: b.url,
      ...(typeof b.expiresIn === "number" ? { expiresIn: b.expiresIn } : {}),
    };
    // The handle comes only with a literal no_link; an unknown reason carries none.
    return b.reason === "no_link" &&
      typeof b.linkHandle === "string" &&
      new RegExp(LINK_HANDLE_PATTERN).test(b.linkHandle)
      ? hidden(out, "linkHandle", b.linkHandle)
      : out;
  }

  if (res.status === 200 && isRecord(body) && body.status === "confirm") {
    const consent = consentViewOf(body.consent);
    if (!grantOk(body.grant) || typeof body.expiresIn !== "number" || !consent)
      throw bad();
    return hidden(
      {
        kind: "pendingConsent",
        expiresIn: body.expiresIn,
        consent,
      } as PendingConsent,
      "grant",
      body.grant,
    );
  }

  const parsed = parseTokenAnswer(res.status, body);
  switch (parsed.kind) {
    case "malformed":
      throw bad();
    case "refused":
      throw refusal("sign-in exchange", res, body);
    case "choose":
      return hidden(
        {
          kind: "pendingSignIn",
          expiresIn: parsed.expiresIn,
          choices: parsed.choices,
        } as PendingSignIn,
        "grant",
        parsed.grant,
      );
    case "token":
      const syncError = await ctx.accept(parsed.accessToken, parsed.subject);
      return {
        kind: "signedIn",
        subject: parsed.subject,
        scope: parsed.scope,
        activation: {
          licenseId:
            parsed.license && typeof parsed.license.id === "string"
              ? parsed.license.id
              : null,
        },
        ...(syncError ? { syncError } : {}),
      };
  }
}
