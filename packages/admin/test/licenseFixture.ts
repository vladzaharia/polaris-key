/**
 * Fixtures for the License pages' suites (licenses, tiers, enrollment): a product with licenses
 * in every computed state, tiers, profiles, a license record with keys and devices, a catalog,
 * and a boot helper that mounts the whole console at a License URL over a scripted backend.
 */

import { configureAxe } from "vitest-axe";
import type {
  LicenseDetail,
  LicenseSummary,
  ProductCatalog,
  ServicesResponse,
  TierSummary,
} from "../src/api.js";
import {
  ALL_ON,
  boot,
  type Enablement,
  type FetchLog,
} from "./consoleHarness.js";

export const API = "/manage/api/products/djdl";
export const NOW_S = Math.floor(Date.now() / 1000);
const DAY = 86_400;

export const axe: ReturnType<typeof configureAxe> = configureAxe({
  rules: {
    // jsdom computes no colour; the brand package's contrast suite covers the tokens.
    "color-contrast": { enabled: false },
  },
});

export function summary(
  id: string,
  over: Partial<LicenseSummary> = {},
): LicenseSummary {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    status: "active",
    activatedAt: NOW_S - 100 * DAY,
    expiresAt: null,
    keyCount: 1,
    activeKeyCount: 1,
    deviceCount: 1,
    profile: null,
    profiles: [],
    tier: "pro",
    channels: [],
    minVersion: null,
    maxVersion: null,
    identityProvider: "manual",
    ...over,
  };
}

export const ADA = summary("lic_1", {
  name: "Ada Lovelace",
  email: "ada@x.io",
  expiresAt: NOW_S + 300 * DAY,
  keyCount: 2,
  activeKeyCount: 1,
  deviceCount: 2,
  channels: ["stable", "beta"],
  modifiedBy: "u1",
  modifiedAt: NOW_S - 3600,
});

export const LICENSES: LicenseSummary[] = [
  ADA,
  summary("lic_2", {
    name: "Lab 3",
    tier: "edu",
    expiresAt: NOW_S + 4 * DAY,
    identityProvider: "oidc",
  }),
  summary("lic_3", {
    name: "Old seat",
    tier: null,
    expiresAt: NOW_S - 30 * DAY,
    deviceCount: 0,
  }),
  summary("lic_4", { name: "Chargeback Ltd", status: "disabled" }),
];

export const PRO: TierSummary = {
  id: "pro",
  label: "Pro",
  profile: "base",
  policyExpiryDays: 365,
  policyDeviceLimit: 5,
  channels: ["stable"],
  minVersion: "1.0.0",
  maxVersion: null,
};
export const EDU: TierSummary = {
  id: "edu",
  label: "Edu",
  profile: null,
  policyExpiryDays: 180,
  policyDeviceLimit: 1,
  channels: [],
  minVersion: null,
  maxVersion: null,
};
export const UNUSED: TierSummary = {
  id: "trial",
  label: "Trial",
  profile: null,
  policyExpiryDays: null,
  policyDeviceLimit: null,
  channels: [],
  minVersion: null,
  maxVersion: null,
};
export const TIERS = [PRO, EDU, UNUSED];

export const PROFILES = [
  { id: "base", name: "Base" },
  { id: "studio", name: "Studio" },
];

export const DETAIL: LicenseDetail = {
  ...ADA,
  maxOfflineDays: 14,
  profiles: ["base", "studio"],
  overrides: {
    config: {
      "feature.timeout": { state: "default", value: 30, updatedAt: NOW_S },
    },
    secrets: {
      "api.token": { state: "enforced", configured: true, updatedAt: NOW_S },
    },
    entitlements: {
      "flag.pro": { state: "hidden", value: true, updatedAt: NOW_S },
    },
  },
  keys: [
    {
      hash: "abcdef0123456789abcdef",
      status: "active",
      label: "laptop",
      createdAt: NOW_S - 10 * DAY,
      createdBy: "u1",
    },
    {
      hash: "deadbeef0000111122223333",
      status: "revoked",
      createdAt: NOW_S - 90 * DAY,
      createdBy: "ops@x.io",
    },
  ],
  devices: [
    {
      deviceId: "dev_bound",
      label: "Studio Mac",
      status: "authorized",
      firstSeen: NOW_S - 20 * DAY,
      lastSeen: NOW_S - 60,
      platform: "macos",
      fingerprint: {
        status: "verified",
        hwid: "BgNwYHns5OhG",
        components: {},
        componentCount: 2,
        firstSeen: NOW_S - 20 * DAY,
        lastSeen: NOW_S,
      },
    },
    {
      deviceId: "dev_gone",
      status: "deauthorized",
      firstSeen: NOW_S - 40 * DAY,
      lastSeen: NOW_S - 30 * DAY,
      platform: "windows",
      fingerprint: null,
    },
  ],
};

export const CATALOG: ProductCatalog = {
  schemaVersion: 2,
  entries: [
    {
      key: "feature.timeout",
      kind: "config",
      category: "general",
      label: "Timeout",
      description: "Request timeout in seconds.",
      schema: { type: "integer", minimum: 1, maximum: 120 },
    },
    {
      key: "api.token",
      kind: "secret",
      category: "secrets",
      label: "API token",
      description: "Upstream API token.",
      schema: { type: "string" },
    },
    {
      key: "flag.pro",
      kind: "flag",
      category: "entitlements",
      label: "Pro features",
      description: "Unlocks pro features.",
      schema: { type: "boolean" },
    },
  ],
};

export const SERVICES: ServicesResponse = {
  services: {
    license: { enabled: true },
    config: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: false },
    update: { enabled: false },
    identity: { enabled: false },
    sync: { enabled: false },
  },
  registration: null,
  effectiveRegistration: "requires-license",
  source: "manifest",
};

/** A response with a status, for error states. */
export function failing(status: number, error = "server_error"): Response {
  return new Response(JSON.stringify({ error, message: "boom" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface LicenseBootOptions {
  routes?: Record<string, unknown>;
  services?: Enablement;
}

/** Mount the console at a License hash over the fixtures (override any route with `routes`). */
export function bootLicense(
  hash: string,
  opts: LicenseBootOptions = {},
): FetchLog {
  return boot(hash, {
    services: opts.services ?? ALL_ON,
    extra: {
      [`${API}/license/licenses`]: { licenses: LICENSES },
      [`${API}/license/licenses/lic_1`]: DETAIL,
      [`${API}/license/tiers`]: { tiers: TIERS },
      [`${API}/config/profiles`]: { profiles: PROFILES },
      [`${API}/config/profiles/base`]: {
        id: "base",
        name: "Base",
        payload: { config: {}, secrets: {}, entitlements: {} },
      },
      [`${API}/config/profiles/studio`]: {
        id: "studio",
        name: "Studio",
        payload: { config: {}, secrets: {}, entitlements: {} },
      },
      [`${API}/config/catalog`]: CATALOG,
      [`${API}/services`]: SERVICES,
      [`${API}/release/releases`]: { releases: [], channels: [] },
      [`POST ${API}/license/licenses`]: {
        licenseId: "lic_new",
        key: "PK-NEWKEY-ONESHOT",
        license: ADA,
      },
      [`PATCH ${API}/license/licenses/lic_1`]: { ok: true, id: "lic_1" },
      ...opts.routes,
    },
  });
}

/**
 * The writes a run made (everything but GET), optionally to paths that start with `prefix`, each
 * with its body parsed as JSON.
 */
export function writes(
  log: FetchLog,
  prefix = "",
): { path: string; method: string; body?: unknown }[] {
  return log.calls
    .filter((c) => c.method !== "GET" && c.path.startsWith(prefix))
    .map(({ path, method, json }) => ({
      path,
      method,
      ...(json !== undefined ? { body: json } : {}),
    }));
}
