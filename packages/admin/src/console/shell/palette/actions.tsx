import * as React from "react";
import { docsUrl } from "../../../lib/docsLinks.js";
import {
  BookOpen,
  Code2,
  KeyRound,
  Package,
  Plus,
  ToggleRight,
  Trash2,
} from "lucide-react";
import type { ServiceSlug } from "../../../api.js";
import { useTheme } from "../../../components/theme.js";
import {
  SERVICE_REQUIRES,
  SERVICE_TABLE,
} from "../../../services.generated.js";
import { docsFor, navItems, SECTIONS, type ServiceState } from "../../nav.js";
import { navigate } from "../../router.js";
import { r } from "../../routes.js";
import { DeleteProductDialog } from "../../components/DeleteProductDialog.js";
import { filterItems } from "./rank.js";
import { THEME_OPTIONS } from "../ThemeMenu.js";
import { SDK_QUICK_START_ID } from "../../sections/core/model/sdkQuickStart.js";
import { focusWhenReady } from "./focus.js";
import type {
  PaletteContext,
  PaletteItem,
  PaletteRunApi,
  PaletteSource,
} from "./types.js";

/**
 * The DOM id of the control that turns `service` on. Update has its own switch inside Ship builds,
 * but it is disabled until Distribution is on and a disabled switch cannot take focus: until then
 * the control is Ship builds' own switch, which turns Release, Distribution and Update on together.
 */
export const serviceSwitchId = (
  service: ServiceSlug,
  services: NonNullable<ServiceState>,
): string => {
  if (service === "update" && missingChain(service, services).length === 0)
    return "feature-ship-builds-in-app-updates";
  const feature =
    service === "release" || service === "distribution" || service === "update"
      ? "ship-builds"
      : service === "license"
        ? "licensing"
        : service === "config"
          ? "managed-config"
          : service === "identity"
            ? "sign-in"
            : "cloud-sync";
  return `feature-${feature}-switch`;
};

const label = (s: ServiceSlug): string =>
  SERVICE_TABLE.find((row) => row.slug === s)?.label ?? s;

/**
 * Every service `service` needs, directly or through another, that is off now, nearest first.
 * Turning on Update with nothing on needs Distribution, which needs Release.
 */
export function missingChain(
  service: ServiceSlug,
  services: NonNullable<ServiceState>,
): ServiceSlug[] {
  const out: ServiceSlug[] = [];
  const visit = (s: ServiceSlug): void => {
    for (const need of SERVICE_REQUIRES[s]) {
      if (services[need]?.enabled === true || out.includes(need)) continue;
      out.push(need);
      visit(need);
    }
  };
  visit(service);
  return out;
}

/** "Release", "Distribution and Release", "A, B and C". */
function listOf(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * "Turn on <Service>" for each service the product does not run (EXPERIENCE.md §0.3 J-1: with
 * Release off, "release" returns Turn on Release). The keywords carry the service's page names,
 * so "rollouts" finds Turn on Distribution. Nothing is offered while enablement loads: the palette
 * cannot yet know what is off. The row opens the Services page with that switch focused; the
 * detail names what else the switch needs, which the page's coherence line then offers to fix.
 */
export function turnOnActions(
  slug: string | null,
  services: ServiceState,
): PaletteItem[] {
  if (!slug || services === null) return [];
  return SERVICE_TABLE.filter(
    (row) => services[row.slug]?.enabled !== true,
  ).map((row) => {
    const section = SECTIONS.find((s) => s.service === row.slug);
    const pages = section ? navItems(section).map((p) => p.label) : [];
    const needs = missingChain(row.slug, services).map(label);
    return {
      id: `action:turn-on:${row.slug}`,
      group: "Actions",
      label: `Turn on ${row.label}`,
      detail: needs.length ? `Needs ${listOf(needs)}` : "Services",
      keywords: `${row.slug} ${pages.join(" ")} enable service`,
      icon: <ToggleRight aria-hidden className="size-4" />,
      matchOnly: true,
      perform: (api) => {
        api.navigate(r.services(slug));
        focusWhenReady(serviceSwitchId(row.slug, services));
      },
    };
  });
}

/** Actions that create something in the product on screen, finishing over the current page. */
export function createActions(
  slug: string | null,
  services: ServiceState,
): PaletteItem[] {
  const items: PaletteItem[] = [
    {
      id: "action:create-product",
      group: "Actions",
      label: "New product",
      detail: "Products",
      keywords: "create add product",
      icon: <Plus aria-hidden className="size-4" />,
      href: r.productNew(),
    },
  ];
  if (slug && services?.license?.enabled === true) {
    items.unshift({
      id: "action:create-license",
      group: "Actions",
      label: "New license…",
      detail: "License",
      keywords: "new issue add license key holder",
      icon: <Plus aria-hidden className="size-4" />,
      // The wizard is a drawer of the Licenses page, so the URL carries it (LX-29).
      perform: (api) => api.navigate(r.newLicense(slug)),
    });
  }
  return items;
}

/** Rows of "Delete product" offered across products at most (Home, a typed query). */
export const DELETE_ACROSS_MAX = 3;

/**
 * "Delete product…": opens the console's one delete dialog (type the slug) over the page. On a
 * product it is the one on screen; from Home, with a query, any of the operator's products.
 * Typed only. The system product is never offered (it is not in `products`).
 */
export function deleteProductActions(
  ctx: Pick<PaletteContext, "slug" | "productName" | "products">,
  query: string,
): PaletteItem[] {
  const targets: { slug: string; name: string }[] = ctx.slug
    ? [{ slug: ctx.slug, name: ctx.productName ?? ctx.slug }]
    : ctx.products.map((p) => ({ slug: p.slug, name: p.name || p.slug }));
  const rows: PaletteItem[] = targets.map((t) => ({
    id: `action:delete-product:${t.slug}`,
    group: "Actions",
    label: "Delete product…",
    detail: ctx.slug ? t.name : `${t.name} · Settings`,
    keywords: `delete remove tombstone product ${t.slug} ${t.name}`,
    icon: <Trash2 aria-hidden className="size-4" />,
    matchOnly: true,
    perform: (api) =>
      api.openPanel(({ open, onOpenChange }) => (
        <DeleteProductDialog
          product={t}
          open={open}
          onOpenChange={onOpenChange}
          onDeleted={() => navigate(r.home())}
        />
      )),
  }));
  if (ctx.slug) return rows;
  return query.trim() === ""
    ? []
    : filterItems(rows, query).slice(0, DELETE_ACROSS_MAX);
}

/**
 * Connecting an app (UX-59; SETUP.md §3): the SDK quick start, its install from pkg.plrs.im and
 * the trust pins, findable by the words a developer types ("sdk", "install", "pins"). The quick
 * start rows open Integration with the SDK picker focused; the pins row opens Keys and secrets.
 * Shown on a match only, on a product.
 */
export function sdkActions(slug: string | null): PaletteItem[] {
  if (!slug) return [];
  const toQuickStart = (api: PaletteRunApi): void => {
    api.navigate(r.integration(slug));
    focusWhenReady(`${SDK_QUICK_START_ID}-tab`);
  };
  return [
    {
      id: "action:sdk-quick-start",
      group: "Actions",
      label: "SDK quick start",
      detail: "Integration",
      keywords:
        "sdk connect integrate app client snippet setup code node react web python swift ios kotlin android godot",
      icon: <Code2 aria-hidden className="size-4" />,
      matchOnly: true,
      perform: toQuickStart,
    },
    {
      id: "action:sdk-install",
      group: "Actions",
      label: "Install the SDK",
      detail: "From pkg.plrs.im",
      keywords:
        "install sdk package registry feed pkg.plrs.im npm pnpm pip uv swiftpm gradle maven godot",
      icon: <Package aria-hidden className="size-4" />,
      matchOnly: true,
      perform: toQuickStart,
    },
    {
      id: "action:trust-pins",
      group: "Actions",
      label: "Trust pins",
      detail: "Keys and secrets",
      keywords:
        "trust pins pinned keys signing key public key kid jwks rotation staged sdk",
      icon: <KeyRound aria-hidden className="size-4" />,
      matchOnly: true,
      href: r.keys(slug),
    },
  ];
}

/**
 * The top bar's Docs and theme buttons, as palette rows (EXPERIENCE.md §5.1: both leave the top
 * bar for the account menu and the palette). Shown on a match only.
 */
function useChromeActions(ctx: PaletteContext): PaletteItem[] {
  const { preference, setPreference } = useTheme();
  const items: PaletteItem[] = THEME_OPTIONS.filter(
    (o) => o.value !== preference,
  ).map((o) => {
    const Icon = o.icon;
    return {
      id: `action:theme:${o.value}`,
      group: "Actions",
      label:
        o.value === "system"
          ? "Use the system theme"
          : `Use the ${o.label.toLowerCase()} theme`,
      detail: "Theme",
      keywords: "theme appearance mode colour color dark light system",
      icon: <Icon aria-hidden className="size-4" />,
      matchOnly: true,
      perform: () => setPreference(o.value),
    };
  });
  const docs = ctx.page ? docsFor(ctx.page) : docsUrl("consoleDocsHome");
  items.push({
    id: "action:docs",
    group: "Actions",
    label: "Open the docs",
    detail: "For this page",
    keywords: "docs documentation help guide manual",
    icon: <BookOpen aria-hidden className="size-4" />,
    matchOnly: true,
    perform: () => {
      window.open(docs, "_blank", "noopener");
    },
  });
  return items;
}

export const actionsPaletteSource: PaletteSource = {
  id: "actions",
  useItems: (ctx, query) => {
    const chrome = useChromeActions(ctx);
    return [
      ...deleteProductActions(ctx, query),
      ...createActions(ctx.slug, ctx.services),
      ...turnOnActions(ctx.slug, ctx.services),
      ...sdkActions(ctx.slug),
      ...chrome,
    ];
  },
};
