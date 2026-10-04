/**
 * Audit action codes as verb phrases (docs/design/ADMIN.md §6.8): `license.disable` reads
 * "disabled license". The raw code still shows in the expanded row and is what the filters send.
 * An unknown code is humanised rather than shown raw.
 */

const VERBS: Record<string, string> = {
  "product.create": "created the product",
  "product.link": "linked the product to a repository",
  "product.update": "updated product settings",
  "product.delete": "deleted the product",
  "product.services.update": "changed enabled services",
  "product.services.revert": "returned services to the manifest",
  "product.policy.update": "changed the fingerprint policy",
  "product.fingerprint.revert":
    "returned the fingerprint policy to the manifest",
  "secret.set": "set secret",
  "secret.usage": "changed the usage of secret",
  "kek.reseal": "re-sealed secrets under the current platform key",
  "key.prepare": "prepared signing key",
  "key.activate": "activated signing key",
  "key.activate.break_glass": "activated signing key early (break-glass)",
  "key.retire": "retired signing key",
  "key.revoke": "revoked key",
  "key.create": "minted license key",
  "license.create": "created license",
  "license.update": "updated license",
  "license.tier.change": "changed the tier of license",
  "license.overrides": "changed config overrides of license",
  "license.enable": "enabled license",
  "license.disable": "disabled license",
  "license.enroll": "enrolled a keyless license",
  "device.deauthorize": "deauthorized device",
  "device.fingerprint.reset": "reset the hardware binding of device",
  "device.fingerprint.drift": "recorded a hardware change on device",
  "device.fingerprint.mismatch": "retired the hardware binding of device",
  "device.seat.coalesced": "merged a re-registered device into",
  "schema.publish": "published the catalog",
  "profile.create": "created profile",
  "profile.delete": "deleted profile",
  "profile.overrides": "changed the payload of profile",
  "tier.create": "created tier",
  "tier.update": "updated tier",
  "tier.delete": "deleted tier",
  "release.resync": "resynced from repo",
  "release.channel.floor": "changed a channel floor",
  "release.channel.update": "changed channel policy",
  "release.channel.revert": "returned a channel to the manifest",
  "release.yank": "yanked release",
  "release.unyank": "unyanked release",
  "release.publish": "published release",
  "release.record": "recorded release",
  "license.merge": "merged license",
  "license.tier": "changed the tier of license",
  "device.attest": "attested device",
  "device.attest.rejected": "rejected the attestation of device",
  "device.trust.refused": "refused an unattested request from device",
  "update.settings.revert": "returned update feed settings to the manifest",
  "update.settings.update": "changed update feed settings",
  "portal.settings.update": "changed customer portal settings",
  "bundle.minted": "minted an offline bundle",
  "access.denied": "was refused console access",
  "ci.publisher.claim": "claimed the trusted publisher",
  "ci.token.issue": "issued CI token",
  "ci.token.revoke": "revoked CI token",
  "outlet_credential.set": "set outlet credential",
  "outlet_credential.pin": "re-pinned outlet credential",
  "outlet_credential.delete": "deleted outlet credential",
  "outlet_credential.use": "used outlet credential",
  "config.mint.approve": "approved edge-mint recipe",
  "config.mint.revoke": "revoked the approval of edge-mint recipe",
  "config.mint.invalidate": "invalidated the approval of edge-mint recipe",
};

export function verbFor(action: string): string {
  const known = VERBS[action];
  if (known) return known;
  return action.replace(/[._]+/g, " ").trim();
}

/** The action filter's choices: one prefix per area, in the order operators look for them. */
export const ACTION_GROUPS: { value: string; label: string }[] = [
  { value: "license.", label: "Licenses" },
  { value: "key.", label: "Keys" },
  { value: "device.", label: "Devices" },
  { value: "secret.", label: "Secrets" },
  { value: "profile.", label: "Profiles" },
  { value: "tier.", label: "Tiers" },
  { value: "schema.", label: "Catalog" },
  { value: "config.", label: "Edge mint" },
  { value: "release.", label: "Release" },
  { value: "update.", label: "Update" },
  { value: "portal.", label: "Customer portal" },
  { value: "outlet_credential.", label: "Outlet credentials" },
  { value: "ci.", label: "CI publishing" },
  { value: "product.", label: "Product and services" },
  { value: "bundle.", label: "Offline bundles" },
  { value: "access.", label: "Access" },
];

/** The target kinds the filter offers (the audit's own `target_kind` values). */
export const TARGET_KINDS: { value: string; label: string }[] = [
  { value: "license", label: "License" },
  { value: "device", label: "Device" },
  { value: "key", label: "Key" },
  { value: "secret", label: "Secret" },
  { value: "profile", label: "Profile" },
  { value: "tier", label: "Tier" },
  { value: "product", label: "Product" },
  { value: "ci_token", label: "CI token" },
];
