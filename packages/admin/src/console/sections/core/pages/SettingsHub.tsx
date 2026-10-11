/**
 * The product settings hub (ST-08, S-18 §4.9 level 2): `#/p/<slug>/settings/<area>`. One `<h1>`
 * and one row of area tabs; each area is a Core page rendered under it, with its own header
 * demoted to an `<h2>` (`PageHeaderNested`).
 *
 * Areas: General (`settings`), Services (`settings/features`), Presentation, Keys & secrets,
 * Members and All settings. Keys & secrets answers to the `keys` area: a member without it does
 * not see the tab (the page itself is refused by the dispatcher). The tabs are route tabs, so the
 * area is in the URL and a phone scrolls the row inside its own region.
 */

import * as React from "react";
import { PageHeaderNested, PageHeader } from "../../../../ui/PageHeader.js";
import { PageTabs, type PageTab } from "../../../components/PageTabs.js";
import { useCan } from "../../../access/useCan.js";
import type { ProductPageId } from "../../../nav.js";
import { productPage } from "../../../routes.js";

/** The hub's areas in tab order; All settings words its destinations with these labels. */
export const SETTINGS_AREAS: { page: ProductPageId; label: string }[] = [
  { page: "settings", label: "General" },
  { page: "services", label: "Services" },
  { page: "presentation", label: "Presentation" },
  { page: "keys", label: "Keys & secrets" },
  { page: "settings-members", label: "Members" },
  { page: "settings-all", label: "All settings" },
];

export function SettingsHub({
  slug,
  page,
  children,
}: {
  slug: string;
  page: ProductPageId;
  children: React.ReactNode;
}): React.ReactElement {
  const canKeys = useCan("keys", slug);
  const tabs: PageTab[] = SETTINGS_AREAS.filter(
    (a) => a.page !== "keys" || canKeys,
  ).map((a) => ({
    value: a.page,
    label: a.label,
    to: productPage(slug, a.page),
  }));
  return (
    <div className="space-y-6" data-template="settings-hub">
      <PageHeader
        title="Settings"
        tabs={<PageTabs label="Settings areas" items={tabs} value={page} />}
      />
      <PageHeaderNested.Provider value>{children}</PageHeaderNested.Provider>
    </div>
  );
}
