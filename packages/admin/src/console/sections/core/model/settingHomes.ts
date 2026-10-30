/**
 * Where an operator changes each product setting: the table behind Settings → All settings (ST-08).
 *
 * One entry per registry key, never per area. An area's keys are often edited on different pages:
 * License's `license.policy` has its two defaults on General and its fingerprint mode on
 * Enrollment, and the release block's repository is linked on General while its binary name has
 * no console editor at all. A row never links to a page that has no control for its key.
 *
 * Three kinds of home:
 *
 * - `page`: a console control writes the value (or, for `licensing.*`, the registry's own row
 *   for it sits on that page). `section` names the part of a page that holds several editors;
 *   the console router owns the hash, so a link goes to the page, not the section.
 * - `manifest`: no console control. The value is declared in a `.pkey/` file of the product's
 *   repository and applied by a resync, so the row names that file and links nowhere.
 * - `api`: no console control and no manifest spelling: an operator-owned value that only the
 *   admin API writes.
 *
 * `test/settingHomes.test.ts` fails when a key the table can show has no entry here, when an
 * entry names a key the registry does not have, and when a kind contradicts the key's owner.
 */

import type { ProductPageId } from "../../../nav.js";

/** The `.pkey/` files a manifest-declared setting can live in (the registry's `manifest.path`). */
export type ManifestFile = "product" | "release" | "distribution";

export type SettingHome =
  | {
      kind: "page";
      page: ProductPageId;
      /** A record under the page (a storefront's own page), when the editor is on one. */
      id?: string;
      /** The section of the page that holds the control, when the page holds several. */
      section?: string;
    }
  | { kind: "manifest"; file: ManifestFile }
  | { kind: "api" };

/**
 * The element a section label scrolls to on its page (`?setting=<key>` lands there when the page draws no row). A label with
 * no entry lands on the page.
 */
const ANCHORS: Readonly<Record<string, string>> = {
  "settings|General": "settings-general",
  "settings|License defaults": "settings-license",
  "settings|Web origins": "settings-origins",
  "settings|Repository": "settings-repository",
  "settings|Alerts": "settings-alerts",
  "settings|Email": "settings-mail",
  "settings|Deltas": "settings-deltas",
  "keys|Signing keys": "keys-signing",
  "keys|Secrets": "keys-secrets",
  "keys|CI publishing": "keys-ci",
  "keys|Device trust": "keys-trust",
  "portal|Polaris Locker": "portal-switches",
  "presentation|Hosting and quotas": "presentation-hosting",
  "sync-setup|Product limits": "sync-limits",
  "connect-setup|Relay": "connect-relay",
};

/** The element id a home's section lands on, if the page has one for it. */
export function anchorOf(home: {
  page: ProductPageId;
  section?: string;
}): string | null {
  return ANCHORS[`${home.page}|${home.section ?? ""}`] ?? null;
}

/** The element id of the section a key's home lands on, when its page has one. */
export function anchorOfKey(key: string): string | null {
  const home = SETTING_HOMES[key];
  return home?.kind === "page" ? anchorOf(home) : null;
}

const at = (
  page: ProductPageId,
  section?: string,
  id?: string,
): SettingHome => ({
  kind: "page",
  page,
  ...(id ? { id } : {}),
  ...(section ? { section } : {}),
});
const manifest = (file: ManifestFile): SettingHome => ({
  kind: "manifest",
  file,
});
const API: SettingHome = { kind: "api" };

/** The Polaris Key storefront's own page: the built-in store `polaris-key` (PS-06). */
const POLARIS_KEY = "polaris-key";

export const SETTING_HOMES: Readonly<Record<string, SettingHome>> = {
  // ── Core ───────────────────────────────────────────────────────────────────────────────────
  "core.name": at("settings", "General"),
  // Shown on General as a read-out marked Not enforced; there is no input (P0-47). The manifest
  // field is retired (ST-32.6), so the value is read-only and no `.pkey/` file declares it.
  "core.adminGroup": at("settings", "General"),
  "core.web.origins": at("settings", "Web origins"),
  "core.manifest.authoritative": at("settings", "Repository"),
  // ST-27: this product's alert destinations, which replace the platform's.
  "core.alerts.destinations": at("settings", "Alerts"),
  // The icon and accents are declared in `.pkey/product`; Presentation uploads hosted files
  // (other keys), and nothing in the console reads the accents.
  "core.presentation": manifest("product"),
  // ST-12: Keys and secrets → Device trust (view-only members see it locked).
  "core.trustPolicy": at("keys", "Device trust"),
  // The wizards' saved choices (ST-39): written by their own steps, never a settings control.
  "core.setup": API,
  "core.services": at("services", "Enabled features"),
  "core.keys": at("keys", "Signing keys"),
  // The manifest names the secrets and the console sets each value, sealed.
  "core.secrets": at("keys", "Secrets"),
  // ST-11: registry rows; Settings → Features → General has their editors (ST-08n).
  "deltas.lazy.enabled": at("settings", "Deltas"),
  "deltas.lazy.hotDevices": at("settings", "Deltas"),
  "deltas.lazy.dailyCap": at("settings", "Deltas"),
  "email.dailyCap": at("settings", "Email"),
  // ST-14: the Customer portal area (Settings → Polaris Locker).
  "portal.enabled": at("portal", "Polaris Locker"),
  "portal.keyReissue": at("portal", "Polaris Locker"),
  "assets.releases.mirror": at("presentation", "Hosting and quotas"),
  "assets.quota.mediaBytes": at("presentation", "Hosting and quotas"),
  "assets.quota.releaseBytes": at("presentation", "Hosting and quotas"),
  "storefront.polarisKey.listed": at(
    "storefronts",
    "Polaris Locker → Listing",
    POLARIS_KEY,
  ),
  "storefront.polarisKey.audience": at(
    "storefronts",
    "Polaris Locker → Listing",
    POLARIS_KEY,
  ),
  "storefront.polarisKey.offerPaths": at(
    "storefronts",
    "Polaris Locker → Ways to add",
    POLARIS_KEY,
  ),
  "storefront.polarisKey.groupLabels": at(
    "storefronts",
    "Polaris Locker → Group labels",
    POLARIS_KEY,
  ),

  // ── License ────────────────────────────────────────────────────────────────────────────────
  // The two defaults are product columns written from General (`updateProduct`), not rows of
  // License → Settings.
  "license.defaults.deviceLimit": at("settings", "License defaults"),
  "license.defaults.maxOfflineDays": at("settings", "License defaults"),
  // The mode is edited on Enrollment; its probes come from the manifest.
  "license.fingerprint": at("enrollment", "Fingerprint policy"),
  // Enrollment has no auto-issue control (P0-47): the `autoIssue` block is the edit path.
  "license.autoIssue": manifest("product"),
  "license.tiers": at("tiers"),
  // The settings-engine rows of License → Settings. Only `clampGraceToExpiry` takes effect and
  // is editable; the other five sit under "Not in effect yet" until their behaviour ships.
  "licensing.entitlementModel": at("license-settings"),
  "licensing.entitlementHolder": at("license-settings"),
  "licensing.clampGraceToExpiry": at("license-settings"),
  "licensing.anchorPolicy": at("license-settings"),
  "licensing.reanchor": at("license-settings"),
  "licensing.refundGraceHours": at("license-settings"),

  // ── Config ─────────────────────────────────────────────────────────────────────────────────
  "config.catalog": at("catalog-edit"),
  "config.profiles": at("profiles"),
  // Edge mint only approves or revokes recipes the manifest declares.
  "config.edgeMint.recipes": manifest("product"),

  // ── Release ────────────────────────────────────────────────────────────────────────────────
  // Linking a repository is the console's only write of it, and only from the unlinked state.
  "release.github": at("settings", "Repository"),
  "release.binaryName": manifest("release"),
  "release.summaryMarker": manifest("release"),
  // Not Update → Feed's "Artifact policy", which edits `update.operatorPolicy`.
  "release.artifactPolicy": manifest("release"),
  "release.channelWorkflow": manifest("release"),
  "release.betaBranch": manifest("release"),
  "release.manualChannels": manifest("release"),
  // The compatibility matrix on Release → Compatibility only reads the window.
  "release.compatWindow": at("feed", "Compatibility window"),
  "release.deliverables": manifest("release"),
  "release.channelPolicy": at("channels"),
  // Lower or clear only, from the lane's rollback floor.
  "release.channelFloors": at("channels"),
  // Pick the pack in the Deliverable selector: its lane holds the floors per content API line.
  "release.packFloors": at("channels"),
  "release.packages.prunePrereleases": API,
  "release.publishing.trustedPublisher": at("keys", "CI publishing"),
  "release.keys": manifest("release"),
  "release.sparkleEd25519Pub": manifest("release"),

  // ── Update ─────────────────────────────────────────────────────────────────────────────────
  "update.metadataAccess": at("feed", "Metadata access"),
  "update.operatorPolicy": at("feed", "Artifact policy"),

  // ── Distribution ───────────────────────────────────────────────────────────────────────────
  "distribution.access": at("access"),
  "distribution.feeds": at("package-feeds"),
  "distribution.packageFeeds": at("package-feeds"),
  // Operator-owned and written by the Worker's commerce routes; the Commerce page only drives
  // App Store Connect.
  "commerce.stores": API,
  // Narrow-only, in the drawer of each channel on the page.
  "distribution.capabilities": at("outlets"),
  // Answered at create (ST-42); the storefronts page's platform chips take it over (UX-53).
  "distribution.intendedPlatforms": API,
  "distribution.outlets": manifest("distribution"),
  "distribution.transports": manifest("distribution"),

  // ── Identity ───────────────────────────────────────────────────────────────────────────────
  // Operator-owned (PX-W13c): platform admins only; the others see it read-only.
  "identity.displayNameApproved": at("app-sign-in", "Presentation"),
  "identity.keyEntry.limit": manifest("product"),
  // App sign-in, License keys.
  "identity.keyEntry.claimByKey": at("portal", "Polaris Locker"),
  "identity.terms": manifest("product"),
  // The paths a web app's sign-in may return to (I-08's `authorize` reads them).
  "identity.redirectPaths": manifest("product"),
  // Sign-in reads the provider and the group map; the page's one action is a resync.
  // App sign-in, Platform sign-in (the Google and Apple audiences and the nearby switch).
  "identity.platformSignIn.google.serverClientId": at(
    "app-sign-in",
    "Platform sign-in",
  ),
  "identity.platformSignIn.google.clientIds": at(
    "app-sign-in",
    "Platform sign-in",
  ),
  "identity.platformSignIn.apple.teamId": at("app-sign-in", "Platform sign-in"),
  "identity.platformSignIn.apple.bundleIds": at(
    "app-sign-in",
    "Platform sign-in",
  ),
  "identity.nearby": at("app-sign-in", "Platform sign-in"),
  "identity.oidc": manifest("product"),
  "identity.provisioning": manifest("product"),
  "identity.oidc.syncTierOnSignIn": at("app-sign-in", "Tier sync"),

  // ── Cloud Sync ─────────────────────────────────────────────────────────────────────────────
  // U-05.20: Cloud Sync → Setup → Product limits (the meter and its Change dialog).
  "cloudSync.ceiling.bytes": at("sync-setup", "Product limits"),

  // ── Cloud Connect ──────────────────────────────────────────────────────────────────────────
  // CC-16: Cloud Connect → Setup. The relay switch has its control (the manifest's `connect.relay`
  // is its default); the monthly ceiling has a Change… dialog (members with Cloud Connect edit).
  "cloudConnect.relay.enabled": at("connect-setup", "Relay"),
  "cloudConnect.ceiling.relayBytes": at("connect-setup", "Relay"),
};

/**
 * Settings the console does not offer yet: not in All settings, search or the palette. The key and
 * its server handling stay. `portal.keyReissue` waits for G7: the Locker never reads
 * `canGetNewKey` or calls the reissue endpoint, so the switch would promise what it cannot do.
 */
export const HIDDEN_SETTINGS: ReadonlySet<string> = new Set([
  "portal.keyReissue",
]);
