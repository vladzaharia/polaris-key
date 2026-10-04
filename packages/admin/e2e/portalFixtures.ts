import type { Request } from "playwright";

/**
 * Today's portal API for the browser checks (portal.e2e.test.ts): the mockup cast of
 * PORTAL.md (Mara Fennick and the fictional products), shaped exactly like the Worker's answers.
 */
export type PortalScenario = "signedOut" | "empty" | "one" | "three" | "twelve";

type Reply = { status?: number; body: unknown };
export type Handler = Reply | ((req: Request) => Reply);

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const ACCOUNT = {
  id: "acct_1",
  name: "Mara Fennick",
  email: "mara@fennick.studio",
};
const GOOD_KEY = "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w";

function lic(
  product: string,
  productName: string,
  over: Record<string, unknown> = {},
) {
  return {
    id: `lic_${product}`,
    product,
    productName,
    productBranding: null,
    name: ACCOUNT.name,
    email: ACCOUNT.email,
    status: "active",
    tier: null,
    activatedAt: NOW - 40 * DAY,
    expiresAt: null,
    maxOfflineDays: null,
    channels: [],
    minVersion: null,
    maxVersion: null,
    identityProvider: "manual",
    usable: true,
    keyCount: 1,
    activeKeyCount: 1,
    deviceCount: 1,
    entitlements: [],
    ...over,
  };
}

const NIGHTFALL = lic("nightfall", "Nightfall", {
  tier: "deluxe",
  deviceCount: 2,
  activatedAt: NOW - 2 * DAY,
  maxOfflineDays: 30,
  entitlements: [
    { key: "base", label: "Base game", value: true },
    { key: "ost", label: "Original soundtrack", value: true },
    { key: "artbook", label: "Digital art book", value: true },
  ],
});
const TIDEWATER = lic("tidewater", "Tidewater Studio", {
  tier: "pro",
  deviceCount: 2,
  activatedAt: NOW - 5 * DAY,
});
const EMBER = lic("ember-tactics", "Ember Tactics", {
  expiresAt: NOW - 20 * DAY,
  usable: false,
  activatedAt: NOW - 200 * DAY,
});
const MOSSGARDEN = lic("mossgarden", "Mossgarden", { activatedAt: NOW - 60 });
const MORE = [
  lic("orbit-survey", "Orbit Survey", {
    deviceCount: 2,
    activatedAt: NOW - 8 * DAY,
  }),
  lic("drift-kart", "Drift Kart", { activatedAt: NOW - 9 * DAY }),
  lic("hollow-pines", "Hollow Pines", { activatedAt: NOW - 10 * DAY }),
  lic("glyphsmith", "Glyphsmith", {
    tier: "studio",
    expiresAt: NOW + 9 * DAY,
    activatedAt: NOW - 11 * DAY,
  }),
  lic("lumen-raw", "Lumen RAW", {
    tier: "perpetual",
    activatedAt: NOW - 12 * DAY,
  }),
  lic("quill", "Quill", {
    identityProvider: "oidc",
    keyCount: 0,
    activeKeyCount: 0,
    deviceCount: 0,
    activatedAt: NOW - 13 * DAY,
  }),
  lic("pixel-forge-sdk", "Pixel Forge SDK", {
    tier: "indie",
    activatedAt: NOW - 14 * DAY,
  }),
  lic("saltwind", "Saltwind", { activatedAt: NOW - 15 * DAY }),
];

function art(
  id: string,
  name: string,
  platform: string | null,
  arch: string | null,
  over: Record<string, unknown> = {},
) {
  return {
    artifactId: id,
    name,
    kind: "installer",
    platform,
    arch,
    sizeBytes: 3_100_000_000,
    sha256: "5b0e1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8fd913",
    access: "licensed",
    canDownload: true,
    ...over,
  };
}

const RELEASES = [
  {
    product: "nightfall",
    productName: "Nightfall",
    releaseId: "rel_142",
    version: "1.4.2",
    title: "Stable",
    notes:
      "- New Photo Mode with free camera and depth of field.\n- Steam Deck: steadier 40 fps in the Lantern Caves.\n- Fixed controller rumble cutting out after a reload.",
    publishedAt: NOW - 13 * DAY,
    sourceUrl: null,
    artifacts: [
      art("n-mac", "Nightfall-1.4.2.dmg", "macos", "universal"),
      art("n-win", "Nightfall-1.4.2-setup.exe", "windows", "x86_64", {
        sizeBytes: 3_400_000_000,
      }),
      art("n-linux", "Nightfall-1.4.2.AppImage", "linux", "x86_64", {
        sizeBytes: 3_200_000_000,
      }),
      art("n-ost", "Original soundtrack.zip", null, null, {
        sizeBytes: 840_000_000,
        access: "entitled",
        canDownload: false,
      }),
    ],
  },
  {
    product: "nightfall",
    productName: "Nightfall",
    releaseId: "rel_141",
    version: "1.4.1",
    title: "Stable",
    notes: null,
    publishedAt: NOW - 32 * DAY,
    sourceUrl: null,
    artifacts: [],
  },
  {
    product: "tidewater",
    productName: "Tidewater Studio",
    releaseId: "rel_241",
    version: "2.4.1",
    title: null,
    notes: "Faster preset browser.",
    publishedAt: NOW - 4 * DAY,
    sourceUrl: null,
    artifacts: [
      art("t-arm", "Tidewater-2.4.1-arm64.dmg", "macos", "arm64"),
      art("t-x64", "Tidewater-2.4.1-x64.dmg", "macos", "x86_64"),
      art("t-win", "Tidewater-2.4.1.msi", "windows", "x86_64"),
    ],
  },
  {
    product: "hollow-pines",
    productName: "Hollow Pines",
    releaseId: "rel_110",
    version: "1.1.0",
    title: null,
    notes: null,
    publishedAt: NOW - 20 * DAY,
    sourceUrl: null,
    artifacts: [
      art("h-win", "HollowPines.exe", "windows", "x86_64"),
      art("h-lin", "HollowPines.tar.gz", "linux", "x86_64"),
    ],
  },
];

const CAPS = {
  auth: { oidc: true, magic: true },
  modules: { licensing: true, claim: true, releases: true },
};

function licensesFor(s: PortalScenario) {
  switch (s) {
    case "empty":
      return [];
    case "one":
      return [NIGHTFALL];
    case "three":
      return [NIGHTFALL, TIDEWATER, EMBER];
    case "twelve":
      return [NIGHTFALL, TIDEWATER, EMBER, MOSSGARDEN, ...MORE];
    default:
      return [];
  }
}

function device(
  id: string,
  label: string,
  platform: string,
  lastSeen: number,
  status = "authorized",
) {
  return {
    deviceId: id,
    status,
    firstSeen: NOW - 60 * DAY,
    lastSeen,
    label,
    platform,
    arch: "x86_64",
    appVersion: "1.4.2",
    sdkName: "polaris-key-godot",
    sdkVersion: "1.0.0",
    ua: null,
  };
}

export function portalRoutes(s: PortalScenario): Record<string, Handler> {
  if (s === "signedOut") {
    return {
      "/api/me": { status: 401, body: { error: "unauthorized" } },
      "/api/capabilities": { body: CAPS },
      "POST /api/magic/start": { body: { ok: true } },
    };
  }
  let licenses = licensesFor(s);
  const removed = new Set<string>();
  const routes: Record<string, Handler> = {
    "/api/me": { body: { account: ACCOUNT, csrf: "csrf" } },
    "/api/capabilities": { body: CAPS },
    "/api/licenses": () => ({ body: { licenses } }),
    "/api/releases": {
      body: {
        releases: RELEASES.filter((r) =>
          licenses.some((l) => l.product === r.product),
        ),
      },
    },
    "POST /api/claim/license-key": (req) => {
      const { key } = req.postDataJSON() as { key: string };
      if (key !== GOOD_KEY)
        return {
          status: 401,
          body: { error: "unauthorized", message: "license key not found" },
        };
      if (!licenses.some((l) => l.product === "mossgarden"))
        licenses = [MOSSGARDEN, ...licenses];
      return { body: { ok: true, license: MOSSGARDEN } };
    },
  };
  for (const l of [NIGHTFALL, TIDEWATER, EMBER, MOSSGARDEN, ...MORE]) {
    routes[`/api/licenses/${l.product}/${l.id}`] = () => ({
      body: {
        ...l,
        keys: l.keyCount
          ? [
              {
                hash: "h",
                status: "active",
                label: null,
                createdAt: l.activatedAt,
                lastUsedAt: null,
              },
            ]
          : [],
        devices:
          l.product === "nightfall"
            ? [
                device("d1", "Mara's MacBook Pro", "macos", NOW - 2 * 3600),
                device("d2", "Studio PC", "windows", NOW - DAY),
                device(
                  "d3",
                  "Old laptop",
                  "windows",
                  NOW - 200 * DAY,
                  "deauthorized",
                ),
              ].filter((d) => !removed.has(d.deviceId))
            : l.deviceCount
              ? [
                  device(
                    `${l.product}-1`,
                    "Mara's MacBook Pro",
                    "macos",
                    NOW - 3 * 3600,
                  ),
                ]
              : [],
      },
    });
    routes[`POST /api/releases/${l.product}/rel_142/artifacts/n-mac/token`] = {
      status: 201,
      body: { url: "/download/tok" },
    };
  }
  routes["DELETE /api/licenses/nightfall/lic_nightfall/devices/d2"] = () => {
    removed.add("d2");
    return { body: { ok: true, deviceId: "d2" } };
  };
  return routes;
}
