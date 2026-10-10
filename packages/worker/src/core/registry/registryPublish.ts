/// <reference types="@cloudflare/workers-types" />
/**
 * Who may publish through a native client (F-22, plans/F-20.md §9: "publish scope is
 * owner-bound only, implies read").
 *
 * A native publish (`npm publish`, `twine upload`, `swift package-registry publish`, a Maven or
 * Gradle `PUT`) presents its credential the way the client's reads do (`registryCredential.ts`).
 * Exactly two principals may publish into an owner's feed:
 *
 *   - a `pkeyr_` registry token of the owner, bound to the owner (never a licence), presented in
 *     a header (never a Godot URL token), holding the `publish` scope and naming the ecosystem;
 *   - a `pkeyci_` CI token of the owner holding `release:publish`: the same principal
 *     `pkey release publish` uses, and the one CI should present (the 30-minute token
 *     `pkey auth github-oidc` exchanges for the job's OIDC token, so the repository stores no
 *     publish secret at all).
 *
 * Everything else is refused before the request body is read:
 *
 *   challenge     no credential, or one that resolves to nobody for this owner (malformed,
 *                 unknown, expired, revoked, another owner's, a pull or URL token) → the
 *                 client's native 401, so it can prompt or retry with its configured credential;
 *   forbidden     a valid credential of this owner that may not publish here: a read-only or
 *                 licence-bound registry token, one narrowed away from the ecosystem, a CI token
 *                 without `release:publish` → 403;
 *   rate-limited  the `registryCredentialMiss` budget (per IP, only lookups that missed the
 *                 cache and D1) → 429.
 *
 * A publish credential is resolved on every publish (through the same 30-second cache as reads),
 * whatever the feed's read mode: publishing is never public.
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { extractFeedCredential } from "./registryCredential.js";
import { rateLimitOk } from "../rateLimit.js";
import {
  isPullToken,
  isRegistryToken,
  lookupRegistryCredential,
} from "./registryTokens.js";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { CI_TOKEN_PREFIX } from "../ciVocabulary.js";

/** Who published, as the audit and `release_packages.source_json` record it. */
export type PublishPrincipal =
  | {
      readonly kind: "registry";
      readonly product: string;
      readonly tokenId: string;
    }
  | {
      readonly kind: "ci";
      readonly product: string;
      readonly tokenId: string;
      readonly ciKind: "oidc" | "static";
      readonly subject: string;
    };

export type PublishAuthorization =
  | { readonly ok: true; readonly principal: PublishPrincipal }
  | {
      readonly ok: false;
      readonly refusal: "challenge" | "forbidden" | "rate-limited";
      /** For the 403's message: what the credential lacks. */
      readonly reason?: string;
    };

/** `registryCredentialMiss` (plans/F-20.md §6.6), shared with the read ladder. */
const CREDENTIAL_MISS_LIMIT = { limit: 30, windowSec: 60 };

/** The CI scope a native publish needs: the same as `pkey release publish`'s submit. */
const CI_PUBLISH_SCOPE = "release:publish";

export interface PublishAuthInput {
  readonly owner: string;
  readonly ecosystem: string;
  /** The caller's IP, for the miss budget. */
  readonly ip: string;
  readonly nowMs?: number;
  readonly waitUntil?: (p: Promise<unknown>) => void;
}

/** Judge the publish credential of `req` for `owner`'s `ecosystem` feed. Reads no body. */
export async function authorizeRegistryPublish(
  env: Env,
  db: Db,
  req: Request,
  input: PublishAuthInput,
): Promise<PublishAuthorization> {
  // The platform's own SDK feeds are published only by the deploy pipeline, in lockstep with the
  // server (F-10 owner ruling): a hand publish would take a version number forever.
  if (input.owner === SYSTEM_PRODUCT_SLUG)
    return {
      ok: false,
      refusal: "forbidden",
      reason: `the ${SYSTEM_PRODUCT_SLUG} feeds are published by the deploy pipeline only`,
    };
  const credential = extractFeedCredential(req);
  if (credential === null) return { ok: false, refusal: "challenge" };
  const token = credential.token;
  // A pull token is OCI's read identity; it never publishes.
  if (isPullToken(token)) return { ok: false, refusal: "challenge" };
  if (!isRegistryToken(token) && !token.startsWith(CI_TOKEN_PREFIX))
    return { ok: false, refusal: "challenge" };
  const nowMs = input.nowMs ?? Date.now();
  const { resolved, miss } = await lookupRegistryCredential(env, db, token, {
    nowMs,
    ...(input.waitUntil ? { waitUntil: input.waitUntil } : {}),
  });
  if (miss) {
    const ok = await rateLimitOk(
      env,
      input.owner,
      {
        bucket: "registryCredentialMiss",
        id: input.ip,
        ...CREDENTIAL_MISS_LIMIT,
      },
      Math.floor(nowMs / 1000),
    );
    if (!ok) return { ok: false, refusal: "rate-limited" };
  }
  // Another owner's credential is no credential here (no oracle on which owner it belongs to).
  if (!resolved || resolved.product !== input.owner)
    return { ok: false, refusal: "challenge" };
  if (resolved.kind === "ci") {
    if (!resolved.scopes.includes(CI_PUBLISH_SCOPE))
      return {
        ok: false,
        refusal: "forbidden",
        reason: `this CI token lacks the ${CI_PUBLISH_SCOPE} scope`,
      };
    return {
      ok: true,
      principal: {
        kind: "ci",
        product: resolved.product,
        tokenId: resolved.tokenId,
        ciKind: resolved.ciKind,
        subject: resolved.subject,
      },
    };
  }
  // A URL token lives in the Godot editor's settings; it is never a header credential.
  if (resolved.presentation !== "header")
    return { ok: false, refusal: "challenge" };
  if (resolved.kind === "license")
    return {
      ok: false,
      refusal: "forbidden",
      reason: "a licence-bound registry token can only read",
    };
  if (!resolved.scopes.includes("publish"))
    return {
      ok: false,
      refusal: "forbidden",
      reason:
        "this registry token can only read; mint one with the publish scope",
    };
  if (
    resolved.ecosystems !== null &&
    !resolved.ecosystems.includes(input.ecosystem)
  )
    return {
      ok: false,
      refusal: "forbidden",
      reason: `this registry token does not publish to the ${input.ecosystem} feed`,
    };
  return {
    ok: true,
    principal: {
      kind: "registry",
      product: resolved.product,
      tokenId: resolved.tokenId,
    },
  };
}
