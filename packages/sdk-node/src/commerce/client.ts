// The Commerce sub-client (SDK parity pass §3.9, `commerce.receipt`, the Worker side is P6-01):
// a store purchase becomes a licence flag.
//
//   binding()            GET  /<p>/distribution/commerce/binding — the licence's opaque binding
//                        UUID and the store products the operator mapped. Hand the binding to the
//                        store BEFORE buying: Apple `appAccountToken`, Play `obfuscatedAccountId`,
//                        or the identity of a Steam web-API ticket.
//   claim(store, …)      POST /<p>/distribution/commerce/claim — forward what the store handed the
//                        device; on `ok` the next licence document carries the flag. The bare
//                        claim does not sync (the commerce-claim transcript pins one request);
//                        pass `{ sync: true }`, or use a store helper, which syncs by default.
//   claimSteam(ticket)   the Steam claim, with no Steamworks dependency: the host passes the hex
//                        ticket from `ISteamUser::GetAuthTicketForWebApi` (identity = bindingId).
//
// Both calls need a device token: a device with no licence is refused `not_entitled`
// (`no_license`), and the SDK never enrols on its own — the host decides (`license.enroll()`).
// A refusal is a value, never a throw; only local-only mode and the D-21 gate throw.

import { PolarisError } from "@polaris-key/client-core";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";

/** The stores the claim accepts (the Worker's `isStore`). */
export type CommerceStore = "app-store" | "play" | "steam";

/** One store product the operator mapped to a licence flag. */
export interface CommerceProduct {
  store: CommerceStore | string;
  productId: string;
  flag: string;
  deliverable?: string;
  [key: string]: unknown;
}

/** `commerce.binding()`. */
export type BindingResult =
  | { kind: "ok"; bindingId: string; products: CommerceProduct[] }
  | CommerceRefusal;

/** A refusal: the Worker's code (`forbidden`, `not_entitled`, `not_found`, `bad_request`,
 *  `unavailable`, `rate_limited`, `attestation_required`, …), its `reason`, the status. */
export interface CommerceRefusal {
  kind: "refused" | "not-owned" | "attestation-required" | "error";
  code: string;
  reason?: string;
  status: number;
  message: string;
}

/** `commerce.claim()`: `ok` (the flag is granted and the client has synced), `not-owned`,
 *  `attestation-required`, `refused{code}`, or `error` (no answer / 5xx). */
export type ClaimResult =
  | {
      kind: "ok";
      store: string;
      productId: string;
      flag: string;
      deliverable?: string;
      state: string;
      granted: boolean;
      changed: boolean;
    }
  | CommerceRefusal;

/** Fired after a successful claim: the facade syncs so the new flag is readable at once. */
export type ClaimedListener = () => Promise<void>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class CommerceClient {
  constructor(
    private readonly ctx: CoreContext,
    private readonly tokens: TokenManager,
    private readonly onClaimed: ClaimedListener,
  ) {}

  /** The licence's purchase binding and the products on sale. */
  async binding(): Promise<BindingResult> {
    const res = await this.call("GET", "distribution/commerce/binding");
    if ("kind" in res) return res;
    const body = res.body;
    if (
      !isRecord(body) ||
      typeof body.bindingId !== "string" ||
      !Array.isArray(body.products)
    )
      throw new PolarisError(
        ErrorCode.badResponse,
        "commerce binding answered without a bindingId and products.",
      );
    return {
      kind: "ok",
      bindingId: body.bindingId,
      products: body.products.filter(isRecord) as CommerceProduct[],
    };
  }

  /**
   * Claim one store purchase. `payload` is the store's own fields, sent beside `store`:
   * App Store `{ signedTransaction }`, Play `{ productId, purchaseToken }`, Steam
   * `{ ticket, dlcAppId }`. With `sync: true`, an `ok` syncs before resolving, so
   * `license.isEntitled(flag)` answers the new grant.
   */
  async claim(
    store: CommerceStore,
    payload: Record<string, unknown>,
    opts: { sync?: boolean } = {},
  ): Promise<ClaimResult> {
    const res = await this.call("POST", "distribution/commerce/claim", {
      store,
      ...payload,
    });
    if ("kind" in res) return res;
    const b = isRecord(res.body) ? res.body : {};
    const result: ClaimResult = {
      kind: "ok",
      store: String(b.store ?? store),
      productId: String(b.productId ?? ""),
      flag: String(b.flag ?? ""),
      ...(typeof b.deliverable === "string"
        ? { deliverable: b.deliverable }
        : {}),
      state: String(b.state ?? ""),
      granted: b.granted === true,
      changed: b.changed === true,
    };
    if (opts.sync) await this.onClaimed().catch(() => undefined);
    return result;
  }

  /** The Steam claim: `ticketHex` from `GetAuthTicketForWebApi` (its identity the binding id),
   *  `dlcAppId` the DLC's Steam app id. */
  claimSteam(
    ticketHex: string,
    dlcAppId: string,
    opts: { sync?: boolean } = {},
  ): Promise<ClaimResult> {
    return this.claim(
      "steam",
      { ticket: ticketHex, dlcAppId },
      { sync: opts.sync !== false },
    );
  }

  /** The App Store claim: the StoreKit 2 transaction's JWS (`Transaction.jwsRepresentation`). */
  claimAppStore(
    signedTransaction: string,
    opts: { sync?: boolean } = {},
  ): Promise<ClaimResult> {
    return this.claim(
      "app-store",
      { signedTransaction },
      { sync: opts.sync !== false },
    );
  }

  /** The Play claim: the purchase's product id and token. */
  claimPlay(
    productId: string,
    purchaseToken: string,
    opts: { sync?: boolean } = {},
  ): Promise<ClaimResult> {
    return this.claim(
      "play",
      { productId, purchaseToken },
      { sync: opts.sync !== false },
    );
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ body: unknown } | CommerceRefusal> {
    this.ctx.requireService("distribution", Feature.commerceReceipt);
    const f = this.ctx.fetcher();
    const token = this.tokens.current;
    if (!token)
      return {
        kind: "refused",
        code: ErrorCode.notEntitled,
        reason: "no_license",
        status: 0,
        message: "this device holds no licence to grant to: enrol first",
      };
    let res: Response;
    try {
      res = await f(this.ctx.url(path), {
        method,
        headers: this.ctx.headers({
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        }),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: this.ctx.deadline(),
      });
    } catch (e) {
      return {
        kind: "error",
        code: "network",
        status: 0,
        message: (e as Error).message,
      };
    }
    const parsed: unknown = await res.json().catch(() => null);
    if (res.ok) return { body: parsed };
    const b = isRecord(parsed) ? parsed : {};
    const nested = isRecord(b.error) ? b.error : undefined;
    const code =
      typeof b.error === "string"
        ? b.error
        : typeof nested?.code === "string"
          ? nested.code
          : res.status >= 500
            ? "server"
            : res.status === 404
              ? ErrorCode.notFound
              : ErrorCode.forbidden;
    const reason =
      typeof b.reason === "string"
        ? b.reason
        : typeof nested?.reason === "string"
          ? nested.reason
          : undefined;
    const message =
      typeof b.message === "string"
        ? b.message
        : typeof nested?.message === "string"
          ? nested.message
          : "";
    const kind: CommerceRefusal["kind"] =
      code === "attestation_required"
        ? "attestation-required"
        : reason === "not_owned"
          ? "not-owned"
          : res.status >= 500 && code === "server"
            ? "error"
            : "refused";
    return {
      kind,
      code,
      ...(reason !== undefined ? { reason } : {}),
      status: res.status,
      message,
    };
  }
}
