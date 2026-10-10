/**
 * Who may read a feed (F-02, plans/F-01.md §6.6; F-21, plans/F-20.md §6.2): the credential
 * extractor, principal resolution and `authorizeFeedRead`.
 *
 * Every registry read goes through `authorizeFeedRead`, and it runs BEFORE the Cache API lookup
 * (`cache.ts`), so a disabled feed or a tightened mode stops a cached answer, even an
 * immutable one held at the edge for a year, within the 30-second settings window
 * (`settings.ts`).
 *
 * THE LADDER, in order; the first failure decides:
 *   0. the owner product's `status` is not `active` (deleted, …) → not-found;
 *   1. the platform kill switch for the ecosystem (`dist_registry_policy.enabled`) → not-found;
 *   2. the owner's Distribution, its `packageFeeds` and the feed's `enabled` → not-found;
 *   3. the mode: `stricter(feed.access_mode, dist_access(deliverable).mode)` on Distribution's
 *      ladder `public < authenticated < licensed < entitled` (`access.ts`). A list document
 *      passes `deliverableId: null`, and only the feed's mode counts;
 *   4. `public` admits anyone, `cache: "public"`. A credential on a public read is never looked
 *      up, so the public hot path reads no token;
 *   5. every other mode resolves the credential, now and only now (lazily, through Core's
 *      30-second cache, `core/registryTokens.ts`), and judges the principal:
 *        - anonymous (no credential, or one that resolves to nothing: malformed, unknown,
 *          expired, revoked, another owner's, outside its ecosystems, a URL token in a header
 *          or the reverse) → the client's native challenge, 401;
 *        - `owner` (a console token) or `ci` (any `pkeyci_` of the owner) → admit, every mode
 *          (Q4);
 *        - `license` → `licenseUsable` for `authenticated` and `licensed` (one strictness, as
 *          `access.ts`); for `entitled`, also the deliverable's `dist_access.entitlement` flag,
 *          held by the licence (`licenseHoldsFlags`). No gate fails closed. A list document
 *          needs only a usable licence. A refusal here is 403, natively.
 *      Every admit at step 5 is `cache: "private"`: `serve.ts` forces `private, no-store`, drops
 *      the ETag and never touches the Cache API.
 * A missing row at steps 1 and 2 is "off" (fail closed). "Off" answers the host's not-found, so
 * it cannot be told apart from an owner or feed that does not exist.
 *
 * A token never widens past the mode: it is judged only where the mode is not `public`, and only
 * for its own owner and ecosystems. The credential is never logged, stored or echoed.
 */

import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../env.js";
import { json } from "../../../core/errors.js";
import type { ServicesMap } from "../../../core/services.js";
import {
  registryHostname,
  registryNotFound,
  type RegistryEcosystem,
} from "../../../core/registryHost.js";
import { licenseUsable } from "../../../core/devices.js";
import { licenseHoldsFlags } from "../../../core/entitledAccess.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import {
  ANONYMOUS,
  REGISTRY_TOKEN_TTL_SECONDS,
  isPullToken,
  isRegistryToken,
  lookupRegistryCredential,
  lookupRegistrySubject,
  principalOf,
  verifyPullToken,
  type FeedPrincipal,
  type ResolvedRegistryToken,
} from "../../../core/registryTokens.js";
import { stricter } from "../access.js";
import {
  extractFeedCredential,
  type FeedCredential,
} from "../../../core/registryCredential.js";
import {
  cachedAccessMode,
  cachedEntitlement,
  cachedRegistrySettings,
  d1RegistrySettings,
  type RegistryFeed,
  type RegistrySettingsSource,
} from "./settings.js";

export type { FeedPrincipal } from "../../../core/registryTokens.js";

// The extractor and the credential type live in Core since F-22 (`core/registryCredential.ts`),
// because Release's native publish routes read them too; re-exported unchanged.
export { extractFeedCredential, type FeedCredential };

/** The `/t/<token>/` segment's credential (Godot's tokenised URLs, §6.3). */
export function pathCredential(token: string): FeedCredential {
  return { scheme: "path", token };
}

/** How a refused read is answered: the not-found, HTTP Basic, or OCI's bearer challenge. */
export type ChallengeKind = "not-found" | "basic" | "oci-bearer";

/** Every refusal: a challenge, a 403 (a valid credential the mode does not admit) or a 429. */
export type RefusalKind = ChallengeKind | "forbidden" | "rate-limited";

export type FeedReadDecision =
  | { readonly ok: true; readonly cache: "public" }
  | {
      readonly ok: true;
      readonly cache: "private";
      /** Who was admitted (never `anonymous`): the private-read budget keys on its token. */
      readonly principal: Exclude<FeedPrincipal, { kind: "anonymous" }>;
    }
  | { readonly ok: false; readonly challenge: RefusalKind };

/** What `authorizeFeedRead` reads. `settings` defaults to the D1 source over `db`. */
export interface FeedReadContext {
  readonly db: Db;
  /** For credential resolution (the pepper, the pull-token key, the limiter). Without it every
   *  credential resolves to `anonymous`. */
  readonly env?: Env;
  /** The owner's service map (`ProductPublic.services`). */
  readonly services: ServicesMap;
  readonly settings?: RegistrySettingsSource;
  /** The clock the caches are judged by, in milliseconds. */
  readonly nowMs?: number;
  /** OCI only: the repository read, which an OCI pull token must grant. */
  readonly repository?: string;
  /** The caller's IP, for the `registryCredentialMiss` budget. */
  readonly ip?: string;
  /** Finish background work (a token's `last_used_at`) after answering. */
  readonly waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * The challenge a non-public mode answers an anonymous client with, by ecosystem. Each feed
 * adapter declares the same value as `capabilities.authChallenge`, and the conformance suite
 * (`test/feedAdapters.test.ts`) pins the two together, so the console never claims a challenge
 * the ladder does not send.
 */
export function challengeFor(ecosystem: RegistryEcosystem): ChallengeKind {
  return ecosystem === "oci" ? "oci-bearer" : "basic";
}

/** A resolution, or the miss budget spent (the caller answers 429). */
type Resolution = FeedPrincipal | "rate-limited";

/** Per credential object: one resolution per (owner, ecosystem, repository), so a list document
 *  judging many packages resolves its credential once. */
const resolutions = new WeakMap<
  FeedCredential,
  Map<string, Promise<Resolution>>
>();

/** `registryCredentialMiss` (plans/F-20.md §6.6): lookups that missed the cache AND D1. */
const CREDENTIAL_MISS_LIMIT = { limit: 30, windowSec: 60 };

async function resolveUncached(
  ctx: FeedReadContext,
  credential: FeedCredential,
  owner: string,
  ecosystem: RegistryEcosystem,
): Promise<Resolution> {
  const env = ctx.env;
  if (!env) return ANONYMOUS;
  const opts = {
    ...(ctx.nowMs !== undefined ? { nowMs: ctx.nowMs } : {}),
    ...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
  };
  const nowMs = ctx.nowMs ?? Date.now();
  // An OCI pull token (`/v2/token`'s): identity only, re-resolved on every request.
  if (credential.scheme === "bearer" && isPullToken(credential.token)) {
    if (ecosystem !== "oci" || ctx.repository === undefined) return ANONYMOUS;
    const claims = await verifyPullToken(
      env,
      credential.token,
      Math.floor(nowMs / 1000),
    );
    if (!claims || claims.sub === "anonymous" || claims.own !== owner)
      return ANONYMOUS;
    if (!claims.repos.includes(`${owner}/${ctx.repository}`)) return ANONYMOUS;
    const resolved = await lookupRegistrySubject(
      ctx.db,
      owner,
      claims.sub,
      opts,
    );
    return resolved && headerPresented(resolved)
      ? principalOf(resolved)
      : ANONYMOUS;
  }
  // A URL token arrives only in Godot's path segment; a header token never does.
  if (credential.scheme === "path" && !isRegistryToken(credential.token))
    return ANONYMOUS;
  const { resolved, miss } = await lookupRegistryCredential(
    env,
    ctx.db,
    credential.token,
    opts,
  );
  if (miss) {
    const ok = await rateLimitOk(
      env,
      owner,
      {
        bucket: "registryCredentialMiss",
        id: ctx.ip ?? "unknown",
        ...CREDENTIAL_MISS_LIMIT,
      },
      Math.floor(nowMs / 1000),
    );
    if (!ok) return "rate-limited";
  }
  if (!resolved) return ANONYMOUS;
  const presented =
    credential.scheme === "path"
      ? resolved.kind !== "ci" && resolved.presentation === "url"
      : headerPresented(resolved);
  return presented ? principalOf(resolved) : ANONYMOUS;
}

function headerPresented(resolved: ResolvedRegistryToken): boolean {
  return resolved.kind === "ci" || resolved.presentation === "header";
}

/** Who `credential` is for `owner`'s `ecosystem` feed (anonymous when it is nobody). */
export function resolveFeedPrincipal(
  ctx: FeedReadContext,
  credential: FeedCredential | null,
  owner: string,
  ecosystem: RegistryEcosystem,
): Promise<Resolution> {
  if (credential === null) return Promise.resolve(ANONYMOUS);
  let byKey = resolutions.get(credential);
  if (!byKey) {
    byKey = new Map();
    resolutions.set(credential, byKey);
  }
  const key = `${owner}\u0000${ecosystem}\u0000${ctx.repository ?? ""}`;
  let p = byKey.get(key);
  if (!p) {
    p = resolveUncached(ctx, credential, owner, ecosystem);
    byKey.set(key, p);
  }
  return p;
}

/** A licence's hold on one gate flag, per isolate for the token window. */
const holds = new Map<string, { held: boolean; until: number }>();

async function licenceHolds(
  db: Db,
  owner: string,
  principal: Extract<FeedPrincipal, { kind: "license" }>,
  flag: string,
  nowMs: number,
): Promise<boolean> {
  const key = `${owner}\u0000${principal.license.id}\u0000${principal.license.modified_at}\u0000${flag}`;
  const hit = holds.get(key);
  if (hit && hit.until > nowMs) return hit.held;
  const held = await licenseHoldsFlags(
    db,
    owner,
    principal.license,
    [flag],
    Math.floor(nowMs / 1000),
  );
  if (holds.size >= 5_000) holds.clear();
  holds.set(key, { held, until: nowMs + REGISTRY_TOKEN_TTL_SECONDS * 1000 });
  return held;
}

/**
 * Steps 0 to 2 of the ladder: the feed's settings when the owner is active, the ecosystem is not
 * killed, and the owner's Distribution, `packageFeeds` and the feed are all on; else `null`
 * (the host's not-found).
 */
export async function feedAnswering(
  ctx: FeedReadContext,
  owner: string,
  ecosystem: RegistryEcosystem,
): Promise<RegistryFeed | null> {
  const source = ctx.settings ?? d1RegistrySettings(ctx.db);
  const nowMs = ctx.nowMs ?? Date.now();
  const {
    productStatus,
    policy,
    owner: ownerRow,
    feed,
  } = await cachedRegistrySettings(source, owner, ecosystem, nowMs);
  // 0. A deleted (or otherwise not active) product serves nothing, whatever its feed rows say.
  if (productStatus !== undefined && productStatus !== "active") return null;
  // 1. The platform kill switch.
  if (!policy?.enabled) return null;
  // 2. Distribution, packageFeeds, the feed.
  if (ctx.services.distribution?.enabled !== true) return null;
  if (!ownerRow?.enabled) return null;
  if (!feed?.enabled) return null;
  return feed;
}

/** May `credential`'s holder read `owner`'s `ecosystem` feed (one deliverable, or the list)? */
export async function authorizeFeedRead(
  ctx: FeedReadContext,
  credential: FeedCredential | null,
  owner: string,
  ecosystem: RegistryEcosystem,
  deliverableId: string | null,
): Promise<FeedReadDecision> {
  const notFound: FeedReadDecision = { ok: false, challenge: "not-found" };
  const source = ctx.settings ?? d1RegistrySettings(ctx.db);
  const nowMs = ctx.nowMs ?? Date.now();
  const feed = await feedAnswering(ctx, owner, ecosystem);
  if (feed === null) return notFound;
  // 3. The mode.
  let mode: ReleaseAccess = feed.accessMode;
  if (deliverableId !== null)
    mode = stricter(
      mode,
      await cachedAccessMode(source, owner, deliverableId, nowMs),
    );
  // 4. Public admits anyone, and no credential is looked up.
  if (mode === "public") return { ok: true, cache: "public" };
  // 5. Resolve the credential now, and judge the principal.
  const challenge: FeedReadDecision = {
    ok: false,
    challenge: challengeFor(ecosystem),
  };
  const principal = await resolveFeedPrincipal(
    ctx,
    credential,
    owner,
    ecosystem,
  );
  if (principal === "rate-limited")
    return { ok: false, challenge: "rate-limited" };
  if (principal.kind === "anonymous") return challenge;
  // Another owner's token, or one narrowed away from this ecosystem, is no credential here.
  if (principal.product !== owner) return challenge;
  if (
    principal.kind !== "ci" &&
    principal.ecosystems !== null &&
    !principal.ecosystems.includes(ecosystem)
  )
    return challenge;
  if (principal.kind === "owner" || principal.kind === "ci")
    return { ok: true, cache: "private", principal };
  const forbidden: FeedReadDecision = { ok: false, challenge: "forbidden" };
  if (!licenseUsable(principal.license, Math.floor(nowMs / 1000)))
    return forbidden;
  if (mode === "entitled" && deliverableId !== null) {
    const flag = await cachedEntitlement(source, owner, deliverableId, nowMs);
    // No gate fails closed, as packs do: an entitled package with no flag admits no licence.
    if (flag === null) return forbidden;
    if (!(await licenceHolds(ctx.db, owner, principal, flag, nowMs)))
      return forbidden;
  }
  return { ok: true, cache: "private", principal };
}

/** Drop this isolate's licence-hold cache (tests). */
export function forgetLicenceHolds(): void {
  holds.clear();
}

/** Where a refusal is answered from: the host name in the challenge, OCI's repository. */
export interface RefusalTarget {
  readonly env: Pick<Env, "PKG_ORIGIN" | "BLOB_ORIGIN">;
  readonly ecosystem: RegistryEcosystem;
  readonly owner: string;
  /** OCI only: the repository path under the owner (`<repo…>`), for the challenge's scope. */
  readonly repository?: string;
}

/** A challenge parameter value, quoted: only characters a registry name or host can hold. */
function quoted(v: string): string {
  return `"${v.replace(/[^A-Za-z0-9._:/@+-]/g, "")}"`;
}

/** The `Retry-After` a rate-limited registry read answers with, in seconds. */
const RETRY_AFTER = "60";

/**
 * The answer for a refused read: the host's not-found; a 401 with the client's native challenge
 * (`WWW-Authenticate: Basic realm="<host>"`; for OCI `Bearer realm=…/v2/token, service=<host>,
 * scope=repository:<owner>/<repo>:pull`); a 403 for a valid credential the mode does not admit
 * (`forbidden`, OCI `DENIED`, Swift `problem+json`); or a 429 (`rate_limited`, OCI
 * `TOOMANYREQUESTS`) with `Retry-After`. `no-store` on all of them: a refusal is never cached.
 */
export function feedRefusal(
  challenge: RefusalKind,
  target: RefusalTarget,
): Response {
  if (challenge === "not-found") return registryNotFound(target.ecosystem);
  const host = registryHostname(target.env) ?? "pkg.plrs.im";
  const origin =
    target.env.PKG_ORIGIN !== undefined && registryHostname(target.env)
      ? new URL(target.env.PKG_ORIGIN).origin
      : `https://${host}`;
  const oci = target.ecosystem === "oci";
  const swift = target.ecosystem === "swift";
  const ociHeaders = { "docker-distribution-api-version": "registry/2.0" };
  const swiftHeaders = {
    "content-type": "application/problem+json",
    "content-version": "1",
  };
  if (challenge === "forbidden") {
    if (oci)
      return json(
        {
          errors: [
            {
              code: "DENIED",
              message: "requested access to the resource is denied",
            },
          ],
        },
        { status: 403, headers: ociHeaders },
      );
    if (swift)
      return json(
        { detail: "access to this package is not granted" },
        { status: 403, headers: swiftHeaders },
      );
    return json(
      { error: "forbidden", reason: "not_entitled" },
      { status: 403 },
    );
  }
  if (challenge === "rate-limited") {
    const retry = { "retry-after": RETRY_AFTER };
    if (oci)
      return json(
        { errors: [{ code: "TOOMANYREQUESTS", message: "too many requests" }] },
        { status: 429, headers: { ...ociHeaders, ...retry } },
      );
    if (swift)
      return json(
        { detail: "too many requests" },
        { status: 429, headers: { ...swiftHeaders, ...retry } },
      );
    return json({ error: "rate_limited" }, { status: 429, headers: retry });
  }
  if (challenge === "oci-bearer") {
    const repo = target.repository
      ? `${target.owner}/${target.repository}`
      : target.owner;
    return json(
      {
        errors: [{ code: "UNAUTHORIZED", message: "authentication required" }],
      },
      {
        status: 401,
        headers: {
          ...ociHeaders,
          "www-authenticate": `Bearer realm=${quoted(`${origin}/v2/token`)},service=${quoted(host)},scope=${quoted(`repository:${repo}:pull`)}`,
        },
      },
    );
  }
  const headers = { "www-authenticate": `Basic realm=${quoted(host)}` };
  if (swift)
    return json(
      { detail: "authentication required" },
      { status: 401, headers: { ...headers, ...swiftHeaders } },
    );
  return json({ error: "unauthorized" }, { status: 401, headers });
}
