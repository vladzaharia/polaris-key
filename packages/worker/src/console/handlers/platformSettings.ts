/**
 * The Platform Settings admin API (A-13, notes/S-13 §5, §6.4). Reached through
 * `handlePlatform` (`console/handlers/platform.ts`), so it is platform-admin only on top of the
 * dispatcher's session gate, per-subject limiter and CSRF check.
 *
 *   GET    /api/platform/settings       — the editable settings (effective value, source, the
 *                                         stored row and its version, bounds, confirm levels) and
 *                                         the read-only inventory: deploy-time values, secrets as
 *                                         presence ONLY, code constants that act as policy, and
 *                                         the S-13 warnings.
 *   PATCH  /api/platform/settings/:key  — `{ value, expectedVersion, confirm?, reason? }`: store a
 *                                         runtime value through `writeSetting()` (strict). 404 for
 *                                         a key that is no live platform setting, 422
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

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import type { AdminSession } from "../../core/console/session.js";
import { ADMIN_SESSION_TTL_SECONDS } from "../../core/console/session.js";
import {
  adminJson,
  err,
  notFound,
  readBody,
} from "../../core/console/respond.js";
import { adminOidcIsDedicated } from "../../platform/platformOidc.js";
import { describeKeyring } from "../../platform/keyvault.js";
import { SETTINGS } from "../../mount.js";
import {
  LAZY_DELTA_MAX_BYTES_CEILING,
  SETTINGS_CACHE_MS,
} from "../../core/platformSettings.js";
import {
  aliasedPlatformEntries,
  platformSettingResolved,
  unrecognisedCeilingVars,
} from "../../core/settings/platformRead.js";
import type { ResolvedSetting } from "../../core/settings/resolve.js";
import type { ConfirmLevel, SettingDef } from "../../core/settings/types.js";
import { writeSetting } from "../../core/settings/write.js";
import { AUDIT_RETENTION_SECONDS } from "../../scheduled.js";
import { PLATFORM_INVENTORY } from "../../platformInventory.generated.js";
import type { InventoryArea } from "../../platformInventory.js";
import {
  BLOB_LOCK_AGE_SECONDS,
  MIN_GC_GRACE_SECONDS,
} from "../../core/assets/blobGc.js";

/**
 * Secrets the page reports as present or absent. Presence only. ST-02: every `Env` member tagged
 * `@inventory secret` in `env.ts`, in `Env` order, so a new secret cannot be left off this list
 * (`pnpm gen platform-inventory --check`). `ADMIN_OIDC_CLIENT_SECRET` is the console's own
 * client secret (I-03); `PLATFORM_OIDC_CLIENT_SECRET` is the shared platform client's.
 */
export const SECRET_NAMES: readonly string[] = PLATFORM_INVENTORY.filter(
  (e) => e.kind === "secret",
).map((e) => e.name);

interface DeployValue {
  name: string;
  area: InventoryArea;
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

/**
 * The deploy-time values: every `Env` member tagged `@inventory var` that is not registry-backed
 * (`@editable`; those are the editable rows, with their deploy value). ST-02: generated from
 * `env.ts`, never a hand-kept list. A `secret` never reaches this list, so no credential value is
 * ever reported here.
 */
function deployValues(env: Env): DeployValue[] {
  return PLATFORM_INVENTORY.filter(
    (e) => e.kind === "var" && e.editable === null,
  ).map((e) => {
    const raw = str(env, e.name);
    return {
      name: e.name,
      area: e.area,
      // The parsed host list: an operator's allowlist, not credential material.
      value:
        e.name === "OIDC_ISSUER_ALLOWLIST" && raw !== null
          ? raw.split(/[\s,]+/).filter((h) => h !== "")
          : raw,
    };
  });
}

/** The KEK keyring's configuration names, in the order the warnings list them. */
const KEK_NAMES = [
  "PLATFORM_KEK_KEYS",
  "PLATFORM_KEK_ACTIVE",
  "PLATFORM_KEK",
  "PLATFORM_KEK_ID",
] as const;

/**
 * The keyring warnings, read from the ring as the Worker loads it (`describeKeyring`), so they
 * can never disagree with what `seal` and `open` do:
 *
 *  - `kek_keyring_unusable` — the ring does not load (a malformed `PLATFORM_KEK_KEYS`, an active
 *    kid outside it, a non-32-byte key, or `PLATFORM_KEK` and `PLATFORM_KEK_KEYS` naming one kid
 *    with different keys). Every sealed value is unreadable, so every product route 404s.
 *  - `kek_legacy_open_only` — `PLATFORM_KEK` sits beside `PLATFORM_KEK_KEYS` and is the only
 *    source of its kid, so it is in the ring open-only (RUNBOOK "Rotating when the old KEK is
 *    unknown"). A transitional state, flagged until `PLATFORM_KEK` is deleted. Not raised for a
 *    same-bytes copy of a `PLATFORM_KEK_KEYS` entry, which adds nothing to the ring.
 *
 * Both name kids and configuration names, never key material.
 */
async function keyringWarnings(env: Env): Promise<Warning[]> {
  let legacy: Awaited<ReturnType<typeof describeKeyring>>["legacy"];
  try {
    ({ legacy } = await describeKeyring(env));
  } catch (e) {
    const set = KEK_NAMES.filter((n) => str(env, n) !== null);
    return [
      {
        code: "kek_keyring_unusable",
        message: `The platform KEK keyring does not load, so no sealed value can be opened and every product route answers 404: ${e instanceof Error ? e.message : "unknown error"}. Correct the keyring secrets in one wrangler secret bulk call (RUNBOOK, "The platform KEK keyring").`,
        names: set.length > 0 ? set : ["PLATFORM_KEK", "PLATFORM_KEK_KEYS"],
      },
    ];
  }
  if (!legacy?.openOnly) return [];
  return [
    {
      code: "kek_legacy_open_only",
      message: `PLATFORM_KEK is set alongside PLATFORM_KEK_KEYS, so it stays in the ring as the legacy key ${legacy.kid}, open-only: new values are sealed under PLATFORM_KEK_ACTIVE. Re-seal with the sweep, then delete PLATFORM_KEK once the Keyring section says it is safe to.`,
      names: ["PLATFORM_KEK"],
    },
  ];
}

/** The S-13 §5.1 warnings. Exported for the tests. */
export async function settingsWarnings(env: Env): Promise<Warning[]> {
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
  out.push(...(await keyringWarnings(env)));
  if (str(env, "PORTAL_SESSION_SECRET") === null)
    out.push({
      code: "portal_session_secret_unset",
      message:
        "PORTAL_SESSION_SECRET is not set, so customer portal sessions cannot be signed.",
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

/** The labels of an enum entry's options (the registry holds the values, not their wording). */
const CHOICE_LABELS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "licensing.reservedNames": { warn: "Warn", error: "Refuse" },
  "identity.reservedDisplayNames": { warn: "Warn", error: "Refuse" },
};

/** The row key the console and `env.ts` know the entry by: its A-13 alias, else the registry key. */
function viewKey(def: SettingDef): string {
  return (def.storage.kind === "scalar" && def.storage.storedAs) || def.key;
}

/** The registry's confirm levels in the page's wording, by value kind. */
function confirmView(def: SettingDef): unknown {
  const c = def.confirm;
  if (def.value.kind === "switch" && "on" in c) return c;
  if (def.value.kind === "integer" && "up" in c)
    return { raise: c.up, lower: c.down };
  if (def.value.kind === "enum" && "up" in c) {
    // An ordered enum: `up` confirms a change toward the last value, `down` toward the first.
    const out: Record<string, ConfirmLevel> = {};
    def.value.values.forEach((v, i) => (out[v] = i === 0 ? c.down : c.up));
    return out;
  }
  if (def.value.kind === "enum" && "change" in c)
    return Object.fromEntries(def.value.values.map((v) => [v, c.change]));
  return c;
}

function settingView(def: SettingDef, r: ResolvedSetting, env: Env) {
  const v = def.value;
  const platformStep = r.chain.find((s) => s.source === "platform");
  const stored =
    platformStep && platformStep.value !== null
      ? {
          value: platformStep.value ?? null,
          valid: platformStep.ignored !== true,
          updatedAt: platformStep.at ?? 0,
          updatedBy: platformStep.by ?? "",
        }
      : null;
  const raw = def.varName === undefined ? undefined : env[def.varName];
  return {
    key: viewKey(def),
    area: def.area,
    label: def.label,
    description: def.description,
    kind: v.kind === "enum" ? "choice" : v.kind,
    ...(v.kind === "integer" ? { unit: v.unit, min: v.min, max: v.max } : {}),
    ...(v.kind === "enum"
      ? {
          options: v.values.map((value) => ({
            value,
            label: CHOICE_LABELS[def.key]?.[value] ?? value,
          })),
        }
      : {}),
    scripts: def.readers.some((p) =>
      p.startsWith("services/release/packs/deltas/"),
    )
      ? ["main", "deltas"]
      : ["main"],
    precedence: def.precedence ?? "runtime",
    default: def.defaultValue,
    deployValue: typeof raw === "string" ? raw : null,
    value: r.value,
    source: r.failsafe
      ? "failsafe"
      : r.source === "platform"
        ? "runtime"
        : r.source === "deploy"
          ? "deploy"
          : "default",
    forcedOff: r.lockedBy === "deploy",
    stored,
    // The `expectedVersion` the next write must carry (0: the key never had a runtime value; a
    // removed value keeps counting, so this is not 0 after a revert).
    version: r.version,
    confirm: confirmView(def),
  };
}

async function list(env: Env, db: Db): Promise<Response> {
  const defs = aliasedPlatformEntries();
  const resolved = await Promise.all(
    defs.map((d) => platformSettingResolved(env, db, d.key, { fresh: true })),
  );
  const storeAvailable = !resolved.some((r) => r.failsafe);
  return adminJson({
    settings: defs.map((d, i) => settingView(d, resolved[i]!, env)),
    storeAvailable,
    propagationSeconds: SETTINGS_CACHE_MS / 1000,
    deployTime: deployValues(env),
    secrets: SECRET_NAMES.map((name) => ({
      name,
      set: str(env, name) !== null,
    })),
    constants: constants(),
    warnings: await settingsWarnings(env),
  });
}

function expectedVersionOf(raw: unknown): number | undefined {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof n === "number" ? n : undefined;
}

/**
 * The registry entries this route serves, by key or alias: a live platform setting an operator
 * edits, whose value is a switch, an integer or one of a short list. Anything else is a 404.
 */
function servedDef(key: string): SettingDef | undefined {
  const def = SETTINGS.get(key, "platform");
  if (
    !def ||
    def.pending ||
    def.ownership !== "operator" ||
    def.storage.kind !== "scalar" ||
    !["switch", "integer", "enum"].includes(def.value.kind)
  )
    return undefined;
  return def;
}

function refused(r: {
  status: number;
  reason: string;
  message: string;
  details?: Record<string, unknown>;
}): Response {
  return err(r.status, ErrorCode.BadRequest, r.message, {
    reason: r.reason,
    ...r.details,
  });
}

/** Every write of this route is `writeSetting()`, strict: version, reason, typed confirmation. */
async function write(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  def: SettingDef,
  now: number,
  op: "set" | "reset",
): Promise<Response> {
  const body = await readBody(req);
  const res = await writeSetting(
    { env, db, registry: SETTINGS },
    {
      key: def.key,
      op,
      ...(op === "set" ? { value: body.value } : {}),
      expectedVersion: expectedVersionOf(
        body.expectedVersion ??
          (op === "reset"
            ? (new URL(req.url).searchParams.get("expectedVersion") ??
              undefined)
            : undefined),
      ),
      // `writeSetting()` refuses a reason that is not text.
      reason: body.reason as string | null | undefined,
    },
    {
      actor: {
        sub: session.sub,
        name: session.name ?? null,
        email: session.email ?? null,
      },
      origin: "console",
      now,
      ...(typeof body.confirm === "string" ? { confirm: body.confirm } : {}),
    },
  );
  if (!res.ok) return refused(res);
  const after = await platformSettingResolved(env, db, def.key, {
    fresh: true,
  });
  return adminJson(settingView(def, after, env));
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
  const def = servedDef(rest[0]!);
  if (!def) return notFound();
  if (req.method === "PATCH")
    return write(req, env, db, session, def, now, "set");
  if (req.method === "DELETE")
    return write(req, env, db, session, def, now, "reset");
  return err(405, "method_not_allowed", "method not allowed");
}
