/**
 * `POST /manage/api/search` with `{ q }` (ST-52, EXPERIENCE.md §0.3 J-1): what the command palette asks for
 * a typed query, across every product the caller may read.
 *
 *   200 { key, licenses, people }
 *
 * The query travels in a JSON body, never the URL: a pasted licence key must not reach request
 * logs.
 *
 * - `key`: set only when the query IS a licence key (`pkey_<product>_<22>`). The key is hashed
 *   with the pepper and looked up in `keys_index`; the answer is the licence, shaped like a
 *   `licenses` row plus `licenseId`, and never echoes the key. A key that is unknown, or of a licence
 *   the caller may not read, answers `null` either way, so the route is no oracle for another
 *   product's keys. A key-shaped query is not searched as text.
 * - `licenses`: by id, name or email, among products where the caller holds Licensing (view).
 * - `people`: accounts by email, among products where the caller holds Core (view); each row is
 *   the pairwise subject the Users page opens.
 *
 * Each kind is capped at {@link SEARCH_KIND_CAP}. The route is `console`-area (every member); each
 * product is then held to its own area. Rate-limited per operator. A query is never logged.
 */

import {
  adminJson,
  AdminBodyError,
  err,
  readBody,
} from "../../core/console/respond.js";
import { parseServices } from "../../core/services.js";
import { ErrorCode } from "../../core/errors.js";
import type { AdminSession } from "../../core/console/session.js";
import { listProducts } from "../../core/products/store.js";
import { rateLimitOk } from "../../core/rateLimit.js";
import type { Db, DbParam } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { hashKey, LICENSE_KEY_SHAPE } from "../../platform/crypto.js";
import { can, productScope, type AreaId } from "../authz.js";

/** Results per kind (EXPERIENCE.md §0.3 J-1). */
export const SEARCH_KIND_CAP = 20;
/** Searches per operator per minute: the palette asks once per pause in typing. */
export const SEARCH_PER_MINUTE = 120;
/** The longest query read; a longer one is cut. */
export const SEARCH_QUERY_MAX = 200;
/** Products per statement, below D1's bound-parameter limit. */
const PRODUCTS_PER_STATEMENT = 60;

export interface SearchLicenseDto {
  product: string;
  productName: string;
  id: string;
  name: string | null;
  email: string | null;
  status: string;
  expiresAt: number | null;
  tier: string | null;
}

export interface SearchPersonDto {
  product: string;
  productName: string;
  subject: string;
  name: string | null;
  email: string | null;
}

export interface SearchResponse {
  key: (SearchLicenseDto & { licenseId: string }) | null;
  licenses: SearchLicenseDto[];
  people: SearchPersonDto[];
}

/** `%`, `_` and the escape itself are literal in a typed query. */
function likeOf(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export async function handleSearch(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  now: number,
): Promise<Response> {
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  if (
    !(await rateLimitOk(
      env,
      "_admin",
      {
        bucket: "adminSearch",
        id: session.principal?.memberId ?? session.sub ?? "",
        limit: SEARCH_PER_MINUTE,
        windowSec: 60,
      },
      now,
    ))
  )
    return err(429, "rate_limited", "too many searches");
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (e) {
    if (e instanceof AdminBodyError) return err(e.status, e.code, e.message);
    throw e;
  }
  const q = (typeof body.q === "string" ? body.q : "")
    .trim()
    .slice(0, SEARCH_QUERY_MAX);
  const empty: SearchResponse = { key: null, licenses: [], people: [] };
  if (q.length < 2) return adminJson(empty);

  const products = (await listProducts(db)).filter(
    (p) => p.system !== 1 && p.status !== "deleted",
  );
  const names = new Map(products.map((p) => [p.slug, p.name ?? p.slug]));
  // A product whose Licensing is off is left out of licence results: its pages are a dead end.
  const readable = (area: AreaId): string[] =>
    products
      .filter((p) => can(session.principal, productScope(p), area, "view"))
      .filter(
        (p) =>
          area !== "license" ||
          parseServices(p.services_json).services.license.enabled,
      )
      .map((p) => p.slug);

  // A pasted key: resolved by its hash, never searched as text.
  const keyed = LICENSE_KEY_SHAPE.exec(q);
  if (keyed) {
    const slug = keyed[1]!;
    if (!readable("license").includes(slug)) return adminJson(empty);
    const hit = await db.first<{ license_id: string }>(
      "SELECT license_id FROM keys_index WHERE product = ? AND key_hash = ?",
      slug,
      await hashKey(q, env.KEY_HASH_PEPPER),
    );
    const [row] = hit
      ? await licenseRows(db, [slug], "l.id = ?", [hit.license_id], 1, names)
      : [];
    return adminJson({
      ...empty,
      key: row ? { ...row, licenseId: row.id } : null,
    });
  }

  const like = likeOf(q.toLowerCase());
  const licenses: SearchLicenseDto[] = [];
  for (const slugs of chunks(readable("license"), PRODUCTS_PER_STATEMENT)) {
    if (licenses.length >= SEARCH_KIND_CAP) break;
    licenses.push(
      ...(await licenseRows(
        db,
        slugs,
        `(l.id = ? OR LOWER(COALESCE(l.name, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(l.email, '')) LIKE ? ESCAPE '\\')`,
        [q, like, like],
        SEARCH_KIND_CAP - licenses.length,
        names,
      )),
    );
  }

  const people: SearchPersonDto[] = [];
  for (const slugs of chunks(readable("core"), PRODUCTS_PER_STATEMENT)) {
    if (people.length >= SEARCH_KIND_CAP) break;
    const marks = slugs.map(() => "?").join(",");
    const rows = await db.all<{
      product: string;
      subject: string;
      display_name: string | null;
      primary_email: string | null;
    }>(
      `SELECT s.product, s.subject, a.display_name, a.primary_email
         FROM accounts a JOIN account_product_subjects s ON s.account_id = a.id
        WHERE s.product IN (${marks}) AND a.status != 'deleted'
          AND (LOWER(COALESCE(a.primary_email, '')) LIKE ? ESCAPE '\\'
               OR LOWER(COALESCE(a.display_name, '')) LIKE ? ESCAPE '\\')
        ORDER BY a.modified_at DESC LIMIT ?`,
      ...slugs,
      like,
      like,
      SEARCH_KIND_CAP - people.length,
    );
    for (const r of rows)
      people.push({
        product: r.product,
        productName: names.get(r.product) ?? r.product,
        subject: r.subject,
        name: r.display_name,
        email: r.primary_email,
      });
  }
  return adminJson({ key: null, licenses, people });
}

/** Licence rows of `slugs` where `where` holds (columns of `l`), newest first, with the tier's name. */
async function licenseRows(
  db: Db,
  slugs: string[],
  where: string,
  params: DbParam[],
  limit: number,
  names: Map<string, string>,
): Promise<SearchLicenseDto[]> {
  const marks = slugs.map(() => "?").join(",");
  const rows = await db.all<{
    product: string;
    id: string;
    name: string | null;
    email: string | null;
    status: string;
    expires_at: number | null;
    tier: string | null;
  }>(
    `SELECT l.product, l.id, l.name, l.email, l.status, l.expires_at, t.label AS tier
       FROM licenses l LEFT JOIN tiers t ON t.product = l.product AND t.id = l.tier_id
      WHERE l.product IN (${marks}) AND ${where}
      ORDER BY l.modified_at DESC LIMIT ?`,
    ...slugs,
    ...params,
    limit,
  );
  return rows.map((r) => ({
    product: r.product,
    productName: names.get(r.product) ?? r.product,
    id: r.id,
    name: r.name,
    email: r.email,
    status: r.status,
    expiresAt: r.expires_at,
    tier: r.tier,
  }));
}
