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
//
// A CACHED TOKEN IS BOUND TO THE DEVICE TOKEN IT WAS MINTED WITH. A hit counts only while the
// client still holds that same device token, so `license.deactivate()`, a cleared or revoked
// token, or a different identity signing in all invalidate it: the call then takes the normal
// path, which refuses with `unauthorized` before any request when no token is held.

import { PolarisError } from "@polaris-key/client-core";
import { Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";
import { redactOnPrint } from "../core/redact.js";

/** What a mint returns. It prints (`console.log`, `JSON.stringify`) with `token` redacted. */
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

/** One cache entry: the minted token and the device token that was presented for it. */
interface Bound<T> {
  deviceToken: string;
  value: T;
}

/** The per-client, per-recipe memory cache, with in-flight sharing so two concurrent asks for
 *  the same recipe (under the same device token) make one request. */
export class MintCache {
  readonly tokens = new Map<string, Bound<MintedToken>>();
  readonly inFlight = new Map<string, Bound<Promise<MintedToken>>>();
}

export async function mintToken(
  ctx: CoreContext,
  tokens: TokenManager | undefined,
  cache: MintCache,
  recipeId: string,
): Promise<MintedToken> {
  ctx.requireService("config", Feature.configMint);
  if (!MINT_ID.test(recipeId)) {
    throw new PolarisError(
      "bad_request",
      `"${recipeId}" is not an edge-mint recipe id (lowercase letters, digits and "-").`,
    );
  }
  const current = tokens?.current ?? null;
  const held = cache.tokens.get(recipeId);
  if (held) {
    if (
      current !== null &&
      held.deviceToken === current &&
      ctx.now() < held.value.expiresAt - MINT_REUSE_MARGIN_SECONDS
    )
      return held.value;
    cache.tokens.delete(recipeId);
  }
  const pending = cache.inFlight.get(recipeId);
  if (pending && current !== null && pending.deviceToken === current)
    return pending.value;
  const request = mintOnce(ctx, tokens, recipeId).then(
    ({ minted, deviceToken }) => {
      cache.tokens.set(recipeId, { deviceToken, value: minted });
      return minted;
    },
    (e: unknown) => {
      cache.tokens.delete(recipeId);
      throw e;
    },
  );
  const entry = { deviceToken: current ?? "", value: request };
  cache.inFlight.set(recipeId, entry);
  try {
    return await request;
  } finally {
    if (cache.inFlight.get(recipeId) === entry) cache.inFlight.delete(recipeId);
  }
}

async function mintOnce(
  ctx: CoreContext,
  tokens: TokenManager | undefined,
  recipeId: string,
): Promise<{ minted: MintedToken; deviceToken: string }> {
  let presented = tokens?.current ?? null;
  let res = await get(ctx, presented, recipeId);
  if (res.status === 401 && tokens && (await tokens.reacquire())) {
    presented = tokens.current;
    res = await get(ctx, presented, recipeId);
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
    return {
      minted: redactOnPrint<MintedToken>(
        { token: b.token, expiresAt: b.expiresAt },
        ["token"],
      ),
      // `get` refused locally when no token was presented, so it is a string here.
      deviceToken: presented as string,
    };
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
