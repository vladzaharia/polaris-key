/**
 * License → Settings (LX-06; S-19 §7.13, plans/LX-01.md §3.2): the product's licensing-model
 * settings, the registry's `license.licensing` area. Each is seeded by `.pkey/product`'s
 * `licensing:` block, a console edit claims it, and Revert returns it to the manifest (S-18 §4.5).
 *
 * The offline grace clamp is in effect (LX-07). The behaviour behind the other settings ships in
 * later packages (LX-09, LX-10, LX-12), so those rows are pending (P0-47): grouped under "Not in
 * effect yet" after the clamp, read-only, each saying what devices do today, their stored value
 * kept for when it ships. The billing-retry grace stays hidden until LX-23 (the registry marks it
 * pending).
 */

import * as React from "react";
import {
  ProductSettingsSection,
  type SettingCopy,
} from "../../components/ProductSettingsSection.js";
import { PageHeader } from "../../components/PageHeader.js";
import { SettingsTemplate } from "../../templates/Settings.js";
import { Callout } from "../../../ui/Callout.js";

const SECTION = "license-settings-licensing";

/** Value labels and confirmation copy per setting (S-19 §7.3–7.6, decision 4's warning). */
export const LICENSING_COPY: Record<string, SettingCopy> = {
  "licensing.entitlementModel": {
    values: { legacy: "Legacy (per license)", combined: "Combined" },
    consequences: (to) =>
      to === "combined"
        ? [
            "A device sees everything its holder has for this product, combined, not just its own license's entitlements.",
            "Devices pick up the change at their next license refresh.",
          ]
        : [
            "Each device sees only its own license's entitlements again, as before the combined model.",
          ],
  },
  "licensing.entitlementHolder": {
    values: { device: "Signed-in account", owner: "License owner" },
    consequences: (to) =>
      to === "owner"
        ? [
            "Anyone who enters a key the owner holds sees everything the owner holds for this product, not just that license.",
            "Keep this for products without sign-in, where a shared key is how a household or studio shares access.",
          ]
        : [
            "A device sees the entitlements of the account signed in on it, or only its license's when nobody is signed in.",
          ],
  },
  "licensing.clampGraceToExpiry": {
    consequences: (to) =>
      to === false
        ? [
            "A license that expires can keep running offline until its offline grace ends.",
          ]
        : ["Offline grace never outlasts the license's expiry."],
  },
  "licensing.anchorPolicy": {
    values: {
      "rank-first": "Highest-ranked tier",
      "most-free-seats": "Most free seats",
      oldest: "Oldest license",
    },
    consequences: () => [
      "Applies when a device next chooses the license it runs on.",
    ],
  },
  "licensing.reanchor": {
    values: { never: "Never", onActivation: "On activation" },
  },
  "licensing.refundGraceHours": {
    consequences: () => [
      "A refund or chargeback still revokes the grant; this only delays it.",
    ],
  },
};

/**
 * The settings stored and resynced today that change nothing yet (P0-47), each with what devices
 * do today whatever it is set to. Only the offline grace clamp is in effect.
 *
 * - The model and the holder (LX-09): `entitlementModelFor` (`passthrough/anchor.ts`) answers
 *   `legacy` for every product, so a device's documents carry only its own license's entitlements.
 * - The anchor choice and re-anchor (LX-10): no `chooseAnchor` yet. A device runs on the license it
 *   activated with (its key, or the one chosen at sign-in, `identity/licenseChoice.ts`), and
 *   nothing moves it to another.
 * - The refund grace (LX-12): `applyStoreGrant`'s `revoke` (`license/storeGrants.ts`) revokes
 *   the grant the moment the refund arrives.
 */
export const LICENSING_PENDING: Record<string, string> = {
  "licensing.entitlementModel":
    "Today each device sees only its own license's entitlements.",
  "licensing.entitlementHolder":
    "Today each device sees only its own license's entitlements, whoever is signed in.",
  "licensing.anchorPolicy":
    "Today a device runs on the license it was activated with.",
  "licensing.reanchor":
    "Today a device never moves to another license on its own.",
  "licensing.refundGraceHours": "Today a refund takes effect at once.",
};

export function LicenseSettingsPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  return (
    <SettingsTemplate
      header={
        <PageHeader
          title="Settings"
          description={
            <>
              How licenses and their entitlements combine for this product.
              Declared in{" "}
              <code className="font-mono text-xs">.pkey/product</code> under{" "}
              <code className="font-mono text-xs">licensing</code>; a change
              here claims the setting until you revert it.
            </>
          }
        />
      }
      sections={[{ id: SECTION, title: "Licensing model" }]}
    >
      <Callout tone="info">
        Only clamping offline grace to expiry is in effect. Devices pick up a
        change to it at their next license refresh.
      </Callout>
      <ProductSettingsSection
        slug={slug}
        area="license.licensing"
        id={SECTION}
        title="Licensing model"
        copy={LICENSING_COPY}
        pending={LICENSING_PENDING}
        pendingDescription="These keep their value but change nothing until their part of the licensing model ships."
      />
    </SettingsTemplate>
  );
}
