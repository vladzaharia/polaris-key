/**
 * Identity's settings slice (ST-03, notes/S-18 Appendix A.2 `identity.*`, §5.3, §5.5),
 * contributed through the descriptor (`identityService.settings`), never imported by Core
 * (rule 6).
 *
 * `identity.keyEntry.limit` is registered here for I-09 and I-10a: claimable from the manifest's
 * `identity:` block (I-04 §3), bounded 1–100 with no unlimited value (`allowUnset: false`, I-04
 * Q7), and capped by the platform entry of the same key (`policyBound: "max"`). The bounds are
 * the platform slice's `KEY_ENTRY_LIMIT_*` constants; the manifest rule I-09 adds
 * (`invalid_identity_key_entry_limit`) must use the same numbers.
 */

import {
  OIDC_SYNC_TIER_ON_SIGN_IN_VALUES,
  type OidcSyncTierOnSignIn,
} from "@polaris-key/manifest";
import type { Db } from "../../core/platform.js";
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
  docs: "/docs/services/identity/oidc/",
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

/** `browserSession.ts`'s 30-day browser session: a product may only shorten it (rule 3). */
const BROWSER_SESSION_DAYS = 30;

export const IDENTITY_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["identity"],
  entries: [
    setting({
      key: "identity.keyEntry.limit",
      scope: "product",
      service: "identity",
      area: "identity.keyEntry",
      label: "Key-entry limit",
      description:
        "How many times a floating licence's key may be entered on new devices while Identity is on. Past it, key entry is refused with a link to the portal.",
      keywords: ["key entry", "key_entry_limit", "activations"],
      docs: "/docs/services/identity/",
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
      manifest: { path: "product:identity.keyEntryLimit" },
      confirm: { up: "L1", down: "L0" },
      visibleWhen: VISIBLE,
      wire: ["discovery", "refusal"],
      storage: { kind: "scalar" },
      pending: { wp: "I-09" },
    }),
    setting({
      key: "identity.oidc",
      scope: "product",
      service: "identity",
      area: "identity.signIn",
      label: "OIDC sign-in",
      description:
        "The identity provider products sign users in with: issuer, client and group-to-role map. Changing the issuer moves who can sign in, so it is manifest-only and passes the issuer allowlist.",
      keywords: ["sso", "issuer", "groupRoleMap"],
      docs: "/docs/services/identity/oidc/",
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
      docs: "/docs/services/identity/oidc/",
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
      docs: "/docs/services/identity/sessions/",
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
      docs: "/docs/build/manifest/authoring/",
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
];

/** The product's `identity.oidc.syncTierOnSignIn` in force (until ST-04's resolver). */
export async function readSyncTierOnSignIn(
  db: Db,
  product: RowSettingProduct,
): Promise<OidcSyncTierOnSignIn> {
  const [view] = await readRowSettings(db, product, IDENTITY_ROW_SETTINGS);
  return view!.value as OidcSyncTierOnSignIn;
}
