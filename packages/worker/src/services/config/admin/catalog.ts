/**
 * The product catalog — `/manage/api/products/<slug>/config/catalog[/…]` (§R1).
 *
 *   GET  config/catalog                 the active catalog JSON (404 before the first publish)
 *   PUT  config/catalog                 publish a new version; `expectedVersion` guards a race
 *   GET  config/catalog/versions        every published version, newest first (ADMIN.md A-6)
 *   GET  config/catalog/versions/<n>    one version's catalog JSON, active or not (A-6)
 *   GET  config/catalog/usage?key=…     the profiles, tiers and licenses that set each key (A-7b)
 *
 * A publish compiles every schema fragment up front, so malformed schema is rejected here rather
 * than at request time, then bumps the version and flips active.
 *
 * ── `expectedVersion` (A-6) ─────────────────────────────────────────────────────────────────
 *
 * The console's editor starts from the version it loaded and sends that number back on publish
 * (`0` when there was no catalog yet). If another publish (a teammate, a repo resync) landed in
 * between, the PUT answers 409 `catalog_version_conflict` with the version that is active now, and
 * the editor shows the operator what changed instead of silently overwriting it. A PUT without
 * the field keeps the old last-writer-wins behaviour, so scripted publishes are unaffected.
 *
 * ── WHY IT IS SPELLED `catalog`, NOT `schema` ───────────────────────────────────────────────
 *
 * Config already serves `GET /<product>/config/schema` on the public wire — the same document,
 * read by devices. Naming the admin resource `schema` too would have put a read-only wire route
 * and an operator-writable admin route one namespace apart under the same noun. `catalog` is
 * what the thing is called everywhere else in the codebase (`@polaris-key/catalog`, `catalog_json`,
 * `ProductCatalog`), so the admin surface now says so.
 */

import { Catalog } from "@polaris-key/catalog";
import { ErrorCode } from "../../../core/errors.js";
import { getActiveSchema, insertSchema } from "../../../core/data.js";
import {
  catalogRepresentabilityResponse,
  adminJson,
  adminNotFound,
  audit,
  deactivateSchemas,
  err,
  getSchemaVersion,
  listLicenses,
  listProfiles,
  listSchemaPublishers,
  listSchemaVersions,
  listTiers,
  nextSchemaVersion,
  parsePayload,
  readBody,
} from "../../../core/adminApi.js";
import type { ConfigAdminContext } from "./index.js";

/** At most this many keys per usage request (a review of a large removal batches its keys). */
export const USAGE_KEY_LIMIT = 100;

const catalogResponse = (json: string): Response =>
  new Response(json, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

export async function handleCatalog(
  ctx: ConfigAdminContext,
  rest: string[] = [],
): Promise<Response> {
  const { req } = ctx;
  if (rest.length === 0) return handleActive(ctx);
  if (req.method !== "GET")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  if (rest[0] === "versions" && rest.length === 1) return listVersions(ctx);
  if (rest[0] === "versions" && rest.length === 2)
    return oneVersion(ctx, rest[1]!);
  if (rest[0] === "usage" && rest.length === 1) return usage(ctx);
  return adminNotFound();
}

async function handleActive(ctx: ConfigAdminContext): Promise<Response> {
  const { req, db, product, session, now } = ctx;
  const slug = product.slug;
  if (req.method === "GET") {
    const row = await getActiveSchema(db, slug);
    if (!row) return adminNotFound();
    return catalogResponse(row.catalog_json);
  }
  if (req.method === "PUT") {
    const body = await readBody(req);
    const catalogJson = body.catalog ?? body;
    let catalog: Catalog;
    try {
      catalog = new Catalog(catalogJson as never);
      catalog.compileAll(); // surfaces malformed schema fragments here, not at request time
    } catch (e) {
      return err(422, ErrorCode.BadRequest, "invalid catalog", {
        fields: [e instanceof Error ? e.message : "invalid catalog"],
      });
    }
    // plans/P3-01.md §2.2: a catalog default is a config value the document carries and each
    // key is a member name in it. The prune would drop a flagged default at signing but checks
    // no key, so an unsignable key (U+0000, an NFC pair) or one the manifest's ID_RE refuses
    // is refused here.
    const unrepresentable = catalogRepresentabilityResponse({
      entries: catalog.entries,
    });
    if (unrepresentable) return unrepresentable;
    if (body.expectedVersion !== undefined) {
      const expected = body.expectedVersion;
      if (
        typeof expected !== "number" ||
        !Number.isInteger(expected) ||
        expected < 0
      ) {
        return err(422, ErrorCode.BadRequest, "invalid expectedVersion", {
          fields: ["expectedVersion"],
        });
      }
      const active = await getActiveSchema(db, slug);
      const current = active?.catalog_version ?? 0;
      if (current !== expected) {
        return err(
          409,
          ErrorCode.BadRequest,
          "the catalog changed since this draft started",
          { reason: "catalog_version_conflict", currentVersion: current },
        );
      }
    }
    const version = await nextSchemaVersion(db, slug);
    await deactivateSchemas(db, slug);
    await insertSchema(db, {
      product: slug,
      catalog_version: version,
      catalog_json: JSON.stringify({
        schemaVersion: version,
        entries: catalog.entries,
      }),
      active: 1,
      created_at: now,
    });
    await audit(
      db,
      slug,
      session,
      now,
      "schema.publish",
      { kind: "schema", id: String(version) },
      `Published catalog v${version}`,
    );
    return adminJson({ ok: true, schemaVersion: version });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}

function entryCount(json: string): number {
  try {
    const parsed = JSON.parse(json) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? parsed.entries.length : 0;
  } catch {
    return 0;
  }
}

/** `GET config/catalog/versions`: the history, with who published each console version. */
async function listVersions(ctx: ConfigAdminContext): Promise<Response> {
  const { db, product } = ctx;
  const [rows, publishers] = await Promise.all([
    listSchemaVersions(db, product.slug),
    listSchemaPublishers(db, product.slug),
  ]);
  const byVersion = new Map(
    publishers
      .filter((p) => p.target_id !== null)
      .map((p) => [p.target_id!, p]),
  );
  return adminJson({
    versions: rows.map((r) => {
      const who = byVersion.get(String(r.catalog_version));
      return {
        version: r.catalog_version,
        active: r.active === 1,
        createdAt: r.created_at,
        entryCount: entryCount(r.catalog_json),
        // No console publish row: the manifest wrote it (product create or a repo resync).
        source: who ? "admin" : "manifest",
        publishedBy: who ? (who.actor_email ?? who.actor_name ?? null) : null,
      };
    }),
  });
}

/** `GET config/catalog/versions/<n>`: one version's catalog JSON. */
async function oneVersion(
  ctx: ConfigAdminContext,
  raw: string,
): Promise<Response> {
  if (!/^[1-9]\d{0,8}$/.test(raw)) return adminNotFound();
  const row = await getSchemaVersion(ctx.db, ctx.product.slug, Number(raw));
  if (!row) return adminNotFound();
  return catalogResponse(row.catalog_json);
}

/**
 * `GET config/catalog/usage?key=a&key=b` (A-7b): for each key, the profiles whose payload sets
 * it, the tiers that inherit one of those profiles, and the licenses whose own overrides set it.
 * The catalog editor's review cross-checks removed keys against this, and the catalog's key
 * drawer lists it as "Overridden by". Ids and names only — never a value.
 */
async function usage(ctx: ConfigAdminContext): Promise<Response> {
  const { req, db, product } = ctx;
  const keys = [...new Set(new URL(req.url).searchParams.getAll("key"))].filter(
    (k) => k !== "",
  );
  if (keys.length === 0)
    return err(422, ErrorCode.BadRequest, "key is required", {
      fields: ["key"],
    });
  if (keys.length > USAGE_KEY_LIMIT)
    return err(422, ErrorCode.BadRequest, "too many keys", {
      fields: ["key"],
    });
  const [profiles, tiers, licenses] = await Promise.all([
    listProfiles(db, product.slug),
    listTiers(db, product.slug),
    listLicenses(db, product.slug),
  ]);
  const parsedProfiles = profiles.map((p) => ({
    row: p,
    payload: parsePayload(p.payload_json),
  }));
  const parsedLicenses = licenses.map((l) => ({
    row: l,
    payload: parsePayload(l.overrides_json),
  }));
  const sets = (p: ReturnType<typeof parsePayload>, key: string): boolean =>
    key in p.config || key in p.secrets || key in p.entitlements;
  const out: Record<
    string,
    {
      profiles: { id: string; name: string }[];
      tiers: { id: string; label: string; profile: string }[];
      licenses: { id: string; name: string | null; email: string | null }[];
    }
  > = {};
  for (const key of keys) {
    const ps = parsedProfiles.filter((p) => sets(p.payload, key));
    const ids = new Set(ps.map((p) => p.row.id));
    out[key] = {
      profiles: ps.map((p) => ({ id: p.row.id, name: p.row.name })),
      tiers: tiers
        .filter((t) => t.profile_id !== null && ids.has(t.profile_id))
        .map((t) => ({ id: t.id, label: t.label, profile: t.profile_id! })),
      licenses: parsedLicenses
        .filter((l) => sets(l.payload, key))
        .map((l) => ({ id: l.row.id, name: l.row.name, email: l.row.email })),
    };
  }
  return adminJson({ keys: out });
}
