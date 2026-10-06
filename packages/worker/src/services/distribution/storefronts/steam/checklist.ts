/**
 * Steam's per-app checklist (A-18g; notes/S-15 §4.3, §5.1): the human steps Steam does not let an
 * API do or read, ticked by the operator. Every tick is an OPERATOR ASSERTION, shown as
 * unverified, stored per product AND per app id (a tick for one app never shows on another),
 * audited on every change. Stored in Distribution's connector settings (`steam-setup`), as A-17c's
 * App Store portal checklist is; no table of its own.
 *
 * Two items carry a date the console can show beside the tick, computed from another tick (never
 * a verification): the 30-day wait runs from the fee tick; the release may come no earlier than
 * two weeks after the Coming Soon page went live.
 */

import type { Db } from "../../../../core/platform.js";
import { renderDeepLink } from "../../../../core/storefront/deeplinks.js";
import { storefrontAdapter } from "../../../../core/storefront/adapter.js";
import {
  readConnectorSettings,
  writeConnectorSettings,
} from "../../connectors/settings.js";

/** The settings slot of the checklist (`dist_connector_settings`). */
export const STEAM_SETUP_SETTINGS = "steam-setup";

const DAY = 86_400;
const limits = () => storefrontAdapter("steam")!.capabilities.limits;

type LinkFor = (appId: string | null) => string | null;
const storePage: LinkFor = (id) =>
  id ? renderDeepLink("steam.store-page", { appId: id }) : null;

/** The steps an operator ticks. Order is the console's. */
export const STEAM_CHECKLIST = [
  {
    item: "fee_paid",
    label: "App fee paid in Steamworks ($100 per app)",
    link: (() => renderDeepLink("steam.new-app")) as LinkFor,
  },
  {
    item: "release_wait",
    label: "30 days have passed since the fee was paid",
    link: (() => null) as LinkFor,
  },
  {
    item: "coming_soon",
    label: "Coming Soon page live (at least two weeks before release)",
    link: storePage,
  },
  {
    item: "store_review",
    label: "Store page review passed",
    link: storePage,
  },
  {
    item: "build_review",
    label: "Build review passed",
    link: ((id) =>
      id ? renderDeepLink("steam.app-admin", { appId: id }) : null) as LinkFor,
  },
] as const;

export type SteamChecklistItem = (typeof STEAM_CHECKLIST)[number]["item"];

export function isSteamChecklistItem(v: unknown): v is SteamChecklistItem {
  return STEAM_CHECKLIST.some((c) => c.item === v);
}

interface StoredTick {
  at: number;
  by: string;
}

type Ticks = Partial<Record<SteamChecklistItem, StoredTick>>;

function normalise(raw: unknown): Ticks {
  const out: Ticks = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSteamChecklistItem(k) || !v || typeof v !== "object") continue;
    const t = v as Record<string, unknown>;
    if (typeof t.at === "number" && typeof t.by === "string")
      out[k] = { at: t.at, by: t.by };
  }
  return out;
}

async function readAll(db: Db, product: string) {
  const stored = await readConnectorSettings(db, product, STEAM_SETUP_SETTINGS);
  const raw = stored?.value.checklist;
  const byApp =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return { stored, byApp };
}

export interface SteamChecklistView {
  item: SteamChecklistItem;
  label: string;
  /** The page to do it in; null when it needs the app id and none is known, or has no page. */
  link: string | null;
  done: boolean;
  doneAt: number | null;
  doneBy: string | null;
  /** Always false: Steam reports none of these steps; a tick is the operator's word. */
  verified: false;
  /** The earliest date (epoch seconds) a dependent step can happen, from another tick. */
  notBefore: number | null;
}

export async function steamChecklistView(
  db: Db,
  product: string,
  appId: string | null,
): Promise<SteamChecklistView[]> {
  const { byApp } = await readAll(db, product);
  const ticks = appId ? normalise(byApp[appId]) : {};
  const l = limits();
  const notBefore = (item: SteamChecklistItem): number | null => {
    if (item === "release_wait" && ticks.fee_paid)
      return ticks.fee_paid.at + (l.feeToReleaseDays ?? 30) * DAY;
    if (item === "coming_soon" && ticks.coming_soon)
      return ticks.coming_soon.at + (l.comingSoonDays ?? 14) * DAY;
    return null;
  };
  return STEAM_CHECKLIST.map((c) => {
    const t = ticks[c.item];
    return {
      item: c.item,
      label: c.label,
      link: (c.link as LinkFor)(appId),
      done: t !== undefined,
      doneAt: t?.at ?? null,
      doneBy: t?.by ?? null,
      verified: false,
      notBefore: notBefore(c.item),
    };
  });
}

/** Tick or untick one item for one app. Answers the item's label (for the audit summary). */
export async function setSteamChecklistTick(
  db: Db,
  product: string,
  appId: string,
  item: SteamChecklistItem,
  done: boolean,
  by: string,
  now: number,
): Promise<string> {
  const { stored, byApp } = await readAll(db, product);
  const ticks = normalise(byApp[appId]);
  if (done) ticks[item] = { at: now, by };
  else delete ticks[item];
  await writeConnectorSettings(
    db,
    product,
    STEAM_SETUP_SETTINGS,
    { ...(stored?.value ?? {}), checklist: { ...byApp, [appId]: ticks } },
    by,
    now,
  );
  return STEAM_CHECKLIST.find((c) => c.item === item)!.label;
}
