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
  /** Sign-in licences: Quill alone, and Drift Kart held by a Steam key and by signing in. */
  | "signIn"
  /**
   * PX-23's origins (S-24 D21): Tidewater Studio held twice, by a key Mara added to a licence
   * nobody was named for, and by one Harbor Audio assigned to her ("From Harbor Audio").
   */
  | "origins";

type Reply = { status?: number; body: unknown };
export type Handler = Reply | ((req: Request) => Reply);

/**
 * The fixtures' clock, fixed so the visual baselines (PX-20) are reproducible: the harness pins the
 * page's `Date` to the same instant (portalHarness.ts), so "2 hours ago" and every printed date read
 * the same on every run.
 */
export const FIXTURE_NOW = Date.UTC(2026, 9, 1, 12, 0, 0) / 1000;
const NOW = FIXTURE_NOW;
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

/** A sign-in licence (no key) with a device: the License card's "1 of 5 devices", "From signing in". */
const QUILL_SIGNIN = lic("quill", "Quill", {
  identityProvider: "oidc",
  keyCount: 0,
  activeKeyCount: 0,
  deviceCount: 1,
  activatedAt: NOW - 13 * DAY,
});
/** Drift Kart held twice: by a Steam key (the best, listed first) and by signing in. */
const DRIFT_KEY = MORE.find((l) => l.product === "drift-kart")!;
const DRIFT_SIGNIN = lic("drift-kart", "Drift Kart", {
  id: "lic_drift-kart-acct",
  identityProvider: "oidc",
  keyCount: 0,
  activeKeyCount: 0,
  deviceCount: 1,
  activatedAt: NOW - 3 * DAY,
});
/** PX-23: Tidewater's key licence as the Worker now reports it: a key Mara added. */
const TIDEWATER_KEY = {
  ...TIDEWATER,
  email: "",
  origin: "key",
  originStore: null,
  // Its key can bring it back, so Remove is offered (PX-23 review).
  removable: true,
};
/** PX-23: a second Tidewater licence, which Harbor Audio assigned to Mara's email. */
const TIDEWATER_FREE = lic("tidewater", "Tidewater Studio", {
  id: "lic_tidewater-free",
  tier: "free",
  deviceCount: 1,
  activatedAt: NOW - 20 * DAY,
  origin: "developer",
  originStore: null,
  removable: true,
});
const SIGN_IN_DEVICE: Record<string, [string, string, string]> = {
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
  "lumen-raw": { developerName: "Aperture Seven", deviceLimit: 2 },
  "pixel-forge": { developerName: "Anvil Labs", deviceLimit: 0 },
  // At its limit: the 12-product shelf shows "Free a device" (§4.15, mockup 35).
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

/** The media proxy's answer for `/media/<product>/<icon|header>` and account pictures, or null (404). */
export function portalMedia(pathname: string): Buffer | null {
  // PX-W16/PX-22: `/media/avatar/<asset>[-96]`, the stored account pictures.
  const a = pathname.match(/^\/media\/avatar\/([0-9a-f]{64})(-96)?$/);
  if (a) {
    const art = AVATAR_ART[a[1]!];
    const size = a[2] ? 96 : 256;
    return art ? artPng(size, size, art.bands, art.disc) : null;
  }
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
    case "signIn":
      return [NIGHTFALL, QUILL_SIGNIN, DRIFT_KEY, DRIFT_SIGNIN];
    case "origins":
      return [TIDEWATER_KEY, TIDEWATER_FREE];
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

// ── Account → Profile (PX-W16's `GET|PATCH /api/me/profile`, upload; PX-22) ─────────────────

const asset = (seed: string): string => seed.repeat(64).slice(0, 64);
const pic = (a: string) => ({
  asset: a,
  url: `/media/avatar/${a}`,
  url96: `/media/avatar/${a}-96`,
});
const STEAM_ASSET = asset("5e");
const GOOGLE_ASSET = asset("6a");
export const UPLOAD_ASSET = asset("7c");
/** Stand-in pictures: Steam's fox orange, Google's teal, the upload's violet. */
const AVATAR_ART: Record<string, { bands: Rgb[]; disc: Rgb }> = {
  [STEAM_ASSET]: {
    bands: [
      [214, 104, 40],
      [178, 78, 30],
    ],
    disc: [250, 232, 210],
  },
  [GOOGLE_ASSET]: {
    bands: [
      [96, 160, 170],
      [62, 118, 128],
    ],
    disc: [232, 196, 170],
  },
  [UPLOAD_ASSET]: {
    bands: [
      [92, 64, 170],
      [60, 40, 120],
    ],
    disc: [236, 226, 255],
  },
};

const PROFILE_SOURCES = [
  {
    linkId: "lnk_steam",
    provider: "steam",
    label: "marafox",
    name: "marafox",
    picture: pic(STEAM_ASSET),
  },
  {
    linkId: "lnk_google",
    provider: "google",
    label: "mara.fennick@gmail.com",
    name: "Mara Fennick",
    picture: pic(GOOGLE_ASSET),
  },
  {
    linkId: "lnk_gc",
    provider: "gamecenter",
    label: "Mara F.",
    name: "Mara F.",
    picture: null,
  },
];

type Profile = {
  displayName: string | null;
  displayNameSource: Record<string, unknown> | null;
  explicitName: boolean;
  picture: ReturnType<typeof pic> | null;
  pictureSource: Record<string, unknown> | null;
  explicitPicture: boolean;
  locale: string | null;
  sources: typeof PROFILE_SOURCES;
};

/** Every signed-in scenario: a typed name and Initials chosen, so the chip shows initials. */
const PROFILE_INITIALS: Profile = {
  displayName: ACCOUNT.name,
  displayNameSource: { kind: "typed" },
  explicitName: true,
  picture: null,
  pictureSource: { kind: "initials" },
  explicitPicture: true,
  locale: "en-US",
  sources: PROFILE_SOURCES,
};

/** Frames 36 and 50: a typed name and the Steam picture, both chosen. */
export const PROFILE_STEAM: Profile = {
  ...PROFILE_INITIALS,
  picture: pic(STEAM_ASSET),
  pictureSource: { kind: "provider", linkId: "lnk_steam", provider: "steam" },
};

/**
 * The profile routes over one profile: GET answers it, PATCH applies an explicit choice the way
 * the Worker does (`card/profile.ts`), the upload answers a stored asset, and `GET /api/me`
 * carries the profile's name and picture as the Worker derives them. `patches` records each body.
 */
export function profileRoutes(
  start: Profile = PROFILE_INITIALS,
  patches: unknown[] = [],
): Record<string, Handler> {
  let profile = start;
  const source = (linkId: string) =>
    profile.sources.find((o) => o.linkId === linkId)!;
  return {
    "/api/me": () => ({
      body: {
        account: {
          ...ACCOUNT,
          name: profile.displayName ?? ACCOUNT.name,
          avatarUrl: profile.picture?.url ?? null,
        },
        csrf: "csrf",
      },
    }),
    "GET /api/me/profile": () => ({ body: { profile } }),
    "PATCH /api/me/profile": (req) => {
      const change = req.postDataJSON() as {
        name?: string;
        nameFrom?: string;
        picture?: "initials" | { from?: string; upload?: string };
      };
      patches.push(change);
      const next = { ...profile };
      if (change.name !== undefined) {
        next.displayName = change.name;
        next.displayNameSource = { kind: "typed" };
        next.explicitName = true;
      } else if (change.nameFrom) {
        const o = source(change.nameFrom);
        next.displayName = o.name;
        next.displayNameSource = {
          kind: "provider",
          linkId: o.linkId,
          provider: o.provider,
        };
        next.explicitName = true;
      }
      const p = change.picture;
      if (p === "initials") {
        next.picture = null;
        next.pictureSource = { kind: "initials" };
      } else if (p?.from) {
        const o = source(p.from);
        next.picture = o.picture;
        next.pictureSource = {
          kind: "provider",
          linkId: o.linkId,
          provider: o.provider,
        };
      } else if (p?.upload) {
        next.picture = pic(p.upload);
        next.pictureSource = { kind: "upload" };
      }
      if (p) next.explicitPicture = true;
      profile = next;
      return { body: { profile } };
    },
    "POST /api/me/profile/picture": () => ({
      status: 201,
      body: { upload: pic(UPLOAD_ASSET) },
    }),
  };
}

// ── Account → Sign-in methods and Where you're signed in (PX-13; frames 36 to 38) ─────────────

/** Mara's sign-in methods (frame 36), shaped like `GET /api/me/methods` (PX-W12). */
export const MARA_METHODS = (() => {
  const m = (
    id: string,
    kind: string,
    label: string,
    group: "accounts" | "email" | "passkeys",
    display: string | null,
    connectedAt: number,
    lastUsedAt: number | null,
    tenantScoped = false,
  ) => ({
    id,
    kind,
    group,
    label,
    display,
    connectedAt,
    lastUsedAt,
    canRemove: true,
    reason: null,
    flag: null,
    relay: false,
    tenantScoped,
  });
  const AUG_12 = Date.UTC(2026, 7, 12, 10) / 1000;
  const JUL_3 = Date.UTC(2026, 6, 3, 10) / 1000;
  const AUG_2 = Date.UTC(2026, 7, 2, 10) / 1000;
  const SEP_19 = Date.UTC(2026, 8, 19, 10) / 1000;
  return {
    methods: [
      m(
        "lnk_google",
        "google",
        "Google",
        "accounts",
        "mara.fennick@gmail.com",
        AUG_12,
        NOW - 21 * DAY,
      ),
      m(
        "lnk_steam",
        "steam",
        "Steam",
        "accounts",
        "marafox",
        JUL_3,
        NOW - 3 * 3600,
      ),
      m(
        "lnk_gc",
        "gamecenter",
        "Game Center",
        "accounts",
        "Mara F.",
        JUL_3,
        NOW - DAY,
        true,
      ),
      m(
        "lnk_mail1",
        "email",
        "Email",
        "email",
        ACCOUNT.email,
        JUL_3,
        NOW - 14 * DAY,
      ),
      m(
        "lnk_mail2",
        "email",
        "Email",
        "email",
        "mara.f@proton.me",
        AUG_2,
        null,
      ),
      m(
        "lnk_pk1",
        "passkey",
        "Passkey",
        "passkeys",
        "Safari on macOS",
        AUG_2,
        NOW - 2 * 3600,
      ),
      m(
        "lnk_pk2",
        "passkey",
        "Passkey",
        "passkeys",
        "Chrome on Windows",
        SEP_19,
        NOW - 4 * DAY,
      ),
    ],
    emails: [
      {
        methodId: "lnk_mail1",
        email: ACCOUNT.email,
        primary: true,
        connectedAt: JUL_3,
        lastUsedAt: NOW - 14 * DAY,
        canRemove: true,
        reason: null,
      },
      {
        methodId: "lnk_mail2",
        email: "mara.f@proton.me",
        primary: false,
        connectedAt: AUG_2,
        lastUsedAt: null,
        canRemove: true,
        reason: null,
      },
    ],
    passkeys: [
      {
        id: "cGFzc2tleS1pY2xvdWQ",
        methodId: "lnk_pk1",
        createdAt: AUG_2,
        lastUsedAt: NOW - 2 * 3600,
        transports: ["internal", "hybrid"],
        synced: true,
        aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
        addedFrom: "Safari on macOS",
        canRemove: true,
        reason: null,
      },
      {
        id: "cGFzc2tleS0xcGFzc3dvcmQ",
        methodId: "lnk_pk2",
        createdAt: SEP_19,
        lastUsedAt: NOW - 4 * DAY,
        transports: ["internal"],
        synced: true,
        aaguid: "bada5566-a7aa-401f-bd96-45619a55120d",
        addedFrom: "Chrome on Windows",
        canRemove: true,
        reason: null,
      },
    ],
    providers: [
      { kind: "apple", connected: false, available: true },
      { kind: "google", connected: true, available: true },
      { kind: "steam", connected: true, available: true },
    ],
    passkey: { canAdd: true, reason: null },
    primaryEmail: ACCOUNT.email,
    hideMyEmail: false,
    // Signed in an hour ago: a change asks to confirm it's you first (frame 37).
    stepUp: {
      authenticatedAt: NOW - 3600,
      freshUntil: NOW - 3300,
      fresh: false,
      maxAgeSeconds: 300,
    },
  };
})();

/** Mara's browsers (`GET /api/sessions`, I-07), this one first. */
const MARA_SESSIONS = [
  {
    id: "sess_this_browser_00001",
    createdAt: NOW - 3 * DAY,
    lastSeenAt: NOW - 60,
    expiresAt: NOW + 27 * DAY,
    browser: "Chrome on macOS",
    methods: ["passkey"],
    current: true,
  },
  {
    id: "sess_phone_000000002",
    createdAt: NOW - 9 * DAY,
    lastSeenAt: NOW - DAY,
    expiresAt: NOW + 21 * DAY,
    browser: "Safari on iOS",
    methods: ["email"],
    current: false,
  },
  {
    id: "sess_desktop_00000003",
    createdAt: NOW - 20 * DAY,
    lastSeenAt: NOW - 2 * DAY,
    expiresAt: NOW + 10 * DAY,
    browser: "Firefox on Windows",
    methods: ["steam"],
    current: false,
  },
];

/** Sign-in methods and sessions for Mara's signed-in scenarios. */
function accountRoutes(): Record<string, Handler> {
  return {
    "GET /api/me/methods": { body: MARA_METHODS },
    "GET /api/sessions": { body: { sessions: MARA_SESSIONS } },
  };
}

const SAM_RELAY = "x7k2mq9p4d@privaterelay.appleid.com";

/**
 * Frame 38: Sam Okafor, whose only method is Sign in with Apple through Hide My Email. His
 * account page shows the last-method guard and the Hide My Email notice.
 */
export function samRoutes(): Record<string, Handler> {
  const SAM = { id: "acct_sam", name: "Sam Okafor", email: SAM_RELAY };
  return {
    "/api/me": { body: { account: { ...SAM, avatarUrl: null }, csrf: "csrf" } },
    "GET /api/me/profile": {
      body: {
        profile: {
          displayName: "Sam Okafor",
          displayNameSource: {
            kind: "provider",
            linkId: "lnk_apple",
            provider: "apple",
          },
          explicitName: false,
          picture: null,
          pictureSource: { kind: "initials" },
          explicitPicture: false,
          locale: "en-US",
          sources: [
            {
              linkId: "lnk_apple",
              provider: "apple",
              label: SAM_RELAY,
              name: "Sam Okafor",
              picture: null,
            },
          ],
        },
      },
    },
    "GET /api/me/methods": {
      body: {
        methods: [
          {
            id: "lnk_apple",
            kind: "apple",
            group: "accounts",
            label: "Apple",
            display: SAM_RELAY,
            connectedAt: NOW - 3600,
            lastUsedAt: NOW - 60,
            canRemove: false,
            reason: "last_link",
            flag: null,
            relay: true,
            tenantScoped: false,
          },
        ],
        emails: [],
        passkeys: [],
        providers: [
          { kind: "apple", connected: true, available: true },
          { kind: "google", connected: false, available: true },
          { kind: "steam", connected: false, available: true },
        ],
        passkey: { canAdd: false, reason: "email_unverified" },
        primaryEmail: SAM_RELAY,
        hideMyEmail: true,
        stepUp: {
          authenticatedAt: NOW - 60,
          freshUntil: NOW + 240,
          fresh: true,
          maxAgeSeconds: 300,
        },
      },
    },
    "GET /api/sessions": { body: { sessions: [MARA_SESSIONS[0]] } },
  };
}

/** One scenario product with Identity on (§3.1), for the product page's sign-in card (PX-13). */
export function identityOn(
  s: PortalScenario,
  slug: string,
): Record<string, Handler> {
  const base = portalRoutes(s)[`/api/products/${slug}`] as (
    req: Request,
  ) => Reply;
  return {
    [`/api/products/${slug}`]: (req) => {
      const r = base(req);
      const body = r.body as { services: Record<string, boolean> };
      return {
        ...r,
        body: { ...body, services: { ...body.services, identity: true } },
      };
    },
  };
}

export function portalRoutes(s: PortalScenario): Record<string, Handler> {
  if (s === "signedOut") {
    return {
      "/api/me": { status: 401, body: { error: "unauthorized" } },
      "/api/capabilities": { body: CAPS },
      // The Worker's answer shape (I-07, PX-W4): the countdown reads `resendIn`.
      "POST /api/signin/email/start": {
        body: { ok: true, expiresIn: 600, codeLength: 6, resendIn: 60 },
      },
      "POST /api/signin/email/resend": {
        body: { ok: true, expiresIn: 600, codeLength: 6, resendIn: 60 },
      },
    };
  }
  let licenses = licensesFor(s);
  const removed = new Set<string>();
  const openOffers = () =>
    s === "twelve"
      ? []
      : OFFERS.filter((o) => !licenses.some((l) => l.product === o.product));
  const routes: Record<string, Handler> = {
    ...profileRoutes(),
    ...accountRoutes(),
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
    QUILL_SIGNIN,
    DRIFT_SIGNIN,
    TIDEWATER_FREE,
  ];
  // Quill is keyless in every scenario that lists it; only "signIn" gives it a device.
  const quill =
    s === "signIn" ? QUILL_SIGNIN : MORE.find((l) => l.product === "quill")!;
  for (const base of ALL.map((x) => (x.product === "quill" ? quill : x))) {
    const own = SIGN_IN_DEVICE[base.id];
    // The scenario's own copy of the licence when it holds one (PX-23's origins), else the base.
    const current = (): Lic =>
      licenses.find((x) => x.product === base.product && x.id === base.id) ??
      base;
    // PX-23: Remove from my library; it stays out of every later answer (LX-26's block).
    routes[`DELETE /api/licenses/${base.product}/${base.id}`] = () => {
      if (!licenses.some((x) => x.product === base.product && x.id === base.id))
        return { status: 404, body: { error: "not_found" } };
      licenses = licenses.filter(
        (x) => !(x.product === base.product && x.id === base.id),
      );
      return {
        body: { ok: true, product: base.product, licenseId: base.id },
      };
    };
    routes[`/api/licenses/${base.product}/${base.id}`] = () => {
      const l = current();
      return {
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
      };
    };
    routes[`POST /api/releases/${base.product}/rel_142/artifacts/n-mac/token`] =
      {
        status: 201,
        body: { url: "/download/tok" },
      };
  }
  // PX-W6: where each licence came from; Drift Kart's key licence was bought on Steam (store
  // name only, never an order id), so its origin reads "Steam key".
  const purchaseOf = (id: string) =>
    id === DRIFT_KEY.id
      ? { source: "store", store: "steam" }
      : { source: "developer", store: null };
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
              purchase: purchaseOf(l.id),
            },
            // The product's other licences, with their own seats.
            ...held.slice(1).map((x) => ({
              ...libraryItem(x).license,
              entitlements: [],
              devices: [],
              purchase: purchaseOf(x.id),
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
  for (const [id, [deviceId]] of Object.entries(SIGN_IN_DEVICE)) {
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
