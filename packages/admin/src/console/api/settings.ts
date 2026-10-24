/**
 * The settings slice of the console API (P0-32.22): the generic settings API and its adapters, trust policy, product settings and drift.
 * Types and the `settingsApi` methods live together; `api.ts` re-exports the types and spreads the methods.
 */
import type {
  TrustPolicyDto,
  TrustPolicyGuard,
  TrustPolicyResponse,
  TrustPolicyWrite,
} from "./core.js";
import type { DeliveryAccess } from "./distribution.js";
import type {
  FingerprintPolicyDto,
  FingerprintPolicyResponse,
} from "./license.js";
import type { AreaId } from "./platform.js";
import type { ManifestPlan } from "./products.js";
import { ApiError, call, p } from "./transport.js";
import type {
  ReleaseAccess,
  SettingsSource,
  UpdateSettings,
} from "./update.js";

// ── product settings (LX-06) ──────────────────────────────────────────────────

/** A setting's value shape (worker `core/settings/types.ts` `ValueSpec`). */
export type SettingValueSpec =
  | { kind: "switch" }
  | { kind: "boolean" }
  | { kind: "integer"; unit: string; min: number; max: number }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "string"; pattern?: string; maxLength: number }
  | { kind: "list"; of: SettingValueSpec; max: number }
  | { kind: "json"; schema: string };

export type SettingConfirmLevel = "L0" | "L1" | "L2" | "L3";

/** The confirm level per direction (worker `SettingConfirm`). */
export type SettingConfirmSpec =
  | { up: SettingConfirmLevel; down: SettingConfirmLevel }
  | { on: SettingConfirmLevel; off: SettingConfirmLevel }
  | { change: SettingConfirmLevel };

/**
 * One product setting with its value in force (`GET …/settings/effective`, the generic settings
 * API of S-18 §4.7): `licensing.*` on License → Settings, the device trust policy on Keys, the
 * fingerprint policy on Enrollment, the update settings and the delivery access.
 */
export interface ProductSetting {
  key: string;
  area: string;
  service: string;
  label: string;
  description: string;
  docs: string;
  spec: SettingValueSpec;
  confirm: SettingConfirmSpec;
  /** A write needs a reason. */
  critical: boolean;
  /** `product:<dotted path>` in `.pkey/`. */
  manifestPath: string | null;
  visibleWhen: {
    service?: string;
    offBehaviour: "hide" | "readOnly" | "visible";
  } | null;
  serviceEnabled: boolean;
  /** The console area a write needs; absent on older responses. */
  rbacArea?: AreaId;
  /** Only the platform's admins write it, whatever `rbacArea` a product admin holds. */
  platformOnly?: boolean;
  /** Who may write it; a `manifest` or `read-only` key is shown, not edited. */
  ownership?:
    | "operator"
    | "manifest"
    | "claimable"
    | "narrow-only"
    | "read-only";
  /** Why a write is refused now whatever the value (no release configuration), when it is. */
  blocked?: string;
  value: unknown;
  source: "default" | "manifest" | "console";
  defaultValue: unknown;
  /** What an unset value follows (the daily mail cap), when the platform supplies one. */
  inherited?: unknown;
  /** What the last applied manifest declares (Revert's target); absent when it declares nothing. */
  manifestValue?: unknown;
  /** The row version, 0 for none: a write's `expectedVersion`. */
  version: number;
  /** Epoch seconds. */
  updatedAt: number | null;
  updatedBy: string | null;
  reason: string | null;
}

/** `GET …/settings/drift` (ST-17): the console's claims against the last applied manifest. */
export interface SettingsDriftItem {
  key: string;
  label: string;
  area: string;
  claimedBy: string | null;
  claimedAt: number | null;
  version: number;
  breakGlass?: { reason: string; expiresAt: number };
  /** `claim`: `revertClaim`; `setting`: `revertProductSetting` with `version`. */
  revert: "claim" | "setting";
  manifestKnown: boolean;
  differs: boolean;
  console: unknown;
  manifest: unknown;
  /** The catalog: which keys the manifest adds, drops or changes. */
  changes?: { added: string[]; removed: string[]; changed: string[] };
}

export interface SettingsDrift {
  snapshot: {
    origin: string;
    appliedAt: number;
    appliedSha: string | null;
  } | null;
  items: SettingsDriftItem[];
  /** What the last apply recorded; null before one did. */
  lastPlan: {
    v: 1;
    origin: "resync" | "link" | "deploy-hook";
    commit: string | null;
    plannedAt: number;
    plan: ManifestPlan;
  } | null;
}

// ── The generic settings API (S-18 §4.7) as the pages that used bespoke routes read it ───────
// `GET …/settings/<key>`, `PATCH|DELETE …/settings/<key>`: one route family for every
// product setting. The pages keep their view models (`UpdateSettings`, `DeliveryAccess`,
// `FingerprintPolicyResponse`, `TrustPolicyResponse`); these functions build them.

const settingPath = (slug: string, key: string): string =>
  `/manage/api/products/${encodeURIComponent(slug)}/settings/${encodeURIComponent(key)}`;

export async function getSetting(
  slug: string,
  key: string,
): Promise<ProductSetting> {
  return (await call<{ setting: ProductSetting }>(settingPath(slug, key)))
    .setting;
}

/**
 * Several settings by key, in parallel. A key the caller may not view answers 403 and is left out
 * (ST-29): the view built from the rest says what it could not read.
 */
export async function getSettings(
  slug: string,
  keys: readonly string[],
): Promise<Map<string, ProductSetting>> {
  const got = await Promise.allSettled(keys.map((k) => getSetting(slug, k)));
  const out = new Map<string, ProductSetting>();
  got.forEach((r, i) => {
    if (r.status === "fulfilled") out.set(keys[i]!, r.value);
    else if (!(r.reason instanceof ApiError && r.reason.status === 403))
      throw r.reason;
  });
  return out;
}

export async function writeSetting(
  slug: string,
  key: string,
  method: "PATCH" | "DELETE",
  body: object,
): Promise<{ setting: ProductSetting }> {
  return call<{ setting: ProductSetting }>(settingPath(slug, key), {
    method,
    body: JSON.stringify(body),
  });
}

/** The console's two owners of a block a resync can also write. */
const ownerOf = (s: ProductSetting): SettingsSource =>
  s.source === "console" ? "admin" : "manifest";

const TRUST_POLICY_KEY = "core.trustPolicy";
export const FINGERPRINT_KEY = "license.fingerprint";
export const AUTO_ISSUE_KEY = "license.autoIssue";
export const DELIVERY_ACCESS_KEY = "distribution.access";
export const UPDATE_ACCESS_KEY = "update.metadataAccess";
export const UPDATE_COMPAT_KEY = "release.compatWindow";
export const UPDATE_POLICY_KEY = "update.operatorPolicy";
export const UPDATE_KEYS = [
  UPDATE_ACCESS_KEY,
  UPDATE_COMPAT_KEY,
  UPDATE_POLICY_KEY,
] as const;

function trustPolicyOf(s: ProductSetting): TrustPolicyResponse {
  return {
    ok: true,
    policy: s.value as TrustPolicyDto,
    source: s.source === "console" ? "admin" : "default",
    version: s.version,
  };
}

export function fingerprintOf(s: ProductSetting): FingerprintPolicyResponse {
  return {
    version: s.version,
    policy: s.value as FingerprintPolicyDto,
    source: ownerOf(s),
  };
}

export function updateSettingsOf(
  by: Map<string, ProductSetting>,
): UpdateSettings {
  // The API lists only the keys whose area the caller holds (ST-29): a member of Ship builds
  // without Settings does not get the access mode, which the view then says it could not read.
  const access = by.get(UPDATE_ACCESS_KEY);
  const compat = by.get(UPDATE_COMPAT_KEY);
  const policy = by.get(UPDATE_POLICY_KEY);
  const window = (compat?.value ?? { min: "", max: "" }) as {
    min: string;
    max: string;
  };
  const operator = (policy?.value ?? {}) as {
    requireSparkleSignature?: boolean;
    minimumSystemVersion?: string;
  };
  return {
    metadataAccess: (access?.value ?? "public") as ReleaseAccess,
    accessSource: access ? ownerOf(access) : "manifest",
    compatMin: window.min,
    compatMax: window.max,
    compatSource: compat ? ownerOf(compat) : "manifest",
    minimumSystemVersion: operator.minimumSystemVersion ?? null,
    requireSparkleSignature: operator.requireSparkleSignature !== false,
    configured: access?.blocked === undefined,
    ...(access ? {} : { hidden: true as const }),
    versions: {
      access: access?.version ?? 0,
      compat: compat?.version ?? 0,
      policy: policy?.version ?? 0,
    },
  };
}

const ACCESS_MODES: ReleaseAccess[] = [
  "public",
  "authenticated",
  "licensed",
  "entitled",
];

export function deliveryAccessOf(s: ProductSetting): DeliveryAccess {
  const rows = Object.entries(
    (s.value ?? {}) as Record<
      string,
      {
        mode: ReleaseAccess;
        entitlement: string | null;
        source: SettingsSource;
        modifiedAt: number;
      }
    >,
  );
  const app = rows.find(([id]) => id === "app")?.[1];
  return {
    version: s.version,
    modes: ACCESS_MODES,
    // Fail closed, as the worker does: no `app` row reads `entitled`.
    app: {
      deliverableId: "app",
      mode: app?.mode ?? "entitled",
      source: app?.source ?? "manifest",
    },
    deliverables: rows.map(([deliverableId, r]) => ({
      deliverableId,
      mode: r.mode,
      entitlement: r.entitlement,
      source: r.source,
      modifiedAt: r.modifiedAt,
    })),
  };
}

export const settingsApi = {
  /** ST-12: the device trust policy, its source and the version a write must carry. */
  trustPolicy: async (slug: string): Promise<TrustPolicyResponse> =>
    trustPolicyOf(await getSetting(slug, TRUST_POLICY_KEY)),
  /** A relaxing change also carries `reason` and `confirm` and needs a fresh step-up. */
  putTrustPolicy: async (
    slug: string,
    { policy, ...guard }: TrustPolicyWrite,
  ): Promise<TrustPolicyResponse> =>
    trustPolicyOf(
      (
        await writeSetting(slug, TRUST_POLICY_KEY, "PATCH", {
          value: policy,
          ...guard,
        })
      ).setting,
    ),
  resetTrustPolicy: async (
    slug: string,
    guard: TrustPolicyGuard,
  ): Promise<TrustPolicyResponse> =>
    trustPolicyOf(
      (await writeSetting(slug, TRUST_POLICY_KEY, "DELETE", guard)).setting,
    ),
  // ── product settings (LX-06: the row-backed slice of S-18 §4.7's settings API) ─────
  /** The row-backed settings of one settings-hub area, with the value in force. */
  productSettings: (slug: string, area?: string) =>
    call<{ settings: ProductSetting[] }>(
      `${p(slug)}/settings/effective${area ? `?area=${encodeURIComponent(area)}` : ""}`,
    ),
  /** ST-17: the console's claims against the last applied manifest, and the last apply's plan. */
  settingsDrift: (slug: string) =>
    call<SettingsDrift>(`${p(slug)}/settings/drift`),
  /** Set a setting in the console: on a repo-linked product this claims it from the manifest. */
  updateProductSetting: (
    slug: string,
    key: string,
    body: {
      value: unknown;
      expectedVersion: number;
      reason?: string;
      /** The setting's key, typed back for a change the registry confirms at L2. */
      confirm?: string;
    },
  ) =>
    call<{ ok: true; claimed: boolean; setting: ProductSetting }>(
      `${p(slug)}/settings/${encodeURIComponent(key)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  /** Revert a console setting to the manifest (or to its default on a manual product). */
  revertProductSetting: (
    slug: string,
    key: string,
    body: { expectedVersion: number; reason?: string; confirm?: string },
  ) =>
    call<{
      ok: true;
      applied: boolean;
      message?: string;
      setting: ProductSetting;
    }>(`${p(slug)}/settings/${encodeURIComponent(key)}`, {
      method: "DELETE",
      body: JSON.stringify(body),
    }),
};
