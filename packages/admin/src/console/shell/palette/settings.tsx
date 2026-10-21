import * as React from "react";
import { SlidersHorizontal } from "lucide-react";
import type { ServiceSlug } from "../../../services.generated.js";
import { serviceLabel } from "../../../ui/ServiceBadge.js";
import { SERVICE_TABLE } from "../../../services.generated.js";
import { SETTING_HOMES } from "../../sections/core/model/settingHomes.js";
import { AREA_NAMES, canIn } from "../../access/can.js";
import { globalPage, productPage } from "../../routes.js";
import {
  SETTINGS_INDEX,
  type SettingsIndexEntry,
} from "../../settings.generated.js";
import { filterItems } from "./rank.js";
import type { PaletteContext, PaletteItem, PaletteSource } from "./types.js";

/** Rows shown under Settings at most: the full list is All settings. */
export const SETTINGS_ROWS_MAX = 8;

/** An area as the console words it: the catalog's service label for a service area, else words. */
const areaWords = (area: string): string => {
  const flat = (t: string): string => t.toLowerCase().replace(/[^a-z]/g, "");
  const head = flat(area.split(".")[0] ?? area);
  const row = SERVICE_TABLE.find(
    (r) => flat(r.slug) === head || flat(r.label) === head,
  );
  if (row) return row.label;
  const s = area
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-.]+/g, " ")
    .toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/**
 * The settings source (ST-10): the generated registry index, found by name, key, alias, keyword or
 * description. Rows come only for text typed, and only for what the member can open: a row is kept
 * when `can()` gives the member its area (`rbacArea`) at its scope, so a member without an area
 * never sees its settings. Product settings need a product on screen, with the service running.
 * The row links to the setting: its row in All settings (`?setting=<key>`) or on the platform
 * page. The index is generated; nothing is listed here by hand.
 */
export function settingsItems(
  ctx: PaletteContext,
  query: string,
): PaletteItem[] {
  if (query.trim() === "") return [];
  const icon = <SlidersHorizontal aria-hidden className="size-4" />;
  const rows: PaletteItem[] = [];
  const namedWords = new Map<string, string>();
  for (const e of SETTINGS_INDEX) {
    if (e.pending !== null || e.deprecated !== null) continue;
    const row = settingRow(ctx, e, icon);
    if (!row) continue;
    rows.push(row);
    namedWords.set(row.id, [...e.aliases, ...e.keywords].join(" "));
  }
  // A name, key or keyword match leads; a word found only in the description follows.
  const words = query.trim().toLowerCase().split(/\s+/);
  const named = (i: PaletteItem): boolean => {
    const hay =
      `${i.label} ${i.id} ${namedWords.get(i.id) ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  // On a product's page its own rows lead the platform's at equal rank.
  const own = (i: PaletteItem): number =>
    i.id.startsWith("setting:platform:") ? 1 : 0;
  const found = filterItems(rows, query);
  const ordered = [
    ...found.filter(named).sort((x, y) => own(x) - own(y)),
    ...found.filter((i) => !named(i)).sort((x, y) => own(x) - own(y)),
  ];
  const shown = ordered.slice(0, SETTINGS_ROWS_MAX);
  if (ordered.length > SETTINGS_ROWS_MAX && ctx.slug)
    shown.push({
      id: `setting:more:${ctx.slug}`,
      group: "Settings",
      label: `See all ${ordered.length} settings`,
      detail: "",
      keywords: query,
      icon,
      href: productPage(ctx.slug, "settings-all", {
        query: { q: query.trim() },
      }),
    });
  return shown;
}

function settingRow(
  ctx: PaletteContext,
  e: SettingsIndexEntry,
  icon: React.ReactNode,
): PaletteItem | null {
  const area = e.rbacArea as keyof typeof AREA_NAMES;
  if (e.scope === "platform") {
    if (!canIn(ctx.me, area, null)) return null;
    return {
      id: `setting:platform:${e.key}`,
      group: "Settings",
      label: e.label,
      detail: `Platform · ${areaWords(e.area)}`,
      keywords: keywords(e),
      icon,
      href: globalPage("platform-settings", { setting: e.key }),
    };
  }
  if (e.scope !== "product" || !ctx.slug) return null;
  if (!canIn(ctx.me, area, ctx.slug)) return null;
  if (
    e.service !== "core" &&
    ctx.services !== null &&
    ctx.services[e.service as ServiceSlug]?.enabled !== true
  )
    return null;
  return {
    id: `setting:${ctx.slug}:${e.key}`,
    group: "Settings",
    label: e.label,
    detail: serviceLabel(e.service as ServiceSlug | "core"),
    keywords: keywords(e),
    icon,
    href: homeHref(ctx.slug, e.key),
  };
}

/**
 * Where a product setting is edited, landing on its row (`?setting=<key>`); All settings for a
 * value only the manifest or the admin API writes.
 */
function homeHref(slug: string, key: string): string {
  const home = SETTING_HOMES[key];
  if (home?.kind === "page")
    return productPage(slug, home.page, {
      id: home.id,
      query: { setting: key },
    });
  return productPage(slug, "settings-all", { query: { setting: key } });
}

function keywords(e: SettingsIndexEntry): string {
  return [
    e.key,
    ...e.aliases,
    ...e.keywords,
    e.scope,
    areaWords(e.area),
    AREA_NAMES[e.rbacArea as keyof typeof AREA_NAMES] ?? "",
    e.description,
  ].join(" ");
}

export const settingsPaletteSource: PaletteSource = {
  id: "settings",
  useItems: settingsItems,
};
