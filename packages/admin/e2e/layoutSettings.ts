/** The settings hub's reads for the layout lint: hosted assets, their quotas and the admin list. */

import { createHash } from "node:crypto";

const NOW = Math.floor(Date.now() / 1000);
const MiB = 1024 * 1024;
const P = "/manage/api/products/djdl";
const IMG = "https://img.layout.test";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function asset(slot: string, over: Record<string, unknown> = {}) {
  const h = sha(`djdl-${slot}`);
  return {
    slot,
    locale: "",
    origin: "manifest",
    sourceKind: "url",
    sourceRef: "https://cdn.example.com/icon.png",
    status: "ready",
    error: null,
    sha256: h,
    size: 126_268,
    contentType: "image/png",
    width: 1024,
    height: 1024,
    checkedAt: NOW,
    modifiedAt: NOW,
    wanted: { kind: "url", src: "https://cdn.example.com/icon.png" },
    pullPending: false,
    attempts: 0,
    nextAttemptAt: null,
    sizesPending: false,
    widths: [64, 128, 256, 512],
    url: `${IMG}/djdl/a/${h}`,
    previewUrl: `${IMG}/djdl/a/${h}/256.webp`,
    uploadable: true,
    maxBytes: 10 * MiB,
    ...over,
  };
}

const GiB = 1024 * MiB;
const NOW_S = NOW;
const DAY = 86_400;
const ALL_ALERTS = [
  "auto_halt",
  "store_connection",
  "commerce",
  "access_changed",
  "notifications_failing",
];
const WEBHOOK = {
  id: "dst_hook000001",
  scope: "_platform",
  kind: "webhook",
  target: "https://hooks.example.com/…",
  label: "Ops channel",
  alerts: ["auto_halt", "commerce"],
  enabled: true,
  version: 1,
  lastStatus: "failed",
  lastAt: NOW_S - 3600,
  lastError: "HTTP 404 from hooks.example.com",
  failures: 2,
};
const EMAIL = {
  ...WEBHOOK,
  id: "dst_mail000001",
  kind: "email",
  target: "ops@example.com",
  label: null,
  alerts: ALL_ALERTS,
  lastStatus: "ok",
  lastError: null,
  failures: 0,
};
const personalToken = (over: Record<string, unknown>) => ({
  id: "pt_a",
  email: "ada@example.com",
  label: "Ada laptop",
  hint: "Hq2a",
  scope: "packages:read",
  createdAt: NOW_S - 60 * DAY,
  expiresAt: NOW_S + 90 * DAY,
  lastUsedAt: NOW_S - 3600,
  revokedAt: null,
  revokeReason: null,
  status: "active",
  ...over,
});
const apiToken = (over: Record<string, unknown>) => ({
  id: "apitok_active01",
  label: "CI bundle minter",
  scopes: ["bundles:mint"],
  createdAt: NOW_S - 30 * DAY,
  expiresAt: NOW_S + 60 * DAY,
  lastUsedAt: NOW_S - 7200,
  revokedAt: null,
  status: "active",
  ...over,
});
const listing = {
  listing: {
    app: { defaultLocale: "en-US", name: "DJDL" },
    source: "admin",
    provenance: {},
    modifiedAt: NOW_S - DAY,
    modifiedBy: "u1",
  },
  locales: [],
  overrides: [],
  limits: { name: 30 },
  stores: [],
  overrideStores: [],
  modelFields: [],
};
const licensing = (
  key: string,
  label: string,
  value: unknown,
  spec: unknown,
) => ({
  key,
  area: "license.licensing",
  service: "license",
  label,
  description: `What ${label.toLowerCase()} does.`,
  docs: "/docs/features/licensing/access/",
  spec,
  confirm: { change: "L1" },
  critical: false,
  manifestPath: `product:${key}`,
  visibleWhen: { service: "license", offBehaviour: "hide" },
  serviceEnabled: true,
  value,
  source: "default",
  defaultValue: value,
  version: 0,
  updatedAt: null,
  updatedBy: null,
  reason: null,
});

/** The pages the layout gate used to pass in an error state: tokens, two Platform sections, Listing, License settings. */
const EXTRA_ROUTES: Record<string, unknown> = {
  "/manage/api/platform/alerts": {
    destinations: [WEBHOOK, EMAIL],
    kinds: [
      { id: "auto_halt", label: "Auto-halt tripped", sent: true },
      {
        id: "store_connection",
        label: "Store connection failing",
        sent: false,
      },
      { id: "commerce", label: "Commerce problem", sent: false },
      { id: "access_changed", label: "Access changed", sent: false },
      {
        id: "notifications_failing",
        label: "A destination is failing",
        sent: true,
      },
    ],
    max: 5,
    emailAvailable: true,
  },
  "/manage/api/platform/reserved-names": {
    mode: "warn",
    keys: [
      {
        key: "deviceLimit",
        type: "integer",
        rule: "The license's own device limit, else the tier's, else the license's deviceLimit entitlement, else the product default.",
      },
    ],
    prefixes: ["license.", "app.", "pkey."],
    products: [
      {
        slug: "djdl",
        name: "DJDL",
        catalogVersion: 1,
        declarations: [{ key: "deviceLimit", compatible: true, problem: null }],
      },
    ],
  },
  "/manage/api/account-tokens": {
    tokens: [
      personalToken({}),
      personalToken({
        id: "pt_long",
        label:
          "A deliberately long label for a build server in the Tidewater cluster",
        email:
          "someone.with.an.extraordinarily.long.address.for.testing@a-very-long-company-domain.example.com",
      }),
      personalToken({
        id: "pt_rev",
        label: "Old",
        status: "revoked",
        revokedAt: NOW_S - DAY,
        revokeReason: "admin",
      }),
    ],
  },
  "/manage/api/tokens": {
    tokens: [
      apiToken({}),
      apiToken({
        id: "apitok_expired1",
        label: "Old release laptop",
        status: "expired",
        expiresAt: NOW_S - DAY,
        lastUsedAt: null,
      }),
      apiToken({
        id: "apitok_revoked1",
        label: "Leaked laptop token",
        status: "revoked",
        revokedAt: NOW_S - 10 * DAY,
      }),
    ],
  },
  [`${P}/distribution/listing`]: listing,
  // License → Settings draws only its header without rows in the `license.licensing` area.
  [`${P}/settings/effective`]: {
    settings: [
      licensing(
        "licensing.anchorPolicy",
        "Anchor license choice",
        "rank-first",
        { kind: "enum", values: ["rank-first", "most-free-seats", "oldest"] },
      ),
      licensing(
        "licensing.clampGraceToExpiry",
        "Clamp offline grace to expiry",
        true,
        { kind: "boolean" },
      ),
    ],
  },
};

export const SETTINGS_ROUTES: Record<string, unknown> = {
  ...EXTRA_ROUTES,
  // Cloud Sync → Setup (U-05.21): the product ceiling and the usage read (tiers, 80 % words).
  [`${P}/settings/effective`]: {
    settings: [
      ...(EXTRA_ROUTES[`${P}/settings/effective`] as { settings: unknown[] })
        .settings,
      {
        key: "cloudSync.ceiling.bytes",
        area: "cloudSync.limits",
        service: "sync",
        label: "Product storage ceiling",
        description: "The most Cloud Sync data all people may keep together.",
        docs: "/docs/features/cloud-sync/",
        spec: { kind: "integer", unit: "bytes", min: 0, max: 1024 ** 5 },
        confirm: { up: "L2", down: "L1" },
        critical: true,
        manifestPath: null,
        visibleWhen: { service: "sync", offBehaviour: "hide" },
        serviceEnabled: true,
        rbacArea: "sync",
        ownership: "operator",
        value: 50 * GiB,
        source: "default",
        defaultValue: 50 * GiB,
        version: 0,
        updatedAt: null,
        updatedBy: null,
        reason: null,
      },
    ],
  },
  // Settings → Differs from the manifest (ST-17): one claim that differs, one kept as the manifest has it.
  [`${P}/settings/drift`]: {
    snapshot: {
      origin: "resync",
      appliedAt: NOW - 3600,
      appliedSha: "abcdef0123",
    },
    items: [
      {
        key: "core.name",
        label: "Display name",
        area: "core",
        claimedBy: "ada@example.com",
        claimedAt: NOW - 1800,
        version: 1,
        revert: "claim",
        manifestKnown: true,
        differs: true,
        console: "DJDL Pro",
        manifest: "DJDL",
      },
      {
        key: "license.defaults.deviceLimit",
        label: "Default device limit",
        area: "license",
        claimedBy: "ada@example.com",
        claimedAt: NOW - 1800,
        version: 1,
        revert: "claim",
        manifestKnown: true,
        differs: false,
        console: 5,
        manifest: 5,
      },
    ],
    lastPlan: null,
  },
  // Alerts (ST-27): the product's destinations and the alert kinds.
  [`${P}/alerts`]: {
    destinations: [
      {
        id: "dst_mail000001",
        scope: "djdl",
        kind: "email",
        target: "team@example.com",
        label: null,
        alerts: ["auto_halt"],
        enabled: true,
        version: 1,
        lastStatus: null,
        lastAt: null,
        lastError: null,
        failures: 0,
      },
    ],
    kinds: [
      { id: "auto_halt", label: "Auto-halt tripped", sent: true },
      {
        id: "store_connection",
        label: "Store connection failing",
        sent: false,
      },
      { id: "commerce", label: "Commerce problem", sent: false },
      { id: "access_changed", label: "Access changed", sent: false },
      {
        id: "notifications_failing",
        label: "A destination is failing",
        sent: true,
      },
    ],
    inherited: 0,
    inheritedByKind: {},
    max: 5,
    emailAvailable: true,
  },
  [`${P}/assets`]: {
    assets: [
      asset("presentation.icon"),
      asset("listing.header", {
        origin: "console",
        sourceKind: "upload",
        sourceRef: null,
        width: 2400,
        height: 1050,
        size: 569_622,
        maxBytes: 20 * MiB,
        wanted: { kind: "repo", src: "art/header.png" },
      }),
      asset("listing.screenshot:1", {
        status: "stale",
        error: "status:404",
        maxBytes: 20 * MiB,
      }),
    ],
  },
  [`${P}/assets/usage`]: {
    hosting: true,
    media: { bytes: 128 * MiB, files: 7, quota: 512 * MiB, full: false },
    release: {
      bytes: 512 * MiB,
      files: 3,
      quota: 2048 * MiB,
      full: false,
    },
    settings: [
      {
        key: "assets.releases.mirror",
        label: "Mirror release files",
        description: "Keeps Polaris Key's own copy of every app release file.",
        spec: { kind: "switch" },
        confirm: { on: "L0", off: "L1" },
        value: "on",
        source: "default",
        inherited: "on",
        own: false,
        version: 0,
      },
      {
        key: "assets.quota.mediaBytes",
        label: "Media quota",
        description: "How many bytes of hosted images this product may hold.",
        spec: { kind: "integer", unit: "bytes", min: 0, max: 1024 ** 4 },
        confirm: { up: "L1", down: "L1" },
        value: 512 * MiB,
        source: "default",
        inherited: 512 * MiB,
        own: false,
        version: 0,
      },
      {
        key: "assets.quota.releaseBytes",
        label: "Release-file quota",
        description:
          "How many bytes of mirrored release files this product may hold.",
        spec: { kind: "integer", unit: "bytes", min: 0, max: 10 * 1024 ** 4 },
        confirm: { up: "L1", down: "L1" },
        value: 2048 * MiB,
        source: "default",
        inherited: 2048 * MiB,
        own: false,
        version: 0,
      },
    ],
  },
  "/manage/api/access/admins": {
    scope: "djdl",
    area: "core",
    admins: [
      { name: "Kenji Mori", email: "kenji@example.com", role: "product_admin" },
      { name: "Ada Lindqvist", email: "ada@example.com", role: "superadmin" },
      { name: "Jonas Weber", email: "jonas@example.com", role: "superadmin" },
    ],
  },
};
