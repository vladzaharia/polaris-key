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

export { DEVICE_ID, PACK_ID };

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const P = "/manage/api/products/djdl";

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

const iconOf = (slug: string) => {
  const sha = createHash("sha256").update(slug).digest("hex");
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
  product("djdl", "DJDL", { presentation: { icon: iconOf("djdl") } }),
  product("acme", "Acme", {
    setup: { status: "ok", healthy: true, nextActions: [] },
    presentation: { icon: iconOf("acme") },
    services: {
      ...services,
      distribution: { enabled: false },
      update: { enabled: false },
      sync: { enabled: false },
    },
  }),
  product(LONG_SLUG, LONG_NAME, { presentation: { icon: null } }),
  // One service beside six: the worst pairing for equal-height card rows on Home.
  product("diceroll", "Diceroll", {
    setup: { status: "ok", healthy: true, nextActions: [] },
    presentation: { icon: iconOf("diceroll") },
    services: Object.fromEntries(
      Object.keys(services).map((s) => [s, { enabled: s === "license" }]),
    ),
  }),
  product("empty", "Empty product", {
    setup: { status: "ok", healthy: true, nextActions: [] },
    packageFeeds: true,
    presentation: { icon: null },
  }),
];

const ME = {
  ...(CORE_ROUTES["/manage/api/me"] as Record<string, unknown>),
  products: PRODUCTS.map((p, i) => ({
    slug: p.slug,
    name: p.name,
    schemaVersion: i + 1,
  })),
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
  "/manage/api/me": ME,
  "/manage/api/products": { products: PRODUCTS },
  // Home's product-card facts (`GET /summary`), long figures included.
  "/manage/api/summary": {
    products: {
      djdl: {
        license: { active: 1_284 },
        release: { version: "12.40.3-beta.17", channel: "nightly-canary" },
        distribution: { storefronts: 11 },
        identity: { users: 128_406 },
      },
      acme: {
        license: { active: 46 },
        release: { version: "0.9.2", channel: "beta" },
        identity: { users: 0 },
      },
      [LONG_SLUG]: {
        license: { active: 9_412 },
        release: null,
        distribution: { storefronts: 1 },
        identity: { users: 71 },
      },
      diceroll: { license: { active: 12 } },
      empty: {
        license: { active: 0 },
        release: null,
        distribution: { storefronts: 0 },
        identity: { users: 0 },
      },
    },
  },
  [P]: { product: PRODUCTS[0] },
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

export function resolve(pathname: string): unknown {
  const empty = "/manage/api/products/empty";
  if (pathname === empty) return { product: PRODUCTS[4] };
  if (pathname.startsWith(`${empty}/`)) {
    const src = ROUTES[`${P}${pathname.slice(empty.length)}`];
    if (pathname === `${empty}/services`) return src;
    return src === undefined ? undefined : emptied(src);
  }
  for (const p of PRODUCTS) {
    if (p.slug === "djdl" || p.slug === "empty") continue;
    const base = `/manage/api/products/${p.slug}`;
    if (pathname === base) return { product: p };
    if (pathname.startsWith(`${base}/`))
      return ROUTES[`${P}${pathname.slice(base.length)}`];
  }
  return ROUTES[pathname];
}
