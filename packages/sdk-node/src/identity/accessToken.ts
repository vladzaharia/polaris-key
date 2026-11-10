// `identity.accessToken()` (identity.accesstoken, D6, WIRE-CONTRACT-V5 §12.13.10): the app's own
// short-lived access token for its own backend, from its device token.
//
// WHAT IT PROVES: this device holds a sign-in (`sub` is the device's pairwise subject, `client_id`
// the product). It is NOT a licence check: no tier, no entitlement, and a signed-in device has
// one whether or not its licence is valid. A backend that sells a licensed feature also checks
// the licence (the server drop-ins).
//
// Discovery gates it: only a product whose identity fragment carries `accessToken: true` (its
// issuer is served) is asked; otherwise the call is the typed `service-unavailable` N/A with no
// request. The token lives in memory only, is reused until 60 seconds before it expires, is
// asked for once at a time and is dropped at sign-out. The SDK never verifies it.

import {
  AccessTokenCache,
  PolarisError,
  UnsupportedError,
  accessTokenRequest,
  readAccessToken,
  type AccessToken,
} from "@polaris-key/client-core";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import { classifyResponse, errorFrom } from "../core/http.js";
import type { TokenManager } from "../core/token.js";
import {
  identityFragmentFrom,
  type ProductDiscoveryDocument,
} from "../discovery.js";

export type { AccessToken };

export interface AccessTokensDeps {
  ctx: CoreContext;
  tokens: TokenManager;
  /** Discovery, loaded on demand. */
  discovery: () => Promise<ProductDiscoveryDocument | null>;
}

export class AccessTokens {
  readonly #cache: AccessTokenCache;

  constructor(private readonly deps: AccessTokensDeps) {
    this.#cache = new AccessTokenCache(() => deps.ctx.now());
  }

  /** Drop the held token (sign-out, deactivation). */
  clear(): void {
    this.#cache.clear();
  }

  async get(opts: { refresh?: boolean } = {}): Promise<AccessToken> {
    const { ctx, tokens } = this.deps;
    ctx.requireService("identity", Feature.identityAccesstoken);
    const fragment = identityFragmentFrom(await this.deps.discovery());
    const endpoint = (fragment?.endpoints as Record<string, string> | undefined)
      ?.token;
    if (fragment?.accessToken !== true || !endpoint)
      throw new UnsupportedError(
        {
          supported: false,
          feature: Feature.identityAccesstoken,
          reason: "product",
          detail:
            "this product's discovery names no access token exchange: its sign-in issuer is not served",
        },
        ErrorCode.serviceUnavailable,
      );
    return this.#cache
      .get(async () => {
        // Read at the time of the call: a device that signed out meanwhile has none.
        const deviceToken = tokens.current;
        if (deviceToken === null)
          throw new PolarisError(
            ErrorCode.noToken,
            "Sign in before asking for an access token.",
          );
        const req = accessTokenRequest({
          tokenEndpoint: endpoint,
          clientId: ctx.product,
          deviceToken,
        });
        const res = await ctx.request(
          req.url,
          {
            method: "POST",
            headers: ctx.headers({ "content-type": req.contentType }),
            body: req.body,
          },
          "access token",
        );
        if (res.status !== 200) {
          const c = await classifyResponse(res);
          // The 429's wait is in the body when no `Retry-After` header came with it.
          const inBody = c.body.retryAfter;
          throw errorFrom(
            c.retryAfterSeconds === undefined &&
              typeof inBody === "number" &&
              Number.isFinite(inBody) &&
              inBody >= 0
              ? { ...c, retryAfterSeconds: Math.ceil(inBody) }
              : c,
            "access token",
          );
        }
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        return readAccessToken(body);
      }, opts)
      .catch((e: unknown) => {
        // The Worker's one refusal for a device that holds no sign-in: nothing held is good any more.
        if (e instanceof PolarisError && e.code === ErrorCode.invalidGrant)
          this.#cache.clear();
        throw e;
      });
  }
}
