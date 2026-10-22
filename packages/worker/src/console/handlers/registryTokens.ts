/**
 * Registry tokens in the console (F-21, plans/F-20.md §6.5): the Tokens tab of both Feeds pages
 * and the licence page's Registry tokens panel, through one handler set parameterised by scope.
 *
 *   Product   /manage/api/products/:slug/distribution/feeds/tokens…
 *   Platform  /manage/api/platform/feeds/tokens…                     (the system product's)
 *
 *   GET   <base>/tokens[?license=<id>]     the owner's tokens (or one licence's), newest first,
 *                                          plus `serviceTokens` (the product's `packages:read`
 *                                          CI tokens; none for a licence filter); an owner-bound
 *                                          read `pkeyr_` is flagged `legacy` (honoured until it
 *                                          expires, never minted again),
 *                                          with the owner's feeds (for the setup snippets)
 *   POST  <base>/tokens                    {label, ecosystems?, expiresInDays?, binding,
 *                                          licenseId?, presentation?, scopes?} — mint; the
 *                                          plaintext is in this answer only
 *                                          (`registry_token.create`). `scopes` `["read",
 *                                          "publish"]` (F-23) mints an owner-bound push token
 *                                          `binding: "service"` (F-33b.3) mints a read service
 *                                          token: a `pkeyci_` CI token holding only
 *                                          `packages:read`, {label, expiresInDays?} (1 to 365
 *                                          days, default 90), `service_token.create`. Not on the
 *                                          platform scope (`system_service_tokens`)
 *   POST  <base>/tokens/:tokenId/revoke    `registry_token.revoke`; a `cit_…` id revokes one of
 *                                          the product's service tokens (`service_token.revoke`)
 *   POST  <base>/tokens/revoke-all         {licenseId?} — `registry_token.revoke_all`
 *
 * The store is Core's (`core/registry/registryTokens.ts`); this layer adds the session, the audit and the
 * scope. Product-scope actions are audited under the product, platform-scope ones in
 * `platform_audit`. Narrative-only under rule 10 (`adminApi`), documented on `/docs/admin/feeds/`.
 */

import { SYSTEM_PRODUCT_SLUG, PACKAGE_ECOSYSTEMS } from "@polaris-key/manifest";
import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import type { AdminSession } from "../../core/console/session.js";
import {
  adminJson,
  err,
  notFound,
  readBody,
} from "../../core/console/respond.js";
import {
  audit,
  listAudit,
  listPlatformAudit,
  platformAudit,
} from "../../core/audit.js";
import {
  STATIC_CI_READ_TOKEN_MAX_TTL_SECONDS,
  issueStaticCiToken,
  listServiceTokens,
  liveServiceTokens,
  revokeAllServiceTokens,
  revokeServiceToken,
  type CiTokenListing,
} from "../../core/publisher.js";
import { PACKAGES_READ_CI_SCOPE } from "../../core/ciVocabulary.js";
import { getProduct } from "../../core/products/store.js";
import { can, productScope } from "../authz.js";
import { registryOrigin } from "../../core/hosts.js";
import {
  MAX_LIVE_TOKENS_PER_LICENSE,
  REGISTRY_TOKEN_LABEL_MAX,
  MAX_LIVE_TOKENS_PER_OWNER,
  REGISTRY_TOKEN_DEFAULT_DAYS,
  REGISTRY_TOKEN_MAX_DAYS,
  REGISTRY_TOKEN_MIN_DAYS,
  REGISTRY_PUBLISH_ECOSYSTEMS,
  REGISTRY_PUBLISH_TOKEN_DEFAULT_DAYS,
  REGISTRY_PUBLISH_TOKEN_MAX_DAYS,
  REGISTRY_TOKEN_USERNAME,
  REGISTRY_URL_TOKEN_DEFAULT_DAYS,
  forgetRegistryTokens,
  listRegistryTokens,
  mintRegistryToken,
  revokeAllRegistryTokens,
  revokeRegistryToken,
  type RegistryTokenFilter,
} from "../../core/registry/registryTokens.js";
import { feedBaseUrl, ECOSYSTEM_LABELS } from "../lib/feedModel.js";
import type { FeedScope } from "./feeds.js";

const BODY_KEYS = [
  "label",
  "ecosystems",
  "expiresInDays",
  "binding",
  "licenseId",
  "presentation",
  // `["read"]` (the default) or `["publish"]` (owner-bound, named ecosystems, ≤ 30 days): F-22's
  // native publishes and F-23's `docker push`.
  "scopes",
] as const;

/** The scope's owner slug, or `null` (an unknown product, or no system product yet). */
async function ownerSlug(db: Db, scope: FeedScope): Promise<string | null> {
  const slug = scope.kind === "product" ? scope.slug : SYSTEM_PRODUCT_SLUG;
  const row = await getProduct(db, slug);
  if (!row) return null;
  if (scope.kind === "platform" && row.system !== 1) return null;
  return slug;
}

async function record(
  db: Db,
  scope: FeedScope,
  owner: string,
  session: AdminSession,
  now: number,
  action: string,
  target: { kind: string; id: string } | null,
  summary: string,
): Promise<void> {
  if (scope.kind === "platform")
    await platformAudit(db, session, now, action, target, summary);
  else await audit(db, owner, session, now, action, target, summary);
}

/** A feed's stored namespace (`{}` when unset or unreadable): the setup snippets name it. */
function namespaceOf(json: string | null | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json ?? "{}");
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The owner's feeds, as the snippets and the console's access hints need them. */
async function feedsOf(env: Env, db: Db, owner: string) {
  const rows = await db.all<{
    ecosystem: string;
    enabled: number;
    access_mode: string;
    namespace_json: string | null;
  }>(
    "SELECT ecosystem, enabled, access_mode, namespace_json FROM dist_registry_feeds WHERE product = ?",
    owner,
  );
  const origin = registryOrigin(env);
  return PACKAGE_ECOSYSTEMS.map((eco) => {
    const row = rows.find((r) => r.ecosystem === eco);
    return {
      ecosystem: eco,
      label: ECOSYSTEM_LABELS[eco],
      enabled: row?.enabled === 1,
      accessMode: row?.access_mode ?? "public",
      baseUrl: feedBaseUrl(origin, eco, owner),
      namespace: namespaceOf(row?.namespace_json),
    };
  });
}

function filterOf(req: Request): RegistryTokenFilter {
  const license = new URL(req.url).searchParams.get("license");
  return license ? { licenseId: license } : {};
}

/** Who revoked a service token and how: the `ci_tokens` row keeps only `revoked_at`. */
export interface ServiceRevocation {
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
}

const NO_REVOCATION: ServiceRevocation = {
  revokedBy: null,
  revokeReason: null,
};

/**
 * `revokedBy` and `revokeReason` of the revoked service tokens in `tokens`, read from the audit
 * trail (`ci_tokens` has no such columns and F-33b.5 adds no migration):
 *  - `manual`: the `service_token.revoke` row naming the token;
 *  - `revoke_all`: the product-wide row written at the same second as the token's `revoked_at`.
 * A revocation older than the newest 200 audit rows, or made by the platform itself, reads as
 * `null`, which the console shows as no "Revoked by" line.
 */
async function serviceRevocations(
  db: Db,
  scope: FeedScope,
  owner: string,
  tokens: readonly CiTokenListing[],
): Promise<Map<string, ServiceRevocation>> {
  const out = new Map<string, ServiceRevocation>();
  const revoked = tokens.filter((t) => t.revokedAt !== null);
  if (revoked.length === 0) return out;
  const filter = { action: "service_token.revoke", limit: 200 };
  const rows =
    scope.kind === "platform"
      ? await listPlatformAudit(db, filter)
      : await listAudit(db, owner, filter);
  for (const t of revoked) {
    // The row that revoked it, not a later idempotent re-revoke (which writes a row too).
    const own = rows.find(
      (r) =>
        r.target_kind === "ci_token" &&
        r.target_id === t.tokenId &&
        r.at === t.revokedAt,
    );
    const all = rows.find(
      (r) =>
        r.target_kind === "product" &&
        r.target_id === owner &&
        r.at === t.revokedAt,
    );
    const hit = own ?? all;
    const by = hit ? hit.actor_email || hit.actor_sub : null;
    out.set(
      t.tokenId,
      hit && by
        ? {
            revokedBy: `admin:${by}`,
            revokeReason: own ? "manual" : "revoke_all",
          }
        : NO_REVOCATION,
    );
  }
  return out;
}

/** A read service token as the console lists it. Never a hash, never the token. */
function serviceView(
  t: CiTokenListing,
  now: number,
  by: ServiceRevocation = NO_REVOCATION,
) {
  return {
    tokenId: t.tokenId,
    label: t.label ?? "",
    scopes: t.scopes,
    createdBy: t.createdBy,
    createdAt: t.issuedAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    hint: t.hint,
    revokedAt: t.revokedAt,
    revokedBy: t.revokedAt !== null ? by.revokedBy : null,
    revokeReason: t.revokedAt !== null ? by.revokeReason : null,
    status:
      t.revokedAt !== null
        ? ("revoked" as const)
        : t.expiresAt <= now
          ? ("expired" as const)
          : ("active" as const),
  };
}

async function serviceViews(
  db: Db,
  scope: FeedScope,
  owner: string,
  now: number,
) {
  const tokens = await listServiceTokens(db, owner, now);
  const by = await serviceRevocations(db, scope, owner, tokens);
  return tokens.map((t) => serviceView(t, now, by.get(t.tokenId)));
}

const SERVICE_TOKEN_DEFAULT_DAYS = 90;
const SERVICE_TOKEN_MAX_DAYS = STATIC_CI_READ_TOKEN_MAX_TTL_SECONDS / 86_400;

async function list(
  req: Request,
  env: Env,
  db: Db,
  scope: FeedScope,
  owner: string,
  now: number,
): Promise<Response> {
  return adminJson({
    owner,
    registryOrigin: registryOrigin(env),
    username: REGISTRY_TOKEN_USERNAME,
    tokens: (await listRegistryTokens(db, owner, now, filterOf(req))).map(
      (t) => ({
        ...t,
        // An owner-wide read token is retired (F-33b.3): it works until it expires.
        legacy: t.binding === "owner" && !t.scopes.includes("publish"),
      }),
    ),
    serviceTokens: new URL(req.url).searchParams.get("license")
      ? []
      : await serviceViews(db, scope, owner, now),
    feeds: await feedsOf(env, db, owner),
    limits: {
      minDays: REGISTRY_TOKEN_MIN_DAYS,
      maxDays: REGISTRY_TOKEN_MAX_DAYS,
      defaultDays: REGISTRY_TOKEN_DEFAULT_DAYS,
      urlDefaultDays: REGISTRY_URL_TOKEN_DEFAULT_DAYS,
      perOwner: MAX_LIVE_TOKENS_PER_OWNER,
      perLicense: MAX_LIVE_TOKENS_PER_LICENSE,
      // F-22: publish tokens are shorter-lived and name their ecosystems.
      serviceDefaultDays: SERVICE_TOKEN_DEFAULT_DAYS,
      serviceMaxDays: SERVICE_TOKEN_MAX_DAYS,
      publishDefaultDays: REGISTRY_PUBLISH_TOKEN_DEFAULT_DAYS,
      publishMaxDays: REGISTRY_PUBLISH_TOKEN_MAX_DAYS,
      // None on the platform scope: its SDK feeds are published by the deploy pipeline only.
      publishEcosystems:
        owner === SYSTEM_PRODUCT_SLUG ? [] : REGISTRY_PUBLISH_ECOSYSTEMS,
    },
  });
}

async function create(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  scope: FeedScope,
  owner: string,
  now: number,
): Promise<Response> {
  const body = await readBody(req);
  const unknown = Object.keys(body).filter(
    (k) => !(BODY_KEYS as readonly string[]).includes(k),
  );
  if (unknown.length)
    return err(422, "bad_request", "unknown token field", { fields: unknown });
  const fields: string[] = [];
  if (typeof body.label !== "string") fields.push("label");
  if (
    body.ecosystems !== undefined &&
    body.ecosystems !== null &&
    !(
      Array.isArray(body.ecosystems) &&
      body.ecosystems.every((e) => typeof e === "string")
    )
  )
    fields.push("ecosystems");
  if (
    body.expiresInDays !== undefined &&
    typeof body.expiresInDays !== "number"
  )
    fields.push("expiresInDays");
  if (
    body.binding !== "owner" &&
    body.binding !== "license" &&
    body.binding !== "service"
  )
    fields.push("binding");
  if (body.licenseId !== undefined && typeof body.licenseId !== "string")
    fields.push("licenseId");
  if (
    body.presentation !== undefined &&
    body.presentation !== "header" &&
    body.presentation !== "url"
  )
    fields.push("presentation");
  if (
    body.scopes !== undefined &&
    !(
      Array.isArray(body.scopes) &&
      body.scopes.every((x) => typeof x === "string")
    )
  )
    fields.push("scopes");
  if (fields.length)
    return err(422, "bad_request", "invalid registry token", { fields });
  if (body.binding === "service")
    return createService(body, env, db, session, scope, owner, now);
  const res = await mintRegistryToken(
    env,
    db,
    {
      product: owner,
      label: body.label as string,
      ecosystems: (body.ecosystems as string[] | null | undefined) ?? null,
      ...(body.expiresInDays !== undefined
        ? { expiresInDays: body.expiresInDays as number }
        : {}),
      binding: body.binding as "owner" | "license",
      licenseId: (body.licenseId as string | undefined) ?? null,
      presentation:
        (body.presentation as "header" | "url" | undefined) ?? "header",
      // `["publish"]` mints a publish token (owner-bound header tokens only; F-22 and F-23).
      ...(body.scopes !== undefined ? { scopes: body.scopes as string[] } : {}),
      createdBy: `admin:${session.email || session.sub}`,
    },
    now,
  );
  if (!res.ok)
    return err(
      res.status,
      res.status === 404 ? "not_found" : "bad_request",
      res.message,
      { reason: res.reason, ...(res.fields ? { fields: res.fields } : {}) },
    );
  const v = res.view;
  await record(
    db,
    scope,
    owner,
    session,
    now,
    "registry_token.create",
    { kind: "registry_token", id: v.tokenId },
    `Created registry token “${v.label}” (…${v.hint}; ${v.binding === "license" ? `licence ${v.licenseId}` : "owner"}; ${v.ecosystems ? v.ecosystems.join(", ") : "every feed"}${v.presentation === "url" ? "; Godot editor URL" : ""}${v.scopes.includes("publish") ? "; publish" : ""}; expires in ${Math.round((v.expiresAt - v.createdAt) / 86_400)} days)`,
  );
  return adminJson({ ok: true, token: res.token, view: v }, 201);
}

/** F-33b.3: mint a read service token, a `pkeyci_` CI token holding only `packages:read`. */
async function createService(
  body: Record<string, unknown>,
  env: Env,
  db: Db,
  session: AdminSession,
  scope: FeedScope,
  owner: string,
  now: number,
): Promise<Response> {
  // Platform: team members read through their personal token (D-F3).
  if (scope.kind === "platform" || owner === SYSTEM_PRODUCT_SLUG)
    return err(
      422,
      "bad_request",
      "the platform's package feeds take no service tokens; team members use a personal token",
      { reason: "system_service_tokens" },
    );
  // A 365-day product-wide credential: the Keys area, as the CI token mint needs (N1).
  if (!can(session.principal, productScope({ slug: owner }), "keys", "edit"))
    return err(403, "forbidden", "You don't have access to this.", {
      reason: "no_access",
      scope: `product:${owner}`,
      area: "keys",
    });
  // A service token is product-wide: no ecosystem, licence, URL or scope narrowing exists.
  const extra = ["ecosystems", "licenseId", "presentation", "scopes"].filter(
    (k) => body[k] !== undefined,
  );
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const days = body.expiresInDays ?? SERVICE_TOKEN_DEFAULT_DAYS;
  const fields = [...extra];
  if (
    label === "" ||
    label.length > REGISTRY_TOKEN_LABEL_MAX ||
    /[\u0000-\u001f\u007f]/.test(label)
  )
    fields.push("label");
  if (
    typeof days !== "number" ||
    !Number.isSafeInteger(days) ||
    days < REGISTRY_TOKEN_MIN_DAYS ||
    days > SERVICE_TOKEN_MAX_DAYS
  )
    fields.push("expiresInDays");
  if (fields.length)
    return err(422, "bad_request", "invalid service token", {
      reason: "invalid_token",
      fields,
    });
  if (
    (await liveServiceTokens(db, owner, now)).length >=
    MAX_LIVE_TOKENS_PER_OWNER
  )
    return err(
      409,
      "bad_request",
      `at most ${MAX_LIVE_TOKENS_PER_OWNER} live service tokens per product; revoke one first`,
      { reason: "token_limit" },
    );
  const issued = await issueStaticCiToken(env, db, {
    product: owner,
    scopes: [PACKAGES_READ_CI_SCOPE],
    expiresAt: now + (days as number) * 86_400,
    label,
    createdBy: `admin:${session.email || session.sub}`,
    now,
  });
  // The cap again after the insert: two racing mints cannot both stay above it.
  if (
    (await liveServiceTokens(db, owner, now)).length > MAX_LIVE_TOKENS_PER_OWNER
  ) {
    await revokeServiceToken(db, owner, issued.tokenId, now);
    return err(
      409,
      "bad_request",
      `at most ${MAX_LIVE_TOKENS_PER_OWNER} live service tokens per product; revoke one first`,
      { reason: "token_limit" },
    );
  }
  await record(
    db,
    scope,
    owner,
    session,
    now,
    "service_token.create",
    { kind: "ci_token", id: issued.tokenId },
    `Created service token “${label}” (reads this product's package feeds; expires in ${days} days)`,
  );
  const [view] = (await liveServiceTokens(db, owner, now)).filter(
    (t) => t.tokenId === issued.tokenId,
  );
  return adminJson(
    { ok: true, token: issued.token, view: serviceView(view!, now) },
    201,
  );
}

async function revokeService(
  db: Db,
  session: AdminSession,
  scope: FeedScope,
  owner: string,
  tokenId: string,
  now: number,
): Promise<Response> {
  const view = await revokeServiceToken(db, owner, tokenId, now);
  if (!view) return notFound();
  forgetRegistryTokens(); // this isolate's 30 s resolution cache
  await record(
    db,
    scope,
    owner,
    session,
    now,
    "service_token.revoke",
    { kind: "ci_token", id: tokenId },
    `Revoked service token “${view.label ?? ""}”`,
  );
  const by = await serviceRevocations(db, scope, owner, [view]);
  return adminJson({
    ok: true,
    view: serviceView(view, now, by.get(view.tokenId)),
  });
}

async function revoke(
  db: Db,
  session: AdminSession,
  scope: FeedScope,
  owner: string,
  tokenId: string,
  now: number,
): Promise<Response> {
  const view = await revokeRegistryToken(
    db,
    owner,
    tokenId,
    `admin:${session.email || session.sub}`,
    "manual",
    now,
  );
  if (!view) return notFound();
  await record(
    db,
    scope,
    owner,
    session,
    now,
    "registry_token.revoke",
    { kind: "registry_token", id: tokenId },
    `Revoked registry token “${view.label}” (…${view.hint})`,
  );
  return adminJson({ ok: true, view });
}

async function revokeAll(
  req: Request,
  db: Db,
  session: AdminSession,
  scope: FeedScope,
  owner: string,
  now: number,
): Promise<Response> {
  const body = await readBody(req);
  if (body.licenseId !== undefined && typeof body.licenseId !== "string")
    return err(422, "bad_request", "invalid licenceId", {
      fields: ["licenseId"],
    });
  const filter: RegistryTokenFilter =
    typeof body.licenseId === "string" ? { licenseId: body.licenseId } : {};
  let n = await revokeAllRegistryTokens(
    db,
    owner,
    `admin:${session.email || session.sub}`,
    "revoke_all",
    now,
    filter,
  );
  await record(
    db,
    scope,
    owner,
    session,
    now,
    "registry_token.revoke_all",
    filter.licenseId
      ? { kind: "license", id: filter.licenseId }
      : { kind: "product", id: owner },
    `Revoked every live registry token${filter.licenseId ? ` of licence ${filter.licenseId}` : ""} (${n})`,
  );
  // Product scope also ends the product's service tokens (a licence filter never does).
  if (!filter.licenseId) {
    let svc: number;
    try {
      svc = await revokeAllServiceTokens(db, owner, now);
    } catch (e) {
      // Batches commit one by one: the ones that ran stay revoked, and a retry finishes the rest.
      forgetRegistryTokens();
      await record(
        db,
        scope,
        owner,
        session,
        now,
        "service_token.revoke",
        { kind: "product", id: owner },
        "Revoking every live service token stopped part-way; run it again to finish",
      );
      throw e;
    }
    forgetRegistryTokens();
    if (svc > 0)
      await record(
        db,
        scope,
        owner,
        session,
        now,
        "service_token.revoke",
        { kind: "product", id: owner },
        `Revoked every live service token (${svc})`,
      );
    n += svc;
  }
  return adminJson({ ok: true, revoked: n });
}

/** Route `…/feeds/tokens…`; `rest` is the path after `tokens`. */
export async function handleRegistryTokensAdmin(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  scope: FeedScope,
  rest: string[],
  now: number,
): Promise<Response> {
  const notAllowed = () => err(405, "method_not_allowed", "method not allowed");
  const owner = await ownerSlug(db, scope);
  if (!owner)
    return scope.kind === "platform"
      ? err(
          409,
          "bad_request",
          "the platform's package feeds are not set up; run the bootstrap first",
          { reason: "system_product_missing" },
        )
      : notFound();
  if (rest.length === 0) {
    if (req.method === "GET") return list(req, env, db, scope, owner, now);
    if (req.method === "POST")
      return create(req, env, db, session, scope, owner, now);
    return notAllowed();
  }
  if (rest.length === 1 && rest[0] === "revoke-all") {
    if (req.method !== "POST") return notAllowed();
    return revokeAll(req, db, session, scope, owner, now);
  }
  if (rest.length === 2 && rest[1] === "revoke") {
    if (req.method !== "POST") return notAllowed();
    if (rest[0]!.startsWith("cit_"))
      return revokeService(db, session, scope, owner, rest[0]!, now);
    return revoke(db, session, scope, owner, rest[0]!, now);
  }
  return notFound();
}
