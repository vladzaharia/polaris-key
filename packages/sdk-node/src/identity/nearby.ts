// The nearby approval routes (WIRE-CONTRACT-V5 §12.11.5; I-47.4): `nearby/start` and `nearby/poll`
// for the new device D, `nearby/approve` for the signed-in device M. This is the HTTP half of
// nearby approval; the LAN half (adverts, the code, `VOUCH_REQ`) is CC-15's, and the sessions
// that join the two are `nearbySession.ts` (D) and `nearbyApprover.ts` (M).
//
// What this module keeps:
//  - an endpoint is used only when discovery names it, and a product whose discovery names none
//    answers the typed `service-unavailable` N/A before any request;
//  - every route carries a `pkey-proof/1` proof (§12.11.1) signed through the device key port, so
//    a private key never leaves it. `start`: value `<signKey>.<agreeKey>`; `poll` and `approve`:
//    the request handle. Line 6 is `-` (no provider token is bound);
//  - D's `poll` is signed by the key D sent on `start`: the handle remembers that `signKey`, and a
//    poll after the device's keys changed is refused locally rather than sent;
//  - `start` sends D's bearer when D holds a credential (Q8), and never invents one;
//  - `poll` answers the token once. It is stored the way a device-code sign-in stores it: through
//    the token manager (as a sign-in), then the identity, the subject, the acquisition sync;
//  - `approve` sends exactly the keys and ids it was given. A `409 device_keys_required` registers
//    M's keys (`devices.registerKeys`) and retries ONCE; a second one is a refusal, never a loop;
//  - the two 404s of `approve` and `poll` are the same bytes whether the request is unknown or the
//    routes are off (N11). A 404 is read through a fresh discovery: `unavailable` only when it no
//    longer names nearby, otherwise it stays a refusal (an unknown, expired or decided request);
//  - the request handle, the proofs and the token are in no print, repr or error message.

import type { VouchRequest } from "@polaris-key/client-core/peer";
import {
  PolarisError,
  UnsupportedError,
  signDeviceProof,
  parseTokenAnswer,
  type DeviceKeyPort,
} from "@polaris-key/client-core";
import {
  NEARBY_REQUEST_PATTERN,
  PAIRWISE_SUBJECT_PATTERN,
  type NearbyChoiceInput,
} from "@polaris-key/protocol/identity";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import {
  classifyResponse,
  errorFrom,
  parseErrorBody,
  transportError,
} from "../core/http.js";
import { printAs, redactOnPrint } from "../core/redact.js";
import type { TokenManager } from "../core/token.js";
import {
  identityFragmentFrom,
  type IdentityFragment,
  type ProductDiscoveryDocument,
} from "../discovery.js";
import type { IdentityEvent, ShownIdentity } from "./signIn.js";

const REQUEST_RE = new RegExp(NEARBY_REQUEST_PATTERN);
const SUBJECT_RE = new RegExp(PAIRWISE_SUBJECT_PATTERN);

/** What `ApproveAnswerInput` (CC-15's `finish()`) takes: the status, the body and the fresh read. */
export interface NearbyFinishInput {
  http: number | null;
  body: string | null;
  discoveryNearby: boolean;
}

/** `nearby/start`'s answer. `request` is a secret: it prints as nothing. */
export interface NearbyStarted {
  /** The request handle (`nr_…`). A secret: give it to the LAN request and nothing else. */
  readonly request: string;
  /** Seconds the request lives (300). */
  readonly expiresIn: number;
  /** Seconds between polls (3). */
  readonly interval: number;
  /** The signing key D sent: `poll` is signed by it, or not sent. */
  readonly signKey: string;
}

/** One `nearby/poll` answer. A denial and a lapse are outcomes, not errors. */
export type NearbyPoll =
  | { kind: "pending" }
  | { kind: "slow-down"; interval: number }
  | { kind: "timeout" }
  | { kind: "denied" }
  /** The routes went away (a 404 after a fresh discovery lost `nearby`). */
  | { kind: "unavailable" }
  | {
      kind: "ready";
      /** The access token the poll stored, so the session can tell its own sign-in from a later
       *  one. Never handed to the caller. */
      token: string;
      subject: string;
      scope: string;
      licenseId: string | null;
      /** The account as the server shows it: for D's person to confirm (§15.6.1 rule 12). */
      identity: ShownIdentity;
    };

declare const GRANTED: unique symbol;

/**
 * The verified `VOUCH_REQ` of a session whose person picked the matching code (`pick()` of
 * CC-15's approval, V5 §15.6.1 rule 10). `approve` takes nothing else: it is not built from a
 * handle and keys, and only {@link grantApproval} makes one. A frozen copy, so what was granted is
 * what is sent.
 */
export type VerifiedVouch = Readonly<VouchRequest> & {
  readonly [GRANTED]: true;
};

/** The decisions of a granted vouch. */
export interface NearbyDecision {
  decision: "approve" | "deny";
  choice?: NearbyChoiceInput;
}

const grants = new WeakSet<object>();

/**
 * The permit: mark the `VouchRequest` that `pick()` returned for a matched code, on a live
 * session, as the one `nearby/approve` may be called with. Only the approver (nearbyApprover.ts)
 * calls it, right after `pick()`; a permit is a frozen copy, kept in a set no other module can
 * reach, so an object built any other way is refused by {@link NearbyRoutes.approve}.
 */
export function grantApproval(v: VouchRequest): VerifiedVouch {
  const permit = Object.freeze({
    request: v.request,
    deviceId: v.deviceId,
    signKey: v.signKey,
    agreeKey: v.agreeKey,
    label: v.label,
    platform: v.platform,
  });
  grants.add(permit);
  return permit as VerifiedVouch;
}

/** One `nearby/approve` answer (§12.11.5). Every variant carries what `finish()` takes. */
export type NearbyApproveAnswer = (
  | { kind: "approved"; deviceLabel: string | null }
  /** Nothing was written; M shows the choice and calls again with `choice`. */
  | { kind: "choose"; choices: unknown }
  /** `204`: the denial is final. */
  | { kind: "denied" }
  /** A 404 after a fresh discovery lost `nearby`: the routes are off. */
  | { kind: "unavailable" }
  /** Any other status. `code` is the Worker's, else the status's registry code. */
  | {
      kind: "refused";
      status: number;
      code: string;
      retryAfterSeconds?: number;
    }
) & { finish: NearbyFinishInput };

export interface NearbyRoutesDeps {
  ctx: CoreContext;
  tokens: TokenManager;
  /** Discovery; `fresh` loads it again first (N11). */
  discovery: (fresh: boolean) => Promise<ProductDiscoveryDocument | null>;
  /** This device's keys (made when none exist) and its `X-PKey-Device` value. */
  signer: () => Promise<{ port: DeviceKeyPort; deviceId: string }>;
  /** `devices.registerKeys(port)`: M registers its keys before an approval that asks for them. */
  registerKeys: (port: DeviceKeyPort) => Promise<unknown>;
  /** The acquisition sync after a token is stored. */
  onAcquired: () => Promise<void>;
  /** Persist who signed in (`identity.json`). */
  storeIdentity: (who: ShownIdentity) => Promise<void>;
  licenseId: () => string | null;
  emit: (e: IdentityEvent) => void;
}

/** @internal Conformance replay seam, see {@link NearbyRoutes.signProof}. */
export type ProofSigner = (
  port: DeviceKeyPort,
  fields: { purpose: string; deviceId: string; value: string },
) => Promise<string>;

type Endpoint = "nearbyStart" | "nearbyPoll" | "nearbyApprove";

const typedUnavailable = (detail: string): UnsupportedError =>
  new UnsupportedError(
    {
      supported: false,
      feature: Feature.identityNearby,
      reason: "product",
      detail,
    },
    ErrorCode.serviceUnavailable,
  );

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

/** The nearby routes. One per identity client. */
export class NearbyRoutes {
  readonly #d: NearbyRoutesDeps;

  /**
   * @internal Conformance replay only (reached through a typed cast, like `redirectEntropy`): the
   * proof as a string. Unset, a proof is signed through the key port (`signDeviceProof`), which
   * refuses one that does not verify; a replay that must send a proof by another key or over
   * another value sets its own.
   */
  signProof: ProofSigner | undefined;

  constructor(deps: NearbyRoutesDeps) {
    this.#d = deps;
    printAs(this, () => ({ service: "NearbyRoutes" }));
  }

  /** The endpoint discovery names, else the typed N/A. Nothing is sent before this answers. */
  async #endpoint(name: Endpoint, fresh = false): Promise<string> {
    const { ctx } = this.#d;
    // Discovery first: the service table comes from it once it is loaded.
    const doc = await this.#d.discovery(fresh);
    ctx.requireService("identity", Feature.identityNearby);
    const f: IdentityFragment | null = identityFragmentFrom(doc);
    const url = (f?.endpoints as Record<string, string> | undefined)?.[name];
    if (f === null || f.nearby !== true || !url)
      throw typedUnavailable(
        "this product's discovery does not name nearby approval",
      );
    return url;
  }

  /** A fresh read: does discovery still name `nearby` and the approve endpoint? */
  async #stillNamed(name: Endpoint): Promise<boolean> {
    try {
      await this.#endpoint(name, true);
      return true;
    } catch {
      return false;
    }
  }

  async #proof(
    port: DeviceKeyPort,
    purpose: "nearby-start" | "nearby-poll" | "nearby-approve",
    deviceId: string,
    value: string,
  ): Promise<string> {
    if (this.signProof)
      return this.signProof(port, { purpose, deviceId, value });
    const p = await signDeviceProof(port, {
      purpose,
      product: this.#d.ctx.product,
      deviceId,
      value,
    });
    return p.sig;
  }

  // ── D ───────────────────────────────────────────────────────────────────────────────────

  /**
   * `POST nearby/start`: D asks to be approved, sending its two public keys. Throws the typed N/A
   * when discovery names no nearby approval or the route is off (`404`), and the Worker's code
   * for a refusal (`invalid_grant`, `device_keys_invalid`, `rate_limited`, ...).
   */
  async start(o: { deviceName?: string } = {}): Promise<NearbyStarted> {
    const url = await this.#endpoint("nearbyStart");
    await this.#endpoint("nearbyPoll");
    const { ctx, tokens } = this.#d;
    const { port, deviceId } = await this.#d.signer();
    const keys = await port.ensure();
    const body: Record<string, unknown> = {
      signKey: keys.signKey,
      agreeKey: keys.agreeKey,
    };
    // §12.7.1: the per-call name, else the client's, else the platform default; "" sends none.
    const label = ctx.deviceLabel(o.deviceName);
    if (label) body.deviceName = label;
    body.proof = await this.#proof(
      port,
      "nearby-start",
      deviceId,
      `${keys.signKey}.${keys.agreeKey}`,
    );
    // Q8: a device id that already holds a credential proves it by that bearer.
    const bearer = tokens.current;
    const res = await ctx.request(
      url,
      {
        method: "POST",
        headers: ctx.headers({
          "content-type": "application/json",
          ...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}),
        }),
        body: JSON.stringify(body),
      },
      "nearby start",
    );
    // The gate is off (the Worker rolled back after our discovery): start has no other 404.
    if (res.status === 404)
      throw typedUnavailable("this product does not serve nearby approval");
    if (res.status !== 201)
      throw errorFrom(await classifyResponse(res), "nearby start");
    const b = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (
      typeof b?.request !== "string" ||
      !REQUEST_RE.test(b.request) ||
      typeof b.expiresIn !== "number" ||
      !(b.expiresIn > 0) ||
      typeof b.interval !== "number" ||
      !(b.interval > 0)
    )
      throw new PolarisError(
        ErrorCode.badResponse,
        "nearby start answered without a complete request.",
      );
    return redactOnPrint<NearbyStarted>(
      {
        request: b.request,
        expiresIn: Math.ceil(b.expiresIn),
        interval: Math.ceil(b.interval),
        signKey: keys.signKey,
      },
      ["request"],
    );
  }

  /**
   * `POST nearby/poll`: one poll of D's request, signed by the key D started it with. A token is
   * stored the way a device-code sign-in stores one and answered once as `ready`. A `429` is
   * `slow-down` (with the interval to use); a `503` throws `server-error` with the `Retry-After`
   * in `retryAfterSeconds` and the request kept; pacing is the caller's.
   *
   * A late answer never replaces a newer token: when the held token changed while the request
   * was in flight (another sign-in landed), a ready answer stores nothing.
   */
  async poll(started: NearbyStarted): Promise<NearbyPoll> {
    const url = await this.#endpoint("nearbyPoll");
    const { ctx, tokens } = this.#d;
    const heldAtStart = tokens.current;
    const { port, deviceId } = await this.#d.signer();
    const keys = await port.publicKeys();
    if (keys === null || keys.signKey !== started.signKey)
      throw new PolarisError(
        ErrorCode.signInFailed,
        "this device's keys changed since nearby sign-in started.",
      );
    const proof = await this.#proof(
      port,
      "nearby-poll",
      deviceId,
      started.request,
    );
    const res = await ctx.request(
      url,
      {
        method: "POST",
        headers: ctx.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ request: started.request, proof }),
      },
      "nearby poll",
    );
    if (res.status === 404) {
      // N11: the same bytes whether the request is unknown or the routes went away.
      if (!(await this.#stillNamed("nearbyPoll")))
        return { kind: "unavailable" };
      throw errorFrom(await classifyResponse(res), "nearby poll");
    }
    if (res.status >= 500 || (res.status !== 200 && res.status !== 429))
      throw errorFrom(await classifyResponse(res), "nearby poll");
    const answer = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (res.status === 429) {
      const n = answer?.interval;
      return {
        kind: "slow-down",
        interval:
          typeof n === "number" && Number.isFinite(n) && n > 0
            ? Math.ceil(n)
            : started.interval + 5,
      };
    }
    if (answer === null || typeof answer !== "object")
      throw new PolarisError(
        ErrorCode.badResponse,
        "nearby poll answered without a body.",
      );
    switch (answer.status) {
      case "pending":
        return { kind: "pending" };
      case "timeout":
        return { kind: "timeout" };
      case "error":
        if (answer.reason === "access_denied") return { kind: "denied" };
        throw new PolarisError(
          ErrorCode.signInFailed,
          "nearby sign-in failed.",
        );
      case undefined:
        break;
      default:
        throw new PolarisError(
          ErrorCode.signInFailed,
          "nearby sign-in failed.",
        );
    }
    const t = parseTokenAnswer(200, answer);
    if (t.kind !== "token" || !SUBJECT_RE.test(t.subject))
      throw new PolarisError(
        ErrorCode.badResponse,
        "nearby poll answered without a complete sign-in.",
      );
    if (tokens.current !== heldAtStart) return { kind: "timeout" };
    // Held unconfirmed (V5 §15.6.1 rule 12): not a sign-in, no stored subject and no `signedIn`
    // event until the person confirms the account (`NearbySignInSession.confirmAccount`), so Sync
    // and Connect do not start for an account nobody has accepted.
    await tokens.set(t.accessToken, "signin", { unconfirmed: true });
    const who = shownFrom(t.license);
    await this.#d.storeIdentity(who);
    await this.#d.onAcquired();
    return {
      kind: "ready",
      token: t.accessToken,
      subject: t.subject,
      scope: t.scope,
      licenseId: text(t.license?.id) ?? this.#d.licenseId(),
      identity: who,
    };
  }

  // ── M ───────────────────────────────────────────────────────────────────────────────────

  /**
   * `POST nearby/approve`: M's decision on D's request, with exactly the ids and keys it is given
   * (the verified `VOUCH_REQ`'s). Needs M's bearer and its registered signing key: a `409
   * device_keys_required` registers the keys and retries once. A refusal is an answer, not a
   * throw; only a missing endpoint, a missing sign-in and a transport failure throw.
   */
  async approve(
    a: VerifiedVouch,
    d: NearbyDecision,
  ): Promise<NearbyApproveAnswer> {
    // No silent approval: only a vouch the approver granted after a matched pick goes out.
    if (!grants.has(a))
      throw new PolarisError(
        ErrorCode.invalidOptions,
        "Nearby approval is refused: the person has not picked the matching code on this session.",
      );
    const url = await this.#endpoint("nearbyApprove");
    const { ctx, tokens } = this.#d;
    const bearer = tokens.current;
    if (bearer === null)
      throw new PolarisError(
        ErrorCode.accountRequired,
        "Sign in before approving a nearby device.",
      );
    const { port, deviceId } = await this.#d.signer();
    let retried = false;
    for (;;) {
      const proof = await this.#proof(
        port,
        "nearby-approve",
        deviceId,
        a.request,
      );
      let res: Response;
      try {
        res = await ctx.request(
          url,
          {
            method: "POST",
            headers: ctx.headers({
              "content-type": "application/json",
              authorization: `Bearer ${bearer}`,
            }),
            body: JSON.stringify({
              request: a.request,
              deviceId: a.deviceId,
              signKey: a.signKey,
              agreeKey: a.agreeKey,
              decision: d.decision,
              ...(d.choice !== undefined ? { choice: d.choice } : {}),
              proof,
            }),
          },
          "nearby approve",
        );
      } catch (e) {
        // No answer: the caller closes (finish maps `http: null`).
        const err = transportError(e, "nearby approve");
        return {
          kind: "refused",
          status: 0,
          code: err.code,
          finish: { http: null, body: null, discoveryNearby: true },
        };
      }
      const raw = await res.text().catch(() => "");
      if (res.status === 409 && !retried) {
        const code = parseErrorBody(raw).code;
        if (code === ErrorCode.deviceKeysRequired) {
          retried = true;
          await this.#d.registerKeys(port);
          continue;
        }
      }
      return await this.#answer(res, raw, retried);
    }
  }

  async #answer(
    res: Response,
    raw: string,
    keysRetried: boolean,
  ): Promise<NearbyApproveAnswer> {
    const finish = (
      discoveryNearby: boolean,
      body: string | null,
    ): NearbyFinishInput => ({
      http: res.status,
      body,
      discoveryNearby,
    });
    if (res.status === 204)
      return { kind: "denied", finish: finish(true, null) };
    if (res.status === 200) {
      const b = parseErrorBody(raw).body;
      if (b.status === "approved")
        return {
          kind: "approved",
          deviceLabel: typeof b.deviceLabel === "string" ? b.deviceLabel : null,
          finish: finish(true, raw),
        };
      if (b.status === "choose")
        return {
          kind: "choose",
          choices: b.choices,
          finish: finish(true, raw),
        };
      return {
        kind: "refused",
        status: 200,
        code: ErrorCode.badResponse,
        finish: finish(true, raw === "" ? null : raw),
      };
    }
    const c = parseErrorBody(raw);
    const code = c.code ?? codeFor(res.status);
    // `finish()` reads the code from a flat body; the Worker nests it. After the one keys retry a
    // second `device_keys_required` must close, not ask for another retry (finishMap would, as
    // its `keysRetried` is the caller's): it is reported under a code finishMap does not map.
    const flat = JSON.stringify({
      code:
        keysRetried &&
        res.status === 409 &&
        code === ErrorCode.deviceKeysRequired
          ? "device_keys_retried"
          : code,
    });
    const retry = res.headers.get("retry-after");
    const retryAfterSeconds =
      retry !== null && /^\d+$/.test(retry.trim()) ? Number(retry) : undefined;
    if (res.status === 404) {
      const named = await this.#stillNamed("nearbyApprove");
      if (!named) return { kind: "unavailable", finish: finish(false, flat) };
    }
    return {
      kind: "refused",
      status: res.status,
      code,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      finish: finish(true, flat),
    };
  }
}

function codeFor(status: number): string {
  if (status === 429) return ErrorCode.rateLimited;
  if (status >= 500) return ErrorCode.serverError;
  if (status === 404) return ErrorCode.notFound;
  if (status === 403) return ErrorCode.forbidden;
  if (status === 401) return ErrorCode.unauthorized;
  if (status === 400) return ErrorCode.badRequest;
  return ErrorCode.httpError;
}

/** The account the token response shows: the licence's `name` and `email`, each a string. */
function shownFrom(license: Record<string, unknown> | null): ShownIdentity {
  const out: ShownIdentity = {};
  const name = text(license?.name);
  const email = text(license?.email);
  if (name) out.name = name;
  if (email) out.email = email;
  return out;
}
