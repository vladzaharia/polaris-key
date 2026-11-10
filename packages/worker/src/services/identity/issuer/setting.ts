import { setting } from "../../../core/settings/define.js";
import type { SettingDef } from "../../../core/settings/types.js";

/**
 * `identity.issuer.enabled` (I-21.4; V5 §12.13): whether the product is an OpenID provider for
 * its registered clients. Off unless the developer turns it on. Turning it on widens who can
 * receive the product's people, so it is security-widening and critical. Its reader is
 * `issuer/served.ts`: every issuer route answers the registry's 404 while it is off.
 */
export const IDENTITY_ISSUER_SETTING = "identity.issuer.enabled";
export const IDENTITY_ISSUER: SettingDef = setting({
  key: IDENTITY_ISSUER_SETTING,
  rbacArea: "keys",
  scope: "product",
  service: "identity",
  area: "identity.platformSignIn",
  label: "Sign in with this product",
  description:
    "Lets websites and apps you register sign people in with this product (OpenID Connect). Registering a client needs it on.",
  keywords: ["openid", "oidc", "sign in with", "clients", "issuer"],
  docs: "/docs/features/sign-in/",
  value: { kind: "boolean" },
  defaultValue: false,
  merge: "cascade",
  ownership: "claimable",
  manifest: { path: "product:identity.issuer.enabled" },
  securityWidening: true,
  widensWhen: "on",
  critical: true,
  confirm: { on: "L1", off: "L1" },
  visibleWhen: { service: "identity", offBehaviour: "hide" },
  storage: { kind: "scalar" },
  readers: ["services/identity/issuer/served.ts"],
  since: "I-21.4",
});
