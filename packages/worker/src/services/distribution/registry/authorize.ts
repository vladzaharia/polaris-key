/**
 * Who may read a feed (F-02, plans/F-01.md §6.6): `feedPrincipal` and `authorizeFeedRead`.
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
 *   4. `public` admits `anonymous`, `cache: "public"`;
 *   5. every other mode refuses `anonymous` in tier 1 with the client's native challenge.
 * A missing row at steps 1 and 2 is "off" (fail closed). "Off" answers the host's not-found, so
 * it cannot be told apart from an owner or feed that does not exist.
 *
 * TIER 1 HAS NO CREDENTIALS. `feedPrincipal` parses every `Authorization` shape a registry
 * client sends (the extractor is built and tested now) and still returns `anonymous`. F-20 and
 * F-21 add token principals by extending `FeedPrincipal` and this ladder's step 5, without
 * changing either signature. The credential is never logged, stored or echoed.
 */

import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { Db, Env } from "../../../core/platform.js";
import { json } from "../../../core/errors.js";
import type { ServicesMap } from "../../../core/services.js";
import {
  registryHostname,
  registryNotFound,
  type RegistryEcosystem,
} from "../../../core/registryHost.js";
import { stricter } from "../access.js";
import {
  cachedAccessMode,
  cachedRegistrySettings,
  d1RegistrySettings,
  type RegistrySettingsSource,
} from "./settings.js";

/** Who is reading. Tier 1 knows only `anonymous`; F-21 adds token principals here. */
export type FeedPrincipal = { readonly kind: "anonymous" };

/** A credential as a registry client sent it. Never logged. */
export interface FeedCredential {
  /** `bearer` (`Authorization: Bearer <t>`), `basic` (`Basic base64(user:pass)`) or `raw`
   *  (`Authorization: <t>`, Cargo's spelling). */
  readonly scheme: "bearer" | "basic" | "raw";
  readonly token: string;
  /** Basic only: the username, when the token is the password. */
  readonly username?: string;
}

const MAX_AUTHORIZATION = 8_192;

function decodeBase64(s: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

/**
 * The credential in `req`'s `Authorization` header, or `null` when there is none or it cannot
 * be parsed. Shapes:
 *   - `Bearer <t>` (npm, OCI after its token dance, SwiftPM, NuGet): the token;
 *   - `Basic base64(user:t)` (pip, uv, Poetry, Gradle, Maven, GodotEnv): the password is the
 *     token, or the username when the password is empty (`base64(t:)`);
 *   - `<t>` with no scheme (Cargo): the whole value.
 * The scheme is matched case-insensitively. Empty tokens, control characters and values over
 * 8 KiB parse as nothing.
 */
export function extractFeedCredential(req: Request): FeedCredential | null {
  const raw = req.headers.get("authorization");
  if (raw === null) return null;
  const value = raw.trim();
  if (value === "" || value.length > MAX_AUTHORIZATION) return null;
  // A header value cannot legitimately carry control characters.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  const sp = value.indexOf(" ");
  const scheme = sp === -1 ? "" : value.slice(0, sp).toLowerCase();
  const rest = sp === -1 ? "" : value.slice(sp + 1).trim();
  if (scheme === "bearer") {
    return rest === "" || /\s/.test(rest)
      ? null
      : { scheme: "bearer", token: rest };
  }
  if (scheme === "basic") {
    const decoded = decodeBase64(rest);
    if (decoded === null) return null;
    const colon = decoded.indexOf(":");
    if (colon === -1) return null;
    const username = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);
    if (password !== "") return { scheme: "basic", token: password, username };
    if (username !== "") return { scheme: "basic", token: username };
    return null;
  }
  // Cargo sends the token as the whole value. A value with a space is some other scheme this
  // host does not speak, and a bare scheme name (`Bearer`, `Basic`) carries no token.
  if (sp === -1)
    return /^(bearer|basic)$/i.test(value)
      ? null
      : { scheme: "raw", token: value };
  return null;
}

/**
 * The reader of `req`. Tier 1: always `anonymous`, whatever the header holds. The extractor
 * runs so its parsing is exercised in production paths too, and its result is dropped.
 */
export function feedPrincipal(req: Request): FeedPrincipal {
  void extractFeedCredential(req);
  return { kind: "anonymous" };
}

/** How a refused read is answered: the not-found, HTTP Basic, or OCI's bearer challenge. */
export type ChallengeKind = "not-found" | "basic" | "oci-bearer";

export type FeedReadDecision =
  | { readonly ok: true; readonly cache: "public" | "private" }
  | { readonly ok: false; readonly challenge: ChallengeKind };

/** What `authorizeFeedRead` reads. `settings` defaults to the D1 source over `db`. */
export interface FeedReadContext {
  readonly db: Db;
  /** The owner's service map (`ProductPublic.services`). */
  readonly services: ServicesMap;
  readonly settings?: RegistrySettingsSource;
  /** The clock the settings cache is judged by, in milliseconds. */
  readonly nowMs?: number;
}

/**
 * The challenge a non-public mode answers in tier 1, by ecosystem. Each feed adapter declares the
 * same value as `capabilities.authChallenge`, and the conformance suite
 * (`test/feedAdapters.test.ts`) pins the two together, so the console never claims a challenge
 * the ladder does not send.
 */
export function challengeFor(ecosystem: RegistryEcosystem): ChallengeKind {
  return ecosystem === "oci" ? "oci-bearer" : "basic";
}

/** May `principal` read `owner`'s `ecosystem` feed (one deliverable, or the list)? */
export async function authorizeFeedRead(
  ctx: FeedReadContext,
  principal: FeedPrincipal,
  owner: string,
  ecosystem: RegistryEcosystem,
  deliverableId: string | null,
): Promise<FeedReadDecision> {
  const notFound: FeedReadDecision = { ok: false, challenge: "not-found" };
  const source = ctx.settings ?? d1RegistrySettings(ctx.db);
  const nowMs = ctx.nowMs ?? Date.now();
  const {
    productStatus,
    policy,
    owner: ownerRow,
    feed,
  } = await cachedRegistrySettings(source, owner, ecosystem, nowMs);
  // 0. A deleted (or otherwise not active) product serves nothing, whatever its feed rows say.
  if (productStatus !== undefined && productStatus !== "active")
    return notFound;
  // 1. The platform kill switch.
  if (!policy?.enabled) return notFound;
  // 2. Distribution, packageFeeds, the feed.
  if (ctx.services.distribution?.enabled !== true) return notFound;
  if (!ownerRow?.enabled) return notFound;
  if (!feed?.enabled) return notFound;
  // 3. The mode.
  let mode: ReleaseAccess = feed.accessMode;
  if (deliverableId !== null)
    mode = stricter(
      mode,
      await cachedAccessMode(source, owner, deliverableId, nowMs),
    );
  // 4. Public admits anyone.
  if (mode === "public") return { ok: true, cache: "public" };
  // 5. Tier 1 has no credentialed principal, so every other mode refuses.
  switch (principal.kind) {
    case "anonymous":
      return { ok: false, challenge: challengeFor(ecosystem) };
  }
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

/**
 * The answer for a refused read: the host's not-found, or a 401 with the client's native
 * challenge (`WWW-Authenticate: Basic realm="<host>"`; for OCI `Bearer realm=…/v2/token,
 * service=<host>, scope=repository:<owner>/<repo>:pull`, whose token endpoint 404s until F-21).
 * `no-store` on all of them: a refusal is never cached.
 */
export function feedRefusal(
  challenge: ChallengeKind,
  target: RefusalTarget,
): Response {
  if (challenge === "not-found") return registryNotFound(target.ecosystem);
  const host = registryHostname(target.env) ?? "pkg.plrs.im";
  const origin =
    target.env.PKG_ORIGIN !== undefined && registryHostname(target.env)
      ? new URL(target.env.PKG_ORIGIN).origin
      : `https://${host}`;
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
          "www-authenticate": `Bearer realm=${quoted(`${origin}/v2/token`)},service=${quoted(host)},scope=${quoted(`repository:${repo}:pull`)}`,
        },
      },
    );
  }
  const headers = { "www-authenticate": `Basic realm=${quoted(host)}` };
  if (target.ecosystem === "swift")
    return json(
      { detail: "authentication required" },
      {
        status: 401,
        headers: { ...headers, "content-type": "application/problem+json" },
      },
    );
  return json({ error: "unauthorized" }, { status: 401, headers });
}
