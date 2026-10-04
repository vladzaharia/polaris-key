/**
 * Non-secret settings of a platform store connection (A-16): values every product of the
 * platform shares and that an operator would otherwise type into each product — the Apple Team
 * ID (App Attest, P6-02), Google Play's RTDN push identity (P6-01) and Play Integrity cloud
 * project number (P6-02).
 *
 * Two sources, the same precedence as the platform credentials: (a) the console value in
 * `platform_store_settings`, (b) a Worker var or secret where one is declared (`envName`). A
 * product's own explicit value always wins over both — that is the CALLER's rule: these
 * resolvers answer only the platform default. Not secret, so they are free to import; writes are
 * the Core admin handler's (platform admin, audited).
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";

/** A store with a platform (team-level) connection. Declared here, in the non-custody module,
 *  so that anything may name a store without importing the credential custody owner. */
export type PlatformStore =
  | "app-store"
  | "google-play"
  | "microsoft-store"
  | "steam";

export const PLATFORM_STORES: readonly PlatformStore[] = [
  "app-store",
  "google-play",
  "microsoft-store",
  "steam",
];

export function isPlatformStore(v: unknown): v is PlatformStore {
  return (
    typeof v === "string" && (PLATFORM_STORES as readonly string[]).includes(v)
  );
}

export interface PlatformStoreSettingSpec {
  store: PlatformStore;
  key: string;
  label: string;
  pattern: RegExp;
  /** The 422 message for a malformed value. Never echoes the input. */
  message: string;
  /** A Worker var/secret consulted when no console value is set. */
  envName: string | null;
  /** Who reads it: shown on the console so the operator knows what the value feeds. */
  usedBy: string;
}

export const PLATFORM_STORE_SETTINGS = {
  "app-store.teamId": {
    store: "app-store",
    key: "teamId",
    label: "Apple Developer Team ID",
    pattern: /^[A-Z0-9]{10}$/,
    message: "teamId must be the 10-character Apple Developer Team ID",
    envName: "PLATFORM_APPLE_TEAM_ID",
    usedBy:
      "App Attest (a trust policy's appAttest.teamId falls back to it; an explicit one wins)",
  },
  "google-play.pushServiceAccount": {
    store: "google-play",
    key: "pushServiceAccount",
    label: "RTDN push subscription service-account email",
    pattern: /^[^\s@]{1,200}@[^\s@]{1,200}$/,
    message:
      "pushServiceAccount must be the push subscription's service-account email",
    envName: null,
    usedBy:
      "Google Play real-time developer notifications (commerce play.pushServiceAccount falls back to it)",
  },
  "google-play.pushAudience": {
    store: "google-play",
    key: "pushAudience",
    label: "RTDN push subscription audience",
    pattern: /^[\x21-\x7e]{1,500}$/,
    message: "pushAudience must be the push subscription's audience",
    envName: null,
    usedBy:
      "Google Play real-time developer notifications (commerce play.pushAudience falls back to it)",
  },
  "google-play.cloudProjectNumber": {
    store: "google-play",
    key: "cloudProjectNumber",
    label: "Play Integrity cloud project number",
    pattern: /^[1-9][0-9]{0,19}$/,
    message:
      "cloudProjectNumber must be the Google Cloud project number (digits)",
    envName: null,
    usedBy:
      "Play Integrity (a trust policy's playIntegrity.cloudProjectNumber falls back to it; an explicit one wins)",
  },
} as const satisfies Record<string, PlatformStoreSettingSpec>;

export type PlatformStoreSettingId = keyof typeof PLATFORM_STORE_SETTINGS;

export const PLATFORM_STORE_SETTING_IDS = Object.keys(
  PLATFORM_STORE_SETTINGS,
) as PlatformStoreSettingId[];

/** The setting id of a store's key, or `null`. */
export function platformStoreSettingId(
  store: string,
  key: string,
): PlatformStoreSettingId | null {
  const id = `${store}.${key}`;
  return Object.hasOwn(PLATFORM_STORE_SETTINGS, id)
    ? (id as PlatformStoreSettingId)
    : null;
}

export interface ResolvedStoreSetting {
  value: string;
  source: "console" | "env";
}

/** The platform default for one setting — console first, then its Worker var — or `null`. A
 *  stored or configured value that no longer matches the pattern is ignored, not trusted. */
export async function resolvePlatformStoreSetting(
  env: Env,
  db: Db,
  id: PlatformStoreSettingId,
): Promise<ResolvedStoreSetting | null> {
  const spec: PlatformStoreSettingSpec = PLATFORM_STORE_SETTINGS[id];
  const row = await db.first<{ value: string }>(
    "SELECT value FROM platform_store_settings WHERE store = ? AND key = ?",
    spec.store,
    spec.key,
  );
  if (row && spec.pattern.test(row.value))
    return { value: row.value, source: "console" };
  if (spec.envName) {
    const v = env[spec.envName];
    if (typeof v === "string" && spec.pattern.test(v.trim()))
      return { value: v.trim(), source: "env" };
  }
  return null;
}

/** The platform's Apple Developer Team ID (App Attest's default), or `null`. */
export async function platformAppleTeamId(
  env: Env,
  db: Db,
): Promise<string | null> {
  return (
    (await resolvePlatformStoreSetting(env, db, "app-store.teamId"))?.value ??
    null
  );
}

/** The platform's Play Integrity cloud project number (P6-02's default), or `null`. */
export async function platformPlayIntegrityProjectNumber(
  env: Env,
  db: Db,
): Promise<string | null> {
  return (
    (
      await resolvePlatformStoreSetting(
        env,
        db,
        "google-play.cloudProjectNumber",
      )
    )?.value ?? null
  );
}

export interface PlatformStoreSettingView {
  key: string;
  label: string;
  usedBy: string;
  value: string | null;
  source: "console" | "env" | null;
  envName: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** Every setting of a store, resolved, for the API. */
export async function platformStoreSettingsView(
  env: Env,
  db: Db,
  store: PlatformStore,
): Promise<PlatformStoreSettingView[]> {
  const out: PlatformStoreSettingView[] = [];
  for (const id of PLATFORM_STORE_SETTING_IDS) {
    const spec: PlatformStoreSettingSpec = PLATFORM_STORE_SETTINGS[id];
    if (spec.store !== store) continue;
    const row = await db.first<{ updated_at: number; updated_by: string }>(
      "SELECT updated_at, updated_by FROM platform_store_settings WHERE store = ? AND key = ?",
      spec.store,
      spec.key,
    );
    const r = await resolvePlatformStoreSetting(env, db, id);
    out.push({
      key: spec.key,
      label: spec.label,
      usedBy: spec.usedBy,
      value: r?.value ?? null,
      source: r?.source ?? null,
      envName: spec.envName,
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    });
  }
  return out;
}

/** Validate and store a console value; answers the value before (`null`: none). Called ONLY
 *  from the Core admin handler, which audits it. */
export async function putPlatformStoreSetting(
  db: Db,
  id: PlatformStoreSettingId,
  raw: unknown,
  actor: string,
  now: number,
): Promise<
  | { ok: true; before: string | null; value: string }
  | { ok: false; message: string }
> {
  const spec: PlatformStoreSettingSpec = PLATFORM_STORE_SETTINGS[id];
  const v = typeof raw === "string" ? raw.trim() : null;
  if (!v || !spec.pattern.test(v)) return { ok: false, message: spec.message };
  const prev = await db.first<{ value: string }>(
    "SELECT value FROM platform_store_settings WHERE store = ? AND key = ?",
    spec.store,
    spec.key,
  );
  await db.run(
    `INSERT INTO platform_store_settings (store, key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (store, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    spec.store,
    spec.key,
    v,
    now,
    actor,
  );
  return { ok: true, before: prev?.value ?? null, value: v };
}

/** Remove a console value (the Worker var, if declared and set, takes over). Answers the value
 *  removed, or `null`. Called ONLY from the Core admin handler, which audits it. */
export async function deletePlatformStoreSetting(
  db: Db,
  id: PlatformStoreSettingId,
): Promise<string | null> {
  const spec: PlatformStoreSettingSpec = PLATFORM_STORE_SETTINGS[id];
  const prev = await db.first<{ value: string }>(
    "SELECT value FROM platform_store_settings WHERE store = ? AND key = ?",
    spec.store,
    spec.key,
  );
  if (!prev) return null;
  await db.run(
    "DELETE FROM platform_store_settings WHERE store = ? AND key = ?",
    spec.store,
    spec.key,
  );
  return prev.value;
}
