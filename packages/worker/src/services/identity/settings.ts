/**
 * Identity's settings slice (ST-03, notes/S-18 Appendix A.2 `identity.*`, §5.3, §5.5),
 * contributed through the descriptor (`identityService.settings`), never imported by Core
 * (rule 6).
 *
 * The manifest's `identity:` block (I-09; plans/I-27.md §3) seeds four claimable settings, in their
 * final nested shape:
 *
 *   identity.keyEntry.limit       `identity.keyEntry.limit`: 1–100, no unlimited value
 *                                 (`allowUnset: false`, I-04 Q7), capped by the platform entry of
 *                                 the same key (`policyBound: "max"`). The bounds are
 *                                 `@polaris-key/manifest`'s `IDENTITY_KEY_ENTRY_LIMIT`, which the
 *                                 manifest rule `invalid_identity_key_entry_limit` uses too. Read
 *                                 through ST-04's resolver (`core/keyEntries.ts` `keyEntryLimit()`)
 *                                 by enforcement and by discovery's `keyEntryLimit`.
 *   identity.keyEntry.claimByKey  `identity.keyEntry.claimByKey`: column-backed on
 *                                 `portal_product_settings.claim_by_key` (`settingsColumns.ts`)
 *                                 until ST-14 folds that table into rows. Off by default; on lets a
 *                                 leaked key claim an email-bound licence, so it is
 *                                 security-widening and the console warns while it is on.
 *   identity.terms                `identity.terms` `{version, url?}` (`productTerms.ts`).
 *   identity.redirectPaths        `identity.redirectPaths`: critical; read by I-08's redirect.
 *
 * The row-backed ones (`IDENTITY_ROW_SETTINGS`) are written by the descriptor's
 * `manifestIngestAlways` on every link and resync (`core/rowSettings.ts`, omit-clears); claimByKey's
 * manifest value reaches its column through `manifestClaimByKeyStatements` below, while Identity is
 * on. A console claim is never overwritten. `identity.native` and `identity.requireTerms` are never registered.
 */

import {
  MAX_IDENTITY_REDIRECT_PATH_LENGTH,
  MAX_IDENTITY_REDIRECT_PATHS,
  OIDC_SYNC_TIER_ON_SIGN_IN_VALUES,
  type OidcSyncTierOnSignIn,
  type ParsedManifest,
} from "@polaris-key/manifest";
import type { Db, DbStatement } from "../../db/types.js";
import { randomId } from "../../crypto.js";
import {
  manifestRowSettingStatements,
  manifestValueAt,
} from "../../core/rowSettings.js";
import { RESYNC_ACTOR } from "../../core/settingsClaims.js";
import {
  readRowSettings,
  type RowSettingProduct,
} from "../../core/rowSettings.js";
import { setting } from "../../core/settings/define.js";
import {
  KEY_ENTRY_LIMIT_DEFAULT,
  KEY_ENTRY_LIMIT_MAX,
  KEY_ENTRY_LIMIT_MIN,
} from "../../core/settings/platform.js";
import type {
  ServiceSettingsSlice,
  SettingDef,
} from "../../core/settings/types.js";
import { IDENTITY_COLUMN_ADAPTERS } from "./settingsColumns.js";

const VISIBLE = { service: "identity", offBehaviour: "hide" } as const;

/**
 * S-19 §7.5 (LX-06, plans/LX-01.md §3.2): kept beside the other S-19 settings (License's
 * `licensing.*`) in the same row store, but in Identity's namespace under `identity.oidc`,
 * because its manifest home is the `oidc:` block. Row-backed: there is no `oidc_config` column.
 * It names `oidc`, so the registry's rule 2 makes it security-widening: `upgradeOnly` lets an
 * identity provider's groups raise a licence's tier.
 */
const SYNC_TIER_ON_SIGN_IN: SettingDef = setting({
  key: "identity.oidc.syncTierOnSignIn",
  scope: "product",
  service: "identity",
  area: "identity.signIn",
  label: "Sync tier on sign-in",
  description:
    "Whether a sign-in may move a licence to the tier the identity provider's groups map to. Upgrade-only never lowers a tier.",
  keywords: ["groupRoleMap", "tier", "upgrade"],
  docs: "/docs/features/sign-in/oidc/",
  value: { kind: "enum", values: OIDC_SYNC_TIER_ON_SIGN_IN_VALUES },
  defaultValue: "off",
  merge: "cascade",
  ownership: "claimable",
  manifest: { path: "product:oidc.syncTierOnSignIn" },
  securityWidening: true,
  widensWhen: "higher",
  critical: true,
  confirm: { change: "L1" },
  visibleWhen: VISIBLE,
  readers: ["services/identity/settings.ts", "core/rowSettings.ts"],
  storage: { kind: "scalar" },
  since: "LX-06",
});

/** I-09: `identity.keyEntry.limit`, from the `identity:` block (the limit PX-W9 enforces). */
const KEY_ENTRY_LIMIT: SettingDef = setting({
  key: "identity.keyEntry.limit",
  scope: "product",
  service: "identity",
  area: "identity.keyEntry",
  label: "Key-entry limit",
  description:
    "How many times the key of a licence that is in no account may be entered on new devices while Identity is on. Past it, with key-entry refusals on, key entry is refused with a link to the portal.",
  keywords: ["key entry", "key_entry_limit", "activations"],
  docs: "/docs/features/sign-in/",
  value: {
    kind: "integer",
    unit: "count",
    min: KEY_ENTRY_LIMIT_MIN,
    max: KEY_ENTRY_LIMIT_MAX,
  },
  defaultValue: KEY_ENTRY_LIMIT_DEFAULT,
  allowUnset: false,
  merge: "policy",
  policyBound: "max",
  widensWhen: "higher",
  ownership: "claimable",
  manifest: { path: "product:identity.keyEntry.limit" },
  confirm: { up: "L1", down: "L0" },
  visibleWhen: VISIBLE,
  wire: ["discovery", "refusal"],
  readers: ["core/keyEntries.ts"],
  storage: { kind: "scalar" },
});

/** The registry key of claimByKey (`settingsColumns.ts` adapts its column). */
export const CLAIM_BY_KEY_SETTING = "identity.keyEntry.claimByKey";

/**
 * I-09: `identity.keyEntry.claimByKey`. Column-backed until ST-14; the claim rules
 * (`accounts/claim.ts`, the portal's preview) read the column. It applies to every product, Identity
 * on or off (the platform claim rule), so it stays visible with Identity off.
 */
const CLAIM_BY_KEY: SettingDef = setting({
  key: CLAIM_BY_KEY_SETTING,
  scope: "product",
  service: "identity",
  area: "identity.keyEntry",
  label: "Add by key without the purchase email",
  description:
    "Whether a licence that carries a buyer email may join an account by its key alone, without that email verified on the account. On, anyone holding a leaked key can add an email-bound licence to their own account. A licence already in an account never moves by its key either way.",
  keywords: ["claim", "license_email_bound", "email-bound", "leaked key"],
  docs: "/docs/features/sign-in/",
  value: { kind: "boolean" },
  defaultValue: false,
  merge: "cascade",
  ownership: "claimable",
  manifest: { path: "product:identity.keyEntry.claimByKey" },
  securityWidening: true,
  widensWhen: "on",
  critical: true,
  confirm: { on: "L1", off: "L0" },
  visibleWhen: { service: "identity", offBehaviour: "visible" },
  readers: [
    "services/identity/accounts/claim.ts",
    "services/identity/portal/selfService.ts",
  ],
  storage: {
    kind: "column",
    table: "portal_product_settings",
    column: "claim_by_key",
  },
  since: "I-09",
});

/** I-09: `identity.terms` `{version, url?}`, the product's terms accepted at sign-in. */
const TERMS: SettingDef = setting({
  key: "identity.terms",
  scope: "product",
  service: "identity",
  area: "identity.signIn",
  label: "Terms",
  description:
    "The product's terms: a version and an https URL. A person signing in through the product accepts each version once; a new version asks again.",
  keywords: ["terms", "eula", "terms_required", "acceptance"],
  docs: "/docs/features/sign-in/",
  value: { kind: "json", schema: "identity.terms (product.schema.json)" },
  defaultValue: null,
  allowUnset: true,
  merge: "cascade",
  ownership: "claimable",
  manifest: { path: "product:identity.terms" },
  confirm: { change: "L1" },
  visibleWhen: VISIBLE,
  readers: ["services/identity/productTerms.ts"],
  storage: { kind: "scalar" },
  since: "I-09",
});

/**
 * I-09: `identity.redirectPaths`, the web redirect's callback paths (a redirect URI is a
 * `web.origins` origin plus one of them, matched exactly). Security-widening on any change. I-08's
 * `authorize` is its reader, so it stays pending on I-08; link and resync already write its row.
 */
const REDIRECT_PATHS: SettingDef = setting({
  key: "identity.redirectPaths",
  scope: "product",
  service: "identity",
  area: "identity.signIn",
  label: "Redirect paths",
  description:
    "The paths a web app's sign-in may return to. A redirect URI is one of the product's web origins plus one of these paths, matched exactly.",
  keywords: ["redirect_uri", "callback", "authorize", "web.origins"],
  docs: "/docs/features/sign-in/",
  value: {
    kind: "list",
    of: {
      kind: "string",
      pattern: "^(?!.*//)(?!.*\\.\\.)/[^?#*\\u0000-\\u0020\\u007f]*$",
      maxLength: MAX_IDENTITY_REDIRECT_PATH_LENGTH,
    },
    max: MAX_IDENTITY_REDIRECT_PATHS,
  },
  defaultValue: [],
  merge: "cascade",
  ownership: "claimable",
  manifest: { path: "product:identity.redirectPaths" },
  securityWidening: true,
  widensWhen: "any",
  critical: true,
  confirm: { change: "L1" },
  visibleWhen: VISIBLE,
  storage: { kind: "scalar" },
  since: "I-09",
  pending: { wp: "I-08" },
});

/** `browserSession.ts`'s 30-day browser session: a product may only shorten it (rule 3). */
const BROWSER_SESSION_DAYS = 30;

export const IDENTITY_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["identity"],
  columns: IDENTITY_COLUMN_ADAPTERS,
  entries: [
    KEY_ENTRY_LIMIT,
    CLAIM_BY_KEY,
    TERMS,
    REDIRECT_PATHS,
    setting({
      key: "identity.oidc",
      scope: "product",
      service: "identity",
      area: "identity.signIn",
      label: "OIDC sign-in",
      description:
        "The identity provider products sign users in with: issuer, client and group-to-role map. Changing the issuer moves who can sign in, so it is manifest-only and passes the issuer allowlist.",
      keywords: ["sso", "issuer", "groupRoleMap"],
      docs: "/docs/features/sign-in/oidc/",
      value: { kind: "json", schema: "oidc (product.schema.json)" },
      defaultValue: null,
      allowUnset: true,
      merge: "cascade",
      ownership: "manifest",
      manifest: { path: "product:oidc" },
      securityWidening: true,
      widensWhen: "any",
      critical: true,
      confirm: { change: "L2" },
      visibleWhen: VISIBLE,
      readers: ["services/identity/oidc.ts", "core/identityTrust.ts"],
      storage: { kind: "rich", adapter: "oidc_config" },
    }),
    // ST-19b: `.pkey/product`'s `provisioning` hooks. Link and every resync replace the rows whole
    // (`resync.ts`), and no admin route writes them, so the manifest owns them. A hook writes an
    // entitlement and a templated secret into a signed-in licence's payload from a verified claim
    // (`applyProvisioningHooks`), so changing one can widen what a sign-in grants:
    // security-widening, like the OIDC block it extends. The entitlement reaches the document.
    setting({
      key: "identity.provisioning",
      scope: "product",
      service: "identity",
      area: "identity.signIn",
      label: "Provisioning hooks",
      description:
        "Hooks that turn a verified OIDC claim into an entitlement and a secret on the signed-in person's licence: the claim, the entitlement key and value, and a secret built from a URL template whose host must be one the hook allows. Changing one changes what a sign-in grants.",
      keywords: ["claims", "entitlements", "provisioning_config"],
      docs: "/docs/features/sign-in/oidc/",
      value: { kind: "json", schema: "provisioning (product.schema.json)" },
      defaultValue: [],
      merge: "cascade",
      ownership: "manifest",
      manifest: { path: "product:provisioning" },
      securityWidening: true,
      widensWhen: "any",
      critical: true,
      confirm: { change: "L2" },
      visibleWhen: VISIBLE,
      wire: ["document"],
      readers: ["services/identity/oidc.ts"],
      storage: { kind: "rich", adapter: "provisioning_config" },
      since: "ST-19b",
    }),
    setting({
      key: "identity.browserSessionDays",
      scope: "product",
      service: "identity",
      area: "identity.signIn",
      label: "Browser session length",
      description:
        "How long a product sign-in in the browser lasts. A product may shorten it, never lengthen it past the platform's 30 days.",
      keywords: ["session", "sign out", "cookie"],
      docs: "/docs/features/sign-in/sessions/",
      value: {
        kind: "integer",
        unit: "days",
        min: 1,
        max: BROWSER_SESSION_DAYS,
      },
      defaultValue: BROWSER_SESSION_DAYS,
      merge: "policy",
      policyBound: "max",
      widensWhen: "higher",
      ownership: "operator",
      confirm: { up: "L1", down: "L0" },
      visibleWhen: VISIBLE,
      storage: { kind: "scalar" },
      pending: { wp: "ST-15" },
    }),
    // PX-W13 (plans/PX-W13.md §8 Q4, as amended): the operator's approval of one product whose
    // display name uses a reserved term (a third party's "Steam Deck Companion"). Operator-only
    // and audited; read by the manifest rule and the card's render-time check through ST-04's
    // resolver, which PX-W13b wires.
    setting({
      key: "identity.displayNameApproved",
      scope: "product",
      service: "identity",
      area: "identity.signIn",
      label: "Approved display name",
      description:
        "Lets this product's name or developer name use a reserved platform or store name. Only the platform operator can set it; the sign-in card then shows the name instead of the product slug.",
      keywords: ["reserved", "display name", "reserved_display_name"],
      docs: "/docs/build/manifest/product/",
      value: { kind: "boolean" },
      defaultValue: false,
      merge: "cascade",
      ownership: "operator",
      confirm: { on: "L1", off: "L0" },
      visibleWhen: VISIBLE,
      storage: { kind: "scalar" },
      pending: { wp: "PX-W13b" },
    }),
    SYNC_TIER_ON_SIGN_IN,
  ],
};

/**
 * Identity's row-backed claimable settings (`core/rowSettings.ts`): what its descriptor's
 * `manifestIngestAlways` applies from `.pkey/product` on every link and resync.
 */
export const IDENTITY_ROW_SETTINGS: readonly SettingDef[] = [
  SYNC_TIER_ON_SIGN_IN,
  KEY_ENTRY_LIMIT,
  TERMS,
  REDIRECT_PATHS,
];

/**
 * Identity's row-backed settings for a link or resync batch (the descriptor's
 * `manifestIngestAlways`), whatever Identity's enablement, so they are already right when Identity
 * is turned on; none of them is read while it is off.
 */
export function identityManifestIngest(
  parsed: ParsedManifest,
  product: string,
  now: number,
): DbStatement[] {
  return manifestRowSettingStatements(
    product,
    IDENTITY_ROW_SETTINGS,
    parsed,
    now,
  );
}

/**
 * claimByKey's manifest value at link and resync (I-09), for the descriptor's `manifestIngest`
 * (Identity on only: the claim rules read the column for every product, so a block declared while
 * Identity is off, which the validator warns about, changes nothing): when `.pkey/product` declares
 * `identity.keyEntry.claimByKey`, its
 * column takes that value unless the console has claimed the key (the guard is in the
 * statement, so a claim made while the resync ran still wins), with one `setting.resync` audit row
 * when the value changes. An undeclared value leaves the column alone: the console set it before
 * the block existed, and a resync must not quietly change what an existing product does.
 */
export function manifestClaimByKeyStatements(
  product: string,
  parsed: ParsedManifest | unknown,
  now: number,
): DbStatement[] {
  const declared = manifestValueAt(parsed, CLAIM_BY_KEY);
  if (typeof declared !== "boolean") return [];
  const value = declared ? 1 : 0;
  const claimed = `EXISTS (SELECT 1 FROM product_settings
      WHERE product = ? AND key = ? AND source = 'console'
        AND (expires_at IS NULL OR expires_at > ?))`;
  const was = `(SELECT claim_by_key FROM portal_product_settings WHERE product = ?)`;
  return [
    {
      sql: `INSERT INTO audit
              (product, id, at, actor_sub, actor_name, actor_email, action, target_kind,
               target_id, parent_id, summary)
            SELECT ?, ?, ?, ?, ?, ?, 'setting.resync', 'setting', ?, NULL, ?
            WHERE NOT ${claimed} AND COALESCE(${was}, 0) <> ?`,
      params: [
        product,
        randomId("aud"),
        now,
        RESYNC_ACTOR.sub,
        RESYNC_ACTOR.name,
        RESYNC_ACTOR.email,
        CLAIM_BY_KEY_SETTING,
        `${CLAIM_BY_KEY_SETTING} set from the manifest: ${declared}`,
        product,
        CLAIM_BY_KEY_SETTING,
        now,
        product,
        value,
      ],
    },
    {
      sql: `INSERT INTO portal_product_settings (product, claim_by_key, created_at, modified_at)
            SELECT ?, ?, ?, ? WHERE NOT ${claimed}
            ON CONFLICT(product) DO UPDATE SET
              claim_by_key = excluded.claim_by_key, modified_at = excluded.modified_at
            WHERE portal_product_settings.claim_by_key <> excluded.claim_by_key`,
      params: [product, value, now, now, product, CLAIM_BY_KEY_SETTING, now],
    },
  ];
}

/** The product's `identity.oidc.syncTierOnSignIn` in force (until ST-04's resolver). */
export async function readSyncTierOnSignIn(
  db: Db,
  product: RowSettingProduct,
): Promise<OidcSyncTierOnSignIn> {
  const [view] = await readRowSettings(db, product, IDENTITY_ROW_SETTINGS);
  return view!.value as OidcSyncTierOnSignIn;
}
