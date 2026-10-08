/**
 * License → Settings (LX-06; S-19 §7.13, plans/LX-01.md §3.2): the product's licensing-model
 * settings, the registry's `license.licensing` area. Each is seeded by `.pkey/product`'s
 * `licensing:` block, a console edit claims it, and Revert returns it to the manifest (S-18 §4.5).
 *
 * The offline grace clamp is in effect (LX-07). The behaviour behind the other settings ships in
 * later packages (LX-09, LX-10, LX-12), so the page says that those take effect as each part of
 * the licensing model arrives. The billing-retry grace stays hidden until LX-23 (the registry
 * marks it pending).
 */

import * as React from "react";
import {
  ProductSettingsSection,
  type SettingCopy,
} from "../../components/ProductSettingsSection.js";
import { PageHeader } from "../../../ui/PageHeader.js";
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
        Clamping offline grace to expiry applies to devices at their next
        licence refresh. The other settings take effect as each part of the
        licensing model ships; until then devices keep today&apos;s behaviour.
      </Callout>
      <ProductSettingsSection
        slug={slug}
        area="license.licensing"
        id={SECTION}
        title="Licensing model"
        copy={LICENSING_COPY}
      />
    </SettingsTemplate>
  );
}
