/// <reference types="@cloudflare/workers-types" />

/**
 * Re-fetch a linked repo's manifest and re-apply it to an already-registered product. This is
 * the "resync" path: an operator pushes new manifest files and asks Polaris Key to pick up the
 * changes WITHOUT minting a new product or touching the signing key.
 *
 * Minimal-viable scope (diff-then-update): we re-parse the manifest and update the catalog
 * (new active schema version), the release block (channel/binary/marker/pub), and the OIDC +
 * tiers rows. The signing key, secrets, and edge-mint key material are NOT re-minted here.
 */

import { Catalog, type ConfigEntry } from "@polaris-key/catalog";
import type { Db, DbStatement, Env } from "../../core/platform.js";
import { audit, type AuditActor } from "../../core/adminApi.js";
import {
  countLicensesUsingProfile,
  countLicensesUsingTier,
  getActiveSchema,
  getProduct,
  listProfiles,
  listTiers,
  nextSchemaVersion,
  setAutoIssuePolicy,
  setFingerprintPolicy,
  setServices,
  stmtDeactivateSchemas,
  stmtInsertEdgeMint,
  stmtInsertOidcConfig,
  stmtInsertProfile,
  stmtInsertProvisioning,
  stmtInsertSchema,
  stmtInsertTier,
} from "../../core/ingest.js";
import { getReleaseConfig, setReleaseAccess } from "./config.js";
import { parseManifest } from "./manifest.js";
import {
  discoverInstallation,
  type FetchImpl,
  getInstallationToken,
} from "./githubApp.js";
import { fetchRepoFile } from "./github.js";
import { isSafeBinaryName } from "./install.js";
import { manifestIssuerRefusal } from "./linkRepo.js";
import { MANIFEST_FILES } from "./manifestFiles.js";
import {
  managedSecretKeyPredicate,
  sealedProfilePayloadJson,
} from "./manifestSecrets.js";
import { changedFields, manifestStateSnapshot } from "./resyncAudit.js";
import { releaseStoreSyncStatements } from "./sync.js";
import { serializeValidatedServices } from "../../core/services.js";

export type ResyncResult =
  | { ok: true; updated: string[] }
  | { ok: false; error: string; errors?: string[] };

/**
 * The actor an audit row from this path names.
 *
 * A resync has no session: it runs from a GitHub push webhook, or from the console's "resync"
 * button (which audits its own `release.resync` row with the operator's session on top of these).
 * Naming the ingest itself is honest — the change came from the repo, and the individual push
 * author is a value in an unauthenticated webhook body, which is exactly the kind of self-
 * attestation this file refuses to trust anywhere else.
 */
const MANIFEST_ACTOR: AuditActor = {
  sub: "system:manifest-resync",
  name: "Manifest resync",
  email: "",
};

/** True when a catalog entry is a secret the worker consumes and never signs into a document. */
function isServerOnlySecret(entry: ConfigEntry): boolean {
  return entry.kind === "secret" && entry.delivery === "serverOnly";
}

/** The active catalog as a `Catalog`, or null when there is none / it will not parse. */
function parseStoredCatalog(catalogJson: string | undefined): Catalog | null {
  if (!catalogJson) return null;
  try {
    return new Catalog(JSON.parse(catalogJson) as never);
  } catch {
    return null;
  }
}

/**
 * Refuse a catalog that drops or reclassifies an ACTIVE `delivery: "serverOnly"` secret.
 *
 * `serverOnly` means "the worker consumes this value; it is never signed into a device
 * document" — `core/payload.ts`'s prune is what makes the declaration true rather than
 * descriptive. Which means the declaration is also the ONLY thing holding the value back, and
 * it lives in a repo file: deleting one word from `.pkey/schema` (or changing `delivery` to
 * `clientScoped`) re-classifies the secret, and the very next config document hands it out
 * signed, to every device, with no admin review.
 *
 * ONE-DIRECTIONAL by design. Adding a new `serverOnly` entry, or promoting an existing key TO
 * `serverOnly`, is a tightening and stays allowed; only the loosening is gated. Returns the
 * operator-facing refusal, or null.
 */
function serverOnlyDowngradeRefusal(
  active: Catalog | null,
  next: Catalog,
): string | null {
  if (!active) return null;
  const incoming = new Map(next.entries.map((e) => [e.key, e]));
  for (const entry of active.entries) {
    if (!isServerOnlySecret(entry)) continue;
    const candidate = incoming.get(entry.key);
    if (!candidate) {
      return (
        `manifest removes the server-only secret ${JSON.stringify(entry.key)} from the catalog; ` +
        `a repo push may not withdraw the declaration that keeps a value out of signed documents`
      );
    }
    if (!isServerOnlySecret(candidate)) {
      return (
        `manifest reclassifies the server-only secret ${JSON.stringify(entry.key)} ` +
        `(kind ${JSON.stringify(candidate.kind)}, delivery ${JSON.stringify(candidate.delivery ?? "clientScoped")}); ` +
        `a repo push may not turn a server-only secret into one the platform signs into device documents`
      );
    }
  }
  return null;
}

async function readManifestFile(
  token: string,
  owner: string,
  repo: string,
  paths: string[],
  fetchImpl: FetchImpl,
): Promise<string | undefined> {
  for (const path of paths) {
    const text = await fetchRepoFile(token, owner, repo, path, fetchImpl);
    if (text !== null) return text;
  }
  return undefined;
}

/**
 * Re-apply a linked repo's `.pkey/` to an existing product. Resolves the GitHub coordinates
 * from `release_config`; if the product was never linked (no gh coordinates) it's an error.
 *
 * SECURITY (R6-05). This deliberately takes NO ref. It used to accept `payload.after` from
 * the webhook body, which made the manifest applied to production a function of a value in
 * the request body — an unreviewed branch or an old commit — structurally defeating branch
 * protection and required review on `.pkey/`. Omitting the ref makes the Contents API serve
 * the DB-configured repo's own default branch, resolved by GitHub, with nothing
 * caller-supplied in the path.
 */
export async function resyncRepo(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<ResyncResult> {
  const product = await getProduct(db, slug);
  if (!product) return { ok: false, error: "unknown product" };
  if (product.release_source !== "github")
    return { ok: false, error: "product is not linked to a repo" };

  const cfg = await getReleaseConfig(db, slug);
  if (!cfg || !cfg.gh_owner || !cfg.gh_repo)
    return { ok: false, error: "product has no linked repo coordinates" };
  const owner = cfg.gh_owner;
  const repo = cfg.gh_repo;

  let token: string;
  try {
    const installId =
      cfg.gh_installation_id ??
      (await discoverInstallation(env, owner, repo, now, fetchImpl));
    // Structured scope, not a bare repo name — the string form is the legacy path and
    // yields an installation-wide token plus a second cache entry (R5-03).
    token = await getInstallationToken(
      env,
      { owner, repo },
      installId,
      now,
      fetchImpl,
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "github access failed",
    };
  }

  const files: Record<string, string> = {};
  try {
    for (const name of ["schema", "product", "release"] as const) {
      const text = await readManifestFile(
        token,
        owner,
        repo,
        MANIFEST_FILES[name],
        fetchImpl,
      );
      if (text !== undefined) files[name] = text;
    }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "github manifest fetch failed",
    };
  }

  const result = parseManifest(files);
  if (!result.ok)
    return {
      ok: false,
      error: "manifest validation failed",
      errors: result.errors,
    };
  const manifest = result.manifest;
  if (manifest.product.slug !== slug) {
    return {
      ok: false,
      error: `manifest slug ${manifest.product.slug} does not match product ${slug}`,
    };
  }

  // R9-01, at ingest. `oidc_config` is the one manifest-owned row with no admin-ownership
  // flag: this function DELETEs and re-INSERTs it unconditionally, so a `.pkey/product` push
  // can repoint the IdP that receives this product's OIDC `client_secret`. Only a NEW or
  // CHANGED issuer is gated — an issuer already stored in D1 is re-applied untouched, because
  // flipping the security posture of a running product on the deploy that ships this code is
  // its own outage, and the attack is the *change*, not the status quo. `provider: "platform"`
  // products (e.g. `djdl`) store no issuer and never reach the gate; a push that TRIES to move
  // such a product to a custom issuer is a change from `""` and is gated like any other.
  //
  // Deliberately BEFORE the first write: everything below this point is a sequence of
  // un-batched `db.run`s, so refusing later would leave half a manifest applied.
  const nextOidc =
    manifest.oidc?.provider === "custom" ? manifest.oidc : undefined;
  if (nextOidc) {
    const stored = await db.first<{ issuer: string | null }>(
      "SELECT issuer FROM oidc_config WHERE product = ?",
      slug,
    );
    // Raw string comparison, not host comparison: any edit to the value — a new host, a new
    // path, a new port — is a change, and a change is what gets gated.
    if ((stored?.issuer ?? "") !== nextOidc.issuer) {
      const refusal = manifestIssuerRefusal(env, nextOidc.issuer);
      if (refusal) return { ok: false, error: refusal };
    }
  }

  // ── The rest of the pre-write gates ─────────────────────────────────────────
  //
  // Everything from here to `const updated` is the same shape as the issuer gate above and is
  // here for the same reason: below it the function is a sequence of un-batched `db.run`s, so a
  // refusal further down leaves half a manifest applied. A gate that has to be able to say "no"
  // to the WHOLE resync has to run before the first write.

  const nextCatalogJson = JSON.stringify(manifest.catalog);
  const activeSchema = await getActiveSchema(db, slug);
  const catalogChanged = activeSchema?.catalog_json !== nextCatalogJson;
  const activeCatalog = parseStoredCatalog(activeSchema?.catalog_json);

  // Same screening the admin API applies before writing `product_schema`. A resync is
  // triggered by a repo webhook, so without this the sync path installs catalogs the admin
  // API would refuse — and the refusal is the only thing bounding `pattern` complexity. Only
  // a CHANGED catalog is screened, so a product whose stored catalog predates the screen keeps
  // resyncing; construction is inside the try either way, so a malformed one is a 4xx and not
  // an unhandled throw out of the webhook.
  let nextCatalog: Catalog;
  try {
    nextCatalog = new Catalog(manifest.catalog as never);
    if (catalogChanged) nextCatalog.compileAll();
  } catch (e) {
    return {
      ok: false,
      error: `invalid catalog in manifest: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }
  if (catalogChanged) {
    const downgrade = serverOnlyDowngradeRefusal(activeCatalog, nextCatalog);
    if (downgrade) return { ok: false, error: downgrade };
  }

  // The Sparkle key is what proves a DMG is authentic: `services/update/appcast.ts` verifies
  // every `.sig` sidecar against it, and an item that does not verify is dropped. A push that
  // swaps the key therefore makes the attacker's own signature the one the feed accepts. Same
  // refusal shape as the issuer gate, and gated on the same thing — the CHANGE, not the status
  // quo. CLEARING it (`sparkleEd25519Pub: ""`) stays allowed: with no key configured the
  // operator-owned `requireSparkleSignature` default makes the feed fail closed, so removal
  // costs the attacker the feed rather than winning it.
  const rel = manifest.release;
  const nextSparkle = rel?.sparkleEd25519Pub || "";
  if (
    nextSparkle &&
    cfg.sparkle_ed25519_pub &&
    nextSparkle !== cfg.sparkle_ed25519_pub
  ) {
    return {
      ok: false,
      error:
        `manifest replaces the stored Sparkle public key for ${slug}; a repo push may not ` +
        `rotate the key that authenticates this product's builds — an operator must do it`,
    };
  }

  // Referential refusals, hoisted above the first write for the same reason. A tier or profile
  // a live license still points at cannot be removed, and finding that out half-way through
  // used to leave the product row and the catalog already rewritten.
  const storedProfiles = await listProfiles(db, slug);
  const nextProfileIds = new Set(manifest.profiles.map((p) => p.id));
  for (const profile of storedProfiles) {
    if (nextProfileIds.has(profile.id)) continue;
    const refs = await countLicensesUsingProfile(db, slug, profile.id);
    if (refs > 0)
      return {
        ok: false,
        error: `cannot remove profile ${profile.id}; ${refs} license(s) still reference it`,
      };
  }
  const nextTierIds = new Set(manifest.tiers.map((t) => t.id));
  for (const tier of await listTiers(db, slug)) {
    if (nextTierIds.has(tier.id)) continue;
    const refs = await countLicensesUsingTier(db, slug, tier.id);
    if (refs > 0)
      return {
        ok: false,
        error: `cannot remove tier ${tier.id}; ${refs} license(s) still reference it`,
      };
  }

  // Catalog-declared secrets carried in a profile payload: sealed before they are serialised,
  // and never allowed to replace a value an operator has already sealed. See
  // `manifestSecrets.ts` for why both halves are one gate.
  const isSecretKey = managedSecretKeyPredicate(
    activeCatalog ? [nextCatalog, activeCatalog] : [nextCatalog],
  );
  const storedPayloads = new Map(
    storedProfiles.map((p) => [p.id, p.payload_json]),
  );
  const profilePayloads = new Map<string, string>();
  for (const p of manifest.profiles) {
    const sealed = await sealedProfilePayloadJson(
      env,
      slug,
      p.id,
      p.payload,
      isSecretKey,
      storedPayloads.get(p.id) ?? null,
    );
    if (!sealed.ok) return { ok: false, error: sealed.error };
    profilePayloads.set(p.id, sealed.json);
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  // The "before" half of the audit trail (`resyncAudit.ts`). Taken after every gate and before
  // the first write, so a refused resync appends nothing at all.
  const beforeState = await manifestStateSnapshot(db, slug);

  const updated: string[] = [];

  await db.run(
    `UPDATE products SET name = ?, compat_min = ?, compat_max = ?,
       default_max_offline_days = ?, default_device_limit = ?, admin_group = ?,
       modified_at = ? WHERE slug = ?`,
    manifest.product.name,
    manifest.product.compatMin,
    manifest.product.compatMax,
    manifest.product.defaultMaxOfflineDays,
    manifest.product.defaultDeviceLimit,
    manifest.product.adminGroup,
    now,
    slug,
  );
  updated.push("product");

  // The fingerprint policy is manifest-owned only until an operator edits it live; after
  // that `setFingerprintPolicy` skips the write, so a push can't clobber their change.
  if (manifest.fingerprint) {
    await setFingerprintPolicy(
      db,
      slug,
      JSON.stringify(manifest.fingerprint),
      "manifest",
      now,
    );
    updated.push("fingerprint");
  }

  // Same ownership rule for the auto-issue policy: manifest-owned until an operator claims it.
  if (manifest.autoIssue) {
    await setAutoIssuePolicy(
      db,
      slug,
      JSON.stringify(manifest.autoIssue),
      "manifest",
      now,
    );
    updated.push("autoIssue");
  }

  // Service enablement + the device-registration policy, under the same ownership rule once
  // more. Unconditional (unlike the two above) because `services` is always present on a parsed
  // manifest — a manifest that declares no `modules:` block still means something definite,
  // namely the defaults. `registration` rides in the same value and is written only when the
  // manifest declared it, so dropping the key from `.pkey/product` returns the product to the
  // derived default rather than freezing whatever it last said. The `services_source = 'admin'`
  // guard lives inside `setServices`, so a push cannot turn a service back on after an operator
  // has turned it off live — nor re-open registration after one has closed it.
  // A4-04: through `serializeValidatedServices`, which is the coherence authority for this
  // column. This call site used to reach `serializeServices` directly, so a repo could push an
  // enablement set the console would have refused — `registration: requires-identity` with
  // Identity off being the one nothing else checks (see `core/registry.ts`).
  const serviceJson = serializeValidatedServices({
    services: manifest.services,
    ...(manifest.registration ? { registration: manifest.registration } : {}),
  });
  if (!serviceJson.ok) {
    return {
      ok: false,
      error: "`.pkey/product` declares an incoherent service set",
      errors: serviceJson.errors,
    };
  }
  await setServices(db, slug, serviceJson.json, "manifest", now);
  updated.push("services");

  // ── schema: publish a new active version only when the catalog changed ──────
  // Screened + `serverOnly`-gated above, before the first write.
  if (catalogChanged) {
    const version = await nextSchemaVersion(db, slug);
    // One transaction, for the reason spelled out at the admin publish site: between the
    // deactivate and the insert the product has NO active catalog, and the document prune
    // fails closed on that state. A webhook-driven resync is exactly the caller most likely to
    // be interrupted mid-flight, so the flip may not be two statements.
    await db.batch([
      stmtDeactivateSchemas(slug),
      stmtInsertSchema({
        product: slug,
        catalog_version: version,
        catalog_json: nextCatalogJson,
        active: 1,
        created_at: now,
      }),
    ]);
    updated.push("schema");
  }

  // ── release_config: update the GitHub-distribution block in place ───────────
  if (rel) {
    // Defence in depth for R6-01 (the repo-name fallback bypasses the manifest boundary).
    const binaryName = rel.binaryName || repo;
    if (!isSafeBinaryName(binaryName)) {
      return {
        ok: false,
        error: `unsafe binary name ${JSON.stringify(binaryName)}; set release.binaryName to match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
      };
    }
    await db.run(
      `UPDATE release_config SET channel_workflow = ?, beta_branch = ?, binary_name = ?,
         sparkle_ed25519_pub = ?, summary_marker = ?, manual_channels_json = ?,
         artifact_policy_json = ?
         WHERE product = ?`,
      rel.channelWorkflow || null,
      rel.betaBranch || "main",
      binaryName,
      rel.sparkleEd25519Pub || null,
      rel.summaryMarker || "pkey:summary",
      rel.manualChannels.length ? JSON.stringify(rel.manualChannels) : null,
      rel.artifactPolicy ? JSON.stringify(rel.artifactPolicy) : null,
      slug,
    );
    // The two access columns leave that UPDATE and go through Release's own writer, because
    // they are the only fields in the row with an OWNER (0022). Putting the ownership predicate
    // on the statement above would have made an operator-pinned access mode block the rest of
    // the release block — the binary name, the Sparkle key — from ever being resynced again.
    await setReleaseAccess(
      db,
      slug,
      { metadata: rel.access.metadata, artifacts: rel.access.artifacts },
      "manifest",
    );
    updated.push("release");
  }

  // ── manifest-owned rows: replace from the code-first source of truth ─────────
  const stmts: DbStatement[] = [];
  stmts.push({
    sql: "DELETE FROM oidc_config WHERE product = ?",
    params: [slug],
  });
  if (manifest.oidc) {
    stmts.push(
      stmtInsertOidcConfig({
        product: slug,
        provider: manifest.oidc.provider,
        issuer: manifest.oidc.issuer,
        clientId: manifest.oidc.clientId,
        clientSecretSecret: manifest.oidc.clientSecretSecret,
        redirectUris: manifest.oidc.redirectUris ?? [],
        groupRoleMap: manifest.oidc.groupRoleMap ?? {},
      }),
    );
  }
  updated.push("oidc");

  // Removal refusals and payload sealing both happened above, before the first write.
  stmts.push({ sql: "DELETE FROM profiles WHERE product = ?", params: [slug] });
  for (const p of manifest.profiles) {
    stmts.push(
      stmtInsertProfile({
        product: slug,
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        payloadJson: profilePayloads.get(p.id) ?? JSON.stringify(p.payload),
        modifiedAt: now,
      }),
    );
  }
  updated.push("profiles");

  stmts.push({ sql: "DELETE FROM tiers WHERE product = ?", params: [slug] });
  for (const t of manifest.tiers) {
    stmts.push(
      stmtInsertTier({
        product: slug,
        id: t.id,
        label: t.label,
        profileId: t.profileId ?? null,
        policyExpiryDays: t.policyExpiryDays ?? null,
        policyDeviceLimit: t.policyDeviceLimit ?? null,
        policyFingerprint: t.policyFingerprint ?? null,
        channels: t.channels,
        minVersion: t.minVersion,
        maxVersion: t.maxVersion,
        modifiedAt: now,
      }),
    );
  }
  updated.push("tiers");

  stmts.push({
    sql: "DELETE FROM provisioning_config WHERE product = ?",
    params: [slug],
  });
  for (const h of manifest.provisioning)
    stmts.push(stmtInsertProvisioning({ product: slug, ...h }));
  updated.push("provisioning");

  stmts.push({
    sql: "DELETE FROM edge_mint_config WHERE product = ?",
    params: [slug],
  });
  for (const e of manifest.edgeMint) {
    stmts.push(
      stmtInsertEdgeMint({
        product: slug,
        id: e.id,
        alg: e.alg,
        signingKeySecret: e.signingKeySecret,
        kid: e.kid,
        claimsTemplate: e.claimsTemplate ?? {},
        ttlSeconds: e.ttlSeconds,
        audience: e.audience ?? null,
        // A6-02 — carried through ingest, not dropped. The normalizer always populates
        // `requires` (`licensed` when the manifest is silent), so a recipe that omits it lands
        // fail-closed rather than inheriting whatever the column default happened to be.
        requires: e.requires,
        requiredEntitlement: e.requiredEntitlement ?? null,
      }),
    );
  }
  updated.push("edgeMint");

  // ── release truth store: the same pass, one extra GitHub read (P2.T2) ───────
  //
  // `release_metadata`/`release_artifacts`/`release_channels`/`release_health` have existed as
  // write-orphaned scaffolding since 0007. This is the writer. It rides in the SAME batch as the
  // manifest-owned rows so a resync is one transaction: a truth store that landed separately
  // could survive a failure that rolled the rest back, and the portal would then list releases
  // for a product whose tiers had not been updated.
  //
  // The row is re-read rather than reused, because the UPDATE above may just have changed the
  // access modes the store records.
  const syncedCfg = rel ? await getReleaseConfig(db, slug) : cfg;
  if (syncedCfg) {
    const storeStmts = await releaseStoreSyncStatements(
      env,
      syncedCfg,
      now,
      fetchImpl,
    );
    if (storeStmts.length > 0) {
      stmts.push(...storeStmts);
      updated.push("releases");
    }
  }

  if (stmts.length > 0) await db.batch(stmts);

  // ── The audit trail (`resyncAudit.ts`) ──────────────────────────────────────
  //
  // One row per field the resync actually MOVED. `updated` above says which sections were
  // processed, which is not the same question — the ownership guards mean an attempted write is
  // often not a change — and it is overwritten in `product_sync_state` by the next sync anyway.
  // A resync of an unchanged manifest therefore appends nothing, and a push that rewrites the
  // admin group leaves a permanent row naming the field, in the same log as every console edit.
  const afterState = await manifestStateSnapshot(db, slug);
  for (const field of changedFields(beforeState, afterState)) {
    await audit(
      db,
      slug,
      MANIFEST_ACTOR,
      now,
      "release.resync.field",
      { kind: "field", id: field },
      `Manifest resync changed ${field} for ${slug}`,
    );
  }

  return { ok: true, updated };
}
