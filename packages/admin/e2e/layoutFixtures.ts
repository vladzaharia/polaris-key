/**
 * The scripted admin API behind the layout lint (`layout.e2e.test.ts`): every read the console's
 * pages make, with realistic, fuller data than the per-area suites carry. Several products (one
 * with a long name), tens of rows in the lists, long identifiers, and an `empty` product whose
 * every collection is empty, so each page renders both its populated and its empty state.
 *
 * It composes the per-area fixtures (Core, Distribution, Feeds) and fills in the rest. `resolve`
 * answers a GET by path; the `empty` product's reads are derived from `djdl`'s with every list
 * emptied, so a page's empty state needs no fixture of its own.
 */

import { createHash } from "node:crypto";
import { artPng, squirclePng } from "./artPng.js";
import { CORE_ROUTES, DEVICE_ID } from "./coreFixtures.js";
import { DISTRIBUTION_ROUTES } from "../test/distributionData.js";
import { feedRoutes } from "../test/feedsFixture.js";
import { CHANNELS, STORE } from "../test/releaseFixture.js";
import { DATA_ROUTES, PACK_ID } from "./layoutData.js";
import { SETTINGS_ROUTES } from "./layoutSettings.js";

export { DEVICE_ID, PACK_ID };

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const P = "/manage/api/products/djdl";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
// U-05.20: Cloud Sync → Usage, in the shape U-05's read really returns: every byte is a settings
// byte (records, files and older versions are 0 until U-09/U-10), the null tier holds people with
// no tier or no license, platforms are the devices' own ids (or null), and no tier limit is above
// the per-person ceiling the read clamps to.
export const SYNC_USAGE = {
  enabled: true,
  usage: {
    bytes: 18.4 * GIB,
    people: 4812,
    settingsBytes: 18.4 * GIB,
    recordBytes: 0,
    fileBytes: 0,
    revisionBytes: 0,
    computedAt: NOW - 240,
    breakdown: {
      byTier: [
        {
          tierId: null,
          people: 3120,
          bytes: 9.5 * GIB,
          medianBytes: 2.6 * MIB,
          over80: 41,
        },
        {
          tierId: "free",
          people: 1402,
          bytes: 5.5 * GIB,
          medianBytes: 3.4 * MIB,
          over80: 3,
        },
        {
          tierId: "standard",
          people: 290,
          bytes: 3.4 * GIB,
          medianBytes: 9.8 * MIB,
          over80: 0,
        },
      ],
      byKind: { settings: 18.4 * GIB, records: 0, files: 0, revisions: 0 },
      byPlatform: [
        { platform: null, peopleThisWeek: 12, lastSyncAt: NOW - 3 * 3600 },
        { platform: "android", peopleThisWeek: 1689, lastSyncAt: NOW - 60 },
        { platform: "ios", peopleThisWeek: 2214, lastSyncAt: NOW - 60 },
        { platform: "windows", peopleThisWeek: 931, lastSyncAt: NOW - 240 },
      ],
    },
  },
  today: { day: "2026-10-22", syncs: 61240, conflicts: 37 },
  tiers: [
    { id: "free", label: "Free", bytes: null },
    { id: "standard", label: "Standard", bytes: 512 * MIB },
  ],
  defaultBytes: 256 * MIB,
};

export const LONG_NAME =
  "Northwind Broadcast Audio Workstation — Enterprise Edition for Studios";
export const LONG_SLUG = "northwind-broadcast-audio-workstation";

const services = Object.fromEntries(
  [
    "license",
    "config",
    "release",
    "distribution",
    "update",
    "identity",
    "sync",
    "commerce",
    "connect",
  ].map((s) => [s, { enabled: true }]),
);

const baseProduct = (
  CORE_ROUTES[`${P}`] as { product: Record<string, unknown> }
).product;
const product = (
  slug: string,
  name: string,
  extra: Record<string, unknown> = {},
) => ({
  ...baseProduct,
  slug,
  name,
  packageFeeds: true,
  services,
  ...extra,
});

/**
 * The fixture image host. Home's product cards and the Products table load product logos from
 * the image host (`presentation.icon`); the lint serves these URLs itself (`fixtureImage`) under a
 * CSP that admits exactly this origin, as the Worker's does for `IMG_ORIGIN`.
 */
export const IMG_ORIGIN = "https://img.layout.test";

const iconOf = (slug: string, kind = "") => {
  const sha = createHash("sha256")
    .update(kind ? `${slug}:${kind}` : slug)
    .digest("hex");
  const url = `${IMG_ORIGIN}/${slug}/a/${sha}`;
  return { url, w64: `${url}/64.webp`, w128: `${url}/128.webp` };
};

/** The bytes for a fixture logo URL: Acme's is a shaped (transparent-cornered) icon. */
export function fixtureImage(url: URL): Buffer | undefined {
  if (url.origin !== IMG_ORIGIN) return undefined;
  const slug = url.pathname.split("/")[1] ?? "";
  if (slug === "acme")
    return squirclePng(128, [[255, 106, 61]], [255, 244, 236], [190, 70, 30]);
  return artPng(
    128,
    128,
    [
      [47, 131, 120],
      [36, 104, 96],
    ],
    [246, 213, 142],
  );
}

const PRODUCTS = [
  product("djdl", "DJDL", {
    verified: true,
    presentation: { icon: iconOf("djdl"), header: iconOf("djdl", "header") },
  }),
  product("acme", "Acme", {
    presentation: { icon: iconOf("acme") },
    services: {
      ...services,
      distribution: { enabled: false },
      update: { enabled: false },
      sync: { enabled: false },
      commerce: { enabled: false },
    },
  }),
  product(LONG_SLUG, LONG_NAME, { presentation: { icon: null } }),
  // One service beside six: the worst pairing for equal-height card rows on Home.
  product("diceroll", "Diceroll", {
    presentation: { icon: iconOf("diceroll") },
    services: Object.fromEntries(
      Object.keys(services).map((s) => [s, { enabled: s === "license" }]),
    ),
  }),
  product("empty", "Empty product", {
    packageFeeds: true,
    presentation: { icon: null },
  }),
  // F-34.7: two declared packages, none published yet (see `waitingFeeds`).
  product("waiting", "Waiting product", { presentation: { icon: null } }),
];

/** The platform's own attention item, as `GET /attention` composes it (ST-44b.1). */
export const PLATFORM_PAUSE_ITEM = {
  id: "@platform:sync.paused",
  product: null,
  kind: "sync.paused",
  tone: "warning",
  service: "sync",
  short: "Writes paused",
  lines: [
    "Cloud Sync writes are paused for every product.",
    "Devices keep their changes and send them on resume.",
  ],
  action: {
    label: "Resume writes",
    page: "platform-settings",
    query: { setting: "cloudSync.writesPaused" },
  },
  area: "platform",
  since: NOW - 2 * 3600,
  by: "Ana Lima",
  reason: "Storage errors in eu-west",
};

const ME = {
  ...(CORE_ROUTES["/manage/api/me"] as Record<string, unknown>),
  products: [
    ...PRODUCTS.map((p, i) => ({
      slug: p.slug,
      name: p.name,
      schemaVersion: i + 1,
    })),
    // F-34.8: reachable by address and in the member's scope, left out of the products list.
    { slug: "feedsoff", name: "Feeds off", schemaVersion: 9 },
  ],
};

/**
 * A Platform admin with no product grant: the console lists no product to them (the Worker's
 * `canSeeProduct`), yet the pause reaches products they cannot see and the platform item is theirs.
 */
export const PLATFORM_ONLY_ME = {
  ...ME,
  sub: "m-ana",
  name: "Ana Lima",
  email: "ana@example.com",
  platformAdmin: true,
  products: [],
};

/**
 * Platform ready as the Worker answers a Platform admin with no product grant (ST-44b.3): the
 * Stores row counts the products it cannot name.
 */
export const PLATFORM_ONLY_READY = {
  done: 6,
  total: 7,
  rows: [
    { id: "keyring", title: "Keyring configured", done: true },
    { id: "portal-sessions", title: "Portal sessions isolated", done: true },
    { id: "console-sign-in", title: "Console sign-in separate", done: true },
    { id: "background-jobs", title: "Background jobs ticking", done: true },
    { id: "email-sender", title: "Email sender configured", done: true },
    { id: "platform-packages", title: "Platform packages set up", done: true },
    {
      id: "store-accounts",
      title: "Stores connected",
      done: false,
      detail:
        "Another product's Steam uploads need a Steamworks publisher key.",
      action: { label: "Connect Steam", to: "connections", store: "steam" },
    },
  ],
};

/** A member who administers the djdl product only (Cloud Sync Setup's product-role reads). */
export const PRODUCT_ROLE_ME = {
  ...ME,
  sub: "m-kenji",
  name: "Kenji Mori",
  email: "kenji@example.com",
  platformAdmin: false,
  permissions: {
    roles: [
      {
        role: "product_admin",
        scope: "product:djdl",
        areas: null,
        source: "grant",
      },
    ],
    platform: { view: ["console"], edit: ["console"] },
    products: {
      djdl: {
        view: [
          "core",
          "license",
          "config",
          "ship",
          "keys",
          "signin",
          "sync",
          "commerce",
          "console",
        ],
        edit: [
          "core",
          "license",
          "config",
          "ship",
          "keys",
          "signin",
          "sync",
          "commerce",
          "console",
        ],
      },
    },
  },
};

type Row = Record<string, unknown>;
const core = (path: string) => CORE_ROUTES[`${P}${path}`] as Row;
const dist = (path: string) => DISTRIBUTION_ROUTES[`${P}${path}`] as Row;

/** Forty devices: the six Core ones and their fleet, one with a long label. */
const coreDevices = core("/devices").devices as Row[];
const devices = Array.from({ length: 40 }, (_, i) => ({
  ...coreDevices[i % coreDevices.length],
  deviceId:
    i < coreDevices.length
      ? coreDevices[i]!.deviceId
      : `dev_${String(i + 1).padStart(28, "0")}`,
  label:
    i === 7
      ? "Main broadcast suite rack-mounted Mac Studio (Glasgow, floor 3, bay 12)"
      : coreDevices[i % coreDevices.length]!.label,
  lastSeen: NOW - i * 5400,
}));

/** Thirty activity rows. */
const coreActivity = core("/activity").items as Row[];
const activity = Array.from({ length: 30 }, (_, i) => ({
  ...coreActivity[i % coreActivity.length],
  id: `act_${i}`,
  at: NOW - i * 4000,
}));

const ROUTES: Record<string, unknown> = {
  ...feedRoutes(),
  ...CORE_ROUTES,
  ...DISTRIBUTION_ROUTES,
  ...DATA_ROUTES,
  ...SETTINGS_ROUTES,
  // A-22: the channel page: attention rows and a long identity value (a clipped card, a rail at 200 %).
  [`${P}/distribution/channels`]: {
    product: "djdl",
    now: NOW,
    platforms: [],
    kinds: [],
    channels: [
      {
        id: "google-play",
        label: "Google Play",
        inScope: true,
        declared: true,
        oneClick: false,
        notUsing: false,
        delivery: {
          state: "attention",
          attention: [
            { code: "credential_expiring" },
            { code: "no_fitting_build", reasons: ["format", "arch"] },
            { code: "identity_mismatch", field: "packageName" },
          ],
          platforms: [{ platform: "android", arches: ["arm64", "x64"] }],
        },
        commerce: null,
        identity: {
          fields: {
            packageName:
              "com.example.djdl.with.a.very.long.package.name.that.keeps.going",
          },
          source: "typed",
        },
      },
      // A-22.4: the App Store channel, whose Releases tab leads with the Distribute flow.
      {
        id: "app-store",
        label: "App Store",
        inScope: true,
        declared: true,
        oneClick: false,
        notUsing: false,
        delivery: { state: "live", attention: [], platforms: [{ platform: "ios", arches: ["arm64"] }] },
        commerce: { state: "ready", reason: null, attention: [] },
        identity: {
          fields: { bundleId: "com.example.djdl", appleId: "6478123905" },
          source: "derived",
        },
      },
    ],
  },
  // F-34.8: the owner row of the switch (feeds on); `feedsoff` answers the off row below.
  [`${P}/distribution/package-feeds`]: {
    packageFeeds: {
      enabled: true,
      version: 3,
      updatedAt: NOW - DAY * 9,
      updatedBy: null,
    },
  },
  [`${P}/devices`]: { devices, nextCursor: null },
  [`${P}/devices/summary`]: { ...core("/devices/summary"), total: 40 },
  [`${P}/activity`]: { items: activity, nextCursor: null },
  [`${P}/release/releases`]: {
    releases: [
      ...(STORE.releases as unknown[]),
      ...(dist("/release/releases").releases as unknown[]),
    ],
    channels: STORE.channels,
    floors: STORE.floors,
  },
  [`${P}/release/channels`]: CHANNELS,
  [`${P}/config/catalog/versions`]: {
    versions: Array.from({ length: 8 }, (_, i) => ({
      version: 8 - i,
      active: i === 0,
      createdAt: NOW - i * 7 * DAY,
      entryCount: 25 - i,
      source: i % 2 ? "manifest" : "admin",
      publishedBy: "ada@example.com",
    })),
  },
  [`${P}/config/catalog/usage`]: { keys: {} },
  // U-05.20: Cloud Sync → Usage, U-05's real shape (see SYNC_USAGE).
  [`${P}/sync/usage`]: SYNC_USAGE,
  [`${P}/config/mint`]: {
    registration: "requires-license",
    anonymousEnroll: false,
    oidcDefault: false,
    publicMint: false,
    licenseEnabled: true,
    identity: null,
    recipes: [],
  },
  // ST-34.11: Personal tokens, Yours (both scopes, a long host) and Everyone.
  "/manage/api/me/personal-tokens": {
    tokens: [
      {
        id: "ptok_cli",
        label: "pkey on ada-lovelace-macbook-pro.studio.example.com",
        hint: "Hq2a",
        scope: "admin",
        createdAt: NOW - 3 * DAY,
        expiresAt: NOW + 4 * DAY,
        lastUsedAt: NOW - 2 * 3600,
        revokedAt: null,
        revokeReason: null,
        status: "active",
      },
      {
        id: "ptok_ci",
        label: "CI build server",
        hint: "j3eX",
        scope: "packages:read",
        createdAt: NOW - 60 * DAY,
        expiresAt: NOW + 30 * DAY,
        lastUsedAt: null,
        revokedAt: null,
        revokeReason: null,
        status: "active",
      },
    ],
  },
  "/manage/api/account-tokens": {
    tokens: [
      {
        id: "ptok_cli",
        email: "ada@example.com",
        label: "pkey on ada-lovelace-macbook-pro.studio.example.com",
        hint: "Hq2a",
        scope: "admin",
        createdAt: NOW - 3 * DAY,
        expiresAt: NOW + 4 * DAY,
        lastUsedAt: NOW - 2 * 3600,
        revokedAt: null,
        revokeReason: null,
        status: "active",
      },
    ],
  },
  // Listing: the store-listing model with one locale and a store override (A-18b).
  [`${P}/distribution/listing`]: {
    listing: {
      app: {
        defaultLocale: "en-US",
        name: "DJDL",
        developerName: "Fennick",
        category: "music",
        contactEmail: "support@example.com",
        copyright: "© Fennick",
        urls: { support: "https://example.com/support" },
      },
      source: "admin",
      provenance: {},
      modifiedAt: NOW - DAY,
      modifiedBy: "ada@example.com",
    },
    locales: [
      {
        locale: "en-US",
        name: "DJDL",
        subtitle: "Mix anywhere",
        shortDescription: "Mix anywhere.",
        description: "A DJ app that runs wherever you do.",
        keywords: ["dj", "mix"],
        features: ["Beat matching", "Cloud library"],
        source: "admin",
        provenance: {},
        modifiedAt: NOW - DAY,
        modifiedBy: "ada@example.com",
      },
    ],
    overrides: [
      {
        store: "play",
        locale: null,
        field: "shortDescription",
        value: "Mix on Android",
      },
    ],
    limits: { name: 30, subtitle: 30, shortDescription: 80 },
    stores: [
      { store: "google-play", label: "Google Play" },
      { store: "app-store", label: "App Store" },
    ],
    overrideStores: ["google-play"],
    modelFields: ["name", "subtitle", "shortDescription", "description"],
  },
  [`${P}/distribution/listing/fit`]: {
    exists: true,
    release: null,
    // A-22.5: Google Play takes a title, two texts and a category it is told in the store.
    stores: [
      {
        store: "play",
        label: "Google Play",
        status: "amber",
        issues: [
          {
            store: "play",
            field: "shortDescription",
            from: "shortDescription",
            locale: null,
            issue: "too_long",
            severity: "warn",
            limit: 10,
            actual: 13,
            unit: "chars",
          },
        ],
        cells: [
          {
            field: "title",
            from: "name",
            locale: null,
            plane: "api",
            status: "green",
            present: true,
          },
          {
            field: "shortDescription",
            from: "shortDescription",
            locale: null,
            plane: "api",
            status: "amber",
            present: true,
          },
          {
            field: "fullDescription",
            from: "description",
            locale: null,
            plane: "copy",
            status: "green",
            present: true,
          },
          {
            field: "category",
            from: "category",
            locale: null,
            plane: "manual",
            status: "green",
            present: false,
          },
        ],
      },
    ],
    issues: [],
  },
  // The platform's alert destinations and reserved-name rules (Settings → Platform).
  "/manage/api/platform/alerts": {
    destinations: [],
    kinds: [
      { id: "auto_halt", label: "Auto-halt tripped", sent: true },
      {
        id: "store_connection",
        label: "Store connection failing",
        sent: false,
      },
    ],
    inherited: 0,
    inheritedByKind: {},
    max: 5,
    emailAvailable: true,
  },
  "/manage/api/platform/reserved-names": {
    mode: "warn",
    keys: [
      { key: "pkey.locale", type: "string", rule: "A BCP 47 language tag." },
    ],
    prefixes: ["pkey."],
    products: [],
  },
  // Access tokens: the admin API tokens and the personal ones.
  "/manage/api/tokens": {
    tokens: [
      {
        id: "tok_1",
        label: "CI migrations",
        scopes: ["migrations:report"],
        createdAt: NOW - 20 * DAY,
        expiresAt: NOW + 70 * DAY,
        lastUsedAt: NOW - 3600,
        revokedAt: null,
        status: "active",
      },
    ],
  },
  "/manage/api/account-tokens": {
    tokens: [
      {
        id: "ptk_1",
        email: "ada@example.com",
        label: "Laptop",
        hint: "a1b2",
        scope: "console",
        createdAt: NOW - 10 * DAY,
        expiresAt: NOW + 80 * DAY,
        lastUsedAt: NOW - 7200,
        revokedAt: null,
        revokeReason: null,
        status: "active",
      },
    ],
  },
  "/manage/api/me": ME,
  // Sign-in methods (ST-30c.4): the linked account, a long-named passkey, one Use for the console can mark.
  "/manage/api/me/methods": {
    methods: [
      {
        id: "lnk_oidc",
        kind: "oidc",
        name: "ada@example.com",
        createdAt: NOW - 90 * DAY,
        lastUsedAt: NOW - 3600,
        strong: true,
        consoleEligible: false,
        aaguid: null,
        addedFrom: null,
      },
      {
        id: "lnk_pk1",
        kind: "passkey",
        name: "A deliberately long passkey name for the YubiKey kept in the Tidewater office safe",
        createdAt: NOW - 30 * DAY,
        lastUsedAt: null,
        strong: false,
        consoleEligible: true,
        aaguid: null,
        addedFrom: "Chrome on macOS",
      },
    ],
    canAdd: true,
    reason: null,
  },
  "/manage/api/products": { products: PRODUCTS },
  // Home: what needs attention (`GET /attention`, long names and lines included) and Platform ready.
  "/manage/api/attention": {
    items: [
      // ST-44b: the Cloud Sync pause is one platform row (product null), whatever the number of
      // products with Cloud Sync on; the server sends it to Platform editors only.
      PLATFORM_PAUSE_ITEM,
      {
        id: "acme:sync.failed",
        product: { slug: "acme", name: "Acme" },
        kind: "sync.failed",
        tone: "danger",
        service: "release",
        short: "Resync failed",
        lines: ["Resync failed.", "The manifest did not validate."],
        action: { label: "Open error", page: "releases" },
        area: "ship",
      },
      {
        id: "djdl:secret.missing:identity.acoustidKey",
        product: { slug: "djdl", name: "DJDL" },
        kind: "secret.missing",
        tone: "warning",
        service: "config",
        short: "Missing secret",
        lines: [
          "Required secret `identity.acoustidKey` has no value in the Default profile.",
        ],
        action: { label: "Set secret", page: "keys" },
        area: "keys",
      },
      {
        id: `${LONG_SLUG}:credential.expiring:play`,
        product: { slug: LONG_SLUG, name: LONG_NAME },
        kind: "credential.expiring",
        tone: "warning",
        service: "release",
        short: "Credential expiring",
        lines: ["Google Play key expires Oct 16."],
        action: { label: "Replace key", page: "storefronts" },
        area: "ship",
      },
      {
        id: "djdl:storefront.identity_mismatch:play",
        product: { slug: "djdl", name: "DJDL" },
        kind: "storefront.identity_mismatch",
        tone: "warning",
        service: "commerce",
        short: "App mismatch",
        lines: [
          "Google Play purchases are checked against `gg.djdl.typo.with.a.long.package.name`, not the assigned app `gg.djdl.app`.",
        ],
        action: { label: "Review", page: "commerce-overview" },
        area: "commerce",
      },
      {
        id: `${LONG_SLUG}:channel.identity_mismatch:app-store:bundleId`,
        product: { slug: LONG_SLUG, name: LONG_NAME },
        kind: "channel.identity_mismatch",
        tone: "warning",
        service: "distribution",
        short: "App mismatch",
        lines: [
          "The `app-store` channel declares bundle ID `com.djdl.typo`; the assigned app is `com.djdl.app`.",
        ],
        action: {
          label: "Review",
          page: "outlets",
          query: { outlet: "app-store" },
        },
        area: "ship",
      },
    ],
  },
  "/manage/api/platform/ready": {
    done: 6,
    total: 7,
    rows: [
      { id: "keyring", title: "Keyring configured", done: true },
      { id: "portal-sessions", title: "Portal sessions isolated", done: true },
      { id: "console-sign-in", title: "Console sign-in separate", done: true },
      { id: "background-jobs", title: "Background jobs ticking", done: true },
      { id: "email-sender", title: "Email sender configured", done: true },
      {
        id: "platform-packages",
        title: "Platform packages set up",
        done: true,
      },
      {
        id: "store-accounts",
        title: "Stores connected",
        done: false,
        detail: "Diceroll's Steam uploads need a Steamworks publisher key.",
        action: { label: "Connect Steam", to: "connections", store: "steam" },
      },
    ],
  },
  [P]: { product: PRODUCTS[0] },
};

// A product whose data fills every kind (what U-09/U-10 will produce): the bar, four kinds, an
// older-versions note, so the paired Stored/Platforms row is linted too (case `long:sync-usage`).
const SYNC_USAGE_RICH = {
  ...SYNC_USAGE,
  usage: {
    ...SYNC_USAGE.usage,
    settingsBytes: 0.2 * GIB,
    recordBytes: 3.1 * GIB,
    fileBytes: 8.5 * GIB,
    revisionBytes: 6.6 * GIB,
  },
};

/** djdl → empty: every array emptied, every count zeroed, so a page draws its empty state. */
function emptied(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return [];
  if (typeof v === "number" && /count|total|licensed|licenseFree/i.test(key))
    return 0;
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        k === "slug" ? "empty" : emptied(x, k),
      ]),
    );
  }
  return v;
}

/** F-34.8: a product (not in the sidebar list) whose package feeds an operator turned off. */
const FEEDS_OFF = "/manage/api/products/feedsoff";
const FEEDS_OFF_AT = NOW - DAY * 2;
/**
 * F-34.7: the `waiting` product has declared an npm and a Swift package and published neither,
 * with a package deliverable each: the Packages cards draw "Waiting…" and the publish command.
 */
function waitingFeeds(pathname: string): unknown {
  const base = "/manage/api/products/waiting";
  if (pathname === `${base}/distribution/feeds`) {
    const src = ROUTES[`${P}/distribution/feeds`] as {
      feeds: Record<string, unknown>[];
    };
    return {
      ...src,
      feeds: src.feeds.map((f) =>
        f.ecosystem === "npm" || f.ecosystem === "swift"
          ? {
              ...f,
              configured: true,
              enabled: true,
              status: "enabled",
              reason: null,
              packages: 0,
              versions: 0,
              lastPublishedAt: null,
            }
          : { ...f, configured: false },
      ),
    };
  }
  if (pathname === `${base}/release/deliverables`)
    return {
      gateKnown: true,
      deliverables: [
        {
          id: "npm.sourcekit",
          kind: "package",
          type: "npm",
        },
        {
          id: "swift.sourcekit",
          kind: "package",
          type: "swift",
        },
      ],
    };
  return undefined;
}

export function resolve(pathname: string): unknown {
  if (pathname === FEEDS_OFF)
    return {
      product: {
        ...PRODUCTS[0],
        slug: "feedsoff",
        name: "Feeds off",
        verified: false,
        packageFeeds: false,
        packages: {
          declared: 3,
          feedsOn: false,
          offBy: "Ana Lima",
          offAt: FEEDS_OFF_AT,
        },
      },
    };
  if (pathname === `${FEEDS_OFF}/distribution/package-feeds`)
    return {
      packageFeeds: {
        enabled: false,
        version: 4,
        updatedAt: FEEDS_OFF_AT,
        updatedBy: "mbr_01J9ZANALIMA",
      },
    };
  if (pathname.startsWith(`${FEEDS_OFF}/`))
    return ROUTES[`${P}${pathname.slice(FEEDS_OFF.length)}`];
  const waiting = waitingFeeds(pathname);
  if (waiting !== undefined) return waiting;
  const empty = "/manage/api/products/empty";
  if (pathname === empty) return { product: PRODUCTS[4] };
  if (pathname.startsWith(`${empty}/`)) {
    const src = ROUTES[`${P}${pathname.slice(empty.length)}`];
    if (pathname === `${empty}/services`) return src;
    // Nobody has synced: the aggregate is all zero (`emptied` leaves a number alone).
    if (pathname === `${empty}/sync/usage`)
      return {
        ...SYNC_USAGE,
        usage: { ...SYNC_USAGE.usage, bytes: 0, people: 0, computedAt: 0 },
        today: { day: SYNC_USAGE.today.day, syncs: 0, conflicts: 0 },
      };
    return src === undefined ? undefined : emptied(src);
  }
  for (const p of PRODUCTS) {
    if (p.slug === "djdl" || p.slug === "empty") continue;
    const base = `/manage/api/products/${p.slug}`;
    if (p.slug === LONG_SLUG && pathname === `${base}/sync/usage`)
      return SYNC_USAGE_RICH;
    if (pathname === base) return { product: p };
    if (pathname.startsWith(`${base}/`))
      return ROUTES[`${P}${pathname.slice(base.length)}`];
  }
  return ROUTES[pathname];
}
