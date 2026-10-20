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
import { getProduct } from "../../core/products/store.js";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { PLATFORM_STORES } from "../../core/platformStoreSettings.js";
import {
  platformCredentialStatus,
  primaryPlatformCredential,
} from "../../core/platformCredentials.js";
import { adminOidcIsDedicated } from "../../platform/platformOidc.js";
import { settingsWarnings } from "../handlers/platformSettings.js";

export interface ReadyRow {
  id: string;
  title: string;
  done: boolean;
  /** One fact, only while the row is open. */
  detail?: string;
  /** Where the fix is: a Platform page id. */
  action?: { label: string; to: string };
}

export interface PlatformReady {
  rows: ReadyRow[];
  done: number;
  total: number;
}

/** The cron runs every 15 minutes (`wrangler.toml`); one missed run is not an outage. */
const TICK_WINDOW_SECONDS = 20 * 60;

/** Outlet kinds that need a platform store account, by store. */
const STORE_OUTLETS: Readonly<Record<string, string>> = {
  "app-store": "app-store",
  "google-play": "google-play",
  "microsoft-store": "ms-store",
  steam: "steam",
};

const STORE_NAMES: Readonly<Record<string, string>> = {
  "app-store": "App Store",
  "google-play": "Google Play",
  "microsoft-store": "Microsoft Store",
  steam: "Steam",
};

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
  const kinds = new Set(
    (
      await db.all<{ kind: string }>(
        "SELECT DISTINCT kind FROM dist_outlets WHERE removed_at IS NULL",
      )
    ).map((r) => r.kind),
  );
  const missingStores: string[] = [];
  for (const store of PLATFORM_STORES) {
    if (!kinds.has(STORE_OUTLETS[store]!)) continue;
    const status = await platformCredentialStatus(
      env,
      db,
      primaryPlatformCredential(store),
    );
    if (!status.configured) missingStores.push(STORE_NAMES[store] ?? store);
  }
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
      action: { label: "Open status", to: "status" },
    },
    {
      id: "email-sender",
      title: "Email sender",
      done: env.EMAIL != null,
      detail: "Sign-in and alert email can't be sent.",
      action: { label: "Open settings", to: "settings" },
    },
    {
      id: "store-accounts",
      title: "Store accounts",
      done: missingStores.length === 0,
      detail:
        missingStores.length === 0
          ? undefined
          : `${missingStores.join(", ")} uploads need a platform account.`,
      action: { label: "Open connections", to: "connections" },
    },
    {
      id: "platform-packages",
      title: "Platform packages",
      done: system !== null,
      detail: "The platform's own package feeds aren't set up.",
      action: { label: "Open packages", to: "packages" },
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
