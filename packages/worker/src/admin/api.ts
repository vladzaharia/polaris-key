/**
 * The admin JSON API: `handleAdmin(req, env, db, path)` where `path` is everything AFTER
 * `/admin` (e.g. `/api/me`, `/api/products/djdl/licenses`). Two route families:
 *
 *   /api/me                                  — the signed-in identity + CSRF + grants
 *   /api/products                            — PLATFORM registry CRUD (platform admins only)
 *   /api/products/<slug>/...                 — per-product admin (product admins + platform)
 *
 * Security posture, enforced on EVERY request (never trusting the SPA):
 *   - **Session-gated**: a valid signed cookie session is required (401 otherwise).
 *   - **Group-gated**: platform routes need `PLATFORM_ADMIN_GROUP`; product routes need the
 *     product's `admin_group` (platform admins pass too). 403 otherwise.
 *   - **CSRF**: mutations must echo `X-PKey-CSRF`; mismatch ⇒ 403.
 *   - **Product-scoped D1**: every per-product query carries the slug — no cross-tenant read.
 *   - **Catalog-validated**: config/secret/flag values validate against the active catalog
 *     before any write (422 on failure).
 *   - **Secrets are write-only**: responses NEVER echo a stored secret value.
 *   - **Audited**: every mutation appends an audit row with the verified actor.
 */

import { Catalog } from "@polaris-key/catalog";
import type { ManagedEntry, ManagedPayload } from "@polaris-key/protocol";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { ErrorCode } from "../http.js";
import { hashKey, mintLicenseKey, randomId } from "../crypto.js";
import { putKeyRecord, deleteKeyRecord, deleteTokenRecord } from "../kv.js";
import {
  getLicense,
  getProduct,
  getActiveSchema,
  insertLicense,
  insertProduct,
  insertSchema,
  insertKey,
  listProducts,
  listKeysByLicense,
  listMachinesByLicense,
  setKeyStatus,
  setMachineStatus,
  getMachine,
  getKey,
  type LicenseRow,
  type ProductRow,
} from "../repo.js";
import { listAudit } from "../repo.js";
import {
  countKeysByLicense,
  deactivateSchemas,
  deleteProduct,
  deleteProfile,
  deleteTier,
  listLicenses,
  listMachinesByProduct,
  listProfiles,
  listTiers,
  nextSchemaVersion,
  patchLicense,
  setLicenseStatus,
  updateProduct,
  upsertProfile,
  upsertTier,
} from "./repo.js";
import { audit } from "./audit.js";
import { canAdminProduct, isPlatformAdmin } from "./authz.js";
import {
  buildClearCookie,
  CSRF_HEADER,
  sessionFromRequest,
  type AdminSession,
} from "./session.js";

// ── response helpers (admin is always no-store) ──────────────────────────────
function adminJson(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(extra ?? {}) },
  });
}
function err(status: number, code: string, message?: string, extra?: Record<string, unknown>): Response {
  return adminJson({ error: code, ...(message ? { message } : {}), ...(extra ?? {}) }, status);
}
function unauthorized(): Response {
  return err(401, ErrorCode.Unauthorized);
}
function forbidden(message?: string): Response {
  return err(403, ErrorCode.Forbidden, message);
}
function notFound(): Response {
  return err(404, ErrorCode.NotFound);
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = (await req.json()) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── catalog loading (for value validation) ───────────────────────────────────
async function loadCatalog(db: Db, product: string): Promise<Catalog | null> {
  const row = await getActiveSchema(db, product);
  if (!row) return null;
  try {
    return new Catalog(JSON.parse(row.catalog_json));
  } catch {
    return null;
  }
}

// ── redaction: never echo a stored secret value ──────────────────────────────
function redactPayload(payload: ManagedPayload, catalog: Catalog | null): {
  config: Record<string, ManagedEntry>;
  secrets: Record<string, { state: string; configured: boolean }>;
  entitlements: Record<string, ManagedEntry>;
} {
  const secrets: Record<string, { state: string; configured: boolean }> = {};
  for (const [key, entry] of Object.entries(payload.secrets ?? {})) {
    secrets[key] = { state: entry.state, configured: entry.value != null && entry.value !== "" };
  }
  // A config key flagged `secret` in the catalog is also redacted.
  const config: Record<string, ManagedEntry> = {};
  for (const [key, entry] of Object.entries(payload.config ?? {})) {
    const meta = catalog?.entryByKey(key);
    config[key] = meta?.secret ? { state: entry.state, value: "" } : entry;
  }
  return { config, secrets, entitlements: payload.entitlements ?? {} };
}

function parsePayload(json: string | null | undefined): ManagedPayload {
  if (!json) return { config: {}, secrets: {}, entitlements: {} };
  try {
    const p = JSON.parse(json) as Partial<ManagedPayload>;
    return { config: p.config ?? {}, secrets: p.secrets ?? {}, entitlements: p.entitlements ?? {} };
  } catch {
    return { config: {}, secrets: {}, entitlements: {} };
  }
}

// ── override batch application (all-or-nothing, catalog-validated) ────────────
interface OverrideUpdate {
  key: string;
  state?: "unmanaged" | "managed" | "hidden";
  value?: unknown;
}

/** Apply a validated batch onto a stored payload JSON; returns the new payload or errors. */
function applyOverrides(
  current: ManagedPayload,
  updates: OverrideUpdate[],
  catalog: Catalog,
): { ok: true; payload: ManagedPayload } | { ok: false; fields: string[] } {
  const fields: string[] = [];
  const next: ManagedPayload = {
    config: { ...current.config },
    secrets: { ...current.secrets },
    entitlements: { ...current.entitlements },
  };
  for (const u of updates) {
    if (!u || typeof u.key !== "string") {
      fields.push("missing key");
      continue;
    }
    const entry = catalog.entryByKey(u.key);
    if (!entry) {
      fields.push(`unknown config key: ${u.key}`);
      continue;
    }
    const bucket =
      entry.kind === "secret" ? next.secrets : entry.kind === "flag" ? next.entitlements : next.config;
    if (u.value === undefined && (u.state === "unmanaged" || u.state === undefined)) {
      // Clearing an override.
      delete bucket[u.key];
      continue;
    }
    if (u.value !== undefined) {
      const res = catalog.validateKeyValue(u.key, u.value);
      if (!res.ok) {
        fields.push(...res.errors);
        continue;
      }
    }
    bucket[u.key] = {
      state: u.state ?? "managed",
      value: (u.value ?? bucket[u.key]?.value ?? true) as ManagedEntry["value"],
    };
  }
  if (fields.length) return { ok: false, fields };
  return { ok: true, payload: next };
}

// ── license summary shaping ──────────────────────────────────────────────────
async function licenseSummary(db: Db, product: string, row: LicenseRow): Promise<Record<string, unknown>> {
  const keyCounts = await countKeysByLicense(db, product, row.id);
  const machines = await listMachinesByLicense(db, product, row.id);
  return {
    id: row.id,
    name: row.name ?? "",
    email: row.email ?? "",
    status: row.status,
    enrolledAt: row.enrolled_at,
    expiresAt: row.expires_at,
    keyCount: keyCounts.total,
    activeKeyCount: keyCounts.active,
    machineCount: machines.filter((m) => m.status === "authorized").length,
    profile: row.profile_id,
    tier: row.tier_id,
    identityProvider: row.sub ? "oidc" : "manual",
    oidcSubject: row.sub ?? undefined,
    modifiedBy: row.modified_by ?? undefined,
    modifiedAt: row.modified_at,
  };
}

// ── product registry shaping ─────────────────────────────────────────────────
function productView(p: ProductRow): Record<string, unknown> {
  return {
    slug: p.slug,
    name: p.name,
    signingKid: p.signing_kid,
    compatMin: p.compat_min,
    compatMax: p.compat_max,
    defaultMaxOfflineDays: p.default_max_offline_days,
    defaultMachineLimit: p.default_machine_limit,
    adminGroup: p.admin_group,
    createdAt: p.created_at,
    modifiedAt: p.modified_at,
  };
}

// ── platform: products CRUD ──────────────────────────────────────────────────
async function handleProducts(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  segments: string[],
  now: number,
): Promise<Response> {
  if (!isPlatformAdmin(env, session)) return forbidden("platform admin required");

  // /api/products
  if (segments.length === 0) {
    if (req.method === "GET") {
      const rows = await listProducts(db);
      return adminJson({ products: rows.map(productView) });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const slug = String(body.slug ?? "").trim();
      if (!/^[a-z0-9-]+$/.test(slug)) return err(422, ErrorCode.BadRequest, "invalid slug", { fields: ["slug"] });
      if (await getProduct(db, slug)) return err(409, ErrorCode.BadRequest, "product exists", { fields: ["slug"] });
      const signingKeySecret = `SIGNING_KEY__${slug.toUpperCase().replace(/-/g, "_")}`;
      await insertProduct(db, {
        slug,
        name: String(body.name ?? slug),
        signing_kid: String(body.signingKid ?? `${slug}-2026`),
        signing_key_secret: signingKeySecret,
        signing_pub: typeof body.signingPub === "string" ? body.signingPub : null,
        compat_min: String(body.compatMin ?? "0.0.0"),
        compat_max: String(body.compatMax ?? "99.0.0"),
        default_max_offline_days: Number(body.defaultMaxOfflineDays ?? 30),
        default_machine_limit: Number(body.defaultMachineLimit ?? 5),
        admin_group: typeof body.adminGroup === "string" ? body.adminGroup : null,
        branding_json: null,
        created_at: now,
        modified_at: now,
      });
      // Seed an empty active schema so the product is immediately usable.
      await insertSchema(db, {
        product: slug,
        catalog_version: 1,
        catalog_json: JSON.stringify({ schemaVersion: 1, entries: [] }),
        active: 1,
        created_at: now,
      });
      await audit(db, slug, session, now, "product.create", { kind: "product", id: slug }, `Created product ${slug}`);
      const row = await getProduct(db, slug);
      return adminJson({ ok: true, product: row ? productView(row) : null, signingKeySecret }, 201);
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  // /api/products/<slug>
  const slug = segments[0]!;
  const row = await getProduct(db, slug);
  if (!row) return notFound();
  if (req.method === "GET") return adminJson({ product: productView(row) });
  if (req.method === "PATCH") {
    const body = await readBody(req);
    await updateProduct(
      db,
      slug,
      {
        name: typeof body.name === "string" ? body.name : undefined,
        compat_min: typeof body.compatMin === "string" ? body.compatMin : undefined,
        compat_max: typeof body.compatMax === "string" ? body.compatMax : undefined,
        default_max_offline_days:
          typeof body.defaultMaxOfflineDays === "number" ? body.defaultMaxOfflineDays : undefined,
        default_machine_limit:
          typeof body.defaultMachineLimit === "number" ? body.defaultMachineLimit : undefined,
        admin_group: typeof body.adminGroup === "string" ? body.adminGroup : undefined,
      },
      now,
    );
    await audit(db, slug, session, now, "product.update", { kind: "product", id: slug }, `Updated product ${slug}`);
    return adminJson({ ok: true, slug });
  }
  if (req.method === "DELETE") {
    await deleteProduct(db, slug);
    await audit(db, slug, session, now, "product.delete", { kind: "product", id: slug }, `Deleted product ${slug}`);
    return adminJson({ ok: true, slug });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}

// ── per-product API ──────────────────────────────────────────────────────────
async function handleProductScoped(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  const product = await getProduct(db, slug);
  if (!product) return notFound();
  if (!canAdminProduct(env, session, product)) return forbidden("not an admin of this product");

  const [resource, id, sub, subId, action] = rest;

  // GET schema / PUT schema
  if (resource === "schema") {
    if (req.method === "GET") {
      const row = await getActiveSchema(db, slug);
      if (!row) return notFound();
      return new Response(row.catalog_json, {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
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
      const version = await nextSchemaVersion(db, slug);
      await deactivateSchemas(db, slug);
      await insertSchema(db, {
        product: slug,
        catalog_version: version,
        catalog_json: JSON.stringify({ schemaVersion: version, entries: catalog.entries }),
        active: 1,
        created_at: now,
      });
      await audit(db, slug, session, now, "schema.publish", { kind: "schema", id: String(version) }, `Published catalog v${version}`);
      return adminJson({ ok: true, schemaVersion: version });
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  // Licenses
  if (resource === "licenses") {
    return handleLicenses(req, env, db, session, slug, [id, sub, subId, action].filter((s): s is string => s != null), now);
  }

  // Profiles
  if (resource === "profiles") {
    return handleProfiles(req, db, session, slug, id, now);
  }

  // Tiers
  if (resource === "tiers") {
    return handleTiers(req, db, session, slug, id, now);
  }

  // Activity (keyset list)
  if (resource === "activity") {
    const url = new URL(req.url);
    const beforeAt = url.searchParams.get("beforeAt");
    const beforeId = url.searchParams.get("beforeId");
    const limit = Number(url.searchParams.get("limit")) || 50;
    const rows = await listAudit(db, slug, {
      beforeAt: beforeAt ? Number(beforeAt) : undefined,
      beforeId: beforeId ?? undefined,
      limit,
    });
    const items = rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: { sub: r.actor_sub ?? "", name: r.actor_name ?? "", email: r.actor_email ?? "" },
      action: r.action,
      target: r.target_kind ? { kind: r.target_kind, id: r.target_id ?? "" } : null,
      summary: r.summary ?? "",
    }));
    const last = rows[rows.length - 1];
    const nextCursor = rows.length >= limit && last ? { beforeAt: last.at, beforeId: last.id } : null;
    return adminJson({ items, nextCursor });
  }

  return notFound();
}

// ── licenses + keys + machines ───────────────────────────────────────────────
async function handleLicenses(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  const [id, sub, subId, action] = rest;

  // /licenses
  if (!id) {
    if (req.method === "GET") {
      const rows = await listLicenses(db, slug);
      const licenses = await Promise.all(rows.map((r) => licenseSummary(db, slug, r)));
      return adminJson({ licenses });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const licenseId = randomId("lic");
      await insertLicense(db, {
        product: slug,
        id: licenseId,
        status: "active",
        sub: null,
        name: typeof body.name === "string" ? body.name : null,
        email: typeof body.email === "string" ? body.email : null,
        groups_json: null,
        tier_id: typeof body.tier === "string" ? body.tier : null,
        profile_id: typeof body.profile === "string" ? body.profile : null,
        enrolled_at: now,
        expires_at: typeof body.expiresAt === "number" ? body.expiresAt : null,
        max_offline_days: typeof body.maxOfflineDays === "number" ? body.maxOfflineDays : null,
        overrides_json: JSON.stringify({ config: {}, secrets: {}, entitlements: {} }),
        modified_by: session.sub,
        modified_at: now,
      });
      // Mint the first key — returned ONCE, only here.
      const key = mintLicenseKey(slug);
      const keyHash = await hashKey(key, env.KEY_HASH_PEPPER);
      await insertKey(db, {
        product: slug,
        key_hash: keyHash,
        license_id: licenseId,
        status: "active",
        label: "Initial key",
        created_at: now,
        created_by: session.sub,
        last_used_at: null,
      });
      await putKeyRecord(env, slug, keyHash, { product: slug, licenseId, status: "active" });
      await audit(db, slug, session, now, "license.create", { kind: "license", id: licenseId }, `Created license for ${body.email ?? body.name ?? licenseId}`);
      const row = await getLicense(db, slug, licenseId);
      return adminJson({ licenseId, key, license: row ? await licenseSummary(db, slug, row) : null }, 201);
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  const license = await getLicense(db, slug, id);
  if (!license) return notFound();
  const catalog = await loadCatalog(db, slug);

  // /licenses/<id>
  if (!sub) {
    if (req.method === "GET") {
      const keys = await listKeysByLicense(db, slug, id);
      const machines = await listMachinesByLicense(db, slug, id);
      const overrides = parsePayload(license.overrides_json);
      return adminJson({
        ...(await licenseSummary(db, slug, license)),
        groups: license.groups_json ? (JSON.parse(license.groups_json) as string[]) : [],
        maxOfflineDays: license.max_offline_days,
        overrides: redactPayload(overrides, catalog),
        keys: keys.map((k) => ({
          hash: k.key_hash,
          status: k.status,
          label: k.label ?? undefined,
          createdAt: k.created_at,
          createdBy: k.created_by ?? "",
          lastUsedAt: k.last_used_at ?? undefined,
        })),
        machines: machines.map((m) => ({
          machineId: m.machine_id,
          status: m.status,
          firstSeen: m.first_seen,
          lastSeen: m.last_seen,
          ua: m.ua ?? undefined,
          label: m.label ?? undefined,
          reported: m.reported_json ? (JSON.parse(m.reported_json) as unknown) : undefined,
        })),
      });
    }
    if (req.method === "PATCH") {
      const body = await readBody(req);
      await patchLicense(
        db,
        slug,
        id,
        {
          name: typeof body.name === "string" ? body.name : undefined,
          email: typeof body.email === "string" ? body.email : undefined,
          expires_at: body.expiresAt === null ? null : typeof body.expiresAt === "number" ? body.expiresAt : undefined,
          max_offline_days: typeof body.maxOfflineDays === "number" ? body.maxOfflineDays : undefined,
        },
        session.sub,
        now,
      );
      await audit(db, slug, session, now, "license.update", { kind: "license", id }, `Updated license ${id}`);
      return adminJson({ ok: true, id });
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  // /licenses/<id>/disable | enable
  if (sub === "disable" || sub === "enable") {
    if (req.method !== "POST") return err(405, ErrorCode.BadRequest, "method not allowed");
    const status = sub === "disable" ? "disabled" : "active";
    await setLicenseStatus(db, slug, id, status, session.sub, now);
    await audit(db, slug, session, now, `license.${sub}`, { kind: "license", id }, `${sub === "disable" ? "Disabled" : "Enabled"} license ${id}`);
    return adminJson({ ok: true, id, status });
  }

  // /licenses/<id>/overrides (PUT batch)
  if (sub === "overrides") {
    if (req.method !== "PUT") return err(405, ErrorCode.BadRequest, "method not allowed");
    if (!catalog) return err(409, ErrorCode.BadRequest, "no active catalog");
    const body = await readBody(req);
    const updates = Array.isArray(body.updates) ? (body.updates as OverrideUpdate[]) : [];
    const result = applyOverrides(parsePayload(license.overrides_json), updates, catalog);
    if (!result.ok) return err(422, ErrorCode.BadRequest, "validation failed", { fields: result.fields });
    await patchLicense(db, slug, id, { overrides_json: JSON.stringify(result.payload) }, session.sub, now);
    await audit(db, slug, session, now, "license.overrides", { kind: "license", id }, `Updated overrides for ${id}`);
    return adminJson({ ok: true, id });
  }

  // /licenses/<id>/keys ...
  if (sub === "keys") {
    return handleKeys(req, env, db, session, slug, id, subId, action, now);
  }

  // /licenses/<id>/machines ...
  if (sub === "machines") {
    return handleMachines(req, env, db, session, slug, id, subId, now);
  }

  return notFound();
}

async function handleKeys(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  licenseId: string,
  keyHash: string | undefined,
  action: string | undefined,
  now: number,
): Promise<Response> {
  if (!keyHash) {
    if (req.method === "GET") {
      const keys = await listKeysByLicense(db, slug, licenseId);
      return adminJson({
        keys: keys.map((k) => ({ hash: k.key_hash, status: k.status, label: k.label ?? undefined, createdAt: k.created_at, createdBy: k.created_by ?? "", lastUsedAt: k.last_used_at ?? undefined })),
      });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const key = mintLicenseKey(slug);
      const hash = await hashKey(key, env.KEY_HASH_PEPPER);
      await insertKey(db, {
        product: slug,
        key_hash: hash,
        license_id: licenseId,
        status: "active",
        label: typeof body.label === "string" ? body.label : null,
        created_at: now,
        created_by: session.sub,
        last_used_at: null,
      });
      await putKeyRecord(env, slug, hash, { product: slug, licenseId, status: "active" });
      await audit(db, slug, session, now, "key.create", { kind: "key", id: hash }, `Minted key for ${licenseId}`);
      // Raw key returned ONCE.
      return adminJson({ key, hash, record: { hash, status: "active", createdAt: now, createdBy: session.sub } }, 201);
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  const existing = await getKey(db, slug, keyHash);
  if (!existing || existing.license_id !== licenseId) return notFound();

  if (action === "revoke") {
    if (req.method !== "POST") return err(405, ErrorCode.BadRequest, "method not allowed");
    await setKeyStatus(db, slug, keyHash, "revoked");
    await deleteKeyRecord(env, slug, keyHash);
    await audit(db, slug, session, now, "key.revoke", { kind: "key", id: keyHash }, `Revoked key ${keyHash.slice(0, 8)}`);
    return adminJson({ ok: true, hash: keyHash, status: "revoked" });
  }
  return notFound();
}

async function handleMachines(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  licenseId: string,
  machineId: string | undefined,
  now: number,
): Promise<Response> {
  if (!machineId) {
    if (req.method === "GET") {
      const machines = await listMachinesByLicense(db, slug, licenseId);
      return adminJson({
        machines: machines.map((m) => ({ machineId: m.machine_id, status: m.status, firstSeen: m.first_seen, lastSeen: m.last_seen, ua: m.ua ?? undefined, label: m.label ?? undefined })),
      });
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }
  const machine = await getMachine(db, slug, machineId);
  if (!machine || machine.license_id !== licenseId) return notFound();
  if (req.method === "DELETE" || req.method === "POST") {
    await setMachineStatus(db, slug, machineId, "deauthorized");
    if (machine.token_hash) await deleteTokenRecord(env, slug, machine.token_hash);
    await audit(db, slug, session, now, "machine.deauthorize", { kind: "machine", id: machineId }, `Deauthorized ${machineId}`);
    return adminJson({ ok: true, machineId });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}

// ── profiles ─────────────────────────────────────────────────────────────────
async function handleProfiles(
  req: Request,
  db: Db,
  session: AdminSession,
  slug: string,
  id: string | undefined,
  now: number,
): Promise<Response> {
  if (!id) {
    if (req.method === "GET") {
      const rows = await listProfiles(db, slug);
      return adminJson({ profiles: rows.map((p) => ({ id: p.id, name: p.name, description: p.description ?? undefined, modifiedBy: p.modified_by ?? undefined, modifiedAt: p.modified_at })) });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const profileId = String(body.id ?? randomId("prof"));
      await upsertProfile(db, {
        product: slug,
        id: profileId,
        name: String(body.name ?? profileId),
        description: typeof body.description === "string" ? body.description : null,
        payload_json: JSON.stringify({ config: {}, secrets: {}, entitlements: {} }),
        modified_by: session.sub,
        modified_at: now,
      });
      await audit(db, slug, session, now, "profile.create", { kind: "profile", id: profileId }, `Created profile ${profileId}`);
      return adminJson({ ok: true, id: profileId }, 201);
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  const row = await listProfiles(db, slug).then((rows) => rows.find((p) => p.id === id) ?? null);
  if (!row) return notFound();
  if (req.method === "GET") {
    const catalog = await loadCatalog(db, slug);
    return adminJson({ id: row.id, name: row.name, description: row.description ?? undefined, payload: redactPayload(parsePayload(row.payload_json), catalog), modifiedBy: row.modified_by ?? undefined, modifiedAt: row.modified_at });
  }
  if (req.method === "PUT") {
    const catalog = await loadCatalog(db, slug);
    if (!catalog) return err(409, ErrorCode.BadRequest, "no active catalog");
    const body = await readBody(req);
    const updates = Array.isArray(body.updates) ? (body.updates as OverrideUpdate[]) : [];
    const result = applyOverrides(parsePayload(row.payload_json), updates, catalog);
    if (!result.ok) return err(422, ErrorCode.BadRequest, "validation failed", { fields: result.fields });
    await upsertProfile(db, { ...row, payload_json: JSON.stringify(result.payload), modified_by: session.sub, modified_at: now });
    await audit(db, slug, session, now, "profile.overrides", { kind: "profile", id }, `Updated profile ${id}`);
    return adminJson({ ok: true, id });
  }
  if (req.method === "DELETE") {
    await deleteProfile(db, slug, id);
    await audit(db, slug, session, now, "profile.delete", { kind: "profile", id }, `Deleted profile ${id}`);
    return adminJson({ ok: true, id });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}

// ── tiers ────────────────────────────────────────────────────────────────────
async function handleTiers(
  req: Request,
  db: Db,
  session: AdminSession,
  slug: string,
  id: string | undefined,
  now: number,
): Promise<Response> {
  if (!id) {
    if (req.method === "GET") {
      const rows = await listTiers(db, slug);
      return adminJson({ tiers: rows.map((t) => ({ id: t.id, label: t.label, profile: t.profile_id, policyExpiryDays: t.policy_expiry_days, policyMachineLimit: t.policy_machine_limit })) });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const tierId = String(body.id ?? randomId("tier"));
      await upsertTier(db, {
        product: slug,
        id: tierId,
        label: String(body.label ?? tierId),
        profile_id: typeof body.profile === "string" ? body.profile : null,
        policy_expiry_days: typeof body.policyExpiryDays === "number" ? body.policyExpiryDays : null,
        policy_machine_limit: typeof body.policyMachineLimit === "number" ? body.policyMachineLimit : null,
        modified_by: session.sub,
        modified_at: now,
      });
      await audit(db, slug, session, now, "tier.create", { kind: "tier", id: tierId }, `Created tier ${tierId}`);
      return adminJson({ ok: true, id: tierId }, 201);
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }
  const row = await listTiers(db, slug).then((rows) => rows.find((t) => t.id === id) ?? null);
  if (!row) return notFound();
  if (req.method === "PATCH") {
    const body = await readBody(req);
    await upsertTier(db, {
      ...row,
      label: typeof body.label === "string" ? body.label : row.label,
      profile_id: typeof body.profile === "string" ? body.profile : row.profile_id,
      policy_expiry_days: typeof body.policyExpiryDays === "number" ? body.policyExpiryDays : row.policy_expiry_days,
      policy_machine_limit: typeof body.policyMachineLimit === "number" ? body.policyMachineLimit : row.policy_machine_limit,
      modified_by: session.sub,
      modified_at: now,
    });
    await audit(db, slug, session, now, "tier.update", { kind: "tier", id }, `Updated tier ${id}`);
    return adminJson({ ok: true, id });
  }
  if (req.method === "DELETE") {
    await deleteTier(db, slug, id);
    await audit(db, slug, session, now, "tier.delete", { kind: "tier", id }, `Deleted tier ${id}`);
    return adminJson({ ok: true, id });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}

// ── /api/me + logout ─────────────────────────────────────────────────────────
async function handleMe(env: Env, db: Db, session: AdminSession): Promise<Response> {
  const products = await listProducts(db);
  const platform = isPlatformAdmin(env, session);
  const adminProducts = products
    .filter((p) => platform || (p.admin_group != null && session.groups.includes(p.admin_group)))
    .map((p) => ({ slug: p.slug, name: p.name, schemaVersion: 0 }));
  return adminJson({
    sub: session.sub,
    name: session.name,
    email: session.email,
    csrf: session.csrf,
    platformAdmin: platform,
    products: adminProducts,
  });
}

/**
 * Admin API dispatcher. `path` is everything AFTER `/admin` (so it begins with `/api`).
 * Verifies the session, CSRF-checks mutations, then routes. Returns 401/403 cleanly.
 */
export async function handleAdminApi(req: Request, env: Env, db: Db, path: string, now: number): Promise<Response> {
  const session = await sessionFromRequest(env, req, now);
  if (!session) return unauthorized();

  // Strip the `/api` prefix; tolerate trailing slash.
  let p = path.startsWith("/api") ? path.slice(4) : path;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  const segments = p.split("/").filter(Boolean);

  // CSRF on every mutation (double-submit; SameSite=Strict is the primary defense).
  if (isMutation(req.method)) {
    const presented = req.headers.get(CSRF_HEADER);
    if (!presented || presented !== session.csrf) return forbidden("csrf");
  }

  const [head, ...rest] = segments;

  if (head === "me") return handleMe(env, db, session);
  if (head === "logout") {
    return adminJson({ ok: true }, 200, { "set-cookie": buildClearCookie() });
  }
  if (head === "products") {
    // /products  or  /products/<slug>/...
    if (rest.length <= 1) return handleProducts(req, env, db, session, rest, now);
    const [slug, ...productRest] = rest;
    return handleProductScoped(req, env, db, session, slug!, productRest, now);
  }

  return notFound();
}
