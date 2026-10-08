/**
 * License → Settings (LX-06; S-19 §7.13, plans/LX-01.md §3.2): the product's licensing-model
 * settings, the registry's `license.licensing` area. Each is seeded by `.pkey/product`'s
 * `licensing:` block, a console edit claims it, and Revert returns it to the manifest (S-18 §4.5).
 *
 * The offline grace clamp is in effect (LX-07). The behaviour behind the other settings ships in
 * later packages (LX-09, LX-10, LX-12), so those rows are marked pending (P0-47): read-only,
 * labelled "Not in effect yet", their stored value kept for when it ships. The billing-retry grace
 * stays hidden until LX-23 (the registry marks it pending).
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
    values: { legacy: "Legacy (per licence)", combined: "Combined" },
    consequences: (to) =>
      to === "combined"
        ? [
            "A device sees the entitlements of every licence and grant its holder has, combined, not just its own licence's.",
            "Devices pick up the change at their next licence refresh.",
          ]
        : [
            "Each device sees only its own licence's entitlements again, as before the combined model.",
          ],
  },
  "licensing.entitlementHolder": {
    values: { device: "Signed-in account", owner: "Licence owner" },
    consequences: (to) =>
      to === "owner"
        ? [
            "Anyone who enters a key the owner holds sees everything the owner holds for this product, not just that licence.",
            "Keep this for products without sign-in, where a shared key is how a household or studio shares access.",
          ]
        : [
            "A device sees the entitlements of the account signed in on it, or only its licence's when nobody is signed in.",
          ],
  },
  "licensing.clampGraceToExpiry": {
    consequences: (to) =>
      to === false
        ? [
            "A licence that expires can keep running offline until its offline grace ends.",
          ]
        : ["Offline grace never outlasts the licence's expiry."],
  },
  "licensing.anchorPolicy": {
    values: {
      "rank-first": "Highest-ranked tier",
      "most-free-seats": "Most free seats",
      oldest: "Oldest licence",
    },
    consequences: () => [
      "Applies when a device next chooses the licence it runs on.",
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

/** What devices do while a setting's behaviour has not shipped. */
const NOT_YET = "Devices keep today's behaviour whatever it is set to.";

/**
 * The settings stored and resynced today that change nothing yet (P0-47): the entitlement model
 * and holder (LX-09), the anchor choice and re-anchor (LX-10), the refund grace (LX-12). Only the
 * offline grace clamp is in effect.
 */
export const LICENSING_PENDING: Record<string, string> = {
  "licensing.entitlementModel": NOT_YET,
  "licensing.entitlementHolder": NOT_YET,
  "licensing.anchorPolicy": NOT_YET,
  "licensing.reanchor": NOT_YET,
  "licensing.refundGraceHours": NOT_YET,
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
              How licences, grants and entitlements combine for this product.
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
        Only clamping offline grace to expiry is in effect, at each
        device&apos;s next licence refresh. The settings marked Not in effect
        yet keep their value but change nothing until their part of the
        licensing model ships.
      </Callout>
      <ProductSettingsSection
        slug={slug}
        area="license.licensing"
        id={SECTION}
        title="Licensing model"
        copy={LICENSING_COPY}
        pending={LICENSING_PENDING}
      />
    </SettingsTemplate>
  );
}
