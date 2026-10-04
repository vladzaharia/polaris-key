/**
 * The registry credential vocabulary (F-21, plans/F-20.md §6.1): the `pkeyr_` token's prefix and
 * shape, its scopes and limits, and the principal a resolved credential becomes.
 *
 * A leaf module on purpose, like `ciVocabulary.ts`: Core's store (`registryTokens.ts`),
 * Distribution's access ladder (`services/distribution/registry/authorize.ts`), the admin API and
 * the portal API all need these, and none of them imports another for a constant.
 */

import type { LicenseRow } from "../repo.js";

/** Every registry token starts with this; anything else is not a registry credential. */
export const REGISTRY_TOKEN_PREFIX = "pkeyr_";

/** `pkeyr_` and at least 43 base64url characters (256 random bits). A floor, as `isDeviceToken`. */
export const REGISTRY_TOKEN_SHAPE = /^pkeyr_[A-Za-z0-9_-]{43,}$/;

/** The username every client that needs one sends beside the token (Basic, docker login). */
export const REGISTRY_TOKEN_USERNAME = "__token__";

/** The scope vocabulary. `publish` is reserved for F-22 and F-23 and refused at mint until then. */
export const REGISTRY_TOKEN_SCOPES = ["read", "publish"] as const;
export type RegistryTokenScope = (typeof REGISTRY_TOKEN_SCOPES)[number];

/** The scopes a mint accepts today. */
export const MINTABLE_REGISTRY_SCOPES: readonly RegistryTokenScope[] = [
  "read",
];

/** How a token is presented: in `Authorization` (every client), or in the Godot editor's URL. */
export type RegistryTokenPresentation = "header" | "url";

/** Who a token is bound to: the owner (console) or one licence of the owner. */
export type RegistryTokenBinding = "owner" | "license";

/** Expiry, in days: required, at least 1, at most 365 (Q6); the defaults per presentation. */
export const REGISTRY_TOKEN_MIN_DAYS = 1;
export const REGISTRY_TOKEN_MAX_DAYS = 365;
export const REGISTRY_TOKEN_DEFAULT_DAYS = 90;
export const REGISTRY_URL_TOKEN_DEFAULT_DAYS = 30;

/** Live (unrevoked, unexpired) tokens per licence and per owner. */
export const MAX_LIVE_TOKENS_PER_LICENSE = 10;
export const MAX_LIVE_TOKENS_PER_OWNER = 500;

/** The longest label. */
export const REGISTRY_TOKEN_LABEL_MAX = 64;

/**
 * How long an isolate keeps a resolved credential (principal and licence row), in seconds. The
 * same window as the feed settings (`REGISTRY_SETTINGS_TTL_SECONDS`), so a revocation, a licence
 * suspension, a tightened feed and a deleted product all take effect within it. Any increase is
 * a THREAT-MODEL §9 review trigger.
 */
export const REGISTRY_TOKEN_TTL_SECONDS = 30;

/** The OCI pull token's lifetime, in seconds. Any increase is a THREAT-MODEL §9 review trigger. */
export const REGISTRY_PULL_TOKEN_TTL_SECONDS = 300;

/** Rows are purged this long after they expired or were revoked. */
export const REGISTRY_TOKEN_RETENTION_SECONDS = 90 * 86_400;

/** Why a token was revoked (`revoke_reason`). */
export type RegistryRevokeReason =
  | "manual"
  | "revoke_all"
  | "license_deleted"
  | "link_removed"
  | "account_deleted"
  | "product_deleted";

/**
 * Who a presented registry credential is, once resolved (plans/F-20.md §6.2). `anonymous` covers
 * every credential that resolves to nothing: none, malformed, unknown, expired, revoked, a URL
 * token in a header or the reverse. The ladder judges the rest against the owner and ecosystem.
 */
export type FeedPrincipal =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "owner";
      readonly product: string;
      readonly tokenId: string;
      readonly ecosystems: readonly string[] | null;
    }
  | {
      readonly kind: "ci";
      readonly product: string;
      readonly tokenId: string;
    }
  | {
      readonly kind: "license";
      readonly product: string;
      readonly tokenId: string;
      readonly license: LicenseRow;
      readonly ecosystems: readonly string[] | null;
    };

/** The anonymous principal. */
export const ANONYMOUS: FeedPrincipal = { kind: "anonymous" };
