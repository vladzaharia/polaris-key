import type { Request } from "playwright";
import { artPng, squirclePng, type Rgb } from "./artPng.js";

/**
 * The portal API for the browser checks (portal.e2e.test.ts): the mockup cast of PORTAL.md
 * (Mara Fennick and the fictional products), shaped exactly like the Worker's answers, including
 * wave 1's `GET /api/library` (PX-W1), `GET /api/products/<p>/downloads` (PX-W2) and
 * `POST /api/activate/preview` (PX-W5).
 */
export type PortalScenario =
  | "signedOut"
  | "empty"
  | "one"
  | "three"
  | "twelve"
  /** Account-wide licences: Quill alone, and Drift Kart held by key and account-wide. */
  | "accountWide";

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

/** Account-wide (signed in, no key) with a device: the License card's "Account-wide · 1 of 5". */
const QUILL_WIDE = lic("quill", "Quill", {
  identityProvider: "oidc",
  keyCount: 0,
  activeKeyCount: 0,
  deviceCount: 1,
  activatedAt: NOW - 13 * DAY,
});
/** Drift Kart held twice: by key (the best, listed first) and account-wide. */
const DRIFT_KEY = MORE.find((l) => l.product === "drift-kart")!;
const DRIFT_WIDE = lic("drift-kart", "Drift Kart", {
  id: "lic_drift-kart-acct",
  identityProvider: "oidc",
  keyCount: 0,
  activeKeyCount: 0,
  deviceCount: 1,
  activatedAt: NOW - 3 * DAY,
});
const ACCOUNT_WIDE_DEVICE: Record<string, [string, string, string]> = {
  lic_quill: ["quill-tv", "Living room PC", "windows"],
  "lic_drift-kart-acct": ["drift-deck", "Mara's Steam Deck", "linux"],
};

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
  // Expired, with an update window that covered 1.8 but not 2.0 (§5.4: "Download 1.8").
  {
    product: "ember-tactics",
    productName: "Ember Tactics",
    releaseId: "rel_200",
    version: "2.0",
    title: null,
    notes: "New campaign: The Ashen Coast.",
    publishedAt: NOW - 10 * DAY,
    sourceUrl: null,
    artifacts: [
      art("e2-mac", "EmberTactics-2.0.dmg", "macos", "universal", {
        access: "entitled",
        canDownload: false,
      }),
      art("e2-win", "EmberTactics-2.0.exe", "windows", "x86_64", {
        access: "entitled",
        canDownload: false,
      }),
    ],
  },
  {
    product: "ember-tactics",
    productName: "Ember Tactics",
    releaseId: "rel_180",
    version: "1.8",
    title: null,
    notes: null,
    publishedAt: NOW - 60 * DAY,
    sourceUrl: null,
    artifacts: [
      art("e18-mac", "EmberTactics-1.8.dmg", "macos", "universal", {
        access: "entitled",
        sizeBytes: 1_900_000_000,
      }),
      art("e18-win", "EmberTactics-1.8.exe", "windows", "x86_64", {
        access: "entitled",
        sizeBytes: 2_000_000_000,
      }),
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

/** PX-W1 presentation per product (developer names from the mockups; no art in fixtures). */
const PRESENTATION: Record<
  string,
  { developerName: string; deviceLimit: number; support?: string }
> = {
  nightfall: {
    developerName: "Lanternworks",
    deviceLimit: 3,
    support: "https://lanternworks.example/support",
  },
  tidewater: { developerName: "Harbor Audio", deviceLimit: 3 },
  "ember-tactics": {
    developerName: "Kiln Games",
    deviceLimit: 3,
    support: "https://kiln.example/renew",
  },
  mossgarden: { developerName: "Little Fern", deviceLimit: 5 },
  quill: { developerName: "Inkwell Labs", deviceLimit: 0 },
  "lumen-raw": { developerName: "Aperture Seven", deviceLimit: 2 },
  "pixel-forge": { developerName: "Anvil Labs", deviceLimit: 0 },
  // At its limit: the 12-product shelf shows "Free up a device" (§4.15, mockup 35).
  quill: { developerName: "Inkwell", deviceLimit: 5 },
  "drift-kart": { developerName: "Tarmac Toys", deviceLimit: 3 },
  "orbit-survey": {
    developerName: "Parallax Nine",
    deviceLimit: 2,
    support: "https://parallax.example/help",
  },
  glyphsmith: {
    developerName: "Northpaw Type",
    deviceLimit: 2,
    support: "https://northpaw.example/renew",
  },
};

/** Stand-in key art per product (PX-08: real images through the media proxy), as palettes. */
const ART: Record<
  string,
  {
    bands: Rgb[];
    disc: Rgb;
    /** `false`: no icon. `squircle`: a shaped icon with transparent corners and a rim. */
    icon?: false | { squircle: Rgb };
  }
> = {
  nightfall: {
    bands: [
      [34, 22, 58],
      [44, 30, 78],
      [62, 40, 104],
      [38, 26, 66],
    ],
    disc: [232, 220, 186],
    // Shaped like a macOS icon (DJDL's Liquid Glass icon is one): it must show edge to edge.
    icon: { squircle: [74, 196, 206] },
  },
  tidewater: {
    bands: [
      [18, 44, 44],
      [24, 92, 84],
      [240, 204, 170],
      [244, 140, 104],
    ],
    disc: [196, 110, 80],
  },
  "ember-tactics": {
    bands: [
      [44, 22, 14],
      [70, 32, 18],
      [96, 40, 20],
    ],
    disc: [250, 120, 40],
  },
  "orbit-survey": {
    bands: [
      [12, 14, 22],
      [18, 20, 30],
    ],
    disc: [222, 166, 110],
  },
  // Cover art and no icon: the product header's letter tile in front of the cover.
  glyphsmith: {
    bands: [[242, 234, 216]],
    disc: [196, 72, 52],
    icon: false,
  },
  // PX-16: the Discover cast of mockup 23.
  quill: {
    bands: [[246, 241, 230]],
    disc: [40, 38, 46],
  },
  mossgarden: {
    bands: [
      [232, 238, 214],
      [150, 184, 96],
      [92, 140, 64],
    ],
    disc: [242, 210, 96],
  },
  "lumen-raw": {
    bands: [[26, 22, 20]],
    disc: [240, 140, 60],
  },
};

/** The media proxy's answer for `/media/<product>/<icon|header>`, or null (404). */
export function portalMedia(pathname: string): Buffer | null {
  const m = pathname.match(/^\/media\/([a-z0-9-]+)\/(icon|header)$/);
  const art = m ? ART[m[1]!] : undefined;
  if (!m || !art || (m[2] === "icon" && art.icon === false)) return null;
  if (m[2] === "icon" && art.icon)
    return squirclePng(256, art.bands, art.disc, art.icon.squircle);
  return m[2] === "icon"
    ? artPng(256, 256, art.bands, art.disc)
    : artPng(640, 360, art.bands, art.disc);
}

type Lic = ReturnType<typeof lic>;

/** The first licence of each product, in order. */
function firstPerProduct(list: readonly Lic[]): Lic[] {
  const seen = new Set<string>();
  return list.filter((l) => !seen.has(l.product) && !!seen.add(l.product));
}

function libraryItem(l: Lic) {
  const pres = PRESENTATION[l.product];
  const limit = pres?.deviceLimit ?? 0;
  const status =
    l.expiresAt !== null && l.expiresAt <= NOW
      ? "expired"
      : limit > 0 && l.deviceCount >= limit
        ? "device_limit"
        : l.expiresAt !== null && l.expiresAt - NOW <= 14 * DAY
          ? "expires_soon"
          : "active";
  return {
    product: l.product,
    name: l.productName,
    developerName: pres?.developerName ?? null,
    tintColor: null,
    website: null,
    iconUrl:
      ART[l.product] && ART[l.product]!.icon !== false
        ? `/media/${l.product}/icon?v=1`
        : null,
    headerUrl: ART[l.product] ? `/media/${l.product}/header?v=1` : null,
    support: pres?.support ? { url: pres.support, email: null } : null,
    status,
    license: {
      id: l.id,
      tier: l.tier,
      status,
      licenseStatus: l.status,
      activatedAt: l.activatedAt,
      expiresAt: l.expiresAt,
      maxOfflineDays: l.maxOfflineDays,
      deviceLimit: limit,
      activeSeatCount: l.deviceCount,
      deviceCount: l.deviceCount,
      dormantCount: 0,
    },
    licenseCount: 1,
    addedAt: l.activatedAt,
  };
}

function file(
  releaseId: string,
  version: string,
  artifactId: string,
  name: string,
  platform: string | null,
  arch: string | null,
  over: Record<string, unknown> = {},
) {
  return {
    releaseId,
    artifactId,
    version,
    name,
    buildId: null,
    platform,
    arch,
    format: name.split(".").pop() ?? null,
    role: platform ? "payload" : null,
    sizeBytes: 3_100_000_000,
    sha256: "5b0e1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8fd913",
    minOs: null,
    canDownload: true,
    reason: null,
    ...over,
  };
}

/** PX-W2's view of Nightfall: the Universal Mac build, the soundtrack not hosted yet, Steam. */
function nightfallDownloads() {
  const mac = file(
    "rel_142",
    "1.4.2",
    "n-mac",
    "Nightfall-1.4.2.dmg",
    "macos",
    "universal",
  );
  const win = file(
    "rel_142",
    "1.4.2",
    "n-win",
    "Nightfall-1.4.2-setup.exe",
    "windows",
    "x86_64",
    { sizeBytes: 3_400_000_000 },
  );
  const linux = file(
    "rel_142",
    "1.4.2",
    "n-linux",
    "Nightfall-1.4.2.AppImage",
    "linux",
    "x86_64",
    { sizeBytes: 3_200_000_000 },
  );
  const rec = (
    platform: string,
    label: string,
    f: ReturnType<typeof file>,
  ) => ({
    platform,
    label,
    releaseId: "rel_142",
    version: "1.4.2",
    universal: f.arch === "universal",
    latest: true,
    files: [f],
  });
  return {
    product: { slug: "nightfall", name: "Nightfall" },
    channel: "stable",
    available: true,
    access: "licensed",
    detected: { platform: "macos", arch: null, touchAmbiguous: false },
    latest: {
      releaseId: "rel_142",
      version: "1.4.2",
      title: "Stable",
      publishedAt: NOW - 13 * DAY,
    },
    recommended: rec("macos", "macOS", mac),
    platforms: [
      {
        platform: "macos",
        label: "macOS",
        recommended: rec("macos", "macOS", mac),
        files: [mac],
      },
      {
        platform: "windows",
        label: "Windows",
        recommended: rec("windows", "Windows", win),
        files: [win],
      },
      {
        platform: "linux",
        label: "Linux",
        recommended: rec("linux", "Linux", linux),
        files: [linux],
      },
    ],
    extras: [
      file("rel_142", "1.4.2", "n-ost", "Original soundtrack.zip", null, null, {
        sizeBytes: 840_000_000,
        canDownload: false,
        reason: "not_hosted",
      }),
    ],
    stores: [
      {
        id: "steam:main",
        kind: "steam",
        outletId: "main",
        platforms: ["windows", "macos", "linux"],
        label: "Steam",
        url: "https://store.steampowered.com/app/000000/",
        deepLink: null,
        command: null,
        activateUrl: null,
        live: true,
        version: "1.4.2",
      },
    ],
  };
}

/** Tidewater: two Mac builds (never guessed between), Windows, and the App Store live. */
function tidewaterDownloads() {
  const arm = file(
    "rel_241",
    "2.4.1",
    "t-arm",
    "Tidewater-2.4.1-arm64.dmg",
    "macos",
    "arm64",
  );
  const x64 = file(
    "rel_241",
    "2.4.1",
    "t-x64",
    "Tidewater-2.4.1-x64.dmg",
    "macos",
    "x86_64",
  );
  const win = file(
    "rel_241",
    "2.4.1",
    "t-win",
    "Tidewater-2.4.1.msi",
    "windows",
    "x86_64",
  );
  const mac = {
    platform: "macos",
    label: "macOS",
    releaseId: "rel_241",
    version: "2.4.1",
    universal: false,
    latest: true,
    files: [arm, x64],
  };
  return {
    product: { slug: "tidewater", name: "Tidewater Studio" },
    channel: "stable",
    available: true,
    access: "licensed",
    detected: { platform: "macos", arch: null, touchAmbiguous: false },
    latest: {
      releaseId: "rel_241",
      version: "2.4.1",
      title: null,
      publishedAt: NOW - 4 * DAY,
    },
    recommended: mac,
    platforms: [
      {
        platform: "macos",
        label: "macOS",
        recommended: mac,
        files: [arm, x64],
      },
      {
        platform: "windows",
        label: "Windows",
        recommended: {
          ...mac,
          platform: "windows",
          label: "Windows",
          files: [win],
        },
        files: [win],
      },
    ],
    extras: [],
    stores: [
      {
        id: "app-store:ios",
        kind: "app-store",
        outletId: "ios",
        platforms: ["ios"],
        label: "App Store",
        url: "https://apps.apple.com/app/id000000000",
        deepLink: null,
        command: null,
        activateUrl: null,
        live: true,
        version: "2.4.1",
      },
    ],
  };
}

/** Ember Tactics: expired; the update window covered 1.8, not 2.0 (§5.4 "Download 1.8"). */
function emberDownloads() {
  const notEntitled = { canDownload: false, reason: "not_entitled" };
  const m20 = file(
    "rel_200",
    "2.0",
    "e2-mac",
    "EmberTactics-2.0.dmg",
    "macos",
    "universal",
    notEntitled,
  );
  const w20 = file(
    "rel_200",
    "2.0",
    "e2-win",
    "EmberTactics-2.0.exe",
    "windows",
    "x86_64",
    notEntitled,
  );
  const m18 = file(
    "rel_180",
    "1.8",
    "e18-mac",
    "EmberTactics-1.8.dmg",
    "macos",
    "universal",
    { sizeBytes: 1_900_000_000 },
  );
  const w18 = file(
    "rel_180",
    "1.8",
    "e18-win",
    "EmberTactics-1.8.exe",
    "windows",
    "x86_64",
    { sizeBytes: 2_000_000_000 },
  );
  const rec = (
    platform: string,
    label: string,
    f: ReturnType<typeof file>,
  ) => ({
    platform,
    label,
    releaseId: "rel_180",
    version: "1.8",
    universal: f.arch === "universal",
    latest: false,
    files: [f],
  });
  return {
    product: { slug: "ember-tactics", name: "Ember Tactics" },
    channel: "stable",
    available: true,
    access: "entitled",
    detected: { platform: "macos", arch: null, touchAmbiguous: false },
    latest: {
      releaseId: "rel_200",
      version: "2.0",
      title: null,
      publishedAt: NOW - 10 * DAY,
    },
    recommended: rec("macos", "macOS", m18),
    platforms: [
      {
        platform: "macos",
        label: "macOS",
        recommended: rec("macos", "macOS", m18),
        files: [m20, m18],
      },
      {
        platform: "windows",
        label: "Windows",
        recommended: rec("windows", "Windows", w18),
        files: [w20, w18],
      },
    ],
    extras: [],
    stores: [],
  };
}

/**
 * PX-W10's `GET /api/discover` offers (mockup 23): what each would give and why. The empty,
 * one- and three-product accounts get them; the twelve-product account has nothing to add
 * (mockup 25).
 */
function discoverOffer(
  product: string,
  name: string,
  offer: {
    tier: string;
    tierLabel: string;
    deviceLimit: number;
    expiryDays: number | null;
  },
  reason: string,
  platforms: string[],
) {
  return {
    product,
    name,
    developerName: PRESENTATION[product]?.developerName ?? null,
    tintColor: product === "pixel-forge" ? "#7a2430" : null,
    website: null,
    iconUrl: ART[product] ? `/media/${product}/icon?v=1` : null,
    headerUrl: ART[product] ? `/media/${product}/header?v=1` : null,
    support: null,
    platforms,
    offer: {
      ...offer,
      expiresAt:
        offer.expiryDays === null ? null : NOW + offer.expiryDays * DAY,
    },
    reason,
  };
}

const OFFERS = [
  discoverOffer(
    "quill",
    "Quill",
    {
      tier: "personal",
      tierLabel: "Personal",
      deviceLimit: 0,
      expiryDays: null,
    },
    "free_with_account",
    ["web", "macos", "ios"],
  ),
  discoverOffer(
    "mossgarden",
    "Mossgarden",
    {
      tier: "lifetime",
      tierLabel: "Lifetime",
      deviceLimit: 5,
      expiryDays: null,
    },
    "free_with_account",
    ["macos", "windows", "ios", "android"],
  ),
  discoverOffer(
    "lumen-raw",
    "Lumen RAW",
    { tier: "beta", tierLabel: "Beta", deviceLimit: 2, expiryDays: 90 },
    "group:Aperture Seven customers",
    ["macos", "windows"],
  ),
  discoverOffer(
    "pixel-forge",
    "Pixel Forge SDK",
    { tier: "indie", tierLabel: "Indie", deviceLimit: 0, expiryDays: null },
    "group:fennick.studio",
    ["macos", "windows", "linux"],
  ),
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
    case "accountWide":
      return [NIGHTFALL, QUILL_WIDE, DRIFT_KEY, DRIFT_WIDE];
    default:
      return [];
  }
}

function productDevice(
  deviceId: string,
  label: string,
  platform: string,
  appVersion: string,
  lastSeen: number,
) {
  return {
    deviceId,
    label,
    platform,
    arch: "x86_64",
    appVersion,
    firstSeen: NOW - 300 * DAY,
    lastSeen,
    dormant: false,
  };
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
  const openOffers = () =>
    s === "twelve"
      ? []
      : OFFERS.filter((o) => !licenses.some((l) => l.product === o.product));
  const routes: Record<string, Handler> = {
    "/api/me": { body: { account: ACCOUNT, csrf: "csrf" } },
    "/api/capabilities": { body: CAPS },
    "/api/licenses": () => ({ body: { licenses } }),
    // One item per product (the first licence listed is the best), like the Worker.
    "/api/library": () => ({
      body: {
        products: firstPerProduct(licenses).map((l) => ({
          ...libraryItem(l),
          licenseCount: licenses.filter((x) => x.product === l.product).length,
        })),
        discoverCount: openOffers().length,
      },
    }),
    "/api/discover": () => ({ body: { offers: openOffers() } }),
    "/api/products/nightfall/downloads": { body: nightfallDownloads() },
    "/api/products/tidewater/downloads": { body: tidewaterDownloads() },
    "/api/products/ember-tactics/downloads": { body: emberDownloads() },
    "POST /api/activate/preview": (req) => {
      const { key } = req.postDataJSON() as { key: string };
      if (key !== GOOD_KEY)
        return { body: { verdict: "unknown", product: null, entries: null } };
      return {
        body: {
          verdict: licenses.some((l) => l.product === "mossgarden")
            ? "already_yours"
            : "addable",
          product: {
            slug: "mossgarden",
            name: "Mossgarden",
            developerName: "Little Fern",
            iconUrl: null,
            headerUrl: null,
          },
          entries: null,
          license: {
            tier: "standard",
            tierLabel: "Standard",
            status: "active",
            usable: true,
            expiresAt: null,
            deviceLimit: 5,
          },
          platforms: ["macos", "windows", "linux"],
        },
      };
    },
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
  const ALL = [
    NIGHTFALL,
    TIDEWATER,
    EMBER,
    MOSSGARDEN,
    ...MORE.filter((l) => l.product !== "quill"),
    QUILL_WIDE,
    DRIFT_WIDE,
  ];
  // Quill is keyless in every scenario that lists it; only "accountWide" gives it a device.
  const quill =
    s === "accountWide" ? QUILL_WIDE : MORE.find((l) => l.product === "quill")!;
  for (const l of ALL.map((x) => (x.product === "quill" ? quill : x))) {
    const own = ACCOUNT_WIDE_DEVICE[l.id];
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
            : own && l.deviceCount
              ? [device(own[0], own[1], own[2], NOW - 3 * 3600)].filter(
                  (d) => !removed.has(d.deviceId),
                )
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
  // PX-10: the product view for the focused flows (seats, devices, declared return targets).
  for (const slug of new Set(ALL.map((x) => x.product))) {
    routes[`/api/products/${slug}`] = () => {
      const held = licenses.filter((x) => x.product === slug);
      const l = held[0];
      if (!l) return { status: 404, body: { error: "not_found" } };
      const item = libraryItem(l);
      const devices =
        l.product === "orbit-survey"
          ? [
              productDevice(
                "gaming",
                "Gaming PC",
                "windows",
                "2.0.3",
                NOW - DAY,
              ),
              productDevice(
                "work",
                "Work laptop",
                "windows",
                "1.9.0",
                NOW - 41 * DAY,
              ),
            ].filter((d) => !removed.has(d.deviceId))
          : [];
      const seats =
        l.product === "orbit-survey"
          ? devices.length
          : item.license.activeSeatCount;
      return {
        body: {
          ...item,
          services: { license: true, release: true },
          status:
            seats >= item.license.deviceLimit && item.license.deviceLimit > 0
              ? "device_limit"
              : item.status,
          returnTo: {
            origins: [`https://${l.product}.example`],
            schemes: [l.product.replace(/-/g, "")],
          },
          licenses: [
            {
              ...item.license,
              activeSeatCount: seats,
              deviceCount: seats,
              entitlements: [],
              devices,
            },
            // The product's other licences, with their own seats.
            ...held.slice(1).map((x) => ({
              ...libraryItem(x).license,
              entitlements: [],
              devices: [],
            })),
          ],
        },
      };
    };
  }
  // PX-11: Tidewater's private npm feed and this licence's tokens (F-21's portal API).
  const tokens = [
    {
      tokenId: "rt_ci",
      label: "CI build server",
      hint: "Hq2a",
      scopes: ["read"],
      ecosystems: null,
      presentation: "header",
      createdAt: NOW - 60 * DAY,
      expiresAt: NOW + 90 * DAY,
      lastUsedAt: (NOW - 3 * 3600) as number | null,
      revokedAt: null,
      status: "active",
    },
    {
      tokenId: "rt_laptop",
      label: "Laptop",
      hint: "j3eX",
      scopes: ["read"],
      ecosystems: null,
      presentation: "header",
      createdAt: NOW - 84 * DAY,
      expiresAt: NOW + 6 * DAY - 60,
      lastUsedAt: null as number | null,
      revokedAt: null,
      status: "active",
    },
  ];
  const tokensPath = "/api/licenses/tidewater/lic_tidewater/registry-tokens";
  routes[tokensPath] = () => ({
    body: {
      available: true,
      licenseUsable: true,
      registryOrigin: "https://pkg.plrs.im",
      username: "__token__",
      feeds: [
        {
          ecosystem: "npm",
          accessMode: "licensed",
          baseUrl: "https://pkg.plrs.im/npm/tidewater/",
        },
      ],
      tokens,
      limits: {
        minDays: 1,
        maxDays: 365,
        defaultDays: 90,
        urlDefaultDays: 365,
        perLicense: 10,
      },
    },
  });
  routes[`POST ${tokensPath}`] = (req) => {
    const { label } = req.postDataJSON() as { label: string };
    const view = {
      ...tokens[0]!,
      tokenId: "rt_new",
      label,
      hint: "Yj3e",
      lastUsedAt: null,
    };
    tokens.push(view);
    return {
      status: 201,
      body: { ok: true, token: "pkeyr_Lm9xT2qVb8sPzK4wNc7dRf1hYj3e", view },
    };
  };
  routes["DELETE /api/licenses/orbit-survey/lic_orbit-survey/devices/work"] =
    () => {
      removed.add("work");
      return { body: { ok: true, deviceId: "work" } };
    };
  // PX-W10's claim: mints once (idempotent); Lumen RAW's offer ended (409 `not_eligible`).
  for (const o of OFFERS) {
    routes[`POST /api/discover/${o.product}/claim`] = () => {
      if (o.product === "lumen-raw")
        return {
          status: 409,
          body: {
            error: "not_eligible",
            message: "this product is no longer offered to your account",
          },
        };
      const added = !licenses.some((l) => l.product === o.product);
      const l =
        o.product === "mossgarden"
          ? MOSSGARDEN
          : lic(o.product, o.name, {
              tier: o.offer.tier,
              identityProvider: "oidc",
              activatedAt: NOW - 30,
              deviceCount: 0,
            });
      if (added) licenses = [l, ...licenses];
      return {
        body: {
          added,
          product: o.product,
          license: {
            id: l.id,
            tier: o.offer.tier,
            tierLabel: o.offer.tierLabel,
            status: "active",
            usable: true,
            expiresAt: o.offer.expiresAt,
            deviceLimit: o.offer.deviceLimit,
          },
        },
      };
    };
  }
  for (const [id, [deviceId]] of Object.entries(ACCOUNT_WIDE_DEVICE)) {
    const product = id === "lic_quill" ? "quill" : "drift-kart";
    routes[`DELETE /api/licenses/${product}/${id}/devices/${deviceId}`] =
      () => {
        removed.add(deviceId);
        return { body: { ok: true, deviceId } };
      };
  }
  routes["DELETE /api/licenses/nightfall/lic_nightfall/devices/d2"] = () => {
    removed.add("d2");
    return { body: { ok: true, deviceId: "d2" } };
  };
  return routes;
}
