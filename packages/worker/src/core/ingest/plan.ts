/**
 * The ingest's dry-run plan (P0-26b): what applying a manifest to a product will do, read from the
 * same ownership columns the apply honours. Read-only. Moved from `services/release/linkExisting.ts`
 * (`planRepoManifest`) so link-existing, the resync dry run and the console's plan all read the
 * one function that sits beside the apply.
 */

import { parseJsonColumn } from "../../platform/json.js";
import type { Db } from "../../db/types.js";
import { claimsForApply, type ClaimKey } from "../settingsClaims.js";
import {
  countLicensesUsingTier,
  listProfiles,
  listTiers,
} from "../licensing/store.js";
import { getActiveSchema, getProduct } from "../products/store.js";
import { getManifestSnapshot } from "../manifestSnapshot.js";
import { liveRowClaimKeys } from "../rowSettings.js";
import { parseServices } from "../services.js";
import { parseStoredPresentation, serializePresentation } from "../products.js";
import { getPublisherPolicy } from "../publisher.js";
import type {
  ManifestPresentation,
  ParsedManifest,
} from "@polaris-key/manifest";
import type { ManifestPlan, PlanWarning } from "./types.js";
import type { ProductRow, ProfileRow, TierRow } from "../repo.js";
import type { ApplyClaims } from "../settingsClaims.js";
import { countLicensesListingProfile, snapshotRowIds } from "./shared.js";

/**
 * The reads `planManifest` shares with its caller (ST-17). The ingest pipeline already holds each
 * of these in its lazy memo, so the apply's plan and the dry run's cost only the reads they alone
 * need. Each defaults to the direct read, so a caller with no memo passes nothing.
 */
export interface PlanReads {
  product?: () => Promise<ProductRow | null>;
  claims?: () => Promise<ApplyClaims>;
  activeSchema?: () => Promise<{ catalog_json: string } | null>;
  previousSnapshot?: () => Promise<{ manifest_json: string } | null>;
  rowClaimKeys?: () => Promise<readonly string[]>;
  tiers?: () => Promise<TierRow[]>;
  profiles?: () => Promise<ProfileRow[]>;
}

const claimed = (source: string | null | undefined): boolean =>
  source === "admin";

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function catalogKeys(catalog: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const entries =
    catalog && typeof catalog === "object"
      ? (catalog as { entries?: unknown }).entries
      : undefined;
  if (!Array.isArray(entries)) return out;
  for (const e of entries)
    if (
      e &&
      typeof e === "object" &&
      typeof (e as { key?: unknown }).key === "string"
    )
      out.set((e as { key: string }).key, JSON.stringify(e));
  return out;
}

/**
 * What the manifest's `presentation` changes against the stored one, member by member (HA-12):
 * `icon <src>` or `no icon`, `accent #rrggbb` or `no accent`, the same for the dark accent. Both
 * sides are compared as `parseStoredPresentation` reads them, so a stored row that only differs
 * in spelling changes nothing visible and lists nothing.
 */
function presentationChanges(
  before: ManifestPresentation | null,
  after: ManifestPresentation | null,
): string[] {
  const out: string[] = [];
  if (!sameJson(before?.icon, after?.icon))
    out.push(after?.icon ? `icon ${after.icon.src}` : "no icon");
  if ((before?.accent ?? null) !== (after?.accent ?? null))
    out.push(after?.accent ? `accent ${after.accent}` : "no accent");
  if ((before?.accentDark ?? null) !== (after?.accentDark ?? null))
    out.push(
      after?.accentDark ? `dark accent ${after.accentDark}` : "no dark accent",
    );
  return out;
}

const list = (ids: readonly string[]): string =>
  ids.length <= 4
    ? ids.join(", ")
    : `${ids.slice(0, 4).join(", ")} and ${ids.length - 4} more`;

/**
 * What applying `manifest` to `slug` will do, read from the same ownership columns
 * `applyRepoManifest` honours. Read-only. A row the manifest drops that licences still use is a
 * conflict (resync refuses it), not a deletion.
 *
 * ST-01b (S-18 model C): a console claim (`product_settings`) on a product field or the catalog,
 * and a tier or profile with `source = 'console'`, are kept by the apply, so they are listed under
 * `skipClaimed`; only `manifest` rows the manifest drops are deleted (or block, when referenced).
 */
export async function planManifest(
  db: Db,
  slug: string,
  manifest: ParsedManifest,
  now: number,
  warnings: readonly PlanWarning[] = [],
  reads: PlanReads = {},
  /** `system`: the deploy hook's subset applies no tiers, profiles, sign-in or release rows. */
  scope: "full" | "system" = "full",
): Promise<ManifestPlan> {
  const plan: ManifestPlan = {
    apply: [],
    skipClaimed: [],
    delete: [],
    conflicts: [],
    // ST-17: the validator's warnings travel with the plan and never block it.
    ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
  };
  const product = await (reads.product ?? (() => getProduct(db, slug)))();
  if (!product) return plan;
  const m = manifest.product;

  // ── the product row ────────────────────────────────────────────────────────
  // ST-20: the claims the resync honours; a break-glass claim it would end is not among them, so
  // its field is planned as applied, and the ending is planned too.
  const applyClaims = await (
    reads.claims ?? (() => claimsForApply(db, slug, manifest, now))
  )();
  const claims = applyClaims.claimed;
  for (const e of applyClaims.ended)
    plan.apply.push({
      area: e.key === "config.catalog" ? "catalog" : "product",
      summary:
        e.why === "expired"
          ? `Ends the expired break-glass claim on ${e.key}`
          : `Ends the break-glass claim on ${e.key}: the manifest changed it`,
    });
  const fields: string[] = [];
  const kept: string[] = [];
  const field = (
    key: ClaimKey,
    differs: boolean,
    sets: string,
    label: string,
  ) => {
    if (!differs) return;
    if (claims.has(key)) kept.push(label);
    else fields.push(sets);
  };
  field("core.name", product.name !== m.name, `name "${m.name}"`, "name");
  field(
    "license.defaults.maxOfflineDays",
    product.default_max_offline_days !== m.defaultMaxOfflineDays,
    `offline grace ${m.defaultMaxOfflineDays} days`,
    "offline grace",
  );
  field(
    "license.defaults.deviceLimit",
    product.default_device_limit !== m.defaultDeviceLimit,
    `device limit ${m.defaultDeviceLimit}`,
    "device limit",
  );
  field(
    "core.web.origins",
    !sameJson(
      parseJsonColumn(product.web_origins_json) ?? [],
      manifest.webOrigins,
    ),
    `${manifest.webOrigins.length} web origins`,
    "web origins",
  );
  if (fields.length)
    plan.apply.push({ area: "product", summary: `Sets ${fields.join(", ")}` });
  // HA-12: `presentation` (the icon and the accents) is manifest-only, like the admin group: the
  // apply writes `presentation_json` from the manifest, clears it when the block is dropped, and
  // audits it as `core.presentation`. Discovery serves the new value within its cache window.
  const presentation = presentationChanges(
    parseStoredPresentation(product.presentation_json ?? null),
    parseStoredPresentation(serializePresentation(manifest.presentation)),
  );
  if (presentation.length)
    plan.apply.push({
      area: "presentation",
      summary: `Presentation: ${presentation.join(", ")}`,
    });
  if (kept.length)
    plan.skipClaimed.push({
      area: "product",
      summary: `${kept.join(", ")} ${kept.length === 1 ? "stays" : "stay"} as set in the console`,
    });
  // LX-06: row-backed settings claimed in the console (`licensing.*`, the sign-in tier sync).
  const rowClaims = await (
    reads.rowClaimKeys ?? (() => liveRowClaimKeys(db, slug, now))
  )();
  if (rowClaims.length)
    plan.skipClaimed.push({
      area: "settings",
      summary: `${list(rowClaims)} ${rowClaims.length === 1 ? "stays" : "stay"} as set in the console`,
    });

  const compatDiffers =
    product.compat_min !== m.compatMin || product.compat_max !== m.compatMax;
  if (compatDiffers)
    (claimed(product.compat_source) ? plan.skipClaimed : plan.apply).push({
      area: "compat",
      summary: claimed(product.compat_source)
        ? `Compatibility window stays ${product.compat_min} to ${product.compat_max} (set in the console)`
        : `Compatibility window ${m.compatMin} to ${m.compatMax}`,
    });

  // ── services ───────────────────────────────────────────────────────────────
  const current = parseServices(product.services_json).services;
  const on: string[] = [];
  const off: string[] = [];
  for (const [svc, v] of Object.entries(manifest.services)) {
    const was = current[svc as keyof typeof current]?.enabled ?? false;
    if (v.enabled && !was) on.push(svc);
    if (!v.enabled && was) off.push(svc);
  }
  if (on.length || off.length) {
    const what = [
      on.length ? `turns on ${list(on)}` : "",
      off.length ? `turns off ${list(off)}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    if (claimed(product.services_source))
      plan.skipClaimed.push({
        area: "services",
        summary: `Services stay as set in the console (the manifest ${what})`,
      });
    else plan.apply.push({ area: "services", summary: `Services: ${what}` });
  }

  // ── the two policies, declared-only ────────────────────────────────────────
  if (
    manifest.fingerprint &&
    !sameJson(
      parseJsonColumn(product.fingerprint_policy_json),
      manifest.fingerprint,
    )
  )
    (claimed(product.fingerprint_policy_source)
      ? plan.skipClaimed
      : plan.apply
    ).push({
      area: "fingerprint",
      summary: claimed(product.fingerprint_policy_source)
        ? "Device fingerprint policy stays as set in the console"
        : "Device fingerprint policy from .pkey/product",
    });
  if (
    manifest.autoIssue &&
    !sameJson(parseJsonColumn(product.auto_issue_json), manifest.autoIssue)
  )
    (claimed(product.auto_issue_source) ? plan.skipClaimed : plan.apply).push({
      area: "autoIssue",
      summary: claimed(product.auto_issue_source)
        ? "Auto-issue stays as set in the console"
        : "Auto-issue policy from .pkey/product",
    });

  // ── catalog: one unit, a new version when it changed ───────────────────────
  const active = await (
    reads.activeSchema ?? (() => getActiveSchema(db, slug))
  )();
  const before = catalogKeys(parseJsonColumn(active?.catalog_json));
  const after = catalogKeys(manifest.catalog);
  if (
    claims.has("config.catalog") &&
    (active?.catalog_json ?? null) !== JSON.stringify(manifest.catalog)
  )
    plan.skipClaimed.push({
      area: "catalog",
      summary: "The catalog stays as set in the console",
    });
  else if (
    (active?.catalog_json ?? null) !== JSON.stringify(manifest.catalog)
  ) {
    const added = [...after.keys()].filter((k) => !before.has(k));
    const changed = [...after.keys()].filter(
      (k) => before.has(k) && before.get(k) !== after.get(k),
    );
    const parts = [
      added.length ? `adds ${list(added)}` : "",
      changed.length ? `changes ${list(changed)}` : "",
    ].filter(Boolean);
    plan.apply.push({
      area: "catalog",
      summary: `Publishes a new catalog version${parts.length ? `: ${parts.join("; ")}` : ""}`,
    });
    for (const k of before.keys())
      if (!after.has(k))
        plan.delete.push({
          area: "catalog",
          id: k,
          summary: `Catalog key ${k}`,
        });
  }

  // ── tiers and profiles, per row (resync's ST-01b rules) ────────────────────
  // A `manifest` row the manifest declares is replaced; a `console` row is never touched (a
  // manifest row with its id is not applied); a dropped `manifest` row is deleted, or blocks when
  // licences (or, for a profile, a surviving tier) still use it.
  // The deploy hook's subset (scope `system`) writes none of the rows below: nothing to plan.
  if (scope === "system") return plan;
  const previousIds = snapshotRowIds(
    (await (reads.previousSnapshot ?? (() => getManifestSnapshot(db, slug)))())
      ?.manifest_json,
  );
  const tiers = await (reads.tiers ?? (() => listTiers(db, slug)))();
  const consoleTiers = new Set(
    tiers.filter((t) => t.source === "console").map((t) => t.id),
  );
  const tierIds = new Set(tiers.map((t) => t.id));
  const keptRow = (
    kind: "tier" | "profile",
    id: string,
    before: Set<string>,
  ) =>
    before.has(id)
      ? `${kind === "tier" ? "Tier" : "Profile"} ${id} stays as set in the console`
      : `${kind === "tier" ? "Tier" : "Profile"} ${id} was created in the console and stays; the manifest's ${kind} ${id} is not applied until one of them is renamed`;
  const appliedTiers = manifest.tiers.filter((t) => !consoleTiers.has(t.id));
  for (const t of manifest.tiers)
    if (consoleTiers.has(t.id))
      plan.skipClaimed.push({
        area: "tiers",
        id: t.id,
        summary: keptRow("tier", t.id, previousIds.tiers),
      });
    else
      plan.apply.push({
        area: "tiers",
        id: t.id,
        summary: tierIds.has(t.id)
          ? `Tier ${t.id} replaced from the manifest`
          : `Tier ${t.id} added`,
      });
  const nextTiers = new Set(manifest.tiers.map((t) => t.id));
  for (const t of tiers) {
    if (consoleTiers.has(t.id) || nextTiers.has(t.id)) continue;
    const refs = await countLicensesUsingTier(db, slug, t.id);
    if (refs > 0)
      plan.conflicts.push({
        area: "tiers",
        id: t.id,
        summary: `Tier ${t.id} is not in the manifest but ${refs} ${refs === 1 ? "license uses" : "licenses use"} it: add it to .pkey/product or move them first`,
      });
    else plan.delete.push({ area: "tiers", id: t.id, summary: `Tier ${t.id}` });
  }

  const profiles = await (reads.profiles ?? (() => listProfiles(db, slug)))();
  const consoleProfiles = new Set(
    profiles.filter((p) => p.source === "console").map((p) => p.id),
  );
  const profileIds = new Set(profiles.map((p) => p.id));
  for (const p of manifest.profiles)
    if (consoleProfiles.has(p.id))
      plan.skipClaimed.push({
        area: "profiles",
        id: p.id,
        summary: keptRow("profile", p.id, previousIds.profiles),
      });
    else
      plan.apply.push({
        area: "profiles",
        id: p.id,
        summary: profileIds.has(p.id)
          ? `Profile ${p.id} replaced from the manifest (secret values set in the console are kept)`
          : `Profile ${p.id} added`,
      });
  // The tiers that survive the apply: the console's, plus the manifest's applied ones.
  const survivingTierProfiles = [
    ...tiers.filter((t) => consoleTiers.has(t.id)).map((t) => t.profile_id),
    ...appliedTiers.map((t) => t.profileId ?? null),
  ];
  const nextProfiles = new Set(manifest.profiles.map((p) => p.id));
  for (const p of profiles) {
    if (consoleProfiles.has(p.id) || nextProfiles.has(p.id)) continue;
    const licences = await countLicensesListingProfile(db, slug, p.id);
    const usedByTiers = survivingTierProfiles.filter((x) => x === p.id).length;
    if (licences + usedByTiers > 0)
      plan.conflicts.push({
        area: "profiles",
        id: p.id,
        summary: `Profile ${p.id} is not in the manifest but ${
          licences
            ? `${licences} ${licences === 1 ? "license uses" : "licenses use"} it`
            : `${usedByTiers === 1 ? "a tier uses" : `${usedByTiers} tiers use`} it`
        }: add it to .pkey/schema or move them first`,
      });
    else
      plan.delete.push({
        area: "profiles",
        id: p.id,
        summary: `Profile ${p.id}`,
      });
  }

  // ── sign-in provider ───────────────────────────────────────────────────────
  const oidc = await db.first<{ provider: string; issuer: string | null }>(
    "SELECT provider, issuer FROM oidc_config WHERE product = ?",
    slug,
  );
  if (manifest.oidc)
    plan.apply.push({
      area: "oidc",
      summary:
        manifest.oidc.provider === "custom"
          ? `Sign-in provider ${manifest.oidc.issuer}`
          : "Sign-in through the platform provider",
    });
  else if (oidc)
    plan.delete.push({
      area: "oidc",
      summary: "Sign-in provider settings (the manifest declares none)",
    });

  // ── release, access, trusted publisher ─────────────────────────────────────
  const cfg = await db.first<{ access_source: string | null }>(
    "SELECT access_source FROM release_config WHERE product = ?",
    slug,
  );
  if (manifest.release) {
    plan.apply.push({
      area: "release",
      summary: "Release settings from .pkey/release",
    });
    if (claimed(cfg?.access_source))
      plan.skipClaimed.push({
        area: "access",
        summary: "Release access modes stay as set in the console",
      });
  }
  const publisher = await getPublisherPolicy(db, slug);
  const declared = manifest.release?.trustedPublisher ?? null;
  if (publisher?.source === "admin") {
    if (declared)
      plan.skipClaimed.push({
        area: "publisher",
        summary: `Trusted publisher stays ${publisher.workflow} in ${publisher.repository} (set in the console)`,
      });
  } else if (declared)
    plan.apply.push({
      area: "publisher",
      summary: `Trusted publisher ${declared.workflow}`,
    });
  else if (publisher)
    plan.delete.push({
      area: "publisher",
      summary: "Trusted publisher (the manifest declares none)",
    });

  // ── edge-mint recipes and provisioning hooks: replaced whole ───────────────
  const recipes = await db.all<{ id: string }>(
    "SELECT id FROM edge_mint_config WHERE product = ?",
    slug,
  );
  const nextRecipes = new Set(manifest.edgeMint.map((e) => e.id));
  if (manifest.edgeMint.length)
    plan.apply.push({
      area: "edgeMint",
      summary: `Token recipes ${list([...nextRecipes])} (each waits for approval)`,
    });
  for (const r of recipes)
    if (!nextRecipes.has(r.id))
      plan.delete.push({
        area: "edgeMint",
        id: r.id,
        summary: `Token recipe ${r.id}`,
      });
  const hooks = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM provisioning_config WHERE product = ?",
    slug,
  );
  if (manifest.provisioning.length)
    plan.apply.push({
      area: "provisioning",
      summary: `${manifest.provisioning.length} provisioning ${manifest.provisioning.length === 1 ? "hook" : "hooks"}`,
    });
  else if ((hooks?.n ?? 0) > 0)
    plan.delete.push({
      area: "provisioning",
      summary: "Provisioning hooks (the manifest declares none)",
    });

  return plan;
}
