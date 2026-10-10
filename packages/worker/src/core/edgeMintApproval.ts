/// <reference types="@cloudflare/workers-types" />

/**
 * THE edge-mint approval rule (P0-12) — whether an operator's approval of a recipe still applies,
 * and the sweep that makes a product-side widening of it permanent.
 *
 * ── WHY THIS LIVES IN CORE ─────────────────────────────────────────────────────────────────
 *
 * Config owns the mint and its approvals, but the product state an approval is checked against
 * is written by the manifest ingest (`services/release/{linkRepo,resync}.ts`), and a service may
 * not import another service (`test/boundaries.test.ts`). The ingest has to run this rule on the
 * state it just wrote (see `invalidateWidenedEdgeMintApprovals`), so the rule is Core's, and
 * `services/config/mint.ts` re-exports it — the same move `core/licensing/authz.ts` made for License.
 *
 * ── WHAT AN APPROVAL COVERS ────────────────────────────────────────────────────────────────
 *
 * An approval (`edge_mint_approvals`) records the recipe's security-relevant fields AND the
 * product settings that decide who can hold the device token the mint accepts:
 *   - whether the mint was acknowledged as PUBLIC (`open_registration_acknowledged`);
 *   - whether License was on (`license_enabled`) — the mint only checks a device's licence while
 *     it is, so turning License off brings back devices whose licences were disabled or expired;
 *   - the sign-in trust (`identity_enabled`, `oidc_*`) — signing in is how device tokens reach
 *     people no operator issued a key to.
 * Every one of those settings is manifest-owned, so a push can change it without touching the
 * recipe.
 */

import type { Db, DbStatement } from "../db/types.js";
import { randomId } from "../platform/crypto.js";
import { getProduct } from "./repo.js";
import {
  allowsAnonymousEnroll,
  allowsOidcDefault,
  parseAutoIssue,
  type AutoIssuePolicy,
} from "../platform/fingerprint.js";
import {
  readIdentityIssuance,
  sameGroupRoleMap,
  type IdentityIssuance,
} from "./accounts/identityTrust.js";
import {
  serviceStateOf,
  type RegistrationPolicy,
  type ServicesMap,
} from "./services.js";

/**
 * Whether anyone at all can obtain the device token the mint accepts — the condition under
 * which an approval must carry the operator's open-registration acknowledgement.
 *
 * Three product settings, each of which a `.pkey/product` push can change without touching the
 * recipe, make the mint public:
 *   - the EFFECTIVE registration is `open` (declared `devices.registration: open`, or License
 *     off with Identity off so the derived policy is open) — any installation registers;
 *   - auto-issue allows anonymous enrolment (`mode` `anonymous` or `both`, enabled with a tier):
 *     `POST /<p>/license/enroll` hands any caller a licence and a device token with no key and
 *     no sign-in, while the effective registration still reads `requires-license`; and
 *   - Identity is on and auto-issue gives signed-in users a default tier (`mode` `oidcDefault`
 *     or `both`): every account the product's identity provider will sign in gets a licence,
 *     mapped group or not. On a public IdP that is anyone.
 * WHICH identity provider, and which groups it maps, is not part of this predicate: it is bound
 * to the approval as its own condition (`identity` in `approvalMismatch`).
 * Pass the resolved `Product`, never the declared manifest values.
 */
export function mintIsPublic(product: {
  registration: RegistrationPolicy;
  autoIssue: AutoIssuePolicy;
  services: ServicesMap;
}): boolean {
  return (
    product.registration === "open" ||
    allowsAnonymousEnroll(product.autoIssue) ||
    (product.services.identity.enabled && allowsOidcDefault(product.autoIssue))
  );
}

/** The recipe's security-relevant columns — what an approval records and must equal. */
export interface MintRecipeFields {
  alg: string;
  signing_key_secret: string;
  kid: string | null;
  claims_template_json: string | null;
  ttl_seconds: number;
  audience: string | null;
}

/** An `edge_mint_approvals` row. */
export interface MintApprovalRow extends MintRecipeFields {
  id: string;
  open_registration_acknowledged: number;
  /** License was on when the operator approved, so the mint was checking licences. */
  license_enabled: number;
  /** Identity was on when the operator approved; the four `oidc_*` columns are what it trusted. */
  identity_enabled: number;
  oidc_provider: string | null;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  oidc_group_role_map_json: string | null;
  approved_at: number;
  approved_by: string;
}

/** The security-relevant fields, in their wire (camelCase) spelling, paired with the column.
 *  `auth_page_template` is deliberately absent: it does not change what is signed, and the
 *  `/auth` page ships its own script-free policy. */
export const MINT_RECIPE_FIELDS = [
  ["alg", "alg"],
  ["signingKeySecret", "signing_key_secret"],
  ["kid", "kid"],
  ["claimsTemplateJson", "claims_template_json"],
  ["ttlSeconds", "ttl_seconds"],
  ["audience", "audience"],
] as const;

export type MintRecipeWireField = (typeof MINT_RECIPE_FIELDS)[number][0];

/** A product-side reason an approval no longer applies: the product WIDENED who can hold a
 *  device token the mint accepts. `registration`: the mint is public and was not acknowledged;
 *  `license`: License was turned off; `identity`: the sign-in trust changed. */
export type MintWidening = "registration" | "license" | "identity";

/** Why an approval no longer applies: a recipe field, or a product-side widening. */
export type MintMismatch = MintRecipeWireField | MintWidening;

/** Which wire fields differ between two recipe values (strict equality; NULL equals NULL). */
export function differingRecipeFields(
  a: MintRecipeFields,
  b: MintRecipeFields,
): MintRecipeWireField[] {
  return MINT_RECIPE_FIELDS.filter(([, col]) => a[col] !== b[col]).map(
    ([wire]) => wire,
  );
}

/**
 * The product state an approval is checked against besides the recipe itself. All of it is
 * product settings a push can change without touching the recipe, so it is read fresh for
 * every decision.
 */
export interface MintApprovalBasis {
  /** `mintIsPublic(product)`. */
  publicMint: boolean;
  /** The License service is on, so the mint requires a usable licence. */
  licenseEnabled: boolean;
  /** The product's current identity issuance inputs (`core/accounts/identityTrust.ts`). */
  identity: IdentityIssuance;
}

/** The product fields `mintApprovalBasis` reads — a resolved `Product` satisfies it. */
export interface MintPolicyProduct {
  slug: string;
  registration: RegistrationPolicy;
  autoIssue: AutoIssuePolicy;
  services: ServicesMap;
}

export async function mintApprovalBasis(
  db: Db,
  product: MintPolicyProduct,
): Promise<MintApprovalBasis> {
  return {
    publicMint: mintIsPublic(product),
    licenseEnabled: product.services.license.enabled,
    identity: await readIdentityIssuance(db, product),
  };
}

/**
 * Whether sign-in could hand out device tokens the approval did not cover. Only a WIDENING
 * counts: with Identity off now there is no sign-in path at all, whatever was approved. With it
 * on, the approval must have been given with Identity on and with the same provider, issuer,
 * client id and group map — otherwise a push could aim sign-in at an issuer the pusher controls,
 * or map their own group onto a tier, and mint with the licence that follows.
 */
function identityWidened(
  approval: MintApprovalRow,
  current: IdentityIssuance,
): boolean {
  if (!current.enabled) return false;
  return (
    approval.identity_enabled !== 1 ||
    approval.oidc_provider !== current.provider ||
    approval.oidc_issuer !== current.issuer ||
    approval.oidc_client_id !== current.clientId ||
    !sameGroupRoleMap(
      approval.oidc_group_role_map_json,
      current.groupRoleMapJson,
    )
  );
}

/**
 * The product-side half of the rule: every way the product now lets more callers hold a device
 * token the mint accepts than it did when the operator approved. Independent of the recipe.
 *   - `registration` when the mint is public now (`mintIsPublic`) and the approval was given
 *     without the acknowledgement — an approval given while the mint was closed is not the
 *     operator's decision that ANYONE may mint;
 *   - `license` when License was on at approval and is off now: the mint checks a device's
 *     licence only while License is on, so a device whose licence an operator disabled, or that
 *     expired, would mint again;
 *   - `identity` when Identity is on and its provider, issuer, client id or group map is not the
 *     one the approval recorded (`identityWidened`).
 * Turning License or Identity ON, or closing the mint, only narrows and is never listed.
 */
export function productWidening(
  approval: MintApprovalRow,
  basis: MintApprovalBasis,
): MintWidening[] {
  return [
    ...(basis.publicMint && approval.open_registration_acknowledged !== 1
      ? (["registration"] as const)
      : []),
    ...(approval.license_enabled === 1 && !basis.licenseEnabled
      ? (["license"] as const)
      : []),
    ...(identityWidened(approval, basis.identity)
      ? (["identity"] as const)
      : []),
  ];
}

/**
 * THE approval rule — the token route, discovery, the admin list and the setup checklist all
 * decide with this one function. Empty means the approval applies. It lists every recipe field
 * whose current value differs from the approved one, then `productWidening`.
 */
export function approvalMismatch(
  recipe: MintRecipeFields,
  approval: MintApprovalRow,
  basis: MintApprovalBasis,
): MintMismatch[] {
  return [
    ...differingRecipeFields(recipe, approval),
    ...productWidening(approval, basis),
  ];
}

/** The resolved mint policy of a stored `products` row, without opening its signing key. */
function mintPolicyOfRow(row: {
  slug: string;
  services_json?: string | null;
  services_source?: string | null;
  auto_issue_json?: string | null;
}): MintPolicyProduct {
  const state = serviceStateOf(row);
  return {
    slug: row.slug,
    registration: state.effectiveRegistration,
    autoIssue: parseAutoIssue(row.auto_issue_json),
    services: state.services,
  };
}

const WIDENING_TEXT: Record<MintWidening, string> = {
  registration: "the mint became public without an acknowledgement",
  license: "License was turned off",
  identity: "sign-in now trusts a different identity provider or group map",
};

/**
 * Delete every approval of `slug` that the product, AS STORED NOW, has widened
 * (`productWidening` non-empty), and audit each as `config.mint.invalidate`. Returns the recipe
 * ids whose approval was dropped.
 *
 * The manifest ingest calls this before its first write and again after its last one. The
 * per-request check alone is not enough: it compares an approval with the product as it stands,
 * so a push that widens issuance and a second push that reverts it would leave the approval
 * applying again — while the licences and device tokens handed out in between (an anonymous
 * enrolment, a sign-in through the pusher's issuer, a device whose disabled licence stopped
 * being checked) keep working. Deleting the approval makes the widening permanent: after the
 * revert the recipe is `pending`, and only an operator's re-approval makes it mint again.
 * The call before the first write catches a widening the previous ingest's sweep missed.
 *
 * The console calls it too, before every write of an approval input (`console/handlers/servicesAdmin.ts`
 * for `services_json`, `services/license/admin/policy.ts` for `auto_issue_json`; `oidc_config`
 * is written only by the ingest). The guarantee rests on THAT pre-write sweep, not on the
 * ingest's `finally`: a `finally` covers a throw, not a Worker killed after the push's
 * un-batched widening writes (CPU limit, a cancelled request), and an approve can race a push's
 * post-write sweep. Because every writer of an approval input — ingest and console — sweeps
 * before it writes, no revert can be the first thing to look at a widened approval. An
 * operator's own console widening is therefore dropped at their next console edit or push.
 *
 * Recipe-field changes are NOT swept: while a recipe differs from its approval it signs nothing,
 * so there is nothing issued in between that a revert could launder.
 */
export async function invalidateWidenedEdgeMintApprovals(
  db: Db,
  slug: string,
  now: number,
  cause: string,
): Promise<string[]> {
  const approvals = await db.all<MintApprovalRow>(
    "SELECT * FROM edge_mint_approvals WHERE product = ? ORDER BY id",
    slug,
  );
  if (approvals.length === 0) return [];
  const row = await getProduct(db, slug);
  if (!row) return [];
  const basis = await mintApprovalBasis(db, mintPolicyOfRow(row));

  const stmts: DbStatement[] = [];
  const dropped: string[] = [];
  for (const approval of approvals) {
    const widened = productWidening(approval, basis);
    if (widened.length === 0) continue;
    dropped.push(approval.id);
    stmts.push({
      // `approved_at` pins the row that was judged, so an operator's re-approval that lands
      // between the read above and this delete is not swept with it.
      sql: `DELETE FROM edge_mint_approvals
             WHERE product = ? AND id = ? AND approved_at = ? AND approved_by = ?`,
      params: [slug, approval.id, approval.approved_at, approval.approved_by],
    });
    stmts.push({
      sql: `INSERT INTO audit (product, id, at, actor_sub, actor_name, actor_email, action,
              target_kind, target_id, parent_id, summary)
            VALUES (?, ?, ?, NULL, NULL, NULL, 'config.mint.invalidate', 'edgeMint', ?, NULL, ?)`,
      params: [
        slug,
        randomId("aud"),
        now,
        approval.id,
        `Dropped the approval of edge-mint recipe ${approval.id} (${cause}): ` +
          widened.map((w) => WIDENING_TEXT[w]).join("; ") +
          ". Review the licences and devices issued since, then re-approve.",
      ],
    });
  }
  if (stmts.length > 0) await db.batch(stmts);
  return dropped;
}
