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
 *   - `GET|PUT|DELETE /api/products/<slug>/outlet-credentials[/<id>]` — store credentials
 *                                             (P5-01; `./outletCredentials.ts`).
 *   - `POST /api/products/<slug>/keys/rotate`    — mint a STAGED key (the active key is
 *                                             untouched until the separate `activate` action).
 *
 * Platform admin gates the registry + link-repo + manual create; product admin (or platform)
 * gates the per-product key/secret/release operations.
 */

import { Catalog } from "@polaris-key/catalog";
import { RESERVED_PRODUCT_SLUGS } from "@polaris-key/manifest";
import { parse as parseYaml } from "yaml";
import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import {
  getProduct,
  getProductSecret,
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
import { linkRepo, MAX_MANIFEST_BYTES } from "../../services/release/sync.js";
import { manifestIngestFor } from "../../core/registry.js";
import { SERVICES } from "../../mount.js";
import {
  isAutoIssueMode,
  isFingerprintMode,
  parseAutoIssue,
  parseFingerprintPolicy,
} from "../../fingerprint.js";
import { audit, platformAudit } from "../audit.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../session.js";
import {
  adminJson,
  err,
  forbidden,
  notFound,
  readBody,
} from "../lib/respond.js";
import { listProductSecretsView, productView } from "../lib/shape.js";
import {
  catalogRepresentabilityResponse,
  WriteChecks,
} from "../lib/writeChecks.js";
import { handleOutletCredentials } from "./outletCredentials.js";

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
    const result = await linkRepo(
      env,
      db,
      repoUrl,
      now,
      fetch,
      manifestIngestFor(SERVICES),
    );
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
    // plans/P3-01.md §2.2: the default offline-day count becomes `graceUntil`, so it takes the
    // bundle mint's rule, an integer from 1 to 365.
    const refused = new WriteChecks()
      .offlineDays("defaultMaxOfflineDays", body.defaultMaxOfflineDays)
      .response();
    if (refused) return refused;
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
    // A-3: a display name is required (`products.name` is NOT NULL), so a blank one is refused
    // rather than silently ignored (PRD-6). The admin group is metadata that can be cleared:
    // `null` (or a blank string) clears it, a non-string anything else is refused.
    if (typeof body.name === "string" && body.name.trim() === "") {
      return err(422, ErrorCode.BadRequest, "name must not be blank", {
        fields: ["name"],
      });
    }
    if (
      body.adminGroup !== undefined &&
      body.adminGroup !== null &&
      typeof body.adminGroup !== "string"
    ) {
      return err(
        422,
        ErrorCode.BadRequest,
        "adminGroup must be a string or null",
        { fields: ["adminGroup"] },
      );
    }
    await updateProduct(
      db,
      slug,
      {
        name: typeof body.name === "string" ? body.name.trim() : undefined,
        // `compatMin`/`compatMax` are NOT accepted here any more. The compatibility window is a
        // statement about which BUILDS this product supports, so spec §8 relocates it to
        // `PATCH …/update/settings`. Dropped rather than ignored: an endpoint that quietly
        // accepts a field it no longer owns lets a console appear to save a value that never
        // changes, which is a worse failure than a rejected request.
        default_max_offline_days:
          typeof body.defaultMaxOfflineDays === "number"
            ? body.defaultMaxOfflineDays
            : undefined,
        default_device_limit:
          typeof body.defaultDeviceLimit === "number"
            ? body.defaultDeviceLimit
            : undefined,
        admin_group:
          body.adminGroup === null
            ? null
            : typeof body.adminGroup === "string"
              ? body.adminGroup.trim() || null
              : undefined,
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
  // Same list `validateManifestDocuments` enforces (reserved_slug): these are root paths the
  // router matches before `/<product>/…`, so a product created under one would be permanently
  // shadowed — every one of its routes unreachable. The link-repo path gets this for free via
  // manifest validation; manual create must check explicitly.
  if (RESERVED_PRODUCT_SLUGS.includes(slug))
    return err(422, ErrorCode.BadRequest, "reserved slug", {
      fields: ["slug"],
    });
  if (await getProduct(db, slug))
    return err(409, ErrorCode.BadRequest, "product exists", {
      fields: ["slug"],
    });

  // plans/P3-01.md §2.2: the signing kid is the JWS header `kid` and the trust manifest's
  // `keys[].kid`, so it takes the manifest's `KID_RE`; the default offline-day count becomes
  // `graceUntil`, so it takes the bundle mint's 1–365 rule.
  const refused = new WriteChecks()
    .kid("signingKid", body.signingKid)
    .offlineDays("defaultMaxOfflineDays", body.defaultMaxOfflineDays)
    .response();
  if (refused) return refused;

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
    // A catalog default is a config value the document carries, and each key a member name in
    // it: refuse an unsignable default or key, and a key the manifest's ID_RE would refuse.
    const unrepresentable = catalogRepresentabilityResponse(catalogObj);
    if (unrepresentable) return unrepresentable;
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
      revoked_at: null,
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
  // P5-01: store credentials. The sweep re-seals the blob byte-for-byte under the same AAD and
  // never parses it; this is the one operator path outside `core/outletCredentials.ts` that
  // opens one, and it is the KEK rotation itself (`test/outletCredentialReach.test.ts`).
  {
    table: "outlet_credentials",
    idColumn: "credential_id",
    blobColumn: "enc_value_json",
    kind: "outlet-credential",
    label: "outletCredentials",
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

/** `{ keys: {k1:3,k2:12}, secrets: {k1:1}, outletCredentials: {k2:1}, managed: {k1:2} }` —
 *  sealed values per kid: whole rows for the envelope columns, individual leaves for the managed
 *  payloads. */
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

  const before = progressOf(await kekCounts(db), active, kids);
  const sweep = await resealSweep(env, db, active, limit);
  // One audit row per product actually touched. The audit table is product-scoped, so a sweep
  // that spans tenants leaves a trail in each tenant's own log, where someone looking at that
  // product will see it. A-12 adds ONE platform row per sweep on top (below): the sweep is a
  // platform action, and it also re-seals platform-managed values no product log covers.
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
  const after = progressOf(counts, active, kids);
  // Counts only, never key material: `before`/`after` are the rows not yet under `active`.
  await platformAudit(
    db,
    session,
    now,
    "kek.reseal",
    { kind: "kek", id: active },
    `Re-sealed ${sweep.resealed} value(s) under KEK ${active} (${after.remaining} remaining)`,
    {
      before,
      after: {
        ...after,
        resealed: sweep.resealed,
        skipped: sweep.skipped,
        failed: sweep.failures.length,
      },
    },
  );
  return adminJson({
    ok: true,
    active,
    kids,
    resealed: sweep.resealed,
    skipped: sweep.skipped,
    failed: sweep.failures.length,
    failures: sweep.failures,
    counts,
    ...after,
  });
}

/**
 * Product-scoped key/secret operations: PUT a write-only secret, or rotate the signing key.
 * Called from the dispatcher with the product already authz-checked (product admin OR platform).
 *
 * Three resources used to be here and are not: `release/{health,resync}` moved to the Release
 * service's own `adminHandle` in P2.T1, the customer-portal settings moved to Identity's in P3
 * (`identity/portal`), and the enrollment/fingerprint policy moved to License's in P7
 * (`license/policy`, §R1). What is left is genuinely platform-owned — a product's KEK-sealed
 * secrets and its signing keypair exist whether or not the product runs any service at all.
 */
export async function handleProductScopedResource(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  resource: string,
  // The trailing path segment: a secret NAME (secrets/<name>) or an action (keys/<rotate>,
  // keys/<rotate>). One position serves all resources that need a sub-action.
  id: string | undefined,
  now: number,
): Promise<Response> {
  if (resource === "secrets")
    return handleSecrets(req, env, db, session, slug, id, now);
  if (resource === "outlet-credentials")
    return handleOutletCredentials(req, env, db, session, slug, id, now);
  if (resource === "keys")
    return handleKeys(req, env, db, session, slug, id, now);
  return notFound();
}

/**
 * The optional `usage` on a secret PUT (P0-12). Absent ⇒ `undefined`: keep what is stored (a new
 * secret is general), so re-uploading a rotated key cannot silently change what it may sign.
 * `"general"` or `null` ⇒ general (stored NULL). `"edge-mint"` ⇒ edge-mint key material.
 * Anything else ⇒ `"invalid"`.
 */
function parseSecretUsage(
  body: Record<string, unknown>,
): "edge-mint" | null | undefined | "invalid" {
  if (!("usage" in body) || body.usage === undefined) return undefined;
  if (body.usage === null || body.usage === "general") return null;
  if (body.usage === "edge-mint") return "edge-mint";
  return "invalid";
}

/**
 * PUT /api/products/<slug>/secrets/<name> {value, usage?} — write-only: seal + store; echo NAME
 * (and the resulting usage) only.
 *
 * `usage` is the ONLY writer of `product_secrets.usage`: a `.pkey/` manifest can name a secret in
 * an edge-mint recipe but can never mark one signable (P0-12). A change of usage is audited on
 * its own (`secret.usage`) so "who made this secret mintable" is one query.
 */
async function handleSecrets(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  name: string | undefined,
  now: number,
): Promise<Response> {
  // A-5: `GET …/secrets` is the inventory — names, usage, timestamps and what requires each.
  // Never a value: the sealed column is not read.
  if (!name) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson({ secrets: await listProductSecretsView(db, slug) });
  }
  if (req.method !== "PUT")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const body = await readBody(req);
  const value = body.value;
  if (typeof value !== "string" || value.length === 0) {
    return err(422, ErrorCode.BadRequest, "value is required", {
      fields: ["value"],
    });
  }
  const usage = parseSecretUsage(body);
  if (usage === "invalid") {
    return err(
      422,
      ErrorCode.BadRequest,
      'usage must be "general" or "edge-mint"',
      { fields: ["usage"] },
    );
  }
  const before = await getProductSecret(db, slug, name);
  const previousUsage = before ? (before.usage ?? null) : null;
  const enc = await seal(env, value, {
    product: slug,
    kind: "product-secret",
    id: name,
  });
  await upsertProductSecret(db, {
    product: slug,
    name,
    enc_value_json: enc,
    ...(usage !== undefined ? { usage } : {}),
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
  const finalUsage = usage === undefined ? previousUsage : usage;
  if (finalUsage !== previousUsage) {
    await audit(
      db,
      slug,
      session,
      now,
      "secret.usage",
      { kind: "secret", id: name },
      `Secret ${name} usage: ${previousUsage ?? "general"} → ${finalUsage ?? "general"}`,
    );
  }
  // NEVER echo the value back — only the name and what it may be used for.
  return adminJson({ ok: true, name, usage: finalUsage ?? "general" });
}

const TRUST_CACHE_SECONDS = 300;

/** Lifecycle order for the key list: active first, then staged, retired, revoked. */
const KEY_STATUS_ORDER: Record<string, number> = {
  active: 0,
  staged: 1,
  retired: 2,
  revoked: 3,
};

/** One signing key as `GET …/keys` lists it (A-4). */
interface SigningKeyListing {
  kid: string;
  status: string;
  alg: string;
  publicKey: string;
  createdAt: number;
  /** Staged keys: when Activate stops needing break-glass (the trust-cache window). */
  activateAfter: number | null;
  /** Active keys: when the key became active (its creation, for a product's first key). */
  activatedAt: number | null;
  /** Retired or revoked keys: when they left service. */
  retiredAt: number | null;
  revokedAt: number | null;
}

async function listSigningKeys(
  db: Db,
  slug: string,
): Promise<SigningKeyListing[]> {
  const rows = await db.all<{
    kid: string;
    alg: string;
    public_b64url: string;
    status: string;
    created_at: number;
    rotated_at: number | null;
    revoked_at: number | null;
  }>(
    `SELECT kid, alg, public_b64url, status, created_at, rotated_at, revoked_at
       FROM product_keys WHERE product = ?`,
    slug,
  );
  return rows
    .map((r) => ({
      kid: r.kid,
      status: r.status,
      alg: r.alg,
      publicKey: r.public_b64url,
      createdAt: r.created_at,
      activateAfter:
        r.status === "staged" ? r.created_at + TRUST_CACHE_SECONDS : null,
      activatedAt:
        r.status === "active" ? (r.rotated_at ?? r.created_at) : null,
      retiredAt:
        r.status === "retired" || r.status === "revoked"
          ? (r.rotated_at ?? null)
          : null,
      revokedAt: r.status === "revoked" ? (r.revoked_at ?? null) : null,
    }))
    .sort(
      (a, b) =>
        (KEY_STATUS_ORDER[a.status] ?? 9) - (KEY_STATUS_ORDER[b.status] ?? 9) ||
        b.createdAt - a.createdAt,
    );
}

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
  // A-4: `GET …/keys` lists the product's signing keys with their lifecycle state. Public
  // material only: the sealed private key is not selected.
  if (!action) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson({ keys: await listSigningKeys(db, slug), now });
  }
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
        revoked_at: null,
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
    // `revoked_at` opens the §2.3 explicit-revocation window: the trust manifest keeps
    // listing the key with status "revoked" for 2× cacheSeconds from this moment.
    await db.run(
      "UPDATE product_keys SET status = ?, rotated_at = ?, revoked_at = ? WHERE product = ? AND kid = ?",
      status,
      now,
      status === "revoked" ? now : null,
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
