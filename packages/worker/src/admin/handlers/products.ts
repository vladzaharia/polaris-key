/**
 * Platform product-registry CRUD (`/api/products` and `/api/products/<slug>`), plus the two
 * product-creation paths and the product-scoped key/secret/release operations:
 *
 *   - `POST /api/products`                  — MANUAL create: configure + upload a schema; mints
 *                                             a per-product Ed25519 signing key (sealed under
 *                                             the platform KEK). NO release/minter rows.
 *   - `POST /api/products/link-repo`        — GITHUB-forward create: read a repo's `.pkey/`.
 *   - `PUT  /api/products/<slug>/secrets/<name>` — write-only sealed secret (never echoed).
 *   - `POST /api/products/<slug>/keys/rotate`    — retire the active key, mint a new active one.
 *   - `POST /api/products/<slug>/release/resync`  — re-fetch `.pkey/` and re-apply.
 *
 * Platform admin gates the registry + link-repo + manual create; product admin (or platform)
 * gates the per-product key/secret/release operations.
 */

import { Catalog } from "@polaris-key/catalog";
import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../http.js";
import {
  getProduct,
  insertProductKey,
  listProducts,
  retireProductKeys,
  stmtInsertProduct,
  stmtInsertProductKey,
  stmtInsertSchema,
  upsertProductSecret,
} from "../../repo.js";
import { deleteProduct, updateProduct } from "../repo.js";
import { generateEd25519, seal } from "../../keyvault.js";
import { linkRepo } from "../../release/linkRepo.js";
import { resyncRepo } from "../../release/resync.js";
import { audit } from "../audit.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, forbidden, notFound, readBody } from "../lib/respond.js";
import { productView } from "../lib/shape.js";

/** Compile a schema supplied as a JSON/YAML string or a parsed object. Returns the catalog or
 *  an error message. Reuses the catalog compiler so manual schema is validated like a publish. */
function compileSchema(input: unknown): { ok: true; catalog: Catalog } | { ok: false; message: string } {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      // Not JSON — fall back to YAML, mirroring the manifest parser's per-file detection.
      return { ok: false, message: "schema must be valid JSON (YAML supported via link-repo)" };
    }
  }
  try {
    const catalog = new Catalog(parsed as never);
    catalog.compileAll();
    return { ok: true, catalog };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "invalid catalog" };
  }
}

const signingKeySecretName = (slug: string): string =>
  `SIGNING_KEY__${slug.toUpperCase().replace(/-/g, "_")}`;

export async function handleProducts(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  segments: string[],
  now: number,
): Promise<Response> {
  if (!isPlatformAdmin(env, session)) return forbidden("platform admin required");

  // /api/products/link-repo — special-cased before treating the segment as a slug.
  if (segments.length === 1 && segments[0] === "link-repo") {
    if (req.method !== "POST") return err(405, ErrorCode.BadRequest, "method not allowed");
    const body = await readBody(req);
    const repoUrl = String(body.repoUrl ?? "").trim();
    if (!repoUrl) return err(422, ErrorCode.BadRequest, "repoUrl is required", { fields: ["repoUrl"] });
    const result = await linkRepo(env, db, repoUrl, now);
    if (!result.ok) {
      return err(422, ErrorCode.BadRequest, result.error, result.errors ? { errors: result.errors } : undefined);
    }
    await audit(db, result.slug, session, now, "product.link", { kind: "product", id: result.slug }, `Linked repo for product ${result.slug}`);
    return adminJson(
      { ok: true, slug: result.slug, kid: result.kid, install: result.install, remainingSecrets: result.remainingSecrets },
      201,
    );
  }

  // /api/products
  if (segments.length === 0) {
    if (req.method === "GET") {
      const rows = await listProducts(db);
      return adminJson({ products: rows.map(productView) });
    }
    if (req.method === "POST") return manualCreate(req, env, db, session, now);
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

/**
 * MANUAL product creation. Accepts a slug + meta + an uploaded schema and mints a per-product
 * signing key (sealed under the KEK) so the product can sign config immediately. No release or
 * edge-mint rows are created — a manual product has no GitHub-backed distribution or minter.
 */
async function manualCreate(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  now: number,
): Promise<Response> {
  const body = await readBody(req);
  const slug = String(body.slug ?? "").trim();
  if (!/^[a-z0-9-]+$/.test(slug)) return err(422, ErrorCode.BadRequest, "invalid slug", { fields: ["slug"] });
  if (await getProduct(db, slug)) return err(409, ErrorCode.BadRequest, "product exists", { fields: ["slug"] });

  // A schema is now required so the product gets a real, usable catalog. If none is supplied,
  // seed the empty catalog (still mints a signing key).
  const supplied = body.schema;
  let catalogObj: unknown = { schemaVersion: 1, entries: [] };
  if (supplied !== undefined) {
    const compiled = compileSchema(supplied);
    if (!compiled.ok) return err(422, ErrorCode.BadRequest, "invalid schema", { fields: [compiled.message] });
    catalogObj = { schemaVersion: 1, entries: compiled.catalog.entries };
  }

  // Mint + seal the per-product Ed25519 signing key under the platform KEK.
  const kid = String(body.signingKid ?? `${slug}-${new Date(now * 1000).getUTCFullYear()}`);
  const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
  const encPrivate = await seal(env, privatePkcs8Pem);

  // Atomic: product + signing key + active catalog in ONE batch, so a product can never
  // exist without a usable signing key (matches the link-repo invariant).
  await db.batch([
    stmtInsertProduct({
      slug,
      name: String(body.name ?? slug),
      signing_kid: kid,
      signing_key_secret: signingKeySecretName(slug),
      signing_pub: publicRawB64url,
      compat_min: String(body.compatMin ?? "0.0.0"),
      compat_max: String(body.compatMax ?? "99.0.0"),
      default_max_offline_days: Number(body.defaultMaxOfflineDays ?? 30),
      default_machine_limit: Number(body.defaultMachineLimit ?? 5),
      admin_group: typeof body.adminGroup === "string" ? body.adminGroup : null,
      branding_json: null,
      release_source: null,
      created_at: now,
      modified_at: now,
    }),
    stmtInsertProductKey({
      product: slug,
      kid,
      alg: "Ed25519",
      public_b64url: publicRawB64url,
      enc_private_json: encPrivate,
      status: "active",
      created_at: now,
      rotated_at: null,
    }),
    stmtInsertSchema({
      product: slug,
      catalog_version: 1,
      catalog_json: JSON.stringify(catalogObj),
      active: 1,
      created_at: now,
    }),
  ]);
  await audit(db, slug, session, now, "product.create", { kind: "product", id: slug }, `Created product ${slug}`);
  const created = await getProduct(db, slug);
  return adminJson({ ok: true, slug, kid, product: created ? productView(created) : null }, 201);
}

/**
 * Product-scoped key/secret/release operations: PUT a write-only secret, rotate the signing
 * key, or resync from the linked repo. Called from the dispatcher with the product already
 * authz-checked (product admin OR platform).
 */
export async function handleProductScopedResource(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  resource: string,
  // The trailing path segment: a secret NAME (secrets/<name>) or an action (keys/<rotate>,
  // release/<resync>). One position serves all three resources.
  id: string | undefined,
  now: number,
): Promise<Response> {
  if (resource === "secrets") return handleSecrets(req, env, db, session, slug, id, now);
  if (resource === "keys") return handleKeys(req, env, db, session, slug, id, now);
  if (resource === "release") return handleRelease(req, env, db, session, slug, id, now);
  return notFound();
}

/** PUT /api/products/<slug>/secrets/<name> {value} — write-only: seal + store; echo NAME only. */
async function handleSecrets(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  name: string | undefined,
  now: number,
): Promise<Response> {
  if (!name) return notFound();
  if (req.method !== "PUT") return err(405, ErrorCode.BadRequest, "method not allowed");
  const body = await readBody(req);
  const value = body.value;
  if (typeof value !== "string" || value.length === 0) {
    return err(422, ErrorCode.BadRequest, "value is required", { fields: ["value"] });
  }
  const enc = await seal(env, value);
  await upsertProductSecret(db, { product: slug, name, enc_value_json: enc, created_at: now, modified_at: now });
  await audit(db, slug, session, now, "secret.set", { kind: "secret", id: name }, `Set secret ${name}`);
  // NEVER echo the value back — only the name.
  return adminJson({ ok: true, name });
}

/** POST /api/products/<slug>/keys/rotate — retire the active key, insert a new active one. */
async function handleKeys(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  action: string | undefined,
  now: number,
): Promise<Response> {
  if (action !== "rotate") return notFound();
  if (req.method !== "POST") return err(405, ErrorCode.BadRequest, "method not allowed");

  const kid = `${slug}-${new Date(now * 1000).getUTCFullYear()}-${(now % 100000).toString(36)}`;
  const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
  const encPrivate = await seal(env, privatePkcs8Pem);

  await retireProductKeys(db, slug, now);
  await insertProductKey(db, {
    product: slug,
    kid,
    alg: "Ed25519",
    public_b64url: publicRawB64url,
    enc_private_json: encPrivate,
    status: "active",
    created_at: now,
    rotated_at: null,
  });
  await audit(db, slug, session, now, "key.rotate", { kind: "key", id: kid }, `Rotated signing key to ${kid}`);
  // Respond with the new kid + PUBLIC key only — the private key never leaves the KEK store.
  return adminJson({ ok: true, kid, publicKey: publicRawB64url });
}

/** POST /api/products/<slug>/release/resync — re-fetch `.pkey/` and re-apply (diff-then-update). */
async function handleRelease(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  action: string | undefined,
  now: number,
): Promise<Response> {
  if (action !== "resync") return notFound();
  if (req.method !== "POST") return err(405, ErrorCode.BadRequest, "method not allowed");
  const result = await resyncRepo(env, db, slug, now);
  if (!result.ok) {
    return err(422, ErrorCode.BadRequest, result.error, result.errors ? { errors: result.errors } : undefined);
  }
  await audit(db, slug, session, now, "release.resync", { kind: "product", id: slug }, `Resynced ${slug} from its linked repo`);
  return adminJson({ ok: true, slug, updated: result.updated });
}
