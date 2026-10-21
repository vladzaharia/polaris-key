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
import { History, ListTree, Lock } from "lucide-react";
import { PageHeaderNested } from "../../../../ui/PageHeader.js";
import { Button } from "../../../../ui/Button.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { PageTabs, type PageTab } from "../../../components/PageTabs.js";
import {
  useAccessAdmins,
  useCan,
  useWriteGate,
} from "../../../access/useCan.js";
import { useProduct } from "../../../data/hooks.js";
import type { ProductPageId } from "../../../nav.js";
import { codecs, Link, useSearchParam } from "../../../router.js";
import { productPage, r } from "../../../routes.js";

/**
 * The hub's tabs in order; All settings words its destinations with these labels. `settings`
 * (the product's own settings) lives on the Features tab, so it has no tab of its own.
 */
export const SETTINGS_AREAS: { page: ProductPageId; label: string }[] = [
  { page: "services", label: "Features" },
  { page: "presentation", label: "Presentation" },
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
const AT = codecs.string();

function useLandOn(): void {
  const [at] = useSearchParam("at", AT);
  React.useEffect(() => {
    if (!at) return;
    let done = false;
    const land = (): boolean => {
      const el = document.getElementById(at);
      if (!el) return false;
      done = true;
      el.scrollIntoView({ block: "start" });
      el.focus({ preventScroll: true });
      return true;
    };
    const first = window.setTimeout(land, 50);
    const obs = new MutationObserver(() => {
      if (!done && land()) obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const stop = window.setTimeout(() => obs.disconnect(), 5000);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(stop);
      obs.disconnect();
    };
  }, [at]);
}

export function SettingsHub({
  slug,
  page,
  children,
}: {
  slug: string;
  page: ProductPageId;
  children: React.ReactNode;
}): React.ReactElement {
  useLandOn();
  const gate = useWriteGate(page === "keys" ? "keys" : "core", slug);
  // Features gates its own switches and says why; the other tabs lock whole under one note.
  const lock =
    !gate.allowed &&
    gate.canView &&
    page !== "services" &&
    page !== "settings-all" &&
    page !== "settings-members";
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
            className="text-2xl font-medium tracking-tight text-fg-strong outline-hidden sm:text-4xl"
          >
            Settings
          </h1>
          <div className="ml-auto flex items-center gap-1">
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
      {lock && gate.disabledReason ? (
        <p
          role="note"
          className="flex items-center gap-2 text-sm text-fg-muted"
        >
          <Lock aria-hidden className="size-4 shrink-0" />
          {gate.disabledReason}
        </p>
      ) : null}
      <fieldset
        disabled={lock}
        className="m-0 min-w-0 space-y-6 border-0 p-0 [&:disabled_label:has(input:disabled)]:cursor-not-allowed [&:disabled_label:has(input:disabled)]:opacity-50"
      >
        <PageHeaderNested.Provider value>{children}</PageHeaderNested.Provider>
      </fieldset>
    </div>
  );
}
