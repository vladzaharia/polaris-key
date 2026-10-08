import type { Request } from "playwright";
import { qrSvg } from "../../worker/src/core/qr.js";
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
  | "origins"
  /**
   * The Polaris Key storefront (PS-05, notes/S-21 §6.5): Nightfall and Tidewater Studio held by
   * licence, Kestrel Maps (an open product) held by a library entry; Discover offers Lumen RAW two
   * ways (an operator-labelled group and a trial), Driftwood Notes (open), Mossgarden, and lists
   * Starfall Arena to everyone with only its Steam page.
   */
  | "storefront";

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

/** A sign-in licence (no key) with a device: Devices' "1 of 5 devices in use", "Automatic Grant". */
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
    // Markdown, as developers write it (owner polish 2026-10-07): a heading, bold, a link and
    // more than the summary's three items, so the product page shows Show full notes.
    notes:
      "## Highlights\n- **Photo Mode** with a free camera and depth of field.\n- Steam Deck: steadier 40 fps in the Lantern Caves.\n- Fixed controller rumble cutting out after a reload.\n- Subtitles keep their size after a resolution change.\n\n## Thanks\nTo everyone who sent a save file. More on [the Nightfall blog](https://nightfall.example.com/blog/1-4-2).",
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
  // PS-05's storefront cast.
  driftwood: { developerName: "Tern Studio", deviceLimit: 0 },
  "kestrel-maps": {
    developerName: "Harrier Labs",
    deviceLimit: 0,
    support: "https://harrier.example/help",
  },
  starfall: { developerName: "Comet Forge", deviceLimit: 0 },
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
  // PS-05: the storefront's open products and its link-only listing.
  driftwood: {
    bands: [
      [214, 204, 184],
      [150, 136, 112],
    ],
    disc: [62, 92, 110],
  },
  "kestrel-maps": {
    bands: [
      [28, 52, 46],
      [56, 98, 80],
    ],
    disc: [236, 214, 140],
  },
  starfall: {
    bands: [
      [16, 14, 40],
      [36, 26, 78],
    ],
    disc: [250, 196, 90],
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
  // PS-04: a listing's screenshots (`screenshot-<n>`) are 16:9 like its header.
  const m = pathname.match(
    /^\/media\/([a-z0-9-]+)\/(icon|header|screenshot-\d{1,2})$/,
  );
  const art = m ? ART[m[1]!] : undefined;
  if (!m || !art || (m[2] === "icon" && art.icon === false)) return null;
  if (m[2]!.startsWith("screenshot-"))
    return artPng(640, 360, [...art.bands].reverse(), art.disc);
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

/** The Worker's QR code of a link, as the downloads view carries it (`page/customer.ts`). */
function qrDataUri(text: string, label: string): string {
  const svg = qrSvg(text, `QR code: ${label}`)!;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Tidewater with the download page's install sources (P0-48): Homebrew under macOS, Scoop under
 * Windows, AltStore under iPhone and iPad, F-Droid (with its fingerprint) under Android.
 */
export function tidewaterInstallSources() {
  const base = tidewaterDownloads();
  const HOST = "https://keys.harbor-audio.example/tidewater/distribution";
  const source = `${HOST}/altstore/stable/source.json`;
  const fp = "a3f1c09e7b5d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a3c5e7b9d1f";
  const repo = `${HOST}/fdroid/stable/repo?fingerprint=${fp}`;
  const altDeep = `altstore://source?url=${encodeURIComponent(source)}`;
  const fdroidDeep = `fdroidrepos://${repo.slice("https://".length)}`;
  const link = (o: Record<string, unknown>) => ({
    outletId: "main",
    url: null,
    deepLink: null,
    command: null,
    activateUrl: null,
    live: true,
    version: "2.4.1",
    fingerprint: null,
    qr: null,
    ...o,
  });
  return {
    ...base,
    installSources: [
      link({
        id: "homebrew:main",
        kind: "homebrew",
        platforms: ["macos"],
        label: "Homebrew",
        command: "brew install --cask tidewater-studio",
        version: null,
      }),
      link({
        id: "scoop:main",
        kind: "scoop",
        platforms: ["windows"],
        label: "Scoop",
        command: `scoop install ${HOST}/scoop/stable.json`,
      }),
      link({
        id: "altstore:alt",
        kind: "altstore",
        outletId: "alt",
        platforms: ["ios"],
        label: "Add to AltStore",
        url: source,
        deepLink: altDeep,
        qr: qrDataUri(altDeep, "Add to AltStore"),
      }),
      link({
        id: "fdroid:fd",
        kind: "fdroid",
        outletId: "fd",
        platforms: ["android"],
        label: "Add to F-Droid",
        url: repo,
        deepLink: fdroidDeep,
        fingerprint: fp,
        qr: qrDataUri(fdroidDeep, "Add to F-Droid"),
      }),
    ],
  };
}

/**
 * Ember Tactics: expired. The Worker ends a licence at its end date (P0-47), so no file is
 * downloadable: each says `license_inactive` ("Needs an active license"), and nothing is
 * recommended, as the License card's "Renew … to use it again" says.
 */
function emberDownloads() {
  const inactive = { canDownload: false, reason: "license_inactive" };
  const m20 = file(
    "rel_200",
    "2.0",
    "e2-mac",
    "EmberTactics-2.0.dmg",
    "macos",
    "universal",
    inactive,
  );
  const w20 = file(
    "rel_200",
    "2.0",
    "e2-win",
    "EmberTactics-2.0.exe",
    "windows",
    "x86_64",
    inactive,
  );
  return {
    product: { slug: "ember-tactics", name: "Ember Tactics" },
    channel: "stable",
    available: true,
    access: "licensed",
    detected: { platform: "macos", arch: null, touchAmbiguous: false },
    latest: {
      releaseId: "rel_200",
      version: "2.0",
      title: null,
      publishedAt: NOW - 10 * DAY,
    },
    recommended: null,
    platforms: [
      {
        platform: "macos",
        label: "macOS",
        recommended: null,
        files: [m20],
      },
      {
        platform: "windows",
        label: "Windows",
        recommended: null,
        files: [w20],
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
  const terms = {
    ...offer,
    expiresAt: offer.expiryDays === null ? null : NOW + offer.expiryDays * DAY,
  };
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
    offer: terms,
    reason,
    // PS-04's additive shape: the action, every path (here the one its reason names) and the
    // listing's one line and store pages.
    shortDescription: null as string | null,
    cta: "add" as "add" | "link",
    paths: [identityPath(reason, terms)] as unknown[],
    stores: [] as unknown[],
  };
}

/** The identity path a PX-W10 reason names (`free_with_account`, `group:<g>`), with its terms. */
function identityPath(
  reason: string,
  terms: unknown,
  label: string | null = null,
) {
  const group = reason.startsWith("group:") ? reason.slice(6) : null;
  return {
    kind: group === null ? "auto_issue" : "group",
    detail: group,
    label,
    terms,
    action: "add",
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

/**
 * PS-05's storefront (notes/S-21 §6.5), as PS-04's `GET /api/discover` sends it: Lumen RAW two
 * ways (the group, with the operator's label, first; a 14-day trial for every account), Mossgarden
 * as in mockup 23, Driftwood Notes with nothing to licence (`open`), and Starfall Arena listed to
 * everyone with only its Steam page (`cta: "link"`).
 */
const STEAM_STARFALL = {
  id: "steam:main",
  kind: "steam",
  label: "Steam",
  url: "https://store.example/steam/starfall",
};
const STEAM_LUMEN = {
  id: "steam:main",
  kind: "steam",
  label: "Steam",
  url: "https://store.example/steam/lumen-raw",
};
const LUMEN_STOREFRONT = (() => {
  const base = discoverOffer(
    "lumen-raw",
    "Lumen RAW",
    {
      tier: "standard",
      tierLabel: "Standard",
      deviceLimit: 2,
      expiryDays: null,
    },
    "group:aperture-customers",
    ["macos", "windows"],
  );
  const trial = {
    tier: "trial",
    tierLabel: "Trial",
    deviceLimit: 1,
    expiresAt: NOW + 14 * DAY,
    expiryDays: 14,
  };
  return {
    ...base,
    shortDescription: "RAW development for night skies",
    paths: [
      identityPath("group:aperture-customers", base.offer, "Aperture Seven"),
      {
        kind: "auto_issue",
        detail: null,
        label: null,
        terms: trial,
        action: "add",
        reason: "free_with_account",
      },
    ],
  };
})();
const DRIFTWOOD_OPEN = {
  ...discoverOffer(
    "driftwood",
    "Driftwood Notes",
    { tier: "", tierLabel: "", deviceLimit: 0, expiryDays: null },
    "open",
    ["macos", "linux"],
  ),
  website: "https://tern.example",
  offer: null,
  shortDescription: "A quiet notebook for field recordings",
  paths: [
    {
      kind: "open",
      detail: null,
      label: null,
      terms: null,
      action: "add",
      reason: "open",
    },
  ],
};
const STARFALL_LINK = {
  ...discoverOffer(
    "starfall",
    "Starfall Arena",
    { tier: "", tierLabel: "", deviceLimit: 0, expiryDays: null },
    "",
    ["windows", "linux"],
  ),
  offer: null,
  reason: null,
  cta: "link" as const,
  shortDescription: "Arena battles between the stars",
  paths: [],
  stores: [STEAM_STARFALL],
};
const STOREFRONT_OFFERS = [
  LUMEN_STOREFRONT,
  OFFERS[1]!,
  DRIFTWOOD_OPEN,
  STARFALL_LINK,
];

/** `GET /api/discover/<p>`: the offer plus its listing (description, screenshots, every store). */
const STOREFRONT_PAGES: Record<string, Record<string, unknown>> = {
  "lumen-raw": {
    description:
      "Develop RAW files from long exposures without losing the faint stars.\nStack a night's frames, pull out the Milky Way and keep the foreground sharp.",
    screenshots: [
      "/media/lumen-raw/screenshot-0?v=1",
      "/media/lumen-raw/screenshot-1?v=1",
    ],
    stores: [STEAM_LUMEN],
  },
  driftwood: {
    description:
      "Record, tag and transcribe field recordings in one quiet notebook. Free to use, with no license.",
    screenshots: ["/media/driftwood/screenshot-0?v=1"],
    stores: [],
  },
  starfall: {
    description:
      "Short arena battles between ships of light. Free on Steam for everyone with a Polaris Key account.",
    screenshots: ["/media/starfall/screenshot-0?v=1"],
    stores: [STEAM_STARFALL],
  },
};

/** An open product's library entry (PS-04): no licence, always active, with its presentation. */
function entryItem(product: string, name: string, addedAt: number) {
  const pres = PRESENTATION[product];
  return {
    product,
    name,
    developerName: pres?.developerName ?? null,
    tintColor: null,
    website: `https://${product}.example`,
    iconUrl: ART[product] ? `/media/${product}/icon?v=1` : null,
    headerUrl: ART[product] ? `/media/${product}/header?v=1` : null,
    support: pres?.support ? { url: pres.support, email: null } : null,
    kind: "entry",
    via: "open",
    status: "active",
    license: null,
    licenseCount: 0,
    addedAt,
  };
}
type Entry = ReturnType<typeof entryItem>;

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
    case "storefront":
      return [NIGHTFALL, TIDEWATER];
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
  // PS-05: open products held by a library entry (PS-04), no licence behind them.
  let entries: Entry[] =
    s === "storefront"
      ? [entryItem("kestrel-maps", "Kestrel Maps", NOW - 3 * DAY)]
      : [];
  const removed = new Set<string>();
  const offers = s === "storefront" ? STOREFRONT_OFFERS : OFFERS;
  const holds = (slug: string) =>
    licenses.some((l) => l.product === slug) ||
    entries.some((e) => e.product === slug);
  const openOffers = () =>
    s === "twelve" ? [] : offers.filter((o) => !holds(o.product));
  const routes: Record<string, Handler> = {
    ...profileRoutes(),
    ...accountRoutes(),
    "/api/capabilities": { body: CAPS },
    "/api/licenses": () => ({ body: { licenses } }),
    // One item per product (the first licence listed is the best), like the Worker.
    "/api/library": () => ({
      body: {
        products: [
          ...firstPerProduct(licenses).map((l) => ({
            ...libraryItem(l),
            licenseCount: licenses.filter((x) => x.product === l.product)
              .length,
          })),
          ...entries,
        ],
        // Offers to add, open products included; never a link (S-21 §6.10 item 8).
        discoverCount: openOffers().filter((o) => o.cta === "add").length,
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
            // The hosted art, as the Worker fills it (HA-07): the media proxy's URLs.
            iconUrl: "/media/mossgarden/icon?v=1",
            headerUrl: "/media/mossgarden/header?v=1",
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
  // PX-W10's claim, by path since PS-04: mints once (idempotent), or adds an open product's library
  // entry; Lumen RAW's offer ended (409 `not_eligible`) outside the storefront scenario.
  for (const o of offers) {
    routes[`POST /api/discover/${o.product}/claim`] = (req) => {
      const asked = (req.postDataJSON() as { path?: string } | null)?.path;
      const path = (
        o.paths as Array<{ kind: string; terms: { tier: string } | null }>
      ).find((p, i) => (asked ? p.kind === asked : i === 0));
      if (
        !path ||
        o.cta !== "add" ||
        (o.product === "lumen-raw" && s !== "storefront")
      )
        return {
          status: 409,
          body: {
            error: "not_eligible",
            message: "this product is no longer offered to your account",
          },
        };
      const added = !holds(o.product);
      if (path.kind === "open") {
        if (added) entries = [...entries, entryItem(o.product, o.name, NOW)];
        return {
          body: {
            added,
            product: o.product,
            kind: "entry",
            entry: { via: "open", addedAt: NOW },
          },
        };
      }
      const terms = path.terms as {
        tier: string;
        tierLabel: string;
        expiresAt: number | null;
        deviceLimit: number;
      };
      const l =
        o.product === "mossgarden"
          ? MOSSGARDEN
          : lic(o.product, o.name, {
              tier: terms.tier,
              identityProvider: "oidc",
              keyCount: 0,
              activeKeyCount: 0,
              activatedAt: NOW - 30,
              deviceCount: 0,
            });
      if (added) licenses = [l, ...licenses];
      return {
        body: {
          added,
          product: o.product,
          kind: "license",
          license: {
            id: l.id,
            tier: terms.tier,
            tierLabel: terms.tierLabel,
            status: "active",
            usable: true,
            expiresAt: terms.expiresAt,
            deviceLimit: terms.deviceLimit,
          },
        },
      };
    };
    // PS-04's storefront page: the same one 404 for anything this account can't add now.
    routes[`GET /api/discover/${o.product}`] = () =>
      holds(o.product) || s === "twelve"
        ? { status: 404, body: { error: "not_found" } }
        : { body: { ...o, ...STOREFRONT_PAGES[o.product] } };
  }
  // PS-04: an entry's product view (no licences) and Remove from library (entries only).
  for (const slug of ["kestrel-maps", "driftwood"]) {
    routes[`/api/products/${slug}`] = () => {
      const e = entries.find((x) => x.product === slug);
      if (!e) return { status: 404, body: { error: "not_found" } };
      return {
        body: {
          ...e,
          services: { license: false, distribution: true },
          returnTo: { origins: [], schemes: [] },
          licenses: [],
        },
      };
    };
    routes[`DELETE /api/library/${slug}`] = () => {
      if (!entries.some((x) => x.product === slug))
        return { status: 404, body: { error: "not_found" } };
      entries = entries.filter((x) => x.product !== slug);
      return { body: { ok: true, product: slug } };
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
