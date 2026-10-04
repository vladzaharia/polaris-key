/**
 * The system product (F-03, plans/F-01.md §6.3): `polaris-key` (`SYSTEM_PRODUCT_SLUG`), the
 * platform's own product, which owns the platform packages (our SDKs and the CLI image) on the
 * package feeds.
 *
 * `ensureSystemProduct` is the only thing that creates its row: the platform action
 * `POST /manage/api/platform/feeds/bootstrap`, idempotent and audited. It runs the same creation
 * path as a manual create (an Ed25519 signing key generated and sealed under `PLATFORM_KEK`, the
 * empty catalog), marks the row `system = 1`, enables Release and Distribution, turns its
 * `packageFeeds` on and seeds one feed per ecosystem with the platform's namespaces (§6.7):
 * `@polaris-key` (npm), `polaris-key` (Swift scope), `im.plrs.key` (Maven), the PyPI name
 * `polaris-key` and the Godot publisher `polaris-key`; OCI repositories sit under the owner. Swift
 * releases must be signed (owner decision 2026-10-04). A second run creates nothing and leaves an
 * operator's later settings alone; it re-asserts the flags and queues a full render.
 *
 * This lives in the admin layer, beside the manual create it mirrors: it writes Core's product
 * rows and Distribution's feed rows in one batch, which Core itself may not (rule 6).
 */

import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import type { Env } from "../env.js";
import type { Db, DbStatement } from "../db/types.js";
import { generateEd25519, seal } from "../keyvault.js";
import {
  getProduct,
  stmtInsertProduct,
  stmtInsertProductKey,
  stmtInsertSchema,
} from "../repo.js";
import { parseServices, serializeServices } from "../core/services.js";
import { stmtEnqueuePackageRender, RENDER_ALL } from "../core/registryQueue.js";
import {
  stmtEnsureFeed,
  stmtSetPackageFeeds,
} from "../services/distribution/registryFeeds.js";

/** The platform feeds' namespaces and extensions (plans/F-01.md §6.7, §5.3). */
export const SYSTEM_FEEDS = [
  { ecosystem: "npm", namespace: { scope: "@polaris-key" }, ext: {} },
  { ecosystem: "pypi", namespace: { names: ["polaris-key"], prefixes: [] }, ext: { htmlFallback: true } },
  { ecosystem: "swift", namespace: { scope: "polaris-key" }, ext: { requireSigned: true } },
  { ecosystem: "maven", namespace: { groupPrefixes: ["im.plrs.key"] }, ext: {} },
  { ecosystem: "oci", namespace: {}, ext: {} },
  { ecosystem: "godot", namespace: { publisher: "polaris-key" }, ext: {} },
] as const;

export type EnsureSystemProduct =
  | { ok: true; created: boolean; slug: string }
  | { ok: false; reason: "slug_taken"; message: string };

export async function ensureSystemProduct(
  env: Env,
  db: Db,
  by: string,
  now: number,
): Promise<EnsureSystemProduct> {
  const slug = SYSTEM_PRODUCT_SLUG;
  const existing = await getProduct(db, slug);
  if (existing && existing.system !== 1)
    return {
      ok: false,
      reason: "slug_taken",
      message: `a product named ${slug} exists and is not the system product; it must be removed by hand before the bootstrap can run`,
    };
  const stmts: DbStatement[] = [];
  if (!existing) {
    const kid = `${slug}-${new Date(now * 1000).getUTCFullYear()}`;
    const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
    const encPrivate = await seal(env, privatePkcs8Pem, {
      product: slug,
      kind: "signing-key",
      id: kid,
    });
    stmts.push(
      stmtInsertProduct({
        slug,
        name: "Polaris Key",
        signing_kid: kid,
        signing_pub: publicRawB64url,
        compat_min: "0.0.0",
        compat_max: "99.0.0",
        default_max_offline_days: 30,
        default_device_limit: 5,
        admin_group: null,
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
        catalog_json: JSON.stringify({ schemaVersion: 1, entries: [] }),
        active: 1,
        created_at: now,
      }),
    );
  }
  const services = parseServices(existing?.services_json ?? null);
  services.services.release = { enabled: true };
  services.services.distribution = { enabled: true };
  stmts.push(
    {
      sql: `UPDATE products SET system = 1, services_json = ?, services_source = 'admin',
                                modified_at = ?
             WHERE slug = ?`,
      params: [serializeServices(services), now, slug],
    },
    // `packageFeeds` on: created at version 1 if absent, else switched on in place.
    stmtSetPackageFeeds(slug, true, 0, by, now),
    {
      sql: `UPDATE dist_registry_owners
               SET enabled = 1, version = version + 1, updated_at = ?, updated_by = ?
             WHERE product = ? AND enabled = 0`,
      params: [now, by, slug],
    },
    ...SYSTEM_FEEDS.map((f) =>
      stmtEnsureFeed(slug, f.ecosystem, f.namespace, f.ext, by, now),
    ),
    stmtEnqueuePackageRender(slug, RENDER_ALL, "package-feeds", now),
  );
  await db.batch(stmts);
  return { ok: true, created: !existing, slug };
}
