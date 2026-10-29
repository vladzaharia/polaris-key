// `identity.choice.*` (I-10a.8; WIRE-CONTRACT-V4 §12.5.1): the licence choice an app shows itself
// after `signIn.start({licenseChoice: "app"})` answered `{kind: "choose", grant}`.
//
//   licenses(grant)           the licences the account can run this device on (a view)
//   devices(grant, licenseId) a full licence's seated devices, for Replace (a view)
//   complete(grant, choice)   the person's choice: `license` (+ `replaceDeviceId`), `keep`,
//                             `create` or `key`; the device token is stored like a sign-in
//   cancel(grant)             give the grant up; no token, nothing stored
//
// Each call dials the endpoint discovery names, never one it builds, and answers the typed
// `service-unavailable` N/A when discovery has none (the session then ran in card mode and never
// issued a grant). The grant is the credential: no device bearer is sent (but for `keep`, which the
// device proves with its own token), and the grant is never printed or put in an error message.
//
// A refusal the Worker answers (`invalid_grant`, `license_choice_required`, `not_found`,
// `device_limit`, `rate_limited`, `license_owned`, `key_entry_limit`, ...) is a RESULT, like
// `attach`: `{kind: "refused", code, ...}`. After `device_limit` and `license_choice_required`
// it carries the fresh `view` to choose from again. A refused `complete` keeps the device token,
// the cache and the stored identity: only an `ok` completion changes state. A network failure or
// a 5xx throws under the one taxonomy (SP-46), the grant still spendable.

import {
  PolarisError,
  UnsupportedError,
  parseTokenAnswer,
} from "@polaris-key/client-core";
import type {
  LicenseChoiceInput,
  LicenseChoiceView,
  ReplaceView,
} from "@polaris-key/protocol/identity";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import { classifyResponse, errorFrom } from "../core/http.js";
import type { TokenManager } from "../core/token.js";
import type { ProductDiscoveryDocument } from "../discovery.js";
import { writeStoredSubject } from "./account.js";
import type { IdentityEvent } from "./signIn.js";

export type { LicenseChoiceInput, LicenseChoiceView, ReplaceView };

/** The person's explicit choice (the wire's `LicenseChoiceInput`). */
export type LicenseChoice = LicenseChoiceInput;

/**
 * The `choose` outcome of a sign-in (`license_choice=app`, a choice is due): no token was stored.
 * Show the choice from `choices` (or read a fresh view with `licenses(grant)`), then finish with
 * `complete(grant, choice)` or `cancel(grant)` before `expiresIn` seconds pass (300, §12.5.1).
 * `grant` is a credential: keep it out of logs.
 */
export interface ChooseOutcome {
  kind: "choose";
  grant: string;
  expiresIn: number;
  choices: Record<string, unknown>;
}

/** Why the Worker said no, as a result. Only the members the answer carried are present. */
export interface ChoiceRefusal {
  kind: "refused";
  /** The wire code: `invalid_grant`, `license_choice_required`, `not_found`, `device_limit`,
   *  `rate_limited`, `license_owned`, `key_entry_limit`, `not_entitled`, ... */
  code: string;
  httpStatus: number;
  /** `rate_limited`: seconds to wait. */
  retryAfterSeconds?: number;
  /** `device_limit` and `license_choice_required`: the fresh view to choose from again. */
  view?: LicenseChoiceView;
  /** `device_limit`, `key_entry_limit`: the portal link that frees a seat or an entry. */
  manageUrl?: string;
  /** `license_owned`: where to sign in to the account that owns the licence. */
  signInUrl?: string;
  /** `key_entry_limit`. */
  keyEntries?: { used: number; limit: number };
}

export type ChoiceViewResult<V> = { kind: "ok"; view: V } | ChoiceRefusal;

export type ChoiceCompleteResult =
  | {
      kind: "ok";
      /** The licence the device now runs on, or null on a device with none. */
      licenseId: string | null;
      /** The pairwise account subject (`ps_…`). */
      subject: string;
      scope: string;
      /** After a `key`: the licence's key-entry count. */
      keyEntries?: { used: number; limit: number };
      /** `true` after `keep`: the device kept a licence outside the account, so `attach` may
       *  follow (the device-code `confirm` poll's `attachable`, P1-07). Never set otherwise. */
      attachable?: true;
    }
  | ChoiceRefusal;

export type ChoiceCancelResult = { kind: "ok" } | ChoiceRefusal;

/** What the choice calls need from the identity client. */
export interface ChoiceDeps {
  ctx: CoreContext;
  tokens: TokenManager;
  /** Discovery, loading it first when this session has not. */
  discovery: () => Promise<ProductDiscoveryDocument | null>;
  /** The post-acquisition sync, as after a device-code `ready`. */
  onAcquired: () => Promise<void>;
  /** Forget the stored identity file (a choice answers no name or email). */
  forget: () => Promise<void>;
  emit?: (e: IdentityEvent) => void;
}

type ChoiceEndpoint =
  | "choiceLicenses"
  | "choiceDevices"
  | "choiceComplete"
  | "choiceCancel";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isCount = (v: unknown): v is { used: number; limit: number } =>
  isRecord(v) && typeof v.used === "number" && typeof v.limit === "number";

export class ChoiceClient {
  constructor(private readonly deps: ChoiceDeps) {}

  /** The licences the account can run this device on. Counts against the grant's read budget. */
  licenses(grant: string): Promise<ChoiceViewResult<LicenseChoiceView>> {
    return this.read("choiceLicenses", { grant }, isLicenseView);
  }

  /** The devices seated on a full licence, for Replace. A licence outside the grant's view is
   *  `refused` with `not_found`. */
  devices(
    grant: string,
    licenseId: string,
  ): Promise<ChoiceViewResult<ReplaceView>> {
    return this.read("choiceDevices", { grant, licenseId }, isReplaceView);
  }

  /**
   * Finish with the person's choice. On `ok` the device token is stored, the stored identity is
   * forgotten (a choice answers no name or email), the subject is persisted and the acquisition
   * sync runs, exactly as after a sign-in. The grant is spent on `ok`; a refusal the person can
   * fix (`device_limit`, `license_choice_required`, a wrong key) leaves it open.
   */
  async complete(
    grant: string,
    choice: LicenseChoice,
  ): Promise<ChoiceCompleteResult> {
    const { ctx, tokens } = this.deps;
    // `keep` is proven by the device's own token (the Worker reads it as `held`); every other
    // choice is made on the grant alone.
    const held = choice?.kind === "keep" ? tokens.current : null;
    const res = await this.post("choiceComplete", { grant, choice }, held);
    if (res.status !== 200) return this.refusal(res, "choice complete");
    const body: unknown = await res
      .text()
      .then((t) => JSON.parse(t) as unknown)
      .catch(() => null);
    const answer = parseTokenAnswer(200, body);
    if (answer.kind !== "token")
      throw new PolarisError(
        ErrorCode.badResponse,
        "choice complete answered without a complete sign-in.",
        { status: 200 },
      );
    const keyEntries =
      isRecord(body) && isCount(body.keyEntries) ? body.keyEntries : undefined;
    await tokens.set(answer.accessToken, "signin");
    await this.deps.forget();
    await writeStoredSubject(ctx.dirs.state, answer.subject);
    await this.deps.onAcquired();
    this.deps.emit?.({ kind: "signedIn", subject: answer.subject });
    const licenseId =
      answer.license && typeof answer.license.id === "string"
        ? answer.license.id
        : null;
    return {
      kind: "ok",
      licenseId,
      subject: answer.subject,
      scope: answer.scope,
      ...(keyEntries ? { keyEntries } : {}),
      ...(choice.kind === "keep" ? { attachable: true as const } : {}),
    };
  }

  /** Give the grant up (`204`). Nothing is stored; the sign-in is over. */
  async cancel(grant: string): Promise<ChoiceCancelResult> {
    const res = await this.post("choiceCancel", { grant });
    if (res.status === 204 || res.status === 200) return { kind: "ok" };
    return this.refusal(res, "choice cancel");
  }

  private async read<V>(
    name: ChoiceEndpoint,
    body: Record<string, unknown>,
    valid: (v: unknown) => v is V,
  ): Promise<ChoiceViewResult<V>> {
    const res = await this.post(name, body);
    if (res.status !== 200) return this.refusal(res, name);
    const view: unknown = await res
      .text()
      .then((t) => JSON.parse(t) as unknown)
      .catch(() => null);
    if (!valid(view))
      throw new PolarisError(
        ErrorCode.badResponse,
        `${name} answered without a readable view.`,
        { status: 200 },
      );
    return { kind: "ok", view };
  }

  /** The discovery endpoint, else the typed N/A. Nothing is dialled before this answers. */
  private async endpoint(name: ChoiceEndpoint): Promise<string> {
    const { ctx } = this.deps;
    ctx.requireService("identity", Feature.identityChoice);
    const fragment = (await this.deps.discovery())?.services?.identity;
    const url = (fragment?.endpoints as Record<string, unknown> | undefined)?.[
      name
    ];
    if (typeof url !== "string" || url === "")
      throw new UnsupportedError(
        {
          supported: false,
          feature: Feature.identityChoice,
          reason: "product",
          detail: `this product's discovery names no identity ${name} endpoint`,
        },
        ErrorCode.serviceUnavailable,
      );
    return url;
  }

  private async post(
    name: ChoiceEndpoint,
    body: Record<string, unknown>,
    bearer: string | null = null,
  ): Promise<Response> {
    const url = await this.endpoint(name);
    const { ctx } = this.deps;
    return ctx.request(
      url,
      {
        method: "POST",
        headers: ctx.headers({
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        }),
        body: JSON.stringify(body),
      },
      name,
    );
  }

  /** A non-2xx answer: a 5xx throws; a 4xx is the Worker's refusal as a result. */
  private async refusal(res: Response, what: string): Promise<ChoiceRefusal> {
    const c = await classifyResponse(res);
    if (res.status >= 500) throw errorFrom(c, what);
    const b = c.body;
    const retry =
      c.retryAfterSeconds ??
      (typeof b.retryAfter === "number" && b.retryAfter > 0
        ? Math.ceil(b.retryAfter)
        : undefined);
    return {
      kind: "refused",
      code: c.code,
      httpStatus: c.status,
      ...(retry !== undefined ? { retryAfterSeconds: retry } : {}),
      ...(isLicenseView(b.view) ? { view: b.view } : {}),
      ...(typeof b.manageUrl === "string" ? { manageUrl: b.manageUrl } : {}),
      ...(typeof b.signInUrl === "string" ? { signInUrl: b.signInUrl } : {}),
      ...(isCount(b.keyEntries) ? { keyEntries: b.keyEntries } : {}),
    };
  }
}

function isLicenseView(v: unknown): v is LicenseChoiceView {
  return isRecord(v) && typeof v.state === "string" && Array.isArray(v.choices);
}

function isReplaceView(v: unknown): v is ReplaceView {
  return (
    isRecord(v) && typeof v.licenseId === "string" && Array.isArray(v.devices)
  );
}
