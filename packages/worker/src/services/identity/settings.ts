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

import { setting } from "../../core/settings/define.js";
import {
  KEY_ENTRY_LIMIT_DEFAULT,
  KEY_ENTRY_LIMIT_MAX,
  KEY_ENTRY_LIMIT_MIN,
} from "../../core/settings/platform.js";
import type { ServiceSettingsSlice } from "../../core/settings/types.js";

const VISIBLE = { service: "identity", offBehaviour: "hide" } as const;

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
    // and audited; read by the manifest rule and the card's render-time check once ST-04's
    // resolver can read product settings.
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
      pending: { wp: "ST-04" },
    }),
    // S-19 §7.5: kept beside the other S-19 settings' owner (LX-06) but in Identity's namespace,
    // because its manifest home is the `oidc:` block.
    setting({
      key: "identity.syncTierOnSignIn",
      scope: "product",
      service: "identity",
      area: "identity.signIn",
      label: "Sync tier on sign-in",
      description:
        "Whether a sign-in may move a licence to the tier the identity provider reports. Upgrade-only never lowers a tier.",
      docs: "/docs/services/identity/oidc/",
      value: { kind: "enum", values: ["off", "upgradeOnly"] },
      defaultValue: "off",
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "product:oidc.syncTierOnSignIn" },
      critical: true,
      confirm: { change: "L1" },
      visibleWhen: VISIBLE,
      storage: { kind: "scalar" },
      pending: { wp: "LX-06" },
    }),
  ],
};
