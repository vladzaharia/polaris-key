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
  // Shown on General as a read-out marked Not enforced; there is no input (P0-47).
  "core.adminGroup": manifest("product"),
  "core.web.origins": at("settings", "Web origins"),
  "core.manifest.authoritative": at("settings", "Repository"),
  // ST-27: this product's alert destinations, which replace the platform's.
  "core.alerts.destinations": at("settings", "Alerts"),
  // The icon and accents are declared in `.pkey/product`; Presentation uploads hosted files
  // (other keys), and nothing in the console reads the accents.
  "core.presentation": manifest("product"),
  // `PUT …/trust-policy` exists in the Worker; no console page calls it.
  "core.trustPolicy": API,
  // The wizards' saved choices (ST-39): written by their own steps, never a settings control.
  "core.setup": API,
  "core.services": at("services", "Enabled services"),
  "core.keys": at("keys", "Signing keys"),
  // The manifest names the secrets and the console sets each value, sealed.
  "core.secrets": at("keys", "Secrets"),
  // ST-11: moved out of SQL into registry rows; the settings route writes them, no page has a
  // control yet (follow-up: a Settings editor).
  "deltas.lazy.enabled": API,
  "deltas.lazy.hotDevices": API,
  "deltas.lazy.dailyCap": API,
  "email.dailyCap": API,
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
  "identity.keyEntry.limit": manifest("product"),
  // Sign-in shows it read-only and links to Locker, where the switch is.
  "identity.keyEntry.claimByKey": at("portal", "License keys"),
  "identity.terms": manifest("product"),
  // The paths a web app's sign-in may return to (I-08's `authorize` reads them).
  "identity.redirectPaths": manifest("product"),
  // Sign-in reads the provider and the group map; the page's one action is a resync.
  "identity.oidc": manifest("product"),
  "identity.provisioning": manifest("product"),
  "identity.oidc.syncTierOnSignIn": at("sign-in", "Tier sync"),
};
