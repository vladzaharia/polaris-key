/**
 * Platform product-registry CRUD (`/api/products` and `/api/products/<slug>`), plus the two
 * product-creation paths and the product-scoped key/secret/release operations:
 *
 *   - `POST /api/products`                  — MANUAL create: configure + upload a schema; mints
 *                                             a per-product Ed25519 signing key (sealed under
 *                                             the platform KEK). NO release/minter rows.
 *   - `POST /api/products/link-repo`        — GITHUB-forward create: read a repo's `.pkey/`.
 *   - `GET  /api/products/kek`              — platform KEK keyring status: which kid is active
 *                                             and how many sealed rows sit under each kid.
 *   - `POST /api/products/kek`              — re-seal a bounded batch of rows under the active
 *                                             KEK (the rotation sweep; idempotent + resumable).
 *   - `PUT  /api/products/<slug>/secrets/<name>` — write-only sealed secret (never echoed).
 *   - `POST /api/products/<slug>/keys/rotate`    — retire the active key, mint a new active one.
 *   - `POST /api/products/<slug>/release/resync`  — re-fetch `.pkey/` and re-apply.
 *
 * Platform admin gates the registry + link-repo + manual create; product admin (or platform)
 * gates the per-product key/secret/release operations.
 */

import { Catalog } from "@polaris-key/catalog";
import { parse as parseYaml } from "yaml";
import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../http.js";
import {
  getProduct,
  getTier,
  revertAutoIssueToManifest,
  revertFingerprintPolicyToManifest,
  setAutoIssuePolicy,
  setFingerprintPolicy,
  type ProductRow,
  listProducts,
  stmtInsertProduct,
  stmtInsertProductKey,
  stmtRetireProductKeys,
  stmtSetProductKeyStatus,
  stmtInsertSchema,
  upsertProductSyncState,
  upsertProductSecret,
} from "../../repo.js";
import { deleteTokenRecord } from "../../kv.js";
import { deleteProduct, listDevicesByProduct, updateProduct } from "../repo.js";
import {
  describeKeyring,
  generateEd25519,
  open,
  seal,
  type Sealed,
} from "../../keyvault.js";
import { linkRepo } from "../../release/linkRepo.js";
import { MAX_MANIFEST_BYTES } from "../../release/manifest.js";
import { resyncRepo } from "../../release/resync.js";
import { checkReleaseHealth } from "../../release/health.js";
import {
  getPortalProductSettings,
  portalProductSettingsView,
  upsertPortalProductSettings,
} from "../../portal/repo.js";
import {
  isAutoIssueMode,
  isFingerprintMode,
  parseAutoIssue,
  parseFingerprintPolicy,
} from "../../fingerprint.js";
import { audit } from "../audit.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../session.js";
import {
  adminJson,
  err,
  forbidden,
  notFound,
  readBody,
} from "../lib/respond.js";
import { productView } from "../lib/shape.js";

/** Compile a schema supplied as a JSON/YAML string or a parsed object. Returns the catalog or
 *  an error message. Reuses the catalog compiler so manual schema is validated like a publish. */
function compileSchema(
  input: unknown,
): { ok: true; catalog: Catalog } | { ok: false; message: string } {
  let parsed: unknown = input;
  if (typeof input === "string") {
    // R7-02, second copy. The webhook-reachable parser in `release/manifest.ts` was capped
    // after a 1.67 MB manifest was measured at 37.7 s (`yaml`'s uniqueKeys check is
    // quadratic) — but this admin-reachable copy was left uncapped, so the same defect was
    // still live one route over. `.length` counts UTF-16 units and is never greater than the
    // UTF-8 byte length, so it is a sound O(1) prefilter before the encode.
    if (
      input.length > MAX_MANIFEST_BYTES ||
      new TextEncoder().encode(input).byteLength > MAX_MANIFEST_BYTES
    ) {
      return {
        ok: false,
        message: `schema must be at most ${MAX_MANIFEST_BYTES} bytes`,
      };
    }
    try {
      parsed = JSON.parse(input);
    } catch {
      try {
        // `uniqueKeys: false` is the 34x win; `maxAliasCount` bounds alias expansion.
        parsed = parseYaml(input, { uniqueKeys: false, maxAliasCount: 100 });
      } catch {
        return { ok: false, message: "schema must be valid JSON or YAML" };
      }
    }
  }
  try {
    const catalog = new Catalog(parsed as never);
    catalog.compileAll();
    return { ok: true, catalog };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "invalid catalog",
    };
  }
}

export async function handleProducts(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  segments: string[],
  now: number,
): Promise<Response> {
  if (!isPlatformAdmin(env, session))
    return forbidden("platform admin required");

  // /api/products/kek — the platform KEK keyring. Like `link-repo` below, this is a reserved
  // one-segment ACTION, not a product slug, and is matched before the slug lookup.
  if (segments.length === 1 && segments[0] === "kek")
    return handleKekKeyring(req, env, db, session, now);

  // /api/products/link-repo — special-cased before treating the segment as a slug.
  if (segments.length === 1 && segments[0] === "link-repo") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const body = await readBody(req);
    const repoUrl = String(body.repoUrl ?? "").trim();
    if (!repoUrl)
      return err(422, ErrorCode.BadRequest, "repoUrl is required", {
        fields: ["repoUrl"],
      });
    const result = await linkRepo(env, db, repoUrl, now);
    if (!result.ok) {
      return err(
        422,
        ErrorCode.BadRequest,
        result.error,
        result.errors ? { errors: result.errors } : undefined,
      );
    }
    await audit(
      db,
      result.slug,
      session,
      now,
      "product.link",
      { kind: "product", id: result.slug },
      `Linked repo for product ${result.slug}`,
    );
    return adminJson(
      {
        ok: true,
        slug: result.slug,
        kid: result.kid,
        signing: {
          kid: result.kid,
          alg: "Ed25519",
          publicKey: result.publicKey,
          jwksUrl: `/${result.slug}/.well-known/jwks.json`,
          trustKeys: result.trustKeys,
        },
        install: result.install,
        remainingSecrets: result.remainingSecrets,
      },
      201,
    );
  }

  // /api/products
  if (segments.length === 0) {
    if (req.method === "GET") {
      const rows = await listProducts(db);
      return adminJson({
        products: await Promise.all(
          rows.map((row) => productView(env, db, row)),
        ),
      });
    }
    if (req.method === "POST") return manualCreate(req, env, db, session, now);
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  // /api/products/<slug>
  const slug = segments[0]!;
  const row = await getProduct(db, slug);
  if (!row) return notFound();
  if (req.method === "GET")
    return adminJson({ product: await productView(env, db, row) });
  if (req.method === "PATCH") {
    const body = await readBody(req);
    // R11-02 part 2: `limit > 0` in licenseCore means a 0/negative limit reads as UNLIMITED.
    if (
      typeof body.defaultDeviceLimit === "number" &&
      (!Number.isInteger(body.defaultDeviceLimit) ||
        body.defaultDeviceLimit <= 0)
    ) {
      return err(
        422,
        ErrorCode.BadRequest,
        "defaultDeviceLimit must be a positive integer",
        { fields: ["defaultDeviceLimit"] },
      );
    }
    await updateProduct(
      db,
      slug,
      {
        name: typeof body.name === "string" ? body.name : undefined,
        compat_min:
          typeof body.compatMin === "string" ? body.compatMin : undefined,
        compat_max:
          typeof body.compatMax === "string" ? body.compatMax : undefined,
        default_max_offline_days:
          typeof body.defaultMaxOfflineDays === "number"
            ? body.defaultMaxOfflineDays
            : undefined,
        default_device_limit:
          typeof body.defaultDeviceLimit === "number"
            ? body.defaultDeviceLimit
            : undefined,
        admin_group:
          typeof body.adminGroup === "string" ? body.adminGroup : undefined,
      },
      now,
    );
    await audit(
      db,
      slug,
      session,
      now,
      "product.update",
      { kind: "product", id: slug },
      `Updated product ${slug}`,
    );
    return adminJson({ ok: true, slug });
  }
  if (req.method === "DELETE") {
    const body = await readBody(req);
    if (body.confirmSlug !== slug) {
      return err(422, ErrorCode.BadRequest, "confirmSlug must match product", {
        fields: ["confirmSlug"],
      });
    }
    const devices = await listDevicesByProduct(db, slug);
    for (const device of devices) {
      if (device.token_hash)
        await deleteTokenRecord(env, slug, device.token_hash);
    }
    await audit(
      db,
      slug,
      session,
      now,
      "product.delete",
      { kind: "product", id: slug },
      `Deleted product ${slug}`,
    );
    await deleteProduct(db, slug, now);
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
  if (!/^[a-z0-9-]+$/.test(slug))
    return err(422, ErrorCode.BadRequest, "invalid slug", { fields: ["slug"] });
  if (await getProduct(db, slug))
    return err(409, ErrorCode.BadRequest, "product exists", {
      fields: ["slug"],
    });

  // A schema is now required so the product gets a real, usable catalog. If none is supplied,
  // seed the empty catalog (still mints a signing key).
  const supplied = body.schema;
  let catalogObj: unknown = { schemaVersion: 1, entries: [] };
  if (supplied !== undefined) {
    const compiled = compileSchema(supplied);
    if (!compiled.ok)
      return err(422, ErrorCode.BadRequest, "invalid schema", {
        fields: [compiled.message],
      });
    catalogObj = { schemaVersion: 1, entries: compiled.catalog.entries };
  }

  // Mint + seal the per-product Ed25519 signing key under the platform KEK.
  const kid = String(
    body.signingKid ?? `${slug}-${new Date(now * 1000).getUTCFullYear()}`,
  );
  const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
  const encPrivate = await seal(env, privatePkcs8Pem, {
    product: slug,
    kind: "signing-key",
    id: kid,
  });

  // Atomic: product + signing key + active catalog in ONE batch, so a product can never
  // exist without a usable signing key (matches the link-repo invariant).
  await db.batch([
    stmtInsertProduct({
      slug,
      name: String(body.name ?? slug),
      signing_kid: kid,
      signing_pub: publicRawB64url,
      compat_min: String(body.compatMin ?? "0.0.0"),
      compat_max: String(body.compatMax ?? "99.0.0"),
      default_max_offline_days: Number(body.defaultMaxOfflineDays ?? 30),
      default_device_limit: Number(body.defaultDeviceLimit ?? 5),
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
  await audit(
    db,
    slug,
    session,
    now,
    "product.create",
    { kind: "product", id: slug },
    `Created product ${slug}`,
  );
  const created = await getProduct(db, slug);
  return adminJson(
    {
      ok: true,
      slug,
      kid,
      signing: {
        kid,
        alg: "Ed25519",
        publicKey: publicRawB64url,
        jwksUrl: `/${slug}/.well-known/jwks.json`,
        trustKeys: { [kid]: publicRawB64url },
      },
      product: created ? await productView(env, db, created) : null,
    },
    201,
  );
}

// ── platform KEK keyring + re-seal sweep (R2-09) ───────────────────────────────────────────
//
// A KEK rotation cannot be a `.sql` migration — SQLite cannot do AES-GCM — so the re-encryption
// pass lives here, as an operator-invoked, bounded, idempotent, resumable sweep. See
// docs/RUNBOOK.md § "Rotating PLATFORM_KEK" for the full procedure this backs.

/**
 * SQL for the kid recorded INSIDE a sealed envelope. Read straight from the blob rather than
 * from a denormalised `kek_id` column, so it can never disagree with the ciphertext it
 * describes and no writer has to remember to maintain it.
 *
 * The `json_valid` guard is load-bearing: a bare `json_extract` over a column containing ONE
 * malformed row raises "malformed JSON" for the whole statement, so a single unreadable blob
 * would otherwise blind the sweep to every other row. Guarded, it reads as NULL — counted and
 * reported instead of fatal.
 */
function kekIdOf(column: string): string {
  return `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.kekId') END`;
}

/** The bucket a row whose envelope will not parse as JSON at all is reported under. */
const UNREADABLE_KEK = "(unreadable)";

/** Every table holding sealed values, with the AAD `kind` its rows are bound under. The AAD
 *  (`pkey:v2:<product>:<kind>:<id>`) is reconstructed identically on open and re-seal, so a
 *  rotation never weakens the slot binding. */
const SEALED_TABLES = [
  {
    table: "product_keys",
    idColumn: "kid",
    blobColumn: "enc_private_json",
    kind: "signing-key",
    label: "keys",
  },
  {
    table: "product_secrets",
    idColumn: "name",
    blobColumn: "enc_value_json",
    kind: "product-secret",
    label: "secrets",
  },
] as const;

/**
 * R12-02's catalog-declared managed secrets are ALSO sealed under the platform KEK, but they
 * live as envelopes NESTED inside a JSON payload column rather than as a column of their own —
 * so they need their own pass, or retiring an old KEK would silently break them.
 * (`openManagedValue` swallows a failed open and returns `null`, so the damage would surface as
 * a config document with a missing secret, not as an error.)
 *
 * Both tables are keyed `(product, id)` and store `JSON.stringify(ManagedPayload)` with sealed
 * values under `config` / `secrets`. The AAD is `…:product-secret:managed:<key>`, exactly as
 * `admin/lib/managedSecrets.ts` writes it.
 */
const MANAGED_PAYLOAD_TABLES = [
  { table: "profiles", column: "payload_json" },
  { table: "licenses", column: "overrides_json" },
] as const;

/** How `"kekId":"` looks once the envelope has been JSON-encoded INTO the payload column. */
const NESTED_KEK_MARK = '\\"kekId\\":\\"';

const RESEAL_DEFAULT_LIMIT = 50;
const RESEAL_MAX_LIMIT = 200;

type KekCounts = Record<string, Record<string, number>>;

/** The kid inside a sealed envelope string, or null if the value is not one. */
function envelopeKekId(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value) as Partial<Sealed>;
    return parsed.v === 2 &&
      typeof parsed.ct === "string" &&
      typeof parsed.kekId === "string"
      ? parsed.kekId
      : null;
  } catch {
    return null;
  }
}

interface ManagedLeaf {
  bucket: "config" | "secrets";
  key: string;
  kekId: string;
  value: string;
}

type ManagedBuckets = Record<
  string,
  Record<string, { value?: unknown } | null> | undefined
>;

/** Every sealed envelope inside one managed payload column, with the parsed payload to write
 *  back into. */
function managedLeaves(json: string | null): {
  payload: ManagedBuckets | null;
  leaves: ManagedLeaf[];
} {
  if (!json) return { payload: null, leaves: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { payload: null, leaves: [] };
  }
  if (typeof parsed !== "object" || parsed === null)
    return { payload: null, leaves: [] };
  const payload = parsed as ManagedBuckets;
  const leaves: ManagedLeaf[] = [];
  for (const bucket of ["config", "secrets"] as const) {
    const entries = payload[bucket];
    if (typeof entries !== "object" || entries === null) continue;
    for (const [key, entry] of Object.entries(entries)) {
      const kekId = envelopeKekId(entry?.value);
      if (kekId)
        leaves.push({ bucket, key, kekId, value: entry!.value as string });
    }
  }
  return { payload, leaves };
}

/** SQL selecting rows whose payload holds at least one envelope under a kid OTHER than the
 *  active one. Decided in SQL by occurrence arithmetic — counting `"kekId":"` against
 *  `"kekId":"<active>"` — so an already-migrated row can never occupy the LIMIT and starve the
 *  rows that still need work. Bind with `managedNeedsWorkParams`. */
function managedNeedsWork(column: string): string {
  return `(length(${column}) - length(replace(${column}, ?, ''))) / length(?)
        > (length(${column}) - length(replace(${column}, ?, ''))) / length(?)`;
}

function managedNeedsWorkParams(
  active: string,
): [string, string, string, string] {
  const activeMark = `${NESTED_KEK_MARK}${active}\\"`;
  return [NESTED_KEK_MARK, NESTED_KEK_MARK, activeMark, activeMark];
}

/** `{ keys: {k1:3,k2:12}, secrets: {k1:1}, managed: {k1:2} }` — sealed values per kid: whole
 *  rows for the two envelope columns, individual leaves for the managed payloads. */
async function kekCounts(db: Db): Promise<KekCounts> {
  const counts: KekCounts = {};
  for (const t of SEALED_TABLES) {
    const rows = await db.all<{ kek_id: string | null; n: number }>(
      `SELECT ${kekIdOf(t.blobColumn)} AS kek_id, COUNT(*) AS n
         FROM ${t.table} GROUP BY 1`,
    );
    const perKid: Record<string, number> = {};
    for (const row of rows)
      perKid[row.kek_id ?? UNREADABLE_KEK] = Number(row.n);
    counts[t.label] = perKid;
  }
  // Only rows that actually carry an envelope are parsed; the rest never leave SQLite.
  const managed: Record<string, number> = {};
  for (const t of MANAGED_PAYLOAD_TABLES) {
    const rows = await db.all<{ blob: string }>(
      `SELECT ${t.column} AS blob FROM ${t.table} WHERE ${t.column} LIKE '%kekId%'`,
    );
    for (const row of rows) {
      for (const leaf of managedLeaves(row.blob).leaves)
        managed[leaf.kekId] = (managed[leaf.kekId] ?? 0) + 1;
    }
  }
  counts.managed = managed;
  return counts;
}

/**
 * Two different numbers an operator must not conflate:
 *
 *  - `remaining`  — rows not yet re-sealed under the active kid. Reaching 0 is the gate for
 *                   retiring the old KEK; without it a rotation ends in a guess.
 *  - `unopenable` — rows whose kid is not in the ring AT ALL. These are already dark: their
 *                   product's routes are 404ing right now. Non-zero means a key was dropped
 *                   from `PLATFORM_KEK_KEYS` too early — put it back.
 */
function progressOf(
  counts: KekCounts,
  active: string,
  kids: string[],
): { remaining: number; unopenable: number } {
  let remaining = 0;
  let unopenable = 0;
  for (const perKid of Object.values(counts)) {
    for (const [kid, n] of Object.entries(perKid)) {
      if (kid === active) continue;
      remaining += n;
      if (!kids.includes(kid)) unopenable += n;
    }
  }
  return { remaining, unopenable };
}

interface ResealFailure {
  table: string;
  product: string;
  id: string;
  message: string;
}

/**
 * Re-seal up to `limit` rows under `active`. Four properties make this safe to run at any time,
 * including repeatedly and concurrently with normal admin traffic:
 *
 *  1. **Idempotent** — the `IS NOT <active>` filter means an already-rotated row is never touched.
 *  2. **Compare-and-swap** — the update is conditioned on the OLD ciphertext, so a racing admin
 *     write (a key rotation, a `secret.set`) wins and the row is picked up on the next pass
 *     rather than being clobbered with a stale plaintext.
 *  3. **Bounded** — `limit` keeps one call inside the Worker CPU and D1 per-request budgets.
 *  4. **Verified** — the new envelope must re-open to the same bytes BEFORE it replaces the old
 *     one; a row that cannot be opened at all is reported, never silently skipped or destroyed.
 */
async function resealSweep(
  env: Env,
  db: Db,
  active: string,
  limit: number,
): Promise<{
  resealed: number;
  skipped: number;
  failures: ResealFailure[];
  perProduct: Map<string, number>;
}> {
  let budget = limit;
  let resealed = 0;
  let skipped = 0;
  const failures: ResealFailure[] = [];
  const perProduct = new Map<string, number>();

  for (const t of SEALED_TABLES) {
    if (budget <= 0) break;
    const rows = await db.all<{ product: string; id: string; blob: string }>(
      `SELECT product, ${t.idColumn} AS id, ${t.blobColumn} AS blob
         FROM ${t.table}
        WHERE ${kekIdOf(t.blobColumn)} IS NOT ?
        ORDER BY product, ${t.idColumn}
        LIMIT ?`,
      active,
      budget,
    );
    for (const row of rows) {
      budget--;
      const ctx = {
        product: row.product,
        kind: t.kind,
        id: row.id,
      } as const;
      let next: string;
      try {
        const plaintext = await open(env, row.blob, ctx);
        next = await seal(env, plaintext, ctx);
        if ((await open(env, next, ctx)) !== plaintext)
          throw new Error("re-sealed value did not round-trip");
      } catch (e) {
        failures.push({
          table: t.table,
          product: row.product,
          id: row.id,
          message: e instanceof Error ? e.message : "re-seal failed",
        });
        continue;
      }
      const changed = await db.runChanges(
        `UPDATE ${t.table} SET ${t.blobColumn} = ?
          WHERE product = ? AND ${t.idColumn} = ? AND ${t.blobColumn} = ?`,
        next,
        row.product,
        row.id,
        row.blob,
      );
      if (changed > 0) {
        resealed++;
        perProduct.set(row.product, (perProduct.get(row.product) ?? 0) + 1);
      } else {
        skipped++;
      }
    }
  }

  // Pass 2: envelopes nested inside managed payloads. Budget is spent per ROW here (a row can
  // carry several sealed keys); `resealed` still counts individual values.
  for (const t of MANAGED_PAYLOAD_TABLES) {
    if (budget <= 0) break;
    const rows = await db.all<{ product: string; id: string; blob: string }>(
      `SELECT product, id, ${t.column} AS blob
         FROM ${t.table}
        WHERE ${managedNeedsWork(t.column)}
        ORDER BY product, id
        LIMIT ?`,
      ...managedNeedsWorkParams(active),
      budget,
    );
    for (const row of rows) {
      budget--;
      const { payload, leaves } = managedLeaves(row.blob);
      let rewritten = 0;
      for (const leaf of leaves) {
        if (leaf.kekId === active) continue;
        const ctx = {
          product: row.product,
          kind: "product-secret" as const,
          id: `managed:${leaf.key}`,
        };
        try {
          const plaintext = await open(env, leaf.value, ctx);
          const next = await seal(env, plaintext, ctx);
          if ((await open(env, next, ctx)) !== plaintext)
            throw new Error("re-sealed value did not round-trip");
          payload![leaf.bucket]![leaf.key]!.value = next;
          rewritten++;
        } catch (e) {
          failures.push({
            table: t.table,
            product: row.product,
            id: `${row.id}:${leaf.bucket}.${leaf.key}`,
            message: e instanceof Error ? e.message : "re-seal failed",
          });
        }
      }
      if (rewritten === 0) continue;
      const changed = await db.runChanges(
        `UPDATE ${t.table} SET ${t.column} = ?
          WHERE product = ? AND id = ? AND ${t.column} = ?`,
        JSON.stringify(payload),
        row.product,
        row.id,
        row.blob,
      );
      if (changed > 0) {
        resealed += rewritten;
        perProduct.set(
          row.product,
          (perProduct.get(row.product) ?? 0) + rewritten,
        );
      } else {
        skipped += rewritten;
      }
    }
  }
  return { resealed, skipped, failures, perProduct };
}

/** `GET|POST /api/products/kek` — keyring status, and the re-seal sweep. Platform-admin gated
 *  by the caller; the POST is CSRF-checked by the dispatcher like every other mutation. */
async function handleKekKeyring(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  now: number,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  let active: string;
  let kids: string[];
  try {
    ({ active, kids } = await describeKeyring(env));
  } catch (e) {
    // The keyring is the one piece of configuration whose failure mode is otherwise INVISIBLE:
    // `loadProduct` swallows the `open()` throw and every product route 404s. Report it
    // verbatim here so an operator mid-rotation sees "the ring did not parse", not a 500.
    return err(
      503,
      ErrorCode.BadRequest,
      `platform KEK keyring is unusable: ${e instanceof Error ? e.message : "unknown error"}`,
    );
  }

  if (req.method === "GET") {
    const counts = await kekCounts(db);
    return adminJson({
      ok: true,
      active,
      kids,
      counts,
      ...progressOf(counts, active, kids),
    });
  }

  const body = await readBody(req);
  const limit =
    body.limit === undefined
      ? RESEAL_DEFAULT_LIMIT
      : typeof body.limit === "number" && Number.isInteger(body.limit)
        ? body.limit
        : NaN;
  if (!(limit >= 1 && limit <= RESEAL_MAX_LIMIT)) {
    return err(
      422,
      ErrorCode.BadRequest,
      `limit must be an integer between 1 and ${RESEAL_MAX_LIMIT}`,
      { fields: ["limit"] },
    );
  }

  const sweep = await resealSweep(env, db, active, limit);
  // One audit row per product actually touched. The audit table is product-scoped, so a sweep
  // that spans tenants leaves a trail in each tenant's own log rather than one platform row
  // nobody looking at a product would ever see.
  for (const [product, count] of sweep.perProduct) {
    await audit(
      db,
      product,
      session,
      now,
      "kek.reseal",
      { kind: "kek", id: active },
      `Re-sealed ${count} value(s) for ${product} under KEK ${active}`,
    );
  }
  const counts = await kekCounts(db);
  return adminJson({
    ok: true,
    active,
    kids,
    resealed: sweep.resealed,
    skipped: sweep.skipped,
    failed: sweep.failures.length,
    failures: sweep.failures,
    counts,
    ...progressOf(counts, active, kids),
  });
}

/**
 * Product-scoped key/secret/release/portal operations: PUT a write-only secret, rotate the
 * signing key, resync from the linked repo, or update customer portal module settings. Called
 * from the dispatcher with the product already authz-checked (product admin OR platform).
 */
export async function handleProductScopedResource(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  resource: string,
  // The trailing path segment: a secret NAME (secrets/<name>) or an action (keys/<rotate>,
  // release/<resync>). One position serves all resources that need a sub-action.
  id: string | undefined,
  now: number,
): Promise<Response> {
  if (resource === "secrets")
    return handleSecrets(req, env, db, session, slug, id, now);
  if (resource === "keys")
    return handleKeys(req, env, db, session, slug, id, now);
  if (resource === "release")
    return handleRelease(req, env, db, session, slug, id, now);
  if (resource === "portal")
    return handlePortalSettings(req, db, session, slug, now);
  if (resource === "policy")
    return handleFingerprintPolicy(req, db, session, slug, id, now);
  return notFound();
}

/**
 * `GET|PATCH /api/products/<slug>/policy` and `POST .../policy/revert`.
 *
 * The fingerprint policy is declared in `.pkey/product` but must also be changeable live,
 * which is only coherent if a resync can't silently undo an operator's change. A PATCH here
 * marks the row `admin`-owned; `revert` hands it back to the manifest and the next resync
 * re-applies it.
 */
async function handleFingerprintPolicy(
  req: Request,
  db: Db,
  session: AdminSession,
  slug: string,
  action: string | undefined,
  now: number,
): Promise<Response> {
  const row = await getProduct(db, slug);
  if (!row) return notFound();

  if (action === "revert") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    await revertFingerprintPolicyToManifest(db, slug, now);
    await revertAutoIssueToManifest(db, slug, now);
    await audit(
      db,
      slug,
      session,
      now,
      "product.fingerprint.revert",
      { kind: "product", id: slug },
      `Returned the fingerprint policy for ${slug} to manifest control`,
    );
    const reverted = await getProduct(db, slug);
    return adminJson(policyView(reverted));
  }
  if (action !== undefined) return notFound();

  if (req.method === "GET") return adminJson(policyView(row));
  if (req.method !== "PATCH")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const body = await readBody(req);
  const current = parseFingerprintPolicy(row.fingerprint_policy_json);
  const fields: string[] = [];

  let enabled = current.enabled;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") fields.push("enabled");
    else enabled = body.enabled;
  }

  let defaultMode = current.defaultMode;
  if (body.defaultMode !== undefined) {
    if (!isFingerprintMode(body.defaultMode)) fields.push("defaultMode");
    else defaultMode = body.defaultMode;
  }

  let probes = current.probes;
  if (body.probes !== undefined) {
    if (!Array.isArray(body.probes)) fields.push("probes");
    else {
      // Reuse the same parser the Worker reads policy through, so an admin cannot store a
      // shape the runtime would silently discard.
      probes = parseFingerprintPolicy(
        JSON.stringify({ probes: body.probes }),
      ).probes;
      if (probes.length !== body.probes.length) fields.push("probes");
    }
  }

  // ── auto-issue ──────────────────────────────────────────────────────────────
  const currentAuto = parseAutoIssue(row.auto_issue_json);
  const auto = { ...currentAuto };
  if (body.autoIssue !== undefined) {
    if (
      !body.autoIssue ||
      typeof body.autoIssue !== "object" ||
      Array.isArray(body.autoIssue)
    ) {
      fields.push("autoIssue");
    } else {
      const patch = body.autoIssue as Record<string, unknown>;
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== "boolean")
          fields.push("autoIssue.enabled");
        else auto.enabled = patch.enabled;
      }
      if (patch.tierId !== undefined) {
        if (patch.tierId !== null && typeof patch.tierId !== "string")
          fields.push("autoIssue.tierId");
        else auto.tierId = (patch.tierId as string | null) || null;
      }
      if (patch.mode !== undefined) {
        if (!isAutoIssueMode(patch.mode)) fields.push("autoIssue.mode");
        else auto.mode = patch.mode;
      }
      if (patch.rateLimitPerHour !== undefined) {
        if (
          typeof patch.rateLimitPerHour !== "number" ||
          !Number.isFinite(patch.rateLimitPerHour) ||
          patch.rateLimitPerHour < 0
        ) {
          fields.push("autoIssue.rateLimitPerHour");
        } else auto.rateLimitPerHour = Math.trunc(patch.rateLimitPerHour);
      }
      // Enabling with a tier that doesn't exist would mint licenses whose entitlements
      // nobody configured, so it is rejected here rather than failing silently at enroll.
      if (auto.enabled) {
        if (!auto.tierId) fields.push("autoIssue.tierId");
        else if (!(await getTier(db, slug, auto.tierId)))
          fields.push("autoIssue.tierId");
      }
    }
  }

  if (fields.length > 0)
    return err(422, ErrorCode.BadRequest, "invalid policy", { fields });

  const policy = { enabled, defaultMode, probes };
  await setFingerprintPolicy(db, slug, JSON.stringify(policy), "admin", now);
  if (body.autoIssue !== undefined) {
    await setAutoIssuePolicy(db, slug, JSON.stringify(auto), "admin", now);
  }
  await audit(
    db,
    slug,
    session,
    now,
    "product.policy.update",
    { kind: "product", id: slug },
    `Set the device policy for ${slug}: fingerprint ${enabled ? defaultMode : "disabled"}, ` +
      `auto-issue ${auto.enabled ? `${auto.mode} → ${auto.tierId}` : "disabled"}`,
  );
  return adminJson(await policyView(await getProduct(db, slug)));
}

/** One projection for both GET and the post-write echo, so they can't drift. */
function policyView(row: ProductRow | null): {
  policy: ReturnType<typeof parseFingerprintPolicy>;
  source: string;
  autoIssue: ReturnType<typeof parseAutoIssue>;
  autoIssueSource: string;
} {
  return {
    policy: parseFingerprintPolicy(row?.fingerprint_policy_json),
    source: row?.fingerprint_policy_source ?? "manifest",
    autoIssue: parseAutoIssue(row?.auto_issue_json),
    autoIssueSource: row?.auto_issue_source ?? "manifest",
  };
}

async function handlePortalSettings(
  req: Request,
  db: Db,
  session: AdminSession,
  slug: string,
  now: number,
): Promise<Response> {
  if (req.method === "GET") {
    const settings = await getPortalProductSettings(db, slug);
    return adminJson({ settings: portalProductSettingsView(settings) });
  }
  if (req.method !== "PATCH")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const body = await readBody(req);
  const patch: Parameters<typeof upsertPortalProductSettings>[2] = {};
  const booleans = [
    "portalEnabled",
    "oidcEnabled",
    "magicEnabled",
    "licenseKeyClaimEnabled",
    "releasesEnabled",
  ] as const;
  const fields: string[] = [];
  for (const key of booleans) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") fields.push(key);
    else patch[key] = body[key];
  }
  // R5-01/R5-02 — tri-state, so an operator can override the issuer-derived default in either
  // direction: `null` restores "auto" (on for platform-issuer products, OFF for products on a
  // tenant-controlled 'custom' issuer, whose email/sub claims are outside the trust boundary).
  if (body.autoLinkEnabled !== undefined) {
    if (body.autoLinkEnabled === null) patch.autoLinkEnabled = null;
    else if (typeof body.autoLinkEnabled === "boolean")
      patch.autoLinkEnabled = body.autoLinkEnabled;
    else fields.push("autoLinkEnabled");
  }
  if (body.branding !== undefined) patch.branding = body.branding;
  if (fields.length > 0) {
    return err(422, ErrorCode.BadRequest, "invalid portal settings", {
      fields,
    });
  }

  const settings = await upsertPortalProductSettings(db, slug, patch, now);
  await audit(
    db,
    slug,
    session,
    now,
    "portal.settings.update",
    { kind: "product", id: slug },
    `Updated portal settings for ${slug}`,
  );
  return adminJson({
    ok: true,
    settings: portalProductSettingsView(settings),
  });
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
  if (req.method !== "PUT")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const body = await readBody(req);
  const value = body.value;
  if (typeof value !== "string" || value.length === 0) {
    return err(422, ErrorCode.BadRequest, "value is required", {
      fields: ["value"],
    });
  }
  const enc = await seal(env, value, {
    product: slug,
    kind: "product-secret",
    id: name,
  });
  await upsertProductSecret(db, {
    product: slug,
    name,
    enc_value_json: enc,
    created_at: now,
    modified_at: now,
  });
  await audit(
    db,
    slug,
    session,
    now,
    "secret.set",
    { kind: "secret", id: name },
    `Set secret ${name}`,
  );
  // NEVER echo the value back — only the name.
  return adminJson({ ok: true, name });
}

const TRUST_CACHE_SECONDS = 300;

/** POST /api/products/<slug>/keys/{prepare|activate|retire|revoke}. */
async function handleKeys(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  action: string | undefined,
  now: number,
): Promise<Response> {
  if (!action) return notFound();
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  if (action === "prepare" || action === "rotate") {
    const kid = `${slug}-${new Date(now * 1000).getUTCFullYear()}-${(now % 100000).toString(36)}`;
    const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
    const encPrivate = await seal(env, privatePkcs8Pem, {
      product: slug,
      kind: "signing-key",
      id: kid,
    });

    await db.batch([
      stmtInsertProductKey({
        product: slug,
        kid,
        alg: "Ed25519",
        public_b64url: publicRawB64url,
        enc_private_json: encPrivate,
        status: "staged",
        created_at: now,
        rotated_at: null,
      }),
    ]);
    await audit(
      db,
      slug,
      session,
      now,
      "key.prepare",
      { kind: "key", id: kid },
      `Prepared signing key ${kid}`,
    );
    // Respond with the new kid + PUBLIC key only — the private key never leaves the KEK store.
    return adminJson({
      ok: true,
      kid,
      publicKey: publicRawB64url,
      status: "staged",
      activateAfter: now + TRUST_CACHE_SECONDS,
    });
  }

  const body = await readBody(req);
  const kid = typeof body.kid === "string" ? body.kid : "";
  if (!kid)
    return err(422, ErrorCode.BadRequest, "kid is required", {
      fields: ["kid"],
    });
  const row = await db.first<{
    kid: string;
    status: string;
    created_at: number;
  }>(
    "SELECT kid, status, created_at FROM product_keys WHERE product = ? AND kid = ?",
    slug,
    kid,
  );
  if (!row) return notFound();

  if (action === "activate") {
    const breakGlass = body.breakGlass === true;
    if (row.status !== "staged") {
      return err(
        409,
        ErrorCode.BadRequest,
        "only staged keys can be activated",
      );
    }
    if (!breakGlass && now - row.created_at < TRUST_CACHE_SECONDS) {
      return err(
        409,
        ErrorCode.BadRequest,
        "key has not completed trust cache window",
        {
          activateAfter: row.created_at + TRUST_CACHE_SECONDS,
        },
      );
    }
    await db.batch([
      stmtRetireProductKeys(slug, now),
      stmtSetProductKeyStatus(slug, kid, "active", now),
    ]);
    await audit(
      db,
      slug,
      session,
      now,
      breakGlass ? "key.activate.break_glass" : "key.activate",
      { kind: "key", id: kid },
      `Activated signing key ${kid}`,
    );
    return adminJson({ ok: true, kid, status: "active" });
  }

  if (action === "retire" || action === "revoke") {
    // R11-07 — `idx_product_keys_one_active` enforces AT MOST one active key; nothing enforced
    // AT LEAST one. Retiring or revoking the currently active key left the product with zero,
    // so `getActiveProductKey` returned null, `loadProduct` returned null, and every signed
    // surface for that product went dark until an operator staged and activated a replacement.
    // The `activate` arm above already guards its precondition; these two did not. Rotation is
    // unaffected: `activate` retires the outgoing key and installs the new one in one batch.
    if (row.status === "active") {
      return err(
        409,
        ErrorCode.BadRequest,
        "cannot retire or revoke the active signing key; stage and activate a replacement first",
        { kid, status: row.status },
      );
    }
    const status = action === "retire" ? "retired" : "revoked";
    await db.run(
      "UPDATE product_keys SET status = ?, rotated_at = ? WHERE product = ? AND kid = ?",
      status,
      now,
      slug,
      kid,
    );
    await audit(
      db,
      slug,
      session,
      now,
      `key.${action}`,
      { kind: "key", id: kid },
      `${action === "retire" ? "Retired" : "Revoked"} signing key ${kid}`,
    );
    return adminJson({ ok: true, kid, status });
  }

  return notFound();
}

/** GET/POST /api/products/<slug>/release/* — release health + linked repo resync. */
async function handleRelease(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  action: string | undefined,
  now: number,
): Promise<Response> {
  if (action === "health") {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson({ health: await checkReleaseHealth(env, db, slug, now) });
  }
  if (action !== "resync") return notFound();
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const result = await resyncRepo(env, db, slug, now);
  if (!result.ok) {
    await upsertProductSyncState(db, {
      product: slug,
      source: "manual",
      status: "error",
      last_checked_at: now,
      last_synced_at: null,
      commit_sha: null,
      changed_paths_json: null,
      updated_json: null,
      errors_json: result.errors ? JSON.stringify(result.errors) : null,
      message: result.error,
    });
    return err(
      422,
      ErrorCode.BadRequest,
      result.error,
      result.errors ? { errors: result.errors } : undefined,
    );
  }
  await upsertProductSyncState(db, {
    product: slug,
    source: "manual",
    status: "ok",
    last_checked_at: now,
    last_synced_at: now,
    commit_sha: null,
    changed_paths_json: null,
    updated_json: JSON.stringify(result.updated),
    errors_json: null,
    message: null,
  });
  await audit(
    db,
    slug,
    session,
    now,
    "release.resync",
    { kind: "product", id: slug },
    `Resynced ${slug} from its linked repo`,
  );
  return adminJson({ ok: true, slug, updated: result.updated });
}
