// Reference: outlet kinds, capabilities and detection (plans/P3-01.md §2.9), restated as literals.
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import { hasOwn } from "./claims.js";

// ── Outlet kinds and capabilities (plans/P3-01.md §2.9), restated as literals ────────────────

export const REF_OUTLET_KINDS = [
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
export const REF_RELEASE_PLATFORMS = [
  "macos",
  "ios",
  "android",
  "windows",
  "linux",
  "web",
];
export const REF_OUTLET_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const REF_BINARY_ORDER = ["none", "store", "self"];

export interface RefCaps {
  binaryUpdates: string;
  codeUpdates: boolean;
  dataUpdates: boolean;
  channelSwitch: boolean;
  commerce: string;
  downloadedScripts: boolean;
}
const refCaps = (
  binaryUpdates: string,
  codeUpdates: boolean,
  dataUpdates: boolean,
  channelSwitch: boolean,
  commerce: string,
  downloadedScripts: boolean,
): RefCaps => ({
  binaryUpdates,
  codeUpdates,
  dataUpdates,
  channelSwitch,
  commerce,
  downloadedScripts,
});
/** §2.9's table, row for row; `platforms` is each kind's list (`unknown`: every platform). */
export const REF_KIND_TABLE: Record<string, RefCaps & { platforms: string[] }> =
  {
    direct: {
      ...refCaps("self", true, true, true, "own", true),
      platforms: ["macos", "windows", "linux", "android", "ios"],
    },
    "app-store": {
      ...refCaps("store", false, true, false, "store-iap", false),
      platforms: ["ios", "macos"],
    },
    testflight: {
      ...refCaps("store", false, true, false, "store-iap", false),
      platforms: ["ios", "macos"],
    },
    altstore: {
      ...refCaps("store", false, true, false, "own", false),
      platforms: ["ios"],
    },
    "altstore-pal": {
      ...refCaps("store", false, true, false, "own", false),
      platforms: ["ios"],
    },
    play: {
      ...refCaps("store", false, true, false, "store-iap", false),
      platforms: ["android"],
    },
    "play-testing": {
      ...refCaps("store", false, true, false, "store-iap", false),
      platforms: ["android"],
    },
    obtainium: {
      ...refCaps("store", false, true, false, "own", false),
      platforms: ["android"],
    },
    "fdroid-repo": {
      ...refCaps("store", false, true, false, "own", false),
      platforms: ["android"],
    },
    "ms-store": {
      ...refCaps("store", false, true, false, "store-iap", false),
      platforms: ["windows"],
    },
    "app-installer": {
      ...refCaps("none", false, true, false, "own", false),
      platforms: ["windows"],
    },
    steam: {
      ...refCaps("none", false, true, false, "steam", false),
      platforms: ["windows", "macos", "linux"],
    },
    itch: {
      ...refCaps("none", false, true, false, "own", false),
      platforms: ["windows", "macos", "linux"],
    },
    flathub: {
      ...refCaps("none", false, true, false, "own", false),
      platforms: ["linux"],
    },
    snap: {
      ...refCaps("none", false, true, false, "own", false),
      platforms: ["linux"],
    },
    winget: {
      ...refCaps("none", false, true, false, "own", false),
      platforms: ["windows"],
    },
    web: {
      ...refCaps("none", false, true, false, "own", true),
      platforms: ["web"],
    },
    unknown: {
      ...refCaps("none", false, false, false, "none", false),
      platforms: [...REF_RELEASE_PLATFORMS],
    },
  };
export const REF_PLATFORM_NARROWING: Record<
  string,
  Record<string, Partial<RefCaps>>
> = {
  ios: {
    direct: {
      binaryUpdates: "store",
      codeUpdates: false,
      downloadedScripts: false,
    },
  },
};
export const REF_SUBKINDS = [
  "homebrew",
  "npm",
  "pnpm",
  "npx",
  "scoop",
  "chocolatey",
  "flatpak",
  "appimage",
];
const REF_PACKAGE_MANAGED: Partial<RefCaps> = {
  binaryUpdates: "none",
  codeUpdates: false,
};
export const REF_SUBKIND_NARROWING: Record<string, Partial<RefCaps>> = {
  homebrew: REF_PACKAGE_MANAGED,
  npm: REF_PACKAGE_MANAGED,
  pnpm: REF_PACKAGE_MANAGED,
  npx: REF_PACKAGE_MANAGED,
  scoop: REF_PACKAGE_MANAGED,
  chocolatey: REF_PACKAGE_MANAGED,
  flatpak: REF_PACKAGE_MANAGED,
  appimage: {},
};
export const REF_LISTING_PREFIXES: Record<string, string[]> = {
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
export const REF_CONFIDENCES = ["attested", "declared", "heuristic", "stamp"];
export const CAP_BOOLS = [
  "codeUpdates",
  "dataUpdates",
  "channelSwitch",
  "downloadedScripts",
] as const;

/** Narrow `caps` by one narrowing: booleans AND, `binaryUpdates` the narrower, `commerce`
 *  becomes `none` only when told `none`; nothing widens. */
function refNarrow(
  caps: RefCaps,
  n: Record<string, unknown> | undefined,
): RefCaps {
  if (!n) return caps;
  const out = { ...caps };
  for (const k of CAP_BOOLS)
    if (typeof n[k] === "boolean") out[k] = out[k] && (n[k] as boolean);
  if (
    typeof n.binaryUpdates === "string" &&
    REF_BINARY_ORDER.includes(n.binaryUpdates)
  ) {
    if (
      REF_BINARY_ORDER.indexOf(n.binaryUpdates) <
      REF_BINARY_ORDER.indexOf(out.binaryUpdates)
    )
      out.binaryUpdates = n.binaryUpdates;
  }
  if (n.commerce === "none") out.commerce = "none";
  return out;
}

export function refEffectiveCapabilities(
  kind: string,
  o: {
    platform: string;
    subkind?: string | null;
    server?: Record<string, unknown>;
  },
): RefCaps {
  const base = REF_KIND_TABLE[kind] ?? REF_KIND_TABLE.unknown!;
  const { platforms: _p, ...caps0 } = base;
  let caps: RefCaps = caps0;
  caps = refNarrow(caps, REF_PLATFORM_NARROWING[o.platform]?.[kind]);
  caps = refNarrow(
    caps,
    o.subkind ? REF_SUBKIND_NARROWING[o.subkind] : undefined,
  );
  caps = refNarrow(caps, o.server);
  return caps;
}

// ── §4.7 `outlet-matrix.json` ────────────────────────────────────────────────────────────────

/** The 25 signals in vocabulary order, with S-06's confidence and evidence (§4.7). */
export const REF_SIGNALS: {
  signal: string;
  confidence: string | null;
  verified: string;
  note?: string;
}[] = [
  {
    signal: "ios.appDistributor",
    confidence: "attested",
    verified: "source",
    note: "the device run is unmeasured",
  },
  { signal: "ios.bundleIdRewrite", confidence: "declared", verified: "source" },
  {
    signal: "ios.provisioningProfile",
    confidence: "heuristic",
    verified: "unmeasured",
  },
  { signal: "macos.masReceipt", confidence: "attested", verified: "measured" },
  {
    signal: "macos.receiptSandbox",
    confidence: "attested",
    verified: "measured",
    note: "one app",
  },
  { signal: "macos.signingLeaf", confidence: "attested", verified: "measured" },
  {
    signal: "macos.homebrewCask",
    confidence: "heuristic",
    verified: "measured",
  },
  {
    signal: "macos.homebrewFormula",
    confidence: "heuristic",
    verified: "measured",
    note: "the realpath reading",
  },
  {
    signal: "windows.packageIdentity",
    confidence: "attested",
    verified: "source",
  },
  {
    signal: "windows.signatureKind",
    confidence: "attested",
    verified: "source",
  },
  {
    signal: "windows.appInstallerUri",
    confidence: "attested",
    verified: "source",
  },
  {
    signal: "windows.externalLocation",
    confidence: "attested",
    verified: "source",
    note: "needs a device",
  },
  {
    signal: "windows.pathConvention",
    confidence: "heuristic",
    verified: "unmeasured",
  },
  {
    signal: "linux.flatpakInfo",
    confidence: "attested",
    verified: "measured",
    note: "a foreign Flatpak too",
  },
  {
    signal: "linux.snapEnv",
    confidence: "declared",
    verified: "emulated",
    note: "and source",
  },
  { signal: "linux.appImageEnv", confidence: "declared", verified: "emulated" },
  {
    signal: "steam.libraryManifest",
    confidence: "declared",
    verified: "measured",
    note: "macOS only",
  },
  {
    signal: "steam.appIdEnv",
    confidence: "heuristic",
    verified: "measured",
    note: "macOS only",
  },
  {
    signal: "steam.appIdFile",
    confidence: null,
    verified: "measured",
    note: "refuted as a dev-mode signal",
  },
  {
    signal: "itch.receipt",
    confidence: "declared",
    verified: "emulated",
    note: "and source",
  },
  { signal: "itch.appEnv", confidence: null, verified: "source" },
  {
    signal: "android.installSource",
    confidence: "declared",
    verified: "measured",
    note: "every installer but Play; the digest read on one variant",
  },
  {
    signal: "android.installerMismatch",
    confidence: "declared",
    verified: "measured",
  },
  { signal: "web.displayMode", confidence: "heuristic", verified: "measured" },
  {
    signal: "node.packageManager",
    confidence: "heuristic",
    verified: "measured",
  },
];
export const REF_VERIFIED = ["measured", "emulated", "source", "unmeasured"];
const MAC_STORE_LEAVES: Record<string, string> = {
  "Apple Mac OS Application Signing": "app-store",
  "TestFlight Beta Distribution": "testflight",
};
export const REF_PLATFORM_DATA = {
  listingUrlPrefixes: REF_LISTING_PREFIXES,
  playStoreCertSha256s: [] as string[],
  altStorePalMarketplaceIds: [] as string[],
  playPackages: ["com.android.vending"],
  obtainiumPackages: ["dev.imranr.obtainium", "dev.imranr.obtainium.fdroid"],
  fdroidClientPackages: [
    "org.fdroid.fdroid",
    "com.looker.droidify",
    "com.machiav3lli.fdroid",
  ],
  systemInstallerPackages: [
    "com.google.android.packageinstaller",
    "com.android.packageinstaller",
  ],
  macosStoreLeaves: MAC_STORE_LEAVES,
  deadlineMs: 2000,
};

interface Evidence {
  signal: string;
  confidence: string | null;
  names?: { kind: string; subkind: string | null };
  vetoes?: string[];
}

/** `detectOutlet({stamp, signals})` (plans/P3-01.md §2.9), the generator's reference. */
export function refDetectOutlet(
  stamp: {
    outletKind: string;
    subkind: string | null;
    outletIds: Record<string, string>;
  } | null,
  signals: Record<string, any>,
): {
  kind: string;
  confidence: string | null;
  source: string | null;
  subkind: string | null;
} {
  const UNKNOWN = {
    kind: "unknown",
    confidence: null,
    source: null,
    subkind: null,
  };
  const ids = stamp?.outletIds ?? {};
  const has = (s: string): boolean => hasOwn(signals, s);
  const v = (s: string): any => signals[s];
  const identityHolds = (s: string): boolean => {
    switch (s) {
      case "ios.bundleIdRewrite":
        return v(s)?.altBundleIdentifier === ids.bundleId;
      case "macos.receiptSandbox":
        return v("macos.masReceipt") === true;
      case "macos.homebrewCask":
        return v(s) === ids.caskToken;
      case "macos.homebrewFormula":
        return v(s) === ids.homebrewFormula;
      case "windows.packageIdentity":
        return v(s) === ids.msixFamilyName;
      case "windows.signatureKind":
      case "windows.appInstallerUri":
      case "windows.externalLocation":
        return (
          has("windows.packageIdentity") &&
          v("windows.packageIdentity") === ids.msixFamilyName
        );
      case "linux.flatpakInfo":
        return v(s) === ids.flatpakId;
      case "linux.snapEnv":
        return v(s)?.name === ids.snapName;
      case "linux.appImageEnv":
        return (
          typeof v(s)?.exePath === "string" &&
          typeof v(s)?.appDir === "string" &&
          v(s).exePath.startsWith(v(s).appDir)
        );
      case "steam.libraryManifest":
        return v(s) === ids.steamAppId;
      case "steam.appIdEnv":
        return v(s)?.appId === ids.steamAppId;
      case "itch.receipt":
        return v(s) === ids.itchGameId;
      case "android.installSource":
        return v(s)?.installer === v(s)?.initiator;
      case "node.packageManager":
        return v(s)?.packageMatch === true;
      default:
        return true;
    }
  };
  // 1. Filter.
  const evidence: Evidence[] = [];
  for (const { signal, confidence } of REF_SIGNALS) {
    if (!has(signal) || confidence === null || !identityHolds(signal)) continue;
    const value = v(signal);
    const e: Evidence = { signal, confidence };
    const name = (kind: string, subkind: string | null = null): void =>
      void (e.names = { kind, subkind });
    switch (signal) {
      case "ios.appDistributor":
        if (value === "appStore") name("app-store");
        else if (value === "testFlight") name("testflight");
        else if (value === "web") name("direct");
        else if (
          typeof value === "string" &&
          value.startsWith("marketplace:")
        ) {
          if (
            REF_PLATFORM_DATA.altStorePalMarketplaceIds.includes(
              value.slice(12),
            )
          )
            name("altstore-pal");
          else e.vetoes = ["app-store", "testflight"];
        }
        break;
      case "ios.bundleIdRewrite":
        name("altstore");
        break;
      case "ios.provisioningProfile":
        if (value === true) e.vetoes = ["app-store"];
        break;
      case "macos.masReceipt":
        if (value === true)
          name(v("macos.receiptSandbox") === true ? "testflight" : "app-store");
        break;
      case "macos.signingLeaf":
        if (hasOwn(MAC_STORE_LEAVES, value)) name(MAC_STORE_LEAVES[value]!);
        else e.vetoes = ["app-store", "testflight"];
        break;
      case "macos.homebrewCask":
      case "macos.homebrewFormula":
        name("direct", "homebrew");
        break;
      case "windows.signatureKind":
        if (value === "Store") name("ms-store");
        else if (value === "Developer" || value === "Enterprise")
          e.vetoes = ["ms-store"];
        break;
      case "windows.appInstallerUri":
        if (value !== null) name("app-installer");
        break;
      case "windows.pathConvention":
        if (value === "winget") name("winget");
        else if (value === "scoop" || value === "chocolatey")
          name("direct", value);
        break;
      case "linux.flatpakInfo":
        if (stamp?.outletKind === "direct" && stamp.subkind === "flatpak")
          name("direct", "flatpak");
        else name("flathub");
        break;
      case "linux.snapEnv":
        if (
          typeof value.revision === "string" &&
          value.revision.startsWith("x")
        )
          e.vetoes = ["snap"];
        else name("snap");
        break;
      case "linux.appImageEnv":
        name("direct", "appimage");
        break;
      case "steam.libraryManifest":
      case "steam.appIdEnv":
        name("steam");
        break;
      case "itch.receipt":
        name("itch");
        break;
      case "android.installSource": {
        const installer = value.installer as string | null;
        if (
          installer !== null &&
          REF_PLATFORM_DATA.playPackages.includes(installer)
        ) {
          name("play");
          if (
            REF_PLATFORM_DATA.playStoreCertSha256s.includes(
              value.initiatorCertSha256,
            )
          )
            e.confidence = "attested";
        } else if (
          installer !== null &&
          REF_PLATFORM_DATA.obtainiumPackages.includes(installer)
        )
          name("obtainium");
        else if (
          installer !== null &&
          REF_PLATFORM_DATA.fdroidClientPackages.includes(installer)
        )
          name("fdroid-repo");
        else if (
          installer === null ||
          installer === "com.android.shell" ||
          REF_PLATFORM_DATA.systemInstallerPackages.includes(installer)
        )
          name("direct");
        break;
      }
      case "android.installerMismatch":
        if (value === true) e.vetoes = ["play", "play-testing"];
        break;
      case "web.displayMode":
        name("web");
        break;
      case "node.packageManager":
        name("direct", value.manager);
        break;
      default:
        break;
    }
    evidence.push(e);
  }
  const vetoed = (kind: string): boolean =>
    evidence.some((e) => e.vetoes?.includes(kind));
  // 2. Attested naming.
  const attested = evidence.filter(
    (e) => e.confidence === "attested" && e.names,
  );
  if (attested.length > 0) {
    const kinds = new Set(attested.map((e) => e.names!.kind));
    if (kinds.size > 1) return UNKNOWN;
    const first = attested[0]!;
    if (vetoed(first.names!.kind)) return UNKNOWN;
    return {
      kind: first.names!.kind,
      confidence: "attested",
      source: first.signal,
      subkind: first.names!.subkind,
    };
  }
  // 3. The stamp.
  if (!stamp) return UNKNOWN;
  const cur = {
    kind: stamp.outletKind,
    confidence: "stamp",
    source: "stamp",
    subkind: stamp.subkind,
  };
  // 4. Vetoes.
  if (vetoed(cur.kind)) return UNKNOWN;
  // 5. Restricting signals.
  const width = (kind: string, subkind: string | null): number =>
    REF_BINARY_ORDER.indexOf(
      refNarrow(
        refEffectiveCapabilities(kind, { platform: "" }),
        subkind ? REF_SUBKIND_NARROWING[subkind] : undefined,
      ).binaryUpdates,
    );
  for (const conf of ["declared", "heuristic"])
    for (const e of evidence) {
      if (e.confidence !== conf || !e.names) continue;
      if (width(e.names.kind, e.names.subkind) > width(cur.kind, cur.subkind))
        continue;
      const subkind =
        e.names.subkind ?? (e.names.kind === cur.kind ? cur.subkind : null);
      return {
        kind: e.names.kind,
        confidence: conf,
        source: e.signal,
        subkind,
      };
    }
  return cur;
}
