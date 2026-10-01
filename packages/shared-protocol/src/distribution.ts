// @polaris-key/protocol/distribution — outlet kinds and capabilities (WIRE-CONTRACT-V4 §8,
// plans/P3-01.md §2.9). Every SDK, the Worker and `outlet-matrix.json` hold these same tables;
// the Node runner asserts them equal to the matrix, and the generator restates them as literals.
//
// `OUTLET_KINDS`, `OutletKind` and `OUTLET_ID_PATTERN` moved here from `@polaris-key/manifest`
// (P2b-02), which re-exports them with the same values and order.

/** Every outlet kind (README §3.1 "outlet"). An outlet id that is one of these needs no `kind`. */
export const OUTLET_KINDS = [
  "direct",
  "app-store",
  "testflight",
  "altstore",
  "altstore-pal",
  "play",
  "play-testing",
  "obtainium",
  "fdroid-repo",
  "ms-store",
  "app-installer",
  "steam",
  "itch",
  "flathub",
  "snap",
  "winget",
  "web",
] as const;
export type OutletKind = (typeof OUTLET_KINDS)[number];

/** Outlet ids: lower-case, starting with a letter, at most 64 characters (`altstore-beta`). */
export const OUTLET_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** A detection result, never a kind: nothing can declare it, and it never has a feed entry. */
export const OUTLET_UNKNOWN = "unknown";

/** Who installs a new build, narrowest first: the platform, a store, or the SDK itself. */
export const BINARY_UPDATES_ORDER = ["none", "store", "self"] as const;
export type BinaryUpdates = (typeof BINARY_UPDATES_ORDER)[number];

/** What an install may do, by the outlet it arrived through (the six fields of the Worker's
 *  `outletCapabilities` hook, without the outlet id). */
export interface OutletCapabilities {
  binaryUpdates: BinaryUpdates;
  codeUpdates: boolean;
  dataUpdates: boolean;
  channelSwitch: boolean;
  commerce: "own" | "store-iap" | "steam" | "none";
  downloadedScripts: boolean;
}

const STORE: OutletCapabilities = {
  binaryUpdates: "store",
  codeUpdates: false,
  dataUpdates: true,
  channelSwitch: false,
  commerce: "store-iap",
  downloadedScripts: false,
};
const STORE_OWN: OutletCapabilities = { ...STORE, commerce: "own" };
const PLATFORM_OWN: OutletCapabilities = {
  ...STORE_OWN,
  binaryUpdates: "none",
};

/** The capability defaults per outlet kind, and for `unknown` (plans/P3-01.md §2.9). The feed
 *  and a platform or subkind can narrow them; nothing widens them. */
export const OUTLET_CAPABILITY_DEFAULTS: Readonly<
  Record<OutletKind | typeof OUTLET_UNKNOWN, OutletCapabilities>
> = {
  direct: {
    binaryUpdates: "self",
    codeUpdates: true,
    dataUpdates: true,
    channelSwitch: true,
    commerce: "own",
    downloadedScripts: true,
  },
  "app-store": STORE,
  testflight: STORE,
  altstore: STORE_OWN,
  "altstore-pal": STORE_OWN,
  play: STORE,
  "play-testing": STORE,
  obtainium: STORE_OWN,
  "fdroid-repo": STORE_OWN,
  "ms-store": STORE,
  "app-installer": PLATFORM_OWN,
  winget: PLATFORM_OWN,
  steam: { ...PLATFORM_OWN, commerce: "steam" },
  itch: PLATFORM_OWN,
  flathub: PLATFORM_OWN,
  snap: PLATFORM_OWN,
  web: { ...PLATFORM_OWN, downloadedScripts: true },
  unknown: {
    binaryUpdates: "none",
    codeUpdates: false,
    dataUpdates: false,
    channelSwitch: false,
    commerce: "none",
    downloadedScripts: false,
  },
};

/** The platforms each kind serves. `unknown` lists every platform (it can be anywhere). */
export const OUTLET_PLATFORMS: Readonly<
  Record<OutletKind | typeof OUTLET_UNKNOWN, readonly string[]>
> = {
  direct: ["macos", "windows", "linux", "android", "ios"],
  "app-store": ["ios", "macos"],
  testflight: ["ios", "macos"],
  altstore: ["ios"],
  "altstore-pal": ["ios"],
  play: ["android"],
  "play-testing": ["android"],
  obtainium: ["android"],
  "fdroid-repo": ["android"],
  "ms-store": ["windows"],
  "app-installer": ["windows"],
  winget: ["windows"],
  steam: ["windows", "macos", "linux"],
  itch: ["windows", "macos", "linux"],
  flathub: ["linux"],
  snap: ["linux"],
  web: ["web"],
  unknown: ["macos", "ios", "android", "windows", "linux", "web"],
};

/** A narrowing: any subset of the capability fields. */
export type CapabilityNarrowing = Partial<OutletCapabilities>;

/** Per platform, per kind. On iOS a `direct` install is Web Distribution: it opens its page
 *  (`store`) and never loads code (S-07 row 13). */
export const PLATFORM_NARROWING: Readonly<
  Record<string, Readonly<Record<string, CapabilityNarrowing>>>
> = {
  ios: {
    direct: {
      binaryUpdates: "store",
      codeUpdates: false,
      downloadedScripts: false,
    },
  },
};

/** How a `direct` install was put on the device, where that changes who updates it. */
export const OUTLET_SUBKINDS = [
  "homebrew",
  "npm",
  "pnpm",
  "npx",
  "scoop",
  "chocolatey",
  "flatpak",
  "appimage",
] as const;
export type OutletSubkind = (typeof OUTLET_SUBKINDS)[number];

const PACKAGE_MANAGED: CapabilityNarrowing = {
  binaryUpdates: "none",
  codeUpdates: false,
};

/** A package manager or Flatpak updates the install; AppImageUpdate is a native method, so
 *  `appimage` narrows nothing. */
export const SUBKIND_NARROWING: Readonly<
  Record<OutletSubkind, CapabilityNarrowing>
> = {
  homebrew: PACKAGE_MANAGED,
  npm: PACKAGE_MANAGED,
  pnpm: PACKAGE_MANAGED,
  npx: PACKAGE_MANAGED,
  scoop: PACKAGE_MANAGED,
  chocolatey: PACKAGE_MANAGED,
  flatpak: PACKAGE_MANAGED,
  appimage: {},
};

/** The only prefixes a feed's `listingUrl` may start with, byte for byte, per kind. Every
 *  other kind carries no `listingUrl`. [I] until P3-10 opens each on a device. */
export const LISTING_URL_PREFIXES: Readonly<Record<string, readonly string[]>> =
  {
    "app-store": ["https://apps.apple.com/", "itms-apps://apps.apple.com/"],
    testflight: ["https://testflight.apple.com/join/"],
    play: [
      "https://play.google.com/store/apps/details?id=",
      "market://details?id=",
    ],
    "play-testing": [
      "https://play.google.com/apps/testing/",
      "https://play.google.com/store/apps/details?id=",
      "market://details?id=",
    ],
    "ms-store": [
      "https://apps.microsoft.com/detail/",
      "ms-windows-store://pdp/?productid=",
    ],
  };

/** How sure outlet detection is, strongest first (plans/P3-01.md §2.9). */
export const OUTLET_CONFIDENCES = [
  "attested",
  "declared",
  "heuristic",
  "stamp",
] as const;
export type OutletConfidence = (typeof OUTLET_CONFIDENCES)[number];
