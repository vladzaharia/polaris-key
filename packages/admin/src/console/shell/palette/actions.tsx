import * as React from "react";
import {
  BookOpen,
  Code2,
  KeyRound,
  Package,
  Plus,
  ToggleRight,
} from "lucide-react";
import type { ServiceSlug } from "../../../api.js";
import { useTheme } from "../../../components/theme.js";
import {
  SERVICE_REQUIRES,
  SERVICE_TABLE,
} from "../../../services.generated.js";
import { docsFor, navItems, SECTIONS, type ServiceState } from "../../nav.js";
import { r } from "../../routes.js";
import { THEME_OPTIONS } from "../ThemeMenu.js";
import { SDK_QUICK_START_ID } from "../../sections/core/model/sdkQuickStart.js";
import { focusWhenReady } from "./focus.js";
import type {
  PaletteContext,
  PaletteItem,
  PaletteRunApi,
  PaletteSource,
} from "./types.js";

/** The License area's create dialog, loaded with its chunk only when the action runs. */
const CreateLicenseDialog = React.lazy(() =>
  import("../../sections/license/components/CreateLicenseDialog.js").then(
    (m) => ({
      default: m.CreateLicenseDialog,
    }),
  ),
);

/** The DOM id of a service's switch on the Services page (`pages/core/Services.tsx`). */
export const serviceSwitchId = (service: ServiceSlug): string =>
  `service-${service}`;

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
        focusWhenReady(serviceSwitchId(row.slug));
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
      label: "Create product",
      detail: "Products",
      keywords: "new add product",
      icon: <Plus aria-hidden className="size-4" />,
      href: r.productNew(),
    },
  ];
  if (slug && services?.license?.enabled === true) {
    items.unshift({
      id: "action:create-license",
      group: "Actions",
      label: "Create license…",
      detail: "License",
      keywords: "new issue add license key holder",
      icon: <Plus aria-hidden className="size-4" />,
      perform: (api) =>
        api.openPanel((props) => (
          <CreateLicenseDialog slug={slug} {...props} />
        )),
    });
  }
  return items;
}

/**
 * Connecting an app (UX-59; SETUP.md §3): the SDK quick start, its install from pkg.plrs.im and
 * the trust pins, findable by the words a developer types ("sdk", "install", "pins"). The quick
 * start rows open Overview with the SDK chooser focused; the pins row opens Keys & secrets.
 * Shown on a match only, on a product.
 */
export function sdkActions(slug: string | null): PaletteItem[] {
  if (!slug) return [];
  const toQuickStart = (api: PaletteRunApi): void => {
    api.navigate(r.overview(slug));
    focusWhenReady(SDK_QUICK_START_ID);
  };
  return [
    {
      id: "action:sdk-quick-start",
      group: "Actions",
      label: "SDK quick start",
      detail: "Overview · Trust & SDK",
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
      detail: "Keys & secrets",
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
  const docs = ctx.page ? docsFor(ctx.page) : "/docs/admin/";
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
  useItems: (ctx) => {
    const chrome = useChromeActions(ctx);
    return [
      ...createActions(ctx.slug, ctx.services),
      ...turnOnActions(ctx.slug, ctx.services),
      ...sdkActions(ctx.slug),
      ...chrome,
    ];
  },
};
