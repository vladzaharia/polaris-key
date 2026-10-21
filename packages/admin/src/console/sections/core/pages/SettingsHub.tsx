/**
 * The product settings hub (ST-08, S-18 §4.9 level 2), after products.features: a masthead (the
 * product's icon, the one `<h1>`, History) over four route tabs (Features, Presentation, Keys &
 * secrets, Members). Each tab is a Core page rendered under it with no header of its own.
 *
 * `#/p/<slug>/settings` (the product's own settings) is Features with its last row unfolded.
 * All settings is a link in the header, not a tab. Keys & secrets answers to the `keys` area: a
 * member without it does not see the tab (the page itself is refused by the dispatcher). The tabs
 * are route tabs, so the area is in the URL and a phone scrolls the row inside its own region.
 */

import * as React from "react";
import { History, ListTree } from "lucide-react";
import { PageHeaderNested } from "../../../../ui/PageHeader.js";
import { Button } from "../../../../ui/Button.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { Callout } from "../../../../ui/Callout.js";
import { WriteLock } from "../../../../ui/WriteLock.js";
import { PageTabs, type PageTab } from "../../../components/PageTabs.js";
import {
  useAccessAdmins,
  useCan,
  useWriteGate,
} from "../../../access/useCan.js";
import { useProduct } from "../../../data/hooks.js";
import type { ProductPageId } from "../../../nav.js";
import { Link } from "../../../router.js";
import { useSettingTarget } from "../../../useSettingTarget.js";
import { anchorOfKey } from "../model/settingHomes.js";
import { productPage, r } from "../../../routes.js";

/**
 * The hub's tabs in order; All settings words its destinations with these labels. `settings`
 * (the product's own settings) lives on the Features tab, so it has no tab of its own.
 */
export const SETTINGS_AREAS: { page: ProductPageId; label: string }[] = [
  { page: "services", label: "Features & general" },
  { page: "presentation", label: "Presentation" },
  { page: "portal", label: "Polaris Locker" },
  { page: "keys", label: "Keys & secrets" },
  { page: "settings-members", label: "Members" },
];

/** The tab a hub page sits under: the product's own settings are on Features. */
const TAB_OF: Partial<Record<ProductPageId, ProductPageId>> = {
  settings: "services",
};

/**
 * Land on the row an All settings link names (`?at=<element id>`): wait for it to render, scroll
 * to it and focus it. Each target is taken once, so the reader scrolls on from there.
 */
export function SettingsHub({
  slug,
  page,
  children,
}: {
  slug: string;
  page: ProductPageId;
  children: React.ReactNode;
}): React.ReactElement {
  useSettingTarget(true, undefined, anchorOfKey);
  // The access is named by the tab's words, never the area's internal name ("Core").
  const gate = useWriteGate(
    page === "keys" ? "keys" : "core",
    slug,
    page === "keys" ? "Keys & secrets" : "Settings",
  );
  // One notice per page, on every tab that has something to edit. Features gates its own
  // switches; the other tabs lock whole.
  const viewOnly =
    !gate.allowed &&
    gate.canView &&
    page !== "settings-all" &&
    page !== "settings-members";
  const lock = viewOnly && page !== "services";
  const canKeys = useCan("keys", slug);
  const product = useProduct(slug);
  const admins = useAccessAdmins("core", slug);
  const name = product.data?.name ?? slug;
  const tabs: PageTab[] = SETTINGS_AREAS.filter(
    (a) => a.page !== "keys" || canKeys,
  ).map((a) => ({
    value: a.page,
    label: a.label,
    to: productPage(slug, a.page),
    count:
      a.page === "settings-members" && admins.data?.admins
        ? admins.data.admins.filter((m) => m.role !== "superadmin").length
        : undefined,
  }));
  return (
    <div className="space-y-6" data-template="settings-hub">
      <header className="space-y-3">
        <nav aria-label="Breadcrumb" className="text-sm text-fg-muted">
          <Link
            to={r.overview(slug)}
            className="rounded-xs underline-offset-4 hover:underline"
          >
            {name}
          </Link>
        </nav>
        <div className="flex items-center gap-4">
          <ProductLogo
            name={name}
            presentation={product.data?.presentation}
            size={48}
            className="max-sm:hidden"
          />
          <h1
            tabIndex={-1}
            data-page-title=""
            className="text-2xl font-medium tracking-tight text-fg-strong outline-hidden forced-colors:outline-none sm:text-4xl"
          >
            Settings
          </h1>
          <div className="ms-auto flex items-center gap-1">
            <Button asChild variant="ghost" size="sm">
              <Link
                to={productPage(slug, "settings-all")}
                aria-label="All settings"
              >
                <ListTree aria-hidden />
                <span className="max-sm:sr-only">All settings</span>
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm" className="max-sm:hidden">
              <Link to={r.activity(slug)}>
                <History aria-hidden />
                History
              </Link>
            </Button>
          </div>
        </div>
        <div className="border-b border-border">
          <PageTabs
            label="Settings"
            items={tabs}
            value={TAB_OF[page] ?? (page === "settings-all" ? "" : page)}
          />
        </div>
      </header>
      {viewOnly && gate.disabledReason ? (
        <Callout tone="info" title="You can view these settings">
          {gate.disabledReason}
        </Callout>
      ) : null}
      <WriteLock locked={lock} reason={gate.disabledReason}>
        <PageHeaderNested.Provider value>{children}</PageHeaderNested.Provider>
      </WriteLock>
    </div>
  );
}
