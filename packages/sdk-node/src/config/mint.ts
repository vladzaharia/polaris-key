// Edge-mint — `GET /<p>/config/mint/<recipeId>/token` (Config, P0-12).
//
// A product declares a recipe (alg, key, claims template, lifetime) and an operator approves
// it; the Worker signs a short-lived token for a third party (Apple MusicKit's developer token
// is the first instance) for any device of the product that presents its device token. This is
// how a catalog secret with `delivery: "edgeMint"` reaches a runtime without the signing key
// ever leaving the Worker.
//
// THE CACHE IS MEMORY ONLY. A minted token is a live credential for someone else's API, so it
// is never written to the cache file or the keyring, and it dies with the process. Within one
// process it is reused until `expiresAt` minus a 30-second margin, so a host that asks for the
// token on every API call costs one mint per lifetime rather than one per call (and does not
// burn the per-device budget, P0-12).

import { PolarisError } from "@polaris-key/client-core";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";

/** What a mint returns. */
export interface MintedToken {
  token: string;
  /** Epoch seconds. */
  expiresAt: number;
}

/** A cached token is reused until this many seconds before its `expiresAt`. */
export const MINT_REUSE_MARGIN_SECONDS = 30;

/** The router's recipe-id alphabet (`MINT_ID` in the Worker's `services/config/routes.ts`): a
 *  traversal or an encoded separator can never reach the recipe lookup, so an id outside it is
 *  refused here instead of sent. */
export const MINT_ID = /^[a-z0-9-]+$/;

/** The per-client, per-recipe memory cache, with in-flight sharing so two concurrent asks for
 *  the same recipe make one request. */
export class MintCache {
  readonly tokens = new Map<string, MintedToken>();
  readonly inFlight = new Map<string, Promise<MintedToken>>();
}

export async function mintToken(
  ctx: CoreContext,
  tokens: TokenManager | undefined,
  cache: MintCache,
  recipeId: string,
): Promise<MintedToken> {
  ctx.requireService("config");
  if (!MINT_ID.test(recipeId)) {
    throw new PolarisError(
      "bad_request",
      `"${recipeId}" is not an edge-mint recipe id (lowercase letters, digits and "-").`,
    );
  }
  const held = cache.tokens.get(recipeId);
  if (held && ctx.now() < held.expiresAt - MINT_REUSE_MARGIN_SECONDS)
    return held;
  const pending = cache.inFlight.get(recipeId);
  if (pending) return pending;
  const request = mintOnce(ctx, tokens, recipeId).then(
    (minted) => {
      cache.tokens.set(recipeId, minted);
      return minted;
    },
    (e: unknown) => {
      cache.tokens.delete(recipeId);
      throw e;
    },
  );
  cache.inFlight.set(recipeId, request);
  try {
    return await request;
  } finally {
    cache.inFlight.delete(recipeId);
  }
}

async function mintOnce(
  ctx: CoreContext,
  tokens: TokenManager | undefined,
  recipeId: string,
): Promise<MintedToken> {
  let res = await get(ctx, tokens?.current ?? null, recipeId);
  if (res.status === 401 && tokens && (await tokens.reacquire())) {
    res = await get(ctx, tokens.current, recipeId);
  }
  if (res.status === 200) {
    const b = (await res.json().catch(() => ({}))) as {
      token?: unknown;
      expiresAt?: unknown;
    };
    if (typeof b.token !== "string" || typeof b.expiresAt !== "number") {
      throw new PolarisError(
        "bad_response",
        "edge-mint answered without a token and its expiry.",
      );
    }
    return { token: b.token, expiresAt: b.expiresAt };
  }
  const body = (await res.json().catch(() => ({}))) as {
    error?: string | { code?: string };
    message?: string;
  };
  const code =
    typeof body.error === "string"
      ? body.error
      : (body.error?.code ?? `http_${res.status}`);
  throw new PolarisError(
    code,
    body.message ??
      `edge-mint of "${recipeId}" failed with status ${res.status}.`,
  );
}

/** One GET, or a local refusal when there is no credential to present. */
async function get(
  ctx: CoreContext,
  token: string | null,
  recipeId: string,
): Promise<Response> {
  if (!token) {
    throw new PolarisError(
      "unauthorized",
      "edge-mint needs a device token: activate, enrol, sign in or register first.",
    );
  }
  const f = ctx.fetcher();
  try {
    return await f(ctx.url(`config/mint/${recipeId}/token`), {
      headers: ctx.headers({ authorization: `Bearer ${token}` }),
      signal: ctx.deadline(),
    });
  } catch (e) {
    throw new PolarisError("network-error", (e as Error).message);
  }
}
