/**
 * Platform ready (UX-67, ST-44): the first-run checklist for platform admins, from facts the
 * Worker already holds, never from a stored tick-box. A row is `done` while its fact holds, so it
 * can reopen. `GET /manage/api/platform/ready` answers it; Home shows it only while a row is open.
 *
 * Rows the Worker cannot read a fact for are left out rather than guessed: "Reserved names
 * reviewed" (no acknowledgement is stored) and "Team access" (the member roster is the groups'
 * and the role bindings' together). They join when those facts exist.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { getProduct, listProducts } from "../../core/products/store.js";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { storesMissingAccount } from "../../services/distribution/public.js";
import { adminOidcIsDedicated } from "../../platform/platformOidc.js";
import { settingsWarnings } from "../handlers/platformSettings.js";

export interface ReadyRow {
  id: string;
  title: string;
  done: boolean;
  /** One fact, only while the row is open. */
  detail?: string;
  /** Where the fix is: a Platform page id. */
  action?: { label: string; to: string; store?: string };
}

export interface PlatformReady {
  rows: ReadyRow[];
  done: number;
  total: number;
}

const STORE_LABEL: Readonly<Record<string, string>> = {
  "app-store": "App Store",
  "google-play": "Google Play",
  "microsoft-store": "Microsoft Store",
  steam: "Steam",
};

/** What each store's platform account is, in the sentence that asks for it. */
const STORE_NEEDS: Readonly<Record<string, string>> = {
  "app-store": "an App Store Connect API key",
  "google-play": "a Google Play service account",
  "microsoft-store": "a Partner Center credential",
  steam: "a Steamworks publisher key",
};

/** "A", "A and B", "A, B and C". */
export function listOf(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "Diceroll's Steam uploads need a Steamworks publisher key." */
function storeSentence(
  m: { store: string; products: string[] },
  names: ReadonlyMap<string, string>,
): string {
  const label = STORE_LABEL[m.store] ?? m.store;
  const who = m.products.map((p) => names.get(p) ?? p);
  const needs = STORE_NEEDS[m.store] ?? "a platform account";
  return who.length === 1
    ? `${who[0]}'s ${label} uploads need ${needs}.`
    : `${label} uploads for ${listOf(who)} need ${needs}.`;
}

/** The cron runs every 15 minutes (`wrangler.toml`); one missed run is not an outage. */
const TICK_WINDOW_SECONDS = 20 * 60;

export async function platformReady(
  env: Env,
  db: Db,
  now: number,
): Promise<PlatformReady> {
  const warnings = new Set((await settingsWarnings(env)).map((w) => w.code));
  const beat = await db
    .first<{
      at: number | null;
    }>("SELECT MAX(at) AS at FROM platform_heartbeats")
    .catch(() => null);
  const missingStores = await storesMissingAccount(env, db);
  const names = new Map(
    missingStores.length === 0
      ? []
      : (await listProducts(db)).map((p) => [p.slug, p.name || p.slug]),
  );
  const system = await getProduct(db, SYSTEM_PRODUCT_SLUG);

  const rows: ReadyRow[] = [
    {
      id: "keyring",
      title: "Keyring configured",
      done: !warnings.has("kek_keyring_unusable"),
      detail: "The keyring doesn't load, so sealed values can't be opened.",
      action: { label: "Open settings", to: "settings" },
    },
    {
      id: "portal-sessions",
      title: "Portal sessions isolated",
      done: !warnings.has("portal_session_secret_unset"),
      detail:
        "Customer sessions can't be signed without PORTAL_SESSION_SECRET.",
      action: { label: "Open settings", to: "settings" },
    },
    {
      id: "console-sign-in",
      title: "Console sign-in separate",
      done: adminOidcIsDedicated(env),
      detail: "The console shares the sign-in client customers use.",
      action: { label: "Open settings", to: "settings" },
    },
    {
      id: "background-jobs",
      title: "Background jobs ticking",
      done: beat?.at != null && beat.at >= now - TICK_WINDOW_SECONDS,
      detail: "No scheduled run in the last 20 minutes.",
      action: { label: "Open Operations", to: "status" },
    },
    {
      id: "email-sender",
      title: "Email sender configured",
      done: env.EMAIL != null,
      detail: "Sign-in and alert email can't be sent.",
      action: { label: "Open settings", to: "settings" },
    },
    {
      id: "store-accounts",
      title: "Store accounts connected",
      done: missingStores.length === 0,
      detail: missingStores.map((m) => storeSentence(m, names)).join(" "),
      action: {
        // Exactly one missing store deep-links the Store connections page to it (`?store=`).
        store: missingStores.length === 1 ? missingStores[0]!.store : undefined,
        label:
          missingStores.length === 1
            ? `Connect ${STORE_LABEL[missingStores[0]!.store] ?? "store"}`
            : "Open store accounts",
        to: "connections",
      },
    },
    {
      id: "platform-packages",
      title: "Platform packages set up",
      done: system !== null,
      detail: "The platform's own package feeds aren't set up.",
      action: { label: "Open package feeds", to: "packages" },
    },
  ];
  return {
    rows: rows.map((r) =>
      r.done ? { id: r.id, title: r.title, done: true } : r,
    ),
    done: rows.filter((r) => r.done).length,
    total: rows.length,
  };
}
