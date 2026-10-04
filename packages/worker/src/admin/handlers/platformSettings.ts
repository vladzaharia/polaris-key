/**
 * The Platform Settings admin API (A-13, notes/S-13 §5, §6.4). Reached through
 * `handlePlatform` (`admin/handlers/platform.ts`), so it is platform-admin only on top of the
 * dispatcher's session gate, per-subject limiter and CSRF check.
 *
 *   GET    /api/platform/settings       — the editable settings (effective value, source, the
 *                                         stored row and its version, bounds, confirm levels) and
 *                                         the read-only inventory: deploy-time values, secrets as
 *                                         presence ONLY, code constants that act as policy, and
 *                                         the S-13 warnings.
 *   PATCH  /api/platform/settings/:key  — `{ value, expectedVersion, confirm? }`: store a runtime
 *                                         value. 404 for a key outside `PLATFORM_SETTINGS`, 422
 *                                         for a value outside its bounds, 409 when the row is no
 *                                         longer at `expectedVersion` (0 = no row).
 *   DELETE /api/platform/settings/:key  — `{ expectedVersion }` (body or `?expectedVersion=`):
 *                                         drop the runtime value, reverting to `[vars]` or the
 *                                         code default.
 *
 * Every write appends one `platform_audit` row with the stored and effective value before and
 * after. Safe because the registry holds no secret (`test/platformSettings.test.ts`). A secret is
 * reported as `{ name, set }` and nothing else: never a value, a length, a prefix or a hash.
 *
 * Admin routes are narrative-only under AGENTS.md rule 10 (`adminApi` in routeCoverage's
 * NARRATIVE_ONLY): no OpenAPI entry.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import type { AdminSession } from "../session.js";
import { ADMIN_SESSION_TTL_SECONDS } from "../session.js";
import { platformAuditStatementFor } from "../audit.js";
import { adminJson, err, notFound, readBody } from "../lib/respond.js";
import { adminOidcIsDedicated } from "../../platformOidc.js";
import {
  deletePlatformSetting,
  invalidatePlatformSettings,
  LAZY_DELTA_MAX_BYTES_CEILING,
  PLATFORM_SETTINGS,
  platformSettingDef,
  platformSettings,
  resolveSetting,
  SETTINGS_CACHE_MS,
  settingConfirmLevel,
  TOMBSTONE_JSON,
  unrecognisedCeilingVars,
  validateSettingValue,
  writePlatformSetting,
  type PlatformSettingDef,
  type ResolvedSetting,
} from "../../core/platformSettings.js";
import { AUDIT_RETENTION_SECONDS } from "../../scheduled.js";
import {
  BLOB_LOCK_AGE_SECONDS,
  MIN_GC_GRACE_SECONDS,
} from "../../core/blobGc.js";

/**
 * Secrets the page reports as present or absent. Presence only. `ADMIN_OIDC_CLIENT_SECRET` is the
 * console's own client secret (I-03); `PLATFORM_OIDC_CLIENT_SECRET` is the shared platform
 * client's.
 */
export const SECRET_NAMES = [
  "PLATFORM_KEK",
  "PLATFORM_KEK_KEYS",
  "KEY_HASH_PEPPER",
  "ADMIN_SESSION_SECRET",
  "PORTAL_SESSION_SECRET",
  "PLATFORM_OIDC_CLIENT_SECRET",
  "ADMIN_OIDC_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "R2_PARENT_ACCESS_KEY_ID",
  "R2_PARENT_SECRET_ACCESS_KEY",
] as const;

type Area = "deployment" | "identity" | "delivery" | "email" | "keyring";

interface DeployValue {
  name: string;
  area: Area;
  /** The value, or `null` when unset. A list for the parsed issuer allowlist. */
  value: string | string[] | null;
}

interface Warning {
  code: string;
  message: string;
  names: string[];
}

function str(env: Env, name: string): string | null {
  const v = env[name];
  return typeof v === "string" && v !== "" ? v : null;
}

function deployValues(env: Env): DeployValue[] {
  const allowlist = str(env, "OIDC_ISSUER_ALLOWLIST");
  return [
    {
      name: "PKEY_ENVIRONMENT",
      area: "deployment",
      value: str(env, "PKEY_ENVIRONMENT"),
    },
    {
      name: "PLATFORM_ADMIN_GROUP",
      area: "identity",
      value: str(env, "PLATFORM_ADMIN_GROUP"),
    },
    // The console's own client (I-03), then the shared platform client the portal and
    // `provider: platform` products use. No fallback between them is reported here: the
    // `console_oidc_shared` warning says when the console is borrowing the platform client.
    {
      name: "ADMIN_OIDC_ISSUER",
      area: "identity",
      value: str(env, "ADMIN_OIDC_ISSUER"),
    },
    {
      name: "ADMIN_OIDC_CLIENT_ID",
      area: "identity",
      value: str(env, "ADMIN_OIDC_CLIENT_ID"),
    },
    {
      name: "PLATFORM_OIDC_ISSUER",
      area: "identity",
      value: str(env, "PLATFORM_OIDC_ISSUER"),
    },
    {
      name: "PLATFORM_OIDC_CLIENT_ID",
      area: "identity",
      value: str(env, "PLATFORM_OIDC_CLIENT_ID"),
    },
    {
      name: "OIDC_ISSUER_ALLOWLIST",
      area: "identity",
      // The parsed host list: an operator's allowlist, not credential material.
      value:
        allowlist === null
          ? null
          : allowlist.split(/[\s,]+/).filter((h) => h !== ""),
    },
    { name: "BLOB_ORIGIN", area: "delivery", value: str(env, "BLOB_ORIGIN") },
    {
      name: "CONSOLE_ORIGIN",
      area: "delivery",
      value: str(env, "CONSOLE_ORIGIN"),
    },
    {
      name: "BLOBS_BUCKET_NAME",
      area: "delivery",
      value: str(env, "BLOBS_BUCKET_NAME"),
    },
    {
      name: "R2_ACCOUNT_ID",
      area: "delivery",
      value: str(env, "R2_ACCOUNT_ID"),
    },
    {
      name: "GITHUB_APP_ID",
      area: "delivery",
      value: str(env, "GITHUB_APP_ID"),
    },
    {
      name: "PORTAL_EMAIL_FROM",
      area: "email",
      value: str(env, "PORTAL_EMAIL_FROM"),
    },
    // Kid NAMES, not key material.
    {
      name: "PLATFORM_KEK_ACTIVE",
      area: "keyring",
      value: str(env, "PLATFORM_KEK_ACTIVE"),
    },
    {
      name: "PLATFORM_KEK_ID",
      area: "keyring",
      value: str(env, "PLATFORM_KEK_ID"),
    },
  ];
}

/** The S-13 §5.1 warnings. Exported for the tests. */
export function settingsWarnings(env: Env): Warning[] {
  const out: Warning[] = [];
  // I-03: the console falls back to the shared platform client until its own is set.
  if (!adminOidcIsDedicated(env))
    out.push({
      code: "console_oidc_shared",
      message:
        "The console signs in through the shared platform identity-provider client, the one customers use. Create a console-only client and set ADMIN_OIDC_ISSUER, ADMIN_OIDC_CLIENT_ID and ADMIN_OIDC_CLIENT_SECRET in one deploy.",
      names: (["ISSUER", "CLIENT_ID"] as const)
        .map((s) => `ADMIN_OIDC_${s}`)
        .filter((n) => str(env, n) === null),
    });
  if (str(env, "PLATFORM_KEK_ID") !== null)
    out.push({
      code: "kek_id_set",
      message:
        "PLATFORM_KEK_ID is set. Changing it on its own makes every sealed secret unopenable; rotate through PLATFORM_KEK_KEYS and PLATFORM_KEK_ACTIVE instead.",
      names: ["PLATFORM_KEK_ID"],
    });
  if (str(env, "PORTAL_SESSION_SECRET") === null)
    out.push({
      code: "portal_session_secret_unset",
      message:
        "PORTAL_SESSION_SECRET is not set, so customer portal sessions are signed with ADMIN_SESSION_SECRET and the two realms share key material.",
      names: ["PORTAL_SESSION_SECRET"],
    });
  const badCeiling = unrecognisedCeilingVars(env);
  if (badCeiling.length > 0)
    out.push({
      code: "ceiling_value_unrecognised",
      message:
        'A kill-switch [vars] value is neither "on", "off" nor "runtime", so it is treated as a hard off and no runtime value can turn the setting on. Set it to "runtime" to let the settings page decide.',
      names: badCeiling,
    });
  return out;
}

/** Code constants that act as policy (S-13 §5.3), shown read-only. */
function constants() {
  return [
    {
      name: "ADMIN_SESSION_TTL_SECONDS",
      area: "sessions",
      value: ADMIN_SESSION_TTL_SECONDS,
      unit: "seconds",
    },
    {
      name: "AUDIT_RETENTION_SECONDS",
      area: "retention",
      value: AUDIT_RETENTION_SECONDS,
      unit: "seconds",
    },
    {
      name: "BLOB_LOCK_AGE_SECONDS",
      area: "blob-store",
      value: BLOB_LOCK_AGE_SECONDS,
      unit: "seconds",
    },
    {
      name: "MIN_GC_GRACE_SECONDS",
      area: "blob-store",
      value: MIN_GC_GRACE_SECONDS,
      unit: "seconds",
    },
    {
      name: "LAZY_DELTA_MAX_BYTES_CEILING",
      area: "lazy-deltas",
      value: LAZY_DELTA_MAX_BYTES_CEILING,
      unit: "bytes",
    },
  ];
}

function settingView(def: PlatformSettingDef, r: ResolvedSetting) {
  return {
    key: def.key,
    area: def.area,
    label: def.label,
    description: def.description,
    kind: def.kind,
    ...(def.kind === "integer"
      ? { unit: def.unit, min: def.min, max: def.max }
      : {}),
    scripts: def.scripts,
    precedence: def.precedence,
    default: def.defaultValue,
    deployValue: r.deployValue,
    value: r.value,
    source: r.source,
    forcedOff: r.forcedOff,
    stored: r.stored
      ? {
          value: r.stored.value ?? null,
          valid: r.stored.valid,
          updatedAt: r.stored.updatedAt,
          updatedBy: r.stored.updatedBy,
        }
      : null,
    // The `expectedVersion` the next write must carry (0: the key never had a runtime value; a
    // removed value keeps counting, so this is not 0 after a revert).
    version: r.version,
    confirm: def.confirm,
  };
}

async function list(env: Env, db: Db): Promise<Response> {
  const resolved = await platformSettings(env, db, { fresh: true });
  const storeAvailable = !Object.values(resolved).some(
    (r) => r.source === "failsafe",
  );
  return adminJson({
    settings: PLATFORM_SETTINGS.map((d) => settingView(d, resolved[d.key])),
    storeAvailable,
    propagationSeconds: SETTINGS_CACHE_MS / 1000,
    deployTime: deployValues(env),
    secrets: SECRET_NAMES.map((name) => ({
      name,
      set: str(env, name) !== null,
    })),
    constants: constants(),
    warnings: settingsWarnings(env),
  });
}

function expectedVersionOf(raw: unknown): number | null {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

async function storedRow(db: Db, key: string) {
  return db.first<{
    value_json: string;
    version: number;
    updated_at: number;
    updated_by: string;
  }>(
    "SELECT value_json, version, updated_at, updated_by FROM platform_settings WHERE key = ?",
    key,
  );
}

function parseStored(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** The audit snapshot of one side of a change: the stored value and what took effect. */
function snapshot(r: ResolvedSetting) {
  return {
    stored: r.stored ? (r.stored.value ?? null) : null,
    version: r.version,
    effective: r.value,
    source: r.source,
  };
}

function conflict(currentVersion: number): Response {
  return err(
    409,
    ErrorCode.BadRequest,
    "the setting changed since it was loaded; reload and review it",
    { reason: "version_conflict", currentVersion },
  );
}

async function write(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  def: PlatformSettingDef,
  now: number,
): Promise<Response> {
  const body = await readBody(req);
  const expected = expectedVersionOf(body.expectedVersion);
  if (expected === null)
    return err(400, ErrorCode.BadRequest, "expectedVersion is required", {
      reason: "expected_version_required",
    });
  const value = validateSettingValue(def, body.value);
  if (value === undefined)
    return err(
      422,
      ErrorCode.BadRequest,
      def.kind === "switch"
        ? `${def.key} must be "on" or "off"`
        : `${def.key} must be an integer from ${def.min} to ${def.max}`,
      {
        reason: "invalid_value",
        ...(def.kind === "integer" ? { min: def.min, max: def.max } : {}),
      },
    );

  const before = await resolvedNow(env, db, def);
  // The row is already past the version the caller loaded: refuse before anything is recorded, so
  // the audit snapshot below is always of the state the write replaces.
  if (before.version !== expected) return conflict(before.version);
  const level = settingConfirmLevel(def, before.value, value);
  if ((level === "L2" || level === "L3") && body.confirm !== def.key)
    return err(400, ErrorCode.BadRequest, `type ${def.key} to confirm`, {
      reason: "confirm_required",
      level,
    });

  const afterRow = {
    value,
    version: expected + 1,
    updatedAt: now,
    updatedBy: session.sub,
  };
  const after = resolveSetting(def, env[def.varName], afterRow, true);
  const res = await writePlatformSetting(
    db,
    def.key,
    value,
    expected,
    now,
    session.sub,
    platformAuditStatementFor(
      session,
      now,
      "platform.setting.set",
      { kind: "setting", id: def.key },
      `Set ${def.key} to ${String(value)}`,
      { before: snapshot(before), after: snapshot(after) },
    ),
  );
  if (!res.ok) return conflict(res.currentVersion);
  invalidatePlatformSettings(env, db);
  return adminJson(settingView(def, after));
}

async function revert(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  def: PlatformSettingDef,
  now: number,
): Promise<Response> {
  const body = await readBody(req);
  const expected = expectedVersionOf(
    body.expectedVersion ??
      new URL(req.url).searchParams.get("expectedVersion") ??
      undefined,
  );
  if (expected === null)
    return err(400, ErrorCode.BadRequest, "expectedVersion is required", {
      reason: "expected_version_required",
    });
  const before = await resolvedNow(env, db, def);
  if (!before.stored) return notFound();
  if (before.version !== expected) return conflict(before.version);
  const after = resolveSetting(
    def,
    env[def.varName],
    {
      value: undefined,
      deleted: true,
      version: expected + 1,
      updatedAt: now,
      updatedBy: session.sub,
    },
    true,
  );
  const res = await deletePlatformSetting(
    db,
    def.key,
    expected,
    now,
    session.sub,
    platformAuditStatementFor(
      session,
      now,
      "platform.setting.revert",
      { kind: "setting", id: def.key },
      `Reverted ${def.key} to ${after.source === "deploy" ? "the deploy value" : "the code default"} (${String(after.value)})`,
      { before: snapshot(before), after: snapshot(after) },
    ),
  );
  if (!res.ok) return conflict(res.currentVersion);
  invalidatePlatformSettings(env, db);
  return adminJson(settingView(def, after));
}

/** One setting resolved from a direct read of its row (no cache): what the write compares. */
async function resolvedNow(
  env: Env,
  db: Db,
  def: PlatformSettingDef,
): Promise<ResolvedSetting> {
  const row = await storedRow(db, def.key);
  return resolveSetting(
    def,
    env[def.varName],
    row
      ? {
          value: parseStored(row.value_json),
          deleted: row.value_json === TOMBSTONE_JSON,
          version: row.version,
          updatedAt: row.updated_at,
          updatedBy: row.updated_by,
        }
      : undefined,
    true,
  );
}

export async function handlePlatformSettings(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length === 0) {
    if (req.method !== "GET")
      return err(405, "method_not_allowed", "method not allowed");
    return list(env, db);
  }
  if (rest.length !== 1) return notFound();
  const def = platformSettingDef(rest[0]!);
  if (!def) return notFound();
  if (req.method === "PATCH") return write(req, env, db, session, def, now);
  if (req.method === "DELETE") return revert(req, env, db, session, def, now);
  return err(405, "method_not_allowed", "method not allowed");
}
