/**
 * The config slice of the console API (P0-32.21): the catalog and its history, edge-mint recipes, managed payloads and profiles.
 * Types and the `configApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import type { ManagementState } from "@polaris-key/catalog";
import type { ProductCatalog } from "@polaris-key/catalog";
import type { SecretUsage } from "./platform.js";
import { call, enc, p } from "./transport.js";

/** The security-relevant recipe fields, exactly as the approve call must echo them. */
export interface EdgeMintRecipeFields {
  alg: string;
  signingKeySecret: string;
  kid: string | null;
  claimsTemplateJson: string | null;
  ttlSeconds: number;
  audience: string | null;
  /** Who may mint the recipe: any device (`none`), a device of the product (`registered`), or
   *  a device whose licence is usable (`licensed`, the default). */
  requires: "none" | "registered" | "licensed";
  /** A catalog flag the caller's merged payload must carry, truthy, or `null` for none. */
  requiredEntitlement: string | null;
}

/** The sign-in trust an edge-mint approval covers: the product's identity provider and the group
 *  map that decides who a sign-in licenses. `null` means Identity is off (no sign-in path). */
export interface EdgeMintIdentity {
  provider: string | null;
  issuer: string | null;
  clientId: string | null;
  groupRoleMapJson: string | null;
}

export interface EdgeMintRecipe extends EdgeMintRecipeFields {
  id: string;
  /** Parsed `claimsTemplateJson`, for display only (null when absent or corrupt). */
  claimsTemplate: unknown;
  /** `approved` mints; `pending` was never approved; `changed` was approved in another form. */
  status: "approved" | "pending" | "changed";
  secretUsage: SecretUsage | "missing" | "unrecognised";
  approval:
    | (EdgeMintRecipeFields & {
        /** Whether the approval carries the open-registration acknowledgement. */
        openRegistrationAcknowledged: boolean;
        /** Whether License was on (licences checked) when the approval was given. */
        licenseEnabled: boolean;
        /** The sign-in trust recorded with the approval. */
        identity: EdgeMintIdentity | null;
        approvedAt: number;
        approvedBy: string;
      })
    | null;
  /** Why a `changed` recipe's approval no longer applies. `registration` means the mint is
   *  public now (open registration, anonymous enrolment or an OIDC default tier) and the
   *  approval was given without acknowledging that; `license` means License was turned off
   *  since, so device licences are no longer checked; `identity` means sign-in now trusts a
   *  different identity provider or group map than the approval recorded. The next push or
   *  console edit of the product's services or License policy deletes such an approval before
   *  it writes (the recipe then reads `pending`; the audit log says why), so `changed` for these
   *  three lasts only until then — after an operator's own edit, or a push that was cut off
   *  before its own sweep. */
  changedFields: (
    | keyof EdgeMintRecipeFields
    | "registration"
    | "license"
    | "identity"
  )[];
}

export interface EdgeMintRecipesResponse {
  /** The product's EFFECTIVE registration policy; `open` means anyone can hold a device token. */
  registration: "open" | "requires-identity" | "requires-license";
  /** Whether auto-issue lets any caller enrol anonymously (`POST /<p>/license/enroll`). */
  anonymousEnroll: boolean;
  /** Whether Identity is on and auto-issue gives every signed-in account a default tier. */
  oidcDefault: boolean;
  /** Open registration, anonymous enrolment or an OIDC default tier: anyone (who can sign in)
   *  can hold a device token, so approving needs the acknowledgement. */
  publicMint: boolean;
  /** Whether License is on, so the mint checks each device's licence. */
  licenseEnabled: boolean;
  /** The sign-in trust an approval given now would record; the approve call echoes it. */
  identity: EdgeMintIdentity | null;
  recipes: EdgeMintRecipe[];
}

/** A managed value: its state, value, and when an admin last changed it (epoch seconds). */
export interface ManagedEntry {
  state: ManagementState;
  value?: unknown;
  updatedAt: number;
}

/** A redacted secret entry — value withheld; only whether one is configured + when. */
export interface ManagedSecretView {
  state: ManagementState;
  configured: boolean;
  updatedAt: number;
}

/** The redacted, over-the-wire payload shape (secrets never carry a value). */
export interface RedactedPayload {
  config: Record<string, ManagedEntry>;
  secrets: Record<string, ManagedSecretView>;
  entitlements: Record<string, ManagedEntry>;
}

/** A single override/payload key update sent on a PUT batch. */
export interface OverrideUpdate {
  key: string;
  state?: ManagementState;
  value?: unknown;
}

export interface ProfileSummary {
  id: string;
  name: string;
  description?: string;
  modifiedBy?: string;
  modifiedAt?: number;
  /** ST-01b: `console` once created or edited in the console; a resync leaves it alone. */
  source?: "manifest" | "console";
  /** How many tiers (baseline) and licenses (profile stack) point at it. */
  usedBy?: { tiers: number; licenses: number };
}

export interface ProfileDetail extends Omit<ProfileSummary, "usedBy"> {
  payload: RedactedPayload;
  /** The tiers and licenses that point at it; Delete is refused while either is non-empty. */
  usedBy?: {
    tiers: { id: string; label: string }[];
    licenses: { id: string; name?: string; email?: string }[];
  };
}

export interface CatalogVersionSummary {
  version: number;
  active: boolean;
  createdAt: number;
  entryCount: number;
  /** `admin`: published in the console; `manifest`: written by the product's `.pkey/schema`. */
  source: "admin" | "manifest";
  publishedBy: string | null;
}

/** What sets one catalog key: ids and names, never a value. */
export interface CatalogKeyUsage {
  profiles: { id: string; name: string }[];
  /** Tiers that inherit one of those profiles as their baseline. */
  tiers: { id: string; label: string; profile: string }[];
  licenses: { id: string; name: string | null; email: string | null }[];
  /** U-03: the accounts whose account overrides set it, by pairwise subject. */
  accounts?: { subject: string }[];
}

export const configApi = {
  schema: (slug: string) => call<ProductCatalog>(`${p(slug)}/config/catalog`),
  /**
   * Publish a new catalog version. `expectedVersion` is the version the draft started from (`0`
   * for a first publish): when another publish landed since, the server answers 409
   * `catalog_version_conflict` instead of overwriting it (ADMIN.md A-6).
   */
  publishSchema: (
    slug: string,
    catalog: ProductCatalog,
    expectedVersion?: number,
    /** ST-20: a manifest-authoritative product takes a publish only as a break-glass claim. */
    breakGlass?: { reason: string },
  ) =>
    call<{
      ok: true;
      schemaVersion: number;
      breakGlass?: { expiresAt: number };
    }>(`${p(slug)}/config/catalog`, {
      method: "PUT",
      body: JSON.stringify({
        catalog,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        ...(breakGlass ? { breakGlass } : {}),
      }),
    }),
  /** Every published catalog version, newest first (A-6). */
  catalogVersions: (slug: string) =>
    call<{ versions: CatalogVersionSummary[] }>(
      `${p(slug)}/config/catalog/versions`,
    ),
  /** One catalog version, active or not (A-6). */
  catalogVersion: (slug: string, version: number) =>
    call<ProductCatalog>(`${p(slug)}/config/catalog/versions/${version}`),
  /** The profiles, tiers and licenses that set each key (A-7b). */
  catalogUsage: (slug: string, keys: readonly string[]) =>
    call<{ keys: Record<string, CatalogKeyUsage> }>(
      `${p(slug)}/config/catalog/usage?${([] as string[])
        .concat(keys)
        .map((k) => `key=${enc(k)}`)
        .join("&")}`,
    ),

  edgeMintRecipes: (slug: string) =>
    call<EdgeMintRecipesResponse>(`${p(slug)}/config/mint`),
  /** Approve exactly what the operator was shown — the recipe and the sign-in trust beside it:
   *  the server refuses (409) if either changed. */
  approveEdgeMintRecipe: (
    slug: string,
    id: string,
    fields: EdgeMintRecipeFields,
    identity: EdgeMintIdentity | null,
    /** Whether License was on in the view the operator approved from (refused with 409 if a
     *  push changed it since). */
    licenseEnabled: boolean,
    acknowledgeOpenRegistration = false,
  ) =>
    call<{ ok: true; id: string; status: "approved" }>(
      `${p(slug)}/config/mint/${enc(id)}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          alg: fields.alg,
          signingKeySecret: fields.signingKeySecret,
          kid: fields.kid,
          claimsTemplateJson: fields.claimsTemplateJson,
          ttlSeconds: fields.ttlSeconds,
          audience: fields.audience,
          requires: fields.requires,
          requiredEntitlement: fields.requiredEntitlement,
          identity,
          licenseEnabled,
          ...(acknowledgeOpenRegistration
            ? { acknowledgeOpenRegistration: true }
            : {}),
        }),
      },
    ),
  revokeEdgeMintRecipe: (slug: string, id: string) =>
    call<{ ok: true; id: string; status: "pending" }>(
      `${p(slug)}/config/mint/${enc(id)}/revoke`,
      { method: "POST" },
    ),

  profiles: (slug: string) =>
    call<{ profiles: ProfileSummary[] }>(`${p(slug)}/config/profiles`),
  profile: (slug: string, id: string) =>
    call<ProfileDetail>(`${p(slug)}/config/profiles/${enc(id)}`),
  createProfile: (
    slug: string,
    body: { id?: string; name?: string; description?: string },
  ) =>
    call<{ ok: true; id: string }>(`${p(slug)}/config/profiles`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  putProfilePayload: (slug: string, id: string, updates: OverrideUpdate[]) =>
    call<{ ok: true; id: string }>(`${p(slug)}/config/profiles/${enc(id)}`, {
      method: "PUT",
      body: JSON.stringify({ updates }),
    }),
  /** Edit a profile's name and description (A-7); `description: null` clears it. */
  patchProfile: (
    slug: string,
    id: string,
    body: { name?: string; description?: string | null },
  ) =>
    call<{ ok: true; id: string }>(`${p(slug)}/config/profiles/${enc(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteProfile: (slug: string, id: string) =>
    call<{ ok: true; id: string }>(`${p(slug)}/config/profiles/${enc(id)}`, {
      method: "DELETE",
    }),
};
