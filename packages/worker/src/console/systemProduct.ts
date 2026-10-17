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
 * `polaris-key` and the Godot publisher `polaris-key`; OCI repositories and Cargo crates sit under
 * the owner. Swift releases must be signed (owner decision 2026-10-04). A second run creates
 * nothing and leaves an
 * operator's later settings alone (a service or `packageFeeds` switched off stays off); it
 * fills in any missing feed row and queues a full render.
 *
 * `linkSystemProduct` is the other half (F-10 automation, owner decision 2026-10-04): it links the
 * system product to the monorepo that ships the platform's SDKs and applies that repository's
 * root `.pkey/` (its package deliverables and its trusted publisher), which `linkRepo` refuses
 * for the reserved slug and `resyncRepo` cannot reach (it needs `release_source = 'github'`, which
 * the bootstrap never set). Without it every package publish is refused as `invalid_descriptor`.
 * The deploy hook (`src/platformDeploy.ts`, `POST /webhooks/deploy`) runs both on every production
 * deploy; both are idempotent.
 *
 * This lives in the admin layer, beside the manual create it mirrors: it writes Core's product
 * rows and Distribution's feed rows in one batch, which Core itself may not (rule 6).
 */

import {
  SYSTEM_PRODUCT_SLUG,
  type ParsedManifest,
} from "@polaris-key/manifest";
import type { Ingest } from "../core/ingest/types.js";
import { stmtInsertSchema } from "../services/config/public.js";
import type { Env } from "../platform/env.js";
import type { Db, DbStatement } from "../db/types.js";
import { generateEd25519, seal } from "../platform/keyvault.js";
import {
  getProduct,
  stmtInsertProduct,
  stmtInsertProductKey,
} from "../core/products/store.js";
import { parseServices, serializeServices } from "../core/services.js";
import { type BreakGlassClaim, type ClaimKey } from "../core/settingsClaims.js";
import { isSafeBinaryName } from "../services/release/public.js";
import {
  stmtEnqueuePackageRender,
  RENDER_ALL,
} from "../core/registry/registryQueue.js";
import {
  stmtEnsureFeed,
  stmtSetPackageFeeds,
} from "../services/distribution/public.js";

/** The platform feeds' namespaces and extensions (plans/F-01.md §6.7, §5.3). */
export const SYSTEM_FEEDS = [
  { ecosystem: "npm", namespace: { scope: "@polaris-key" }, ext: {} },
  {
    ecosystem: "pypi",
    namespace: { names: ["polaris-key"], prefixes: [] },
    ext: { htmlFallback: true },
  },
  {
    ecosystem: "swift",
    namespace: { scope: "polaris-key" },
    ext: { requireSigned: true },
  },
  {
    ecosystem: "maven",
    namespace: { groupPrefixes: ["im.plrs.key"] },
    ext: {},
  },
  { ecosystem: "oci", namespace: {}, ext: {} },
  // The Asset Library listing's license and compatibility floor (sdks/godot/README.md: 4.4 or later).
  {
    ecosystem: "godot",
    namespace: { publisher: "polaris-key" },
    ext: { license: "MIT", minGodotVersion: "4.4" },
  },
  // F-30: crates sit in the owner's own index (no namespace); empty until a Rust SDK ships.
  { ecosystem: "cargo", namespace: {}, ext: {} },
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
  if (!existing) {
    // First run only: the services start on. A later run never turns back on what an operator
    // switched off.
    const services = parseServices(null);
    services.services.release = { enabled: true };
    services.services.distribution = { enabled: true };
    stmts.push({
      sql: `UPDATE products SET system = 1, services_json = ?, services_source = 'admin',
                                modified_at = ?
             WHERE slug = ?`,
      params: [serializeServices(services), now, slug],
    });
  }
  stmts.push(
    // `packageFeeds`: created ON if there is no row; an existing row (an operator's off) stays.
    stmtSetPackageFeeds(slug, true, 0, by, now),
    ...SYSTEM_FEEDS.map((f) =>
      stmtEnsureFeed(slug, f.ecosystem, f.namespace, f.ext, by, now),
    ),
    stmtEnqueuePackageRender(slug, RENDER_ALL, "package-feeds", now),
  );
  await db.batch(stmts);
  return { ok: true, created: !existing, slug };
}

/** The repository the system product is linked to: the platform's own monorepo. */
export interface SystemRepository {
  /** `owner/repo` as GitHub spells it. */
  repository: string;
  /** GitHub's NUMERIC ids, pinned against name recycling (as `ci_publishers` pins them). */
  repositoryId: number;
  repositoryOwnerId: number;
}

export type LinkSystemProduct =
  | {
      ok: true;
      slug: string;
      /** The package deliverable ids the manifest declares, now in `release_deliverables`. */
      packages: string[];
      /** What the manifest-owned trusted publisher now is (`null`: none declared). */
      publisher: { workflow: string; environment: string } | null;
      /** A claim (`source = 'admin'`) was found and replaced by the manifest's policy. */
      publisherClaimed: boolean;
      /** Live static CI tokens this run revoked (none can be issued any more). */
      staticTokensRevoked: number;
      /** Forensics: the claimed policy this run replaced (`null`: none was claimed). */
      replacedClaim: {
        source: string;
        repository: string;
        workflow: string;
        environment: string;
        scopes: string[];
        modifiedBy: string | null;
      } | null;
      /** Whether this run changed the publisher (a replaced claim counts). */
      publisherChanged: boolean;
      /**
       * ST-20 (S-18 §4.5 item 7): the live break-glass claims after this apply. The deploy
       * summary lists them.
       */
      breakGlass: BreakGlassClaim[];
      /** ST-20: the break-glass claims this apply ended (expired, or the manifest changed them). */
      breakGlassEnded: { key: ClaimKey; why: "expired" | "changed" }[];
    }
  | {
      ok: false;
      reason: "not_bootstrapped" | "wrong_manifest";
      message: string;
    };

/**
 * Why `manifest` is not the system product's root `.pkey/` for `repo`, or `null` when it is: the
 * slug must be the system product's, and `.pkey/release` must exist and name `repo` as its GitHub
 * provider. Checked by the deploy hook before anything is written, and again by the link.
 */
/**
 * The system product's trusted publisher is fixed in the Worker, never taken from the
 * deploy hook's body: the one reusable workflow every platform publish runs through, in its
 * environment. A body naming anything else is refused, so code in the deploy job cannot repoint
 * the identity that is later handed `release:publish` tokens.
 */
export const SYSTEM_TRUSTED_PUBLISHER = {
  workflow: ".github/workflows/publish-package.yml",
  environment: "package-registry",
} as const;

export function systemManifestProblem(
  manifest: ParsedManifest,
  repo: Pick<SystemRepository, "repository">,
): string | null {
  const slug = SYSTEM_PRODUCT_SLUG;
  if (manifest.product.slug !== slug)
    return `the manifest is ${manifest.product.slug}'s, not the system product's (${slug})`;
  const rel = manifest.release;
  if (!rel) return "the manifest has no .pkey/release";
  const [owner, name] = repo.repository.split("/");
  if (
    !owner ||
    !name ||
    rel.ghOwner.toLowerCase() !== owner.toLowerCase() ||
    rel.ghRepo.toLowerCase() !== name.toLowerCase()
  )
    return `.pkey/release names ${rel.ghOwner}/${rel.ghRepo}, not the platform repository ${repo.repository}`;
  const tp = rel.trustedPublisher;
  if (
    !tp ||
    tp.workflow !== SYSTEM_TRUSTED_PUBLISHER.workflow ||
    tp.environment !== SYSTEM_TRUSTED_PUBLISHER.environment
  )
    return `.pkey/release must declare the trusted publisher ${SYSTEM_TRUSTED_PUBLISHER.workflow} in ${SYSTEM_TRUSTED_PUBLISHER.environment}`;
  if (!isSafeBinaryName(rel.binaryName || name))
    return `unsafe binary name ${JSON.stringify(rel.binaryName || name)}`;
  return null;
}

/**
 * Link the system product to `repo` and apply its root `.pkey/` (already parsed and validated by
 * the caller). Idempotent, one batch:
 *
 *   - `release_source = 'github'` and `release_config`: the GitHub coordinates and the
 *     manifest-owned columns, the manual channels among them (an existing row keeps its
 *     installation id, the operator-only policy, the release keys and claimed access modes);
 *   - the declared deliverables (`manifestDeliverableStatements`, the same rows link and resync
 *     write; a package with releases is never dropped);
 *   - the manifest-owned trusted publisher, with the repository's numeric ids from `repo` (never
 *     from the manifest), and never over an operator's claim;
 *   - every ENABLED service's own manifest rows (`ingest`), by the product's STORED enablement, so
 *     a service an operator switched off is not rewritten;
 *   - the manifest snapshot (ST-01a, `product_manifest_snapshot`, origin `deploy-hook`): the raw
 *     documents the hook body carried and the deploy's commit (`PKEY_GIT_SHA`) as `applied_sha`.
 *
 *   - ST-20: the system product's break-glass claims (it is manifest-authoritative, locked; S-18
 *     §4.5 items 7–8). One whose 7 days ran out, or whose field this manifest changes from the
 *     last applied one, ends here and the manifest's value is written (`endBreakGlassStatements`);
 *     the rest stay, and the answer lists them for the deploy summary.
 *
 * Apart from ended break-glass claims it never touches the services, `packageFeeds`, the feeds,
 * the signing key or the catalog: those are the bootstrap's (and then the operator's). Applying
 * every claimable product field here is ST-17's shared plan function.
 */
export async function linkSystemProduct(
  env: Env,
  db: Db,
  manifest: ParsedManifest,
  repo: SystemRepository,
  applied: {
    /** The raw `.pkey/` documents `manifest` was parsed from, keyed by document name. */
    files: Readonly<Record<string, string>>;
    /** The deploy's commit (`PKEY_GIT_SHA`); `null` (or malformed) is stored as NULL. */
    sha: string | null;
  },
  now: number,
  ingest: Ingest,
): Promise<LinkSystemProduct> {
  const slug = SYSTEM_PRODUCT_SLUG;
  const product = await getProduct(db, slug);
  if (!product || product.system !== 1)
    return {
      ok: false,
      reason: "not_bootstrapped",
      message: `${slug} is not the system product yet; run the package-feeds bootstrap first`,
    };
  const problem = systemManifestProblem(manifest, repo);
  if (problem) return { ok: false, reason: "wrong_manifest", message: problem };
  const [owner, name] = repo.repository.split("/") as [string, string];

  // The deploy hook is the pipeline's `system` scope (plans/P0-26.md D3): today's subset, in one
  // batch, with the manifest snapshot (origin `deploy-hook`, `applied_sha` = the deploy's commit).
  const result = await ingest.run(env, db, {
    mode: "apply",
    scope: "system",
    product: slug,
    manifest,
    now,
    source: {
      origin: "deploy-hook",
      sha: applied.sha,
      files: applied.files as Record<string, string>,
      fetchImpl: fetch,
      repo: {
        owner,
        name,
        installId: null,
        // GitHub's numeric ids come from the hook's verified policy, never from the manifest.
        identity: async () => ({
          id: repo.repositoryId,
          ownerId: repo.repositoryOwnerId,
          fullName: repo.repository,
        }),
        hasFile: async () => false,
        blob: async () => "error",
      },
    },
    seed: { product },
  });
  if (!result.ok)
    return { ok: false, reason: "wrong_manifest", message: result.error };
  const facts = result.facts.system as Omit<
    Extract<LinkSystemProduct, { ok: true }>,
    "ok" | "slug" | "breakGlass" | "breakGlassEnded"
  >;
  return {
    ok: true,
    slug,
    ...facts,
    breakGlass: result.breakGlass ?? [],
    breakGlassEnded: result.breakGlassEnded ?? [],
  };
}
