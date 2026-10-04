/**
 * Registry tokens in the console (F-21, plans/F-20.md §6.5): the Tokens tab of both Feeds pages
 * and the licence page's Registry tokens panel, through one handler set parameterised by scope.
 *
 *   Product   /manage/api/products/:slug/distribution/feeds/tokens…
 *   Platform  /manage/api/platform/feeds/tokens…                     (the system product's)
 *
 *   GET   <base>/tokens[?license=<id>]     the owner's tokens (or one licence's), newest first,
 *                                          with the owner's feeds (for the setup snippets)
 *   POST  <base>/tokens                    {label, ecosystems?, expiresInDays?, binding,
 *                                          licenseId?, presentation?} — mint; the plaintext is
 *                                          in this answer only (`registry_token.create`)
 *   POST  <base>/tokens/:tokenId/revoke    `registry_token.revoke`
 *   POST  <base>/tokens/revoke-all         {licenseId?} — `registry_token.revoke_all`
 *
 * The store is Core's (`core/registryTokens.ts`); this layer adds the session, the audit and the
 * scope. Product-scope actions are audited under the product, platform-scope ones in
 * `platform_audit`. Narrative-only under rule 10 (`adminApi`), documented on `/docs/admin/feeds/`.
 */

import { SYSTEM_PRODUCT_SLUG, PACKAGE_ECOSYSTEMS } from "@polaris-key/manifest";
import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound, readBody } from "../lib/respond.js";
import { audit, platformAudit } from "../audit.js";
import { getProduct } from "../../repo.js";
import { registryOrigin } from "../../core/registryHostname.js";
import {
  MAX_LIVE_TOKENS_PER_LICENSE,
  MAX_LIVE_TOKENS_PER_OWNER,
  REGISTRY_TOKEN_DEFAULT_DAYS,
  REGISTRY_TOKEN_MAX_DAYS,
  REGISTRY_TOKEN_MIN_DAYS,
  REGISTRY_TOKEN_USERNAME,
  REGISTRY_URL_TOKEN_DEFAULT_DAYS,
  listRegistryTokens,
  mintRegistryToken,
  revokeAllRegistryTokens,
  revokeRegistryToken,
  type RegistryTokenFilter,
} from "../../core/registryTokens.js";
import { feedBaseUrl, ECOSYSTEM_LABELS } from "../lib/feedModel.js";
import type { FeedScope } from "./feeds.js";

const BODY_KEYS = [
  "label",
  "ecosystems",
  "expiresInDays",
  "binding",
  "licenseId",
  "presentation",
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

/** The owner's feeds, as the snippets and the console's access hints need them. */
async function feedsOf(env: Env, db: Db, owner: string) {
  const rows = await db.all<{
    ecosystem: string;
    enabled: number;
    access_mode: string;
  }>(
    "SELECT ecosystem, enabled, access_mode FROM dist_registry_feeds WHERE product = ?",
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
    };
  });
}

function filterOf(req: Request): RegistryTokenFilter {
  const license = new URL(req.url).searchParams.get("license");
  return license ? { licenseId: license } : {};
}

async function list(
  req: Request,
  env: Env,
  db: Db,
  owner: string,
  now: number,
): Promise<Response> {
  return adminJson({
    owner,
    registryOrigin: registryOrigin(env),
    username: REGISTRY_TOKEN_USERNAME,
    tokens: await listRegistryTokens(db, owner, now, filterOf(req)),
    feeds: await feedsOf(env, db, owner),
    limits: {
      minDays: REGISTRY_TOKEN_MIN_DAYS,
      maxDays: REGISTRY_TOKEN_MAX_DAYS,
      defaultDays: REGISTRY_TOKEN_DEFAULT_DAYS,
      urlDefaultDays: REGISTRY_URL_TOKEN_DEFAULT_DAYS,
      perOwner: MAX_LIVE_TOKENS_PER_OWNER,
      perLicense: MAX_LIVE_TOKENS_PER_LICENSE,
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
  if (body.expiresInDays !== undefined && typeof body.expiresInDays !== "number")
    fields.push("expiresInDays");
  if (body.binding !== "owner" && body.binding !== "license")
    fields.push("binding");
  if (body.licenseId !== undefined && typeof body.licenseId !== "string")
    fields.push("licenseId");
  if (
    body.presentation !== undefined &&
    body.presentation !== "header" &&
    body.presentation !== "url"
  )
    fields.push("presentation");
  if (fields.length)
    return err(422, "bad_request", "invalid registry token", { fields });
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
      presentation: (body.presentation as "header" | "url" | undefined) ?? "header",
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
    `Created registry token “${v.label}” (…${v.hint}; ${v.binding === "license" ? `licence ${v.licenseId}` : "owner"}; ${v.ecosystems ? v.ecosystems.join(", ") : "every feed"}${v.presentation === "url" ? "; Godot editor URL" : ""}; expires in ${Math.round((v.expiresAt - v.createdAt) / 86_400)} days)`,
  );
  return adminJson({ ok: true, token: res.token, view: v }, 201);
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
  const n = await revokeAllRegistryTokens(
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
    if (req.method === "GET") return list(req, env, db, owner, now);
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
    return revoke(db, session, scope, owner, rest[0]!, now);
  }
  return notFound();
}
