/// <reference types="@cloudflare/workers-types" />

import type { ManagedPayload } from "./payload.js";
import { randomId } from "../../platform/crypto.js";
import { type Env } from "../../platform/env.js";
import { tryParseJson } from "../../platform/json.js";
import type { Db } from "../../db/types.js";
import { type Product, type ProductPublic } from "../products.js";
import { type LicenseRow, type ProductRow, type TierRow } from "../repo.js";
import { appendAudit, auditStatement } from "../audit.js";
import {
  claimEnrolledLicense,
  getLicense,
  getLicenseBySub,
  getTier,
  stmtInsertLicense,
} from "./store.js";
import { getProduct } from "../products/store.js";
import { isImplicitTier, issueTierFor } from "./implicitTier.js";
import { guardedInsert, guardedWrite, oidcGrantStatements } from "./grants.js";
import { licenseTransitionStatement } from "./lifecycleWrites.js";
import { mergeLicenseInto, type LicenseMerge } from "./licenseMerge.js";
import { allowsOidcDefault } from "../fingerprint.js";
import { licenseDeviceLimit, tierExpiresAt } from "./authz.js";
import { licenseUsable } from "../devices.js";
import { applyProvisionedAccountSecrets } from "../accounts/accountOverrides.js";
import {
  applyProvisioning,
  mergeProvisionedOverrides,
  provisionedColumn,
  provisionedSecretTarget,
  signInProvisioning,
  type ProvisionedSecretTarget,
} from "./provisioning.js";

export interface OidcConfigRow {
  product: string;
  provider: string | null;
  issuer: string | null;
  client_id: string | null;
  client_secret_secret: string | null;
  redirect_uris_json: string | null;
  group_role_map_json: string | null;
}

export interface OidcIdentity {
  sub: string;
  email?: string;
  name?: string;
  groups: string[];
  claims: Record<string, unknown>;
}

// ── helpers ──────────────────────────────────────────────────────────────────
export async function getOidcConfig(
  db: Db,
  product: string,
): Promise<OidcConfigRow | null> {
  return db.first<OidcConfigRow>(
    "SELECT * FROM oidc_config WHERE product = ?",
    product,
  );
}

/** Why the auto-issue policy entitles an identity: a group in the product's `groupRoleMap` (the
 *  first mapped group the identity holds, preferring one that names a tier), or the product's
 *  `oidcDefault` auto-issue rule. Discover shows it as the offer's reason (PX-W10, G24). */
export type AutoIssueGrantVia =
  | { kind: "group"; group: string }
  | { kind: "default" };

/** What the auto-issue policy grants an identity: the tier, its expiry, and why. */
export interface AutoIssueGrant {
  tierId: string | null;
  expiresAt: number | null;
  via: AutoIssueGrantVia;
}

/** The tier an identity is entitled to under the product's group map, or its `oidcDefault`
 *  policy: `{ tierId, expiresAt, via }`, or `{ error: "not-entitled" }`. Read-only. This is THE
 *  auto-issue policy function: sign-in mints with it (`activateFromIdentity`) and Discover lists
 *  with it (`previewIdentityIssue`), so the two cannot disagree about who gets what. */
export async function identityTier(
  db: Db,
  product: Pick<ProductPublic, "slug" | "autoIssue">,
  identity: Pick<OidcIdentity, "groups">,
  now: number,
  oidc?: OidcConfigRow | null,
): Promise<AutoIssueGrant | { error: string }> {
  const config =
    oidc === undefined ? await getOidcConfig(db, product.slug) : oidc;
  // A malformed map grants nothing (fail closed) instead of throwing out of sign-in (R8-06).
  const map =
    (tryParseJson(config?.group_role_map_json) as
      | Record<string, { role: string; tier?: string }>
      | undefined) ?? {};

  let entitledBy: string | null = null;
  const tiered: { group: string; tier: string }[] = [];
  for (const g of identity.groups) {
    // Own keys only: a group named like an Object member (`constructor`, `__proto__`) is not mapped.
    const m = Object.prototype.hasOwnProperty.call(map, g) ? map[g] : undefined;
    if (m) {
      if (entitledBy === null) entitledBy = g;
      if (m.tier) tiered.push({ group: g, tier: m.tier });
    }
  }
  // LX-08 (S-19 §7.5): the HIGHEST-RANK mapped tier wins, not the first. A tie keeps the first in
  // the identity's group order, which is the whole answer while every tier has rank 0 (the
  // default), so nothing changes until an operator ranks the tiers.
  const best = await highestRankTier(db, product.slug, tiered);
  const tierGroup: string | null = best?.group ?? null;
  let tierId: string | null = best?.tier ?? null;
  let via: AutoIssueGrantVia;
  if (entitledBy !== null) {
    via = { kind: "group", group: tierGroup ?? entitledBy };
  } else {
    // No mapped group. If the product opts into an OIDC default tier, any authenticated user
    // lands on the free tier instead of a hard 403; with the policy unset this is byte-for-byte
    // the previous behaviour.
    if (allowsOidcDefault(product.autoIssue) && product.autoIssue.tierId) {
      tierId = product.autoIssue.tierId;
      via = { kind: "default" };
    } else {
      return { error: "not-entitled" };
    }
  }

  let expiresAt: number | null = null;
  if (tierId) {
    expiresAt = tierExpiresAt(await getTier(db, product.slug, tierId), now);
  }
  return { tierId, expiresAt, via };
}

/** The rank of each of a product's tiers (`tiers.rank`, LX-08; 0 by default). */
export async function tierRanks(
  db: Db,
  product: string,
): Promise<Map<string, number>> {
  const rows = await db.all<{ id: string; rank: number }>(
    "SELECT id, rank FROM tiers WHERE product = ?",
    product,
  );
  return new Map(rows.map((r) => [r.id, r.rank]));
}

/** The candidate with the highest-rank tier, the first one on a tie (an unknown tier ranks 0).
 *  Reads the ranks only when there is a choice to make. */
export async function highestRankTier<T extends { tier: string }>(
  db: Db,
  product: string,
  candidates: readonly T[],
): Promise<T | null> {
  if (candidates.length === 0) return null;
  if (new Set(candidates.map((c) => c.tier)).size === 1) return candidates[0]!;
  const ranks = await tierRanks(db, product);
  let best = candidates[0]!;
  for (const c of candidates.slice(1))
    if ((ranks.get(c.tier) ?? 0) > (ranks.get(best.tier) ?? 0)) best = c;
  return best;
}

/** Would `activateFromIdentity` refuse this identity? The same two refusals, read-only: no
 *  entitlement, or an existing licence that is not usable. The device-code callback answers the
 *  browser with this, because it defers the activation itself to `/device/poll` (P1-07). */
export async function identityRefusal(
  db: Db,
  product: Product,
  identity: OidcIdentity,
  now: number,
): Promise<string | null> {
  const tier = await identityTier(db, product, identity, now);
  if ("error" in tier) return tier.error;
  const existing = await getLicenseBySub(db, product.slug, identity.sub);
  if (existing && !licenseUsable(existing, now)) return "license-unusable";
  return null;
}

/** The licence overrides `activateFromIdentity` writes for `identity`: its provisioning hooks
 *  applied to an empty payload. Read-only. */
export async function provisionedOverrides(
  db: Db,
  product: Pick<ProductPublic, "slug">,
  identity: OidcIdentity,
  now: number,
): Promise<ManagedPayload> {
  const overrides: ManagedPayload = {
    config: {},
    secrets: {},
    entitlements: {},
  };
  await applyProvisioning(db, product.slug, identity, overrides, now);
  return overrides;
}

/** The device limit `row` will carry once `activateFromIdentity` has activated `identity` onto
 *  it, so the limit the row holds NOW is not mistaken for the one it will have after the attach.
 *  Read-only: the P1-07 attach measures its seat bound with this (R1-07). Both arms rewrite the
 *  row's `overrides_json` only at the provisioning's declared keys (`mergeProvisionedOverrides`),
 *  so an operator `deviceLimit` override survives and counts:
 *  - `claim` (`claimEnrolledLicense`): the anonymous row is rewritten onto the identity's mapped
 *    tier and its expiry (an enroll tier is replaced).
 *  - `signin` (an existing licence of the identity, the migrate destination): since LX-02 the
 *    update keeps the row's own `tier_id` and `expires_at`, so the limit is the stored tier plus
 *    the merged overrides. */
export async function postActivationDeviceLimit(
  db: Db,
  product: Product,
  identity: OidcIdentity,
  row: LicenseRow,
  arm:
    | {
        kind: "claim";
        tier: { tierId: string | null; expiresAt: number | null };
      }
    | { kind: "signin" },
  now: number,
): Promise<number> {
  const { provisioned, declared } = await signInProvisioning(
    db,
    product,
    identity,
    now,
  );
  // The hypothetical column carries the provisioned keys themselves (LX-08 writes them to the
  // `oidc` grant instead, with the same values): the stored grant is not read on top.
  return licenseDeviceLimit(
    db,
    product,
    {
      ...row,
      ...(arm.kind === "claim"
        ? { tier_id: arm.tier.tierId, expires_at: arm.tier.expiresAt }
        : {}),
      overrides_json: mergeProvisionedOverrides(
        row.overrides_json,
        provisioned,
        declared,
      ),
    },
    now,
    { withoutOidcGrant: true },
  );
}

/**
 * The first-load auto-issue, DRY RUN (PX-W10, docs/design/PORTAL.md G24): what
 * `activateFromIdentity` would mint for `identity` on this product, computed by the same two
 * read-only steps it starts with (the policy, `identityTier`, and the provisioning hooks,
 * `provisionedOverrides`) and writing nothing. `{ error: "not-entitled" }` when the policy grants
 * nothing; `existing` is the licence the identity already holds here, which the caller treats as
 * "already held" rather than as an offer.
 */
export async function previewIdentityIssue(
  db: Db,
  product: ProductPublic,
  identity: OidcIdentity,
  now: number,
  /**
   * PS-06: `existing: false` skips the licence lookup by subject (`existing` reads `null`). The
   * console's persona preview runs the policy for a SYNTHETIC identity, whose subject must never
   * be looked up among real licences (notes/S-21 owner decision 11).
   */
  opts: { existing?: boolean } = {},
): Promise<
  | (AutoIssueGrant & {
      overrides: ManagedPayload;
      existing: LicenseRow | null;
    })
  | { error: string }
> {
  const grant = await identityTier(db, product, identity, now);
  if ("error" in grant) return grant;
  return {
    ...grant,
    overrides: await provisionedOverrides(db, product, identity, now),
    existing:
      opts.existing === false
        ? null
        : await getLicenseBySub(db, product.slug, identity.sub),
  };
}

/** One group of the product's `groupRoleMap`, as the console lists it (PS-06). */
export interface IdentityPolicyGroup {
  group: string;
  /** The tier a member's licence is minted on, or `null` when the mapping names none. */
  tier: string | null;
}

/**
 * PS-06 (notes/S-21 §6.6): the identity policy `identityTier` runs, as the operator configured it
 * and with no identity in hand: every mapped group (in the map's order) and the `oidcDefault`
 * tier, `null` when the product does not auto-issue to every signed-in person. The console's
 * "Ways to add", "Who can see this?" and readiness read it. A malformed map reads as no groups,
 * exactly as `identityTier` grants nothing from it.
 */
export async function identityIssuePolicy(
  db: Db,
  product: Pick<ProductPublic, "slug" | "autoIssue">,
): Promise<{ groups: IdentityPolicyGroup[]; defaultTier: string | null }> {
  const oidc = await getOidcConfig(db, product.slug);
  const map =
    (tryParseJson(oidc?.group_role_map_json) as
      | Record<string, { role: string; tier?: string }>
      | undefined) ?? {};
  const groups: IdentityPolicyGroup[] = [];
  if (map && typeof map === "object" && !Array.isArray(map))
    for (const [group, m] of Object.entries(map))
      if (m && typeof m === "object")
        groups.push({
          group,
          tier: typeof m.tier === "string" && m.tier !== "" ? m.tier : null,
        });
  const defaultTier =
    allowsOidcDefault(product.autoIssue) && product.autoIssue.tierId
      ? product.autoIssue.tierId
      : null;
  return { groups, defaultTier };
}

/** Reads the product's `identity.oidc.syncTierOnSignIn` setting. The setting belongs to the
 *  Identity service, which core may not import, so the caller hands the reader in (`via`). */
export type SyncTierReader = (db: Db, product: ProductRow) => Promise<string>;

/** Max compare-and-set rounds `updateLicenseOnSignIn` makes before giving up. */
export const SIGNIN_UPDATE_ATTEMPTS = 3;

/**
 * `identity.oidc.syncTierOnSignIn: upgradeOnly` (LX-08, S-19 §7.5): the tier a sign-in moves an
 * existing licence to, or null to leave it. Only to a STRICTLY higher-rank tier than the one the
 * licence is on; a licence on no tier, or on a tier that no longer exists, is left alone (an
 * operator chose that). `expires_at` never moves (LX-02). With the setting `off` (the default)
 * nothing is read beyond the comparison.
 */
export async function upgradedTier(
  db: Db,
  product: Pick<ProductPublic, "slug">,
  existing: LicenseRow,
  identityTierId: string | null | undefined,
  readSyncTier: SyncTierReader | undefined,
): Promise<TierRow | null> {
  if (!identityTierId || !existing.tier_id) return null;
  if (identityTierId === existing.tier_id) return null;
  const productRow = await getProduct(db, product.slug);
  if (!productRow) return null;
  if (!readSyncTier || (await readSyncTier(db, productRow)) !== "upgradeOnly")
    return null;
  const [current, next] = await Promise.all([
    getTier(db, product.slug, existing.tier_id),
    getTier(db, product.slug, identityTierId),
  ]);
  if (!current || !next) return null;
  // LX-33.2: the implicit Default tier is no tier: a licence on it is left alone, as a tierless one.
  if (isImplicitTier(current)) return null;
  return (next.rank ?? 0) > (current.rank ?? 0) ? next : null;
}

/**
 * The sign-in write on an identity's EXISTING licence (LX-02, S-19 §4.3 G7, §7.5 Phase A,
 * decision 12): `name`, `email` and `groups_json` follow the provider; `expires_at` is NOT touched
 * (a time-limited tier used to renew on every sign-in: endless trials), and neither is `tier_id`,
 * except that the opt-in `syncTierOnSignIn: upgradeOnly` moves it to a higher-rank tier (LX-08,
 * {@link upgradedTier}). `overrides_json` is rewritten only at the provisioning's declared keys
 * (`mergeProvisionedOverrides`), so operator overrides survive and a declared key whose claim
 * disappeared is removed.
 *
 * `email_issuer_class` is rewritten with `email`, not merely on insert: the address on this row
 * is whatever the LATEST sign-in asserted, so the class that vouches for it moves with it.
 *
 * LX-08 (S-19 §7.14 step 4): the provisioned ENTITLEMENT keys are the licence's `oidc` grant,
 * re-evaluated here on every sign-in (a declared key whose claim disappeared leaves the grant),
 * and the declared keys leave the column, so this sign-in also moves its own licence. The grant
 * statements are guarded by the same compare-and-set as the column, in one batch.
 *
 * The merge reads the column and writes it back, so the write is a compare-and-set on the value
 * it merged from: an operator edit that lands in between makes it re-read and merge again
 * instead of being overwritten.
 */
export async function updateLicenseOnSignIn(
  db: Db,
  product: Pick<ProductPublic, "slug">,
  identity: OidcIdentity,
  existing: LicenseRow,
  now: number,
  /** The issuer class that produced `identity.email` on this sign-in. */
  emailIssuerClass: string,
  env?: Env,
  /** The tier the identity's group map (or `oidcDefault`) resolves to, for `syncTierOnSignIn`. */
  identityTierId?: string | null,
  readSyncTier?: SyncTierReader,
): Promise<void> {
  const signIn = await signInProvisioning(db, product, identity, now);
  const declared = signIn.declared;
  // U-27.2 (L-U1): provisioned SECRETS target the licence owner's account overrides when the
  // licence has an owner and this identity is linked to it (its declared secret keys are then
  // removed from the column, so nothing stale lingers there); every other licence keeps them in
  // the column.
  const target = await provisionedSecretTarget(
    db,
    existing.account_id,
    identity.sub,
  );
  const column = await provisionedColumn(
    env,
    db,
    product.slug,
    signIn.provisioned,
    target,
  );
  if (target === "account" && existing.account_id)
    await applyProvisionedAccountSecrets(
      env,
      db,
      product.slug,
      existing.account_id,
      signIn.provisioned.secrets,
      declared.secrets,
      now,
      identity.sub,
    );
  const tier = await upgradedTier(
    db,
    product,
    existing,
    identityTierId,
    readSyncTier,
  );
  let current = existing.overrides_json;
  for (let attempt = 0; attempt < SIGNIN_UPDATE_ATTEMPTS; attempt++) {
    const merged = mergeProvisionedOverrides(current, column, declared);
    const guard = {
      product: product.slug,
      licenseId: existing.id,
      overridesJson: current,
    };
    const applied = await guardedWrite(
      db,
      [
        ...oidcGrantStatements({
          product: product.slug,
          licenseId: existing.id,
          entries: signIn.provisioned.entitlements,
          declared: declared.entitlements,
          now,
          writer: "oidc",
          guard,
        }),
        // The tier move's audit row rides the same guarded batch: no row without the move.
        ...(tier
          ? [
              guardedInsert(
                auditStatement({
                  product: product.slug,
                  id: randomId("aud"),
                  at: now,
                  actor_sub: identity.sub,
                  actor_name: identity.name ?? null,
                  actor_email: identity.email ?? null,
                  action: "license.tier.change",
                  target_kind: "license",
                  target_id: existing.id,
                  parent_id: null,
                  summary: `Moved from tier ${existing.tier_id} to the higher-rank tier ${tier.id} at sign-in (syncTierOnSignIn: upgradeOnly)`,
                }),
                guard,
              ),
            ]
          : []),
      ],
      {
        sql: `UPDATE licenses SET name = ?, email = ?, groups_json = ?, overrides_json = ?,
                email_issuer_class = ?, ${tier ? "tier_id = ?, " : ""}modified_by = ?, modified_at = ?
              WHERE product = ? AND id = ? AND overrides_json IS ?`,
        params: [
          identity.name ?? null,
          identity.email ?? null,
          JSON.stringify(identity.groups),
          merged,
          emailIssuerClass,
          ...(tier ? [tier.id] : []),
          "oidc",
          now,
          product.slug,
          existing.id,
          current,
        ],
      },
      { product: product.slug, licenseId: existing.id, overridesJson: merged },
    );
    if (applied) return;
    const reread = await getLicense(db, product.slug, existing.id);
    if (!reread) throw new Error("license not found");
    current = reread.overrides_json;
  }
  throw new Error(
    "license overrides changed concurrently; sign-in not applied",
  );
}

/** How an identity is being issued a licence. Today only the OIDC sign-in family: the product
 *  sign-in, the licence chooser, the device-code poll and the portal's Discover claim. */
export interface IssueVia {
  kind: "oidc";
  /** Seals secrets provisioned into the licence column until the override migration runs, then
   *  into the owner's account overrides. Every caller passes it. */
  env?: Env;
  /** The sign-in's mint writes its own audit row (`license.mint.oidc`) in the batch that
   *  inserts the licence. The portal's Discover claim passes `false`: it audits the licence it
   *  mints itself (`license.create`, with the Discover path and reason in the summary), and one
   *  claim is one row. Every other caller leaves it on. */
  mintAudit?: boolean;
  /** Reads `identity.oidc.syncTierOnSignIn` (Identity's setting, so injected: core cannot import
   *  it). Absent reads as `off`. */
  readSyncTier?: SyncTierReader;
}

/** Where the licence lands. */
export interface IssueTarget {
  /** LX-03: Core's licence-merge collector (`ServiceContext.licenseMerge`). The migrate arm
   *  needs it to carry the enrolled licence's store grants, purchases and binding to the
   *  identity's licence; without it the migrate is refused (`license-merge-unavailable`)
   *  rather than strand them on a disabled row. */
  licenseMerge?: LicenseMerge;
}

/** The device the caller is on. */
export interface IssueDevice {
  /** The license the caller's device is already using, when it presented one. An anonymous
   *  enrolled license found here is merged into the identity rather than abandoned. The sign-in
   *  callback never passes it, because a device-code flow is confirmed with the public user code
   *  (P1-06). The one HTTP route that does is `/device/poll`, and only on the device-code
   *  holder's explicit opt-in after the player accepted the signed-in identity on the device,
   *  for the licence the flow's own device holds a token on (P1-07). */
  enrolledLicenseId?: string | null;
}

/**
 * THE issuance engine: find or mint a licence for `holder`. Returns the licenseId, or an error
 * if the holder's groups don't grant entitlement. Idempotent on the OIDC subject.
 * Extracted unchanged from `activateFromIdentity` (P0-20); Identity's `activateFromIdentity`
 * is the adapter every caller still uses.
 */
export async function issueLicense(
  db: Db,
  // Never signs, so the public projection is enough: the portal's Discover claim (PX-W10) holds
  // one, and minting through this exact function is what makes it the auto-issue path.
  product: ProductPublic,
  holder: OidcIdentity,
  via: IssueVia,
  target: IssueTarget,
  now: number,
  device: IssueDevice = {},
): Promise<
  { licenseId: string; merged?: "claimed" | "migrated" } | { error: string }
> {
  const identity = holder;
  const opts = {
    enrolledLicenseId: device.enrolledLicenseId,
    licenseMerge: target.licenseMerge,
    env: via.env,
    mintAudit: via.mintAudit,
  };
  const oidc = await getOidcConfig(db, product.slug);
  const tier = await identityTier(db, product, identity, now, oidc);
  if ("error" in tier) return tier;
  const { tierId, expiresAt } = tier;

  const { provisioned: provisionedAll, declared } = await signInProvisioning(
    db,
    product,
    identity,
    now,
  );
  // Provisioned secrets go to the owner's account overrides for a licence that has an owner this
  // identity is linked to (U-27.2, L-U1), decided per licence below; every other licence keeps
  // them in the column. `overrides` is what the provisioning amounts to on a licence with the
  // given target (the device-limit previews read it); entitlement keys go to the licence's
  // `oidc` grant (`oidcGrant`).
  const overridesFor = (target: ProvisionedSecretTarget): ManagedPayload =>
    target === "account" ? { ...provisionedAll, secrets: {} } : provisionedAll;
  // What the column holds for the provisioned keys: sealed (`provisionedColumn`), so only the arms
  // that write it (the claim and the new licence) compute it.
  const column = (target: ProvisionedSecretTarget) =>
    provisionedColumn(opts.env, db, product.slug, provisionedAll, target);
  const oidcGrant = (licenseId: string) =>
    oidcGrantStatements({
      product: product.slug,
      licenseId,
      entries: provisionedAll.entitlements,
      declared: declared.entitlements,
      now,
      writer: "oidc",
      guard: null,
    });

  // The enrolled license this device is currently on, if it is genuinely a claimable
  // anonymous one. Anything else (an admin or OIDC license) is left alone.
  const enrolled = opts.enrolledLicenseId
    ? await getLicense(db, product.slug, opts.enrolledLicenseId)
    : null;
  const claimable =
    enrolled && enrolled.origin === "enroll" && enrolled.sub === null
      ? enrolled
      : null;

  const existing = await getLicenseBySub(db, product.slug, identity.sub);

  // The issuer class that produces `identity.email` on this sign-in is stamped with the address.
  // Auto-linking must not re-derive it from a later manifest edit, which could turn a custom
  // issuer's assertion into a platform assertion retroactively.
  const emailIssuerClass = oidc?.provider === "custom" ? "custom" : "platform";

  // Case 1 — a claimable enrolled license and no identity license yet: attach the identity to
  // the SAME row. Devices, overrides, and the client's local state all survive; the user
  // simply becomes known.
  if (claimable && !existing) {
    await claimEnrolledLicense(
      db,
      product.slug,
      claimable.id,
      {
        sub: identity.sub,
        name: identity.name ?? null,
        email: identity.email ?? null,
        groupsJson: JSON.stringify(identity.groups),
        tierId,
        expiresAt,
        emailIssuerClass,
      },
      now,
    );
    // Provisioning wins only on the keys its hooks declare (`mergeProvisionedOverrides`): an
    // operator's override of any other key on the enrolled licence survives the claim, as the
    // sign-in arm keeps it. Writing the column wholesale destroyed it.
    const claimTarget = await provisionedSecretTarget(
      db,
      claimable.account_id,
      identity.sub,
    );
    await db.batch([
      {
        sql: "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
        params: [
          mergeProvisionedOverrides(
            claimable.overrides_json,
            await column(claimTarget),
            declared,
          ),
          product.slug,
          claimable.id,
        ],
      },
      ...oidcGrant(claimable.id),
    ]);
    // Every key the provisioning DECLARES, not just the ones this identity's claims provide, so
    // a declared key whose claim is absent is cleared from the owner's row (revocation on claim
    // loss), exactly as the sign-in rewrite does.
    if (claimTarget === "account" && claimable.account_id)
      await applyProvisionedAccountSecrets(
        opts.env,
        db,
        product.slug,
        claimable.account_id,
        provisionedAll.secrets,
        declared.secrets,
        now,
      );
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: identity.sub,
      actor_name: identity.name ?? null,
      actor_email: identity.email ?? null,
      action: "license.merge",
      target_kind: "license",
      target_id: claimable.id,
      parent_id: null,
      summary: `Claimed the auto-issued license for ${identity.email ?? identity.sub}`,
    });
    return { licenseId: claimable.id, merged: "claimed" };
  }

  // Case 2 — a claimable enrolled license AND an existing identity license: migrate the
  // devices onto the identity's license and retire the enrolled row, so the user keeps their
  // machines but ends up on the license that already holds their entitlements.
  //
  // LX-03 (notes/S-19 §4.3 G6): one batch (`mergeLicenseInto`) moves the devices SEAT-CHECKED
  // against the limit the identity's license carries after this activation rewrites its tier and
  // overrides (below), carries what every service holds for the enrolled license (its store
  // grants and purchases; its purchase binding stays resolvable as an alias of the identity's
  // license), retires the enrolled row and writes the audit row — or writes none of it.
  if (claimable && existing && licenseUsable(existing, now)) {
    if (!opts.licenseMerge) return { error: "license-merge-unavailable" };
    const limit = await licenseDeviceLimit(
      db,
      product,
      {
        ...existing,
        tier_id: tierId,
        expires_at: expiresAt,
        overrides_json: JSON.stringify(
          overridesFor(
            await provisionedSecretTarget(
              db,
              existing.account_id,
              identity.sub,
            ),
          ),
        ),
      },
      now,
      { withoutOidcGrant: true },
    );
    const merged = await mergeLicenseInto(
      db,
      opts.licenseMerge,
      {
        product: product.slug,
        fromLicenseId: claimable.id,
        toLicenseId: existing.id,
        now,
      },
      limit,
      [
        // R3-05: `enroll_hwid` is deliberately NOT cleared. The retired row keeps occupying
        // `idx_licenses_enroll_hwid`, which is the only guard on "one free license per machine";
        // clearing it let the same machine enrol again immediately and repeat the merge with a
        // second identity, without limit.
        //
        // LX-12: the retired licence ends as `superseded` by the identity's licence. Only an
        // active one moves; one an operator had already revoked keeps that reason.
        licenseTransitionStatement({
          product: product.slug,
          licenseId: claimable.id,
          event: "supersede",
          supersededBy: existing.id,
          actor: "oidc",
          now,
        }),
        auditStatement({
          product: product.slug,
          id: randomId("aud"),
          at: now,
          actor_sub: identity.sub,
          actor_name: identity.name ?? null,
          actor_email: identity.email ?? null,
          action: "license.merge",
          target_kind: "license",
          target_id: existing.id,
          parent_id: claimable.id,
          summary: `Migrated devices and store purchases from auto-issued license ${claimable.id}`,
        }),
      ],
    );
    if (merged === "device_limit") return { error: "device-limit" };
  }

  if (existing) {
    if (!licenseUsable(existing, now)) return { error: "license-unusable" };
    await updateLicenseOnSignIn(
      db,
      product,
      identity,
      existing,
      now,
      emailIssuerClass,
      opts.env,
      tierId,
      via.readSyncTier,
    );
    return {
      licenseId: existing.id,
      ...(claimable ? { merged: "migrated" as const } : {}),
    };
  }

  const licenseId = randomId("lic");
  await db.batch([
    stmtInsertLicense({
      product: product.slug,
      id: licenseId,
      status: "active",
      sub: identity.sub,
      name: identity.name ?? null,
      email: identity.email ?? null,
      groups_json: JSON.stringify(identity.groups),
      tier_id: await issueTierFor(db, product.slug, tierId),
      activated_at: now,
      expires_at: expiresAt,
      max_offline_days: null,
      overrides_json: JSON.stringify(await column("license")),
      channels_json: null,
      min_version: null,
      max_version: null,
      // S-16 G14: without this the column defaults to 'admin' (migrations/0011).
      origin: "oidc",
      email_issuer_class: emailIssuerClass,
      modified_by: "oidc",
      modified_at: now,
    }),
    ...oidcGrant(licenseId),
    // The self-service MINT is audited like every other way a licence comes into existence (the
    // merge arms above write `license.merge`, `enroll.ts` audits its auto-issue): the one path
    // where a stranger turns a verified claim into a brand-new licence row used to write nothing
    // at all. It rides the insert's batch, so there is no licence without its row and no row for
    // a licence a racing sign-in already created. The issuer class is in the summary because it
    // is the fact that decides whether the licence may ever auto-link into a portal account.
    ...(opts.mintAudit === false
      ? []
      : [
          auditStatement({
            product: product.slug,
            id: randomId("aud"),
            at: now,
            actor_sub: identity.sub,
            actor_name: identity.name ?? null,
            actor_email: identity.email ?? null,
            action: "license.mint.oidc",
            target_kind: "license",
            target_id: licenseId,
            parent_id: null,
            summary: `Minted a license for ${identity.email ?? identity.sub} via ${emailIssuerClass} OIDC`,
          }),
        ]),
  ]);
  return { licenseId };
}
