/// <reference types="@cloudflare/workers-types" />

import { Catalog } from "@polaris-key/catalog";
import {
  type DocProfile,
  type ManagedEntry,
  type ManagedPayload,
} from "@polaris-key/protocol";
import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import type { Product } from "./product.js";
import { hashKey, mintToken } from "./crypto.js";
import { mergePayloads } from "./merge.js";
import {
  countActiveMachines,
  getActiveSchema,
  getLicense,
  getMachine,
  getMachineByTokenHash,
  getProfile,
  getTier,
  listLicenseProfiles,
  upsertMachine,
  type LicenseRow,
  type MachineRow,
  type TierRow,
} from "./repo.js";
import { deleteTokenRecord, getTokenRecord, putTokenRecord } from "./kv.js";

export interface ValidMachineToken {
  tokenHash: string;
  license: LicenseRow;
  machine: MachineRow;
}

export type AuthzError =
  | { error: "unauthorized" }
  | { error: "machine_limit"; limit: number; machineCount: number };

function docProfile(license: LicenseRow): DocProfile {
  const name = license.name ?? "";
  return {
    name,
    firstName: name.split(" ")[0] ?? "",
    email: license.email ?? "",
    enrolledAt: license.enrolled_at,
  };
}

export { docProfile };

/** Parse a JSON string-array column, ignoring null/invalid. */
function parseChannelsJson(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v)
      ? (v.filter((c) => typeof c === "string") as string[])
      : [];
  } catch {
    return [];
  }
}

/**
 * Inject the admin upgrade-channel + version-window policy (from the tier and license rows)
 * as ENFORCED entitlements, so the existing gate governs them with no gate-logic changes.
 */
function injectAdminPolicy(
  payload: ManagedPayload,
  tier: TierRow | null,
  license: LicenseRow,
  tighterMin: (a?: string, b?: string) => string | undefined,
  tighterMax: (a?: string, b?: string) => string | undefined,
): void {
  const updatedAt = license.modified_at;
  const enforced = (value: ManagedEntry["value"]): ManagedEntry => ({
    state: "enforced",
    value,
    updatedAt,
  });

  const channels = [
    ...new Set([
      ...parseChannelsJson(tier?.channels_json ?? null),
      ...parseChannelsJson(license.channels_json),
    ]),
  ];
  if (channels.length > 0)
    payload.entitlements["channels"] = enforced(channels);

  if (typeof tier?.policy_machine_limit === "number") {
    payload.entitlements["machineLimit"] = enforced(tier.policy_machine_limit);
  }

  const minVersion = tighterMin(
    tier?.min_version ?? undefined,
    license.min_version ?? undefined,
  );
  if (minVersion) payload.entitlements["app.minVersion"] = enforced(minVersion);

  const maxVersion = tighterMax(
    tier?.max_version ?? undefined,
    license.max_version ?? undefined,
  );
  if (maxVersion) payload.entitlements["app.maxVersion"] = enforced(maxVersion);
}

export function licenseUsable(
  license: LicenseRow | null,
  now: number,
): license is LicenseRow {
  if (!license || license.status !== "active") return false;
  if (license.expires_at !== null && now > license.expires_at) return false;
  return true;
}

function resolveMachineLimit(
  payload: ManagedPayload,
  fallback: number,
): number {
  const e = payload.entitlements["machineLimit"];
  return e && typeof e.value === "number" ? e.value : fallback;
}

export async function catalogDefaultPayload(
  db: Db,
  product: string,
  now: number,
): Promise<string | null> {
  const schemaRow = await getActiveSchema(db, product);
  if (!schemaRow) return null;
  try {
    const catalog = new Catalog(JSON.parse(schemaRow.catalog_json));
    const payload: ManagedPayload = {
      config: {},
      secrets: {},
      entitlements: {},
    };
    for (const entry of catalog.entries) {
      if (entry.kind !== "config" || entry.default === undefined) continue;
      payload.config[entry.key] = {
        state: entry.managementDefault ?? "default",
        value: entry.default as ManagedEntry["value"],
        updatedAt: now,
      };
    }
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

export async function resolveEffective(
  db: Db,
  product: string,
  license: LicenseRow,
  machine: MachineRow | null | undefined,
  now: number,
  policy: {
    tighterMin: (a?: string, b?: string) => string | undefined;
    tighterMax: (a?: string, b?: string) => string | undefined;
  },
): Promise<ManagedPayload> {
  const layers: (string | null | undefined)[] = [
    await catalogDefaultPayload(db, product, now),
  ];

  let tier: TierRow | null = null;
  if (license.tier_id) {
    tier = await getTier(db, product, license.tier_id);
    if (tier?.profile_id) {
      const p = await getProfile(db, product, tier.profile_id);
      layers.push(p?.payload_json ?? null);
    }
  }

  const profiles = await listLicenseProfiles(db, product, license.id);
  if (profiles.length > 0) {
    for (const ref of profiles) {
      const p = await getProfile(db, product, ref.profile_id);
      layers.push(p?.payload_json ?? null);
    }
  } else if (license.profile_id) {
    const p = await getProfile(db, product, license.profile_id);
    layers.push(p?.payload_json ?? null);
  }

  layers.push(license.overrides_json, machine?.overrides_json ?? null);
  const payload = mergePayloads(...layers);
  injectAdminPolicy(
    payload,
    tier,
    license,
    policy.tighterMin,
    policy.tighterMax,
  );
  return payload;
}

export async function authorizeMachine(
  env: Env,
  db: Db,
  product: Product,
  license: LicenseRow,
  deviceId: string,
  now: number,
  opts: {
    userAgent?: string | null;
    platform?: string | null;
    arch?: string | null;
    appVersion?: string | null;
    sdkName?: string | null;
    sdkVersion?: string | null;
  } = {},
): Promise<{ token: string; machine: MachineRow } | AuthzError> {
  if (!licenseUsable(license, now)) return { error: "unauthorized" };

  const existing = await getMachine(db, product.slug, deviceId);
  const isNewAuthorization =
    !existing ||
    existing.status !== "authorized" ||
    existing.license_id !== license.id;
  if (isNewAuthorization) {
    const eff = await resolveEffective(db, product.slug, license, null, now, {
      tighterMin: (a, b) => (a && b ? (a > b ? a : b) : (a ?? b)),
      tighterMax: (a, b) => (a && b ? (a < b ? a : b) : (a ?? b)),
    });
    const limit = resolveMachineLimit(eff, product.defaultMachineLimit);
    if (limit > 0) {
      const count = await countActiveMachines(db, product.slug, license.id);
      if (count >= limit) {
        return { error: "machine_limit", limit, machineCount: count };
      }
    }
  }

  const token = mintToken();
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  if (existing?.token_hash && existing.token_hash !== tokenHash) {
    await deleteTokenRecord(env, product.slug, existing.token_hash);
  }

  const machine: MachineRow = {
    product: product.slug,
    machine_id: deviceId,
    license_id: license.id,
    status: "authorized",
    first_seen: existing?.first_seen ?? now,
    last_seen: now,
    ua: opts.userAgent ?? existing?.ua ?? null,
    label: existing?.label ?? null,
    overrides_json: existing?.overrides_json ?? null,
    reported_json: existing?.reported_json ?? null,
    token_hash: tokenHash,
    platform: opts.platform ?? existing?.platform ?? null,
    arch: opts.arch ?? existing?.arch ?? null,
    app_version: opts.appVersion ?? existing?.app_version ?? null,
    sdk_name: opts.sdkName ?? existing?.sdk_name ?? null,
    sdk_version: opts.sdkVersion ?? existing?.sdk_version ?? null,
  };
  await upsertMachine(db, machine);
  await putTokenRecord(env, product.slug, tokenHash, {
    product: product.slug,
    machineId: deviceId,
    licenseId: license.id,
  });
  return { token, machine };
}

export async function validateMachineToken(
  env: Env,
  db: Db,
  product: Product,
  token: string | null,
  now: number,
  opts: { deviceId?: string | null } = {},
): Promise<ValidMachineToken | { error: "unauthorized" }> {
  if (!token) return { error: "unauthorized" };
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  let rec = await getTokenRecord(env, product.slug, tokenHash);
  if (rec && rec.product !== product.slug) return { error: "unauthorized" };
  let machine = rec
    ? await getMachine(db, product.slug, rec.machineId)
    : await getMachineByTokenHash(db, product.slug, tokenHash);
  if (!rec && machine) {
    rec = {
      product: product.slug,
      machineId: machine.machine_id,
      licenseId: machine.license_id,
    };
    await putTokenRecord(env, product.slug, tokenHash, rec);
  }
  if (opts.deviceId && rec?.machineId !== opts.deviceId)
    return { error: "unauthorized" };
  if (!machine || machine.status !== "authorized")
    return { error: "unauthorized" };
  if (!rec) return { error: "unauthorized" };
  if (machine.license_id !== rec.licenseId || machine.token_hash !== tokenHash)
    return { error: "unauthorized" };

  const license = await getLicense(db, product.slug, rec.licenseId);
  if (!licenseUsable(license, now)) return { error: "unauthorized" };
  return { tokenHash, license, machine };
}

export async function rotateMachineToken(
  env: Env,
  db: Db,
  product: Product,
  valid: ValidMachineToken,
  now: number,
): Promise<string> {
  const token = mintToken();
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  await deleteTokenRecord(env, product.slug, valid.tokenHash);
  await upsertMachine(db, {
    ...valid.machine,
    last_seen: now,
    token_hash: tokenHash,
  });
  await putTokenRecord(env, product.slug, tokenHash, {
    product: product.slug,
    machineId: valid.machine.machine_id,
    licenseId: valid.license.id,
  });
  return token;
}
