/// <reference types="@cloudflare/workers-types" />

/**
 * The account arm of the issuance engine (I-08b, plans/I-08.md D7, plans/I-27.md §2.2).
 *
 * `issueLicense` (`issue.ts`) finds or mints a licence for an identity SUBJECT: its row is keyed
 * by `sub` and `idx_licenses_sub` is the only thing that stops two of them. The first automatic
 * licence of the sign-in card belongs to the ACCOUNT instead: origin `oidc`, `account_id` set in
 * the same batch as the insert, `sub` NULL, no key. P0-20 shipped the identity holder only, so
 * the arm is added here with the same policy (`identityTier`), the same provisioning and the same
 * audit as the subject arm, and it takes no uniqueness from the database: the caller holds the
 * `"license-mint"` claim around it (`services/identity/passthrough/mint.ts`) until LX-38's unique
 * index on `licenses(product, account_id)` replaces the claim.
 *
 * It mints; it never merges, claims an enrolled licence or updates an existing one. The caller
 * has already decided that no candidate licence exists.
 */

import { randomId } from "../../platform/crypto.js";
import type { Db } from "../../db/types.js";
import type { ProductPublic } from "../products.js";
import { auditStatement } from "../audit.js";
import { stmtAttachNewLicense } from "../accounts/accountSubjects.js";
import { applyProvisionedAccountSecrets } from "../accounts/accountOverrides.js";
import { licenseConfigOverridesFrozen } from "../ops/overrideMigration.js";
import { oidcGrantStatements } from "./grants.js";
import {
  getOidcConfig,
  identityTier,
  type IssueVia,
  type OidcIdentity,
} from "./issue.js";
import { provisionedColumn, signInProvisioning } from "./provisioning.js";
import { issueTierFor } from "./implicitTier.js";
import { stmtInsertLicense } from "./store.js";

/** What the product's policy would grant `identity`, read-only (the card's "New" row). */
export async function accountGrant(
  db: Db,
  product: ProductPublic,
  identity: Pick<OidcIdentity, "groups">,
  now: number,
): Promise<{ tierId: string | null; expiresAt: number | null } | null> {
  const grant = await identityTier(db, product, identity, now);
  return "error" in grant
    ? null
    : { tierId: grant.tierId, expiresAt: grant.expiresAt };
}

/**
 * Mint one licence for `accountId` under the product's policy for `identity` (the account's
 * platform identity, or an email-only account's empty one). `{ error: "not-entitled" }` when the
 * policy grants nothing.
 */
export async function issueAccountLicense(
  db: Db,
  product: ProductPublic,
  accountId: string,
  identity: OidcIdentity,
  via: IssueVia,
  now: number,
): Promise<{ licenseId: string } | { error: string }> {
  const oidc = await getOidcConfig(db, product.slug);
  const tier = await identityTier(db, product, identity, now, oidc);
  if ("error" in tier) return tier;
  const { provisioned, declared } = await signInProvisioning(
    db,
    product,
    identity,
    now,
  );
  const frozen = await licenseConfigOverridesFrozen(db);
  const column = await provisionedColumn(
    via.env,
    db,
    product.slug,
    provisioned,
    frozen,
  );
  const licenseId = randomId("lic");
  await db.batch([
    stmtInsertLicense({
      product: product.slug,
      id: licenseId,
      status: "active",
      sub: null,
      name: identity.name ?? null,
      email: identity.email ?? null,
      groups_json: JSON.stringify(identity.groups),
      tier_id: await issueTierFor(db, product.slug, tier.tierId),
      activated_at: now,
      expires_at: tier.expiresAt,
      max_offline_days: null,
      overrides_json: JSON.stringify(column),
      channels_json: null,
      min_version: null,
      max_version: null,
      origin: "oidc",
      email_issuer_class: oidc?.provider === "custom" ? "custom" : "platform",
      modified_by: "oidc",
      modified_at: now,
    }),
    stmtAttachNewLicense(product.slug, licenseId, accountId, now),
    ...oidcGrantStatements({
      product: product.slug,
      licenseId,
      entries: provisioned.entitlements,
      declared: declared.entitlements,
      now,
      writer: "oidc",
      guard: null,
    }),
    ...(via.mintAudit === false
      ? []
      : [
          auditStatement({
            product: product.slug,
            id: randomId("aud"),
            at: now,
            actor_sub: null,
            actor_name: identity.name ?? null,
            actor_email: identity.email ?? null,
            action: "license.mint.oidc",
            target_kind: "license",
            target_id: licenseId,
            parent_id: null,
            summary: "Minted a license for a signed-in account",
          }),
        ]),
  ]);
  if (frozen)
    await applyProvisionedAccountSecrets(
      via.env,
      db,
      product.slug,
      accountId,
      provisioned.secrets,
      declared.secrets,
      now,
    );
  return { licenseId };
}
