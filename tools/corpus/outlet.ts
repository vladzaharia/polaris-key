// `outlet-matrix.json` (plans/P3-01.md §4.7): outlet detection over the reference's signals.

import {
  REF_CONFIDENCES,
  REF_KIND_TABLE,
  REF_LISTING_PREFIXES,
  REF_OUTLET_KINDS,
  REF_PLATFORM_DATA,
  REF_PLATFORM_NARROWING,
  REF_RELEASE_PLATFORMS,
  REF_SIGNALS,
  REF_SUBKIND_NARROWING,
  REF_SUBKINDS,
  REF_VERIFIED,
  refDetectOutlet,
} from "./reference/outlet.js";

export function buildOutletMatrixV1(): unknown {
  const fail = (m: string): never => {
    throw new Error(`outlet-matrix: ${m}`);
  };
  const IDS = {
    steamAppId: "3166810",
    itchGameId: "1001",
    flatpakId: "gg.vlad.Diceroll",
    snapName: "diceroll",
    caskToken: "diceroll",
    homebrewFormula: "diceroll",
    msixFamilyName: "Diceroll_abc123",
    bundleId: "gg.vlad.diceroll",
  };
  const st = (outletKind: string, subkind: string | null = null) => ({
    outletKind,
    subkind,
    outletIds: IDS,
  });
  const and = (
    installer: string | null,
    initiator: string | null,
  ): Record<string, unknown> => ({
    "android.installSource": {
      installer,
      initiator,
      initiatorCertSha256: "0".repeat(64),
    },
    "android.installerMismatch": installer !== initiator,
  });
  const appImage = {
    "linux.appImageEnv": {
      appImage: "/home/a/Diceroll.AppImage",
      appDir: "/tmp/.mount_DicerX1",
      exePath: "/tmp/.mount_DicerX1/usr/bin/diceroll",
    },
  };
  const ID = "Diceroll_abc123";
  type Exp = [string, string | null, string | null, string | null];
  const U: Exp = ["unknown", null, null, null];
  const spec: [
    string,
    ReturnType<typeof st> | null,
    Record<string, unknown>,
    Exp,
  ][] = [
    [
      "stamp only — direct",
      st("direct"),
      {},
      ["direct", "stamp", "stamp", null],
    ],
    ["stamp only — steam", st("steam"), {}, ["steam", "stamp", "stamp", null]],
    ["no stamp and no evidence", null, {}, U],
    [
      "no stamp: a heuristic never selects",
      null,
      { "steam.appIdEnv": { appId: "3166810", clientLaunch: true } },
      U,
    ],
    [
      "the macOS receipt overrides a direct stamp",
      st("direct"),
      {
        "macos.masReceipt": true,
        "macos.signingLeaf": "Apple Mac OS Application Signing",
      },
      ["app-store", "attested", "macos.masReceipt", null],
    ],
    [
      "the macOS TestFlight receipt",
      null,
      {
        "macos.masReceipt": true,
        "macos.receiptSandbox": true,
        "macos.signingLeaf": "TestFlight Beta Distribution",
      },
      ["testflight", "attested", "macos.masReceipt", null],
    ],
    [
      "a store leaf that disagrees with the receipt",
      st("direct"),
      {
        "macos.masReceipt": true,
        "macos.signingLeaf": "TestFlight Beta Distribution",
      },
      U,
    ],
    [
      "a Developer ID leaf vetoes an app-store stamp",
      st("app-store"),
      { "macos.signingLeaf": "Developer ID Application" },
      U,
    ],
    [
      "a Developer ID leaf leaves a steam stamp",
      st("steam"),
      { "macos.signingLeaf": "Developer ID Application" },
      ["steam", "stamp", "stamp", null],
    ],
    [
      "no leaf vetoes a testflight stamp",
      st("testflight"),
      { "macos.signingLeaf": "none" },
      U,
    ],
    [
      "a Homebrew cask restricts a direct stamp",
      st("direct"),
      { "macos.homebrewCask": "diceroll" },
      ["direct", "heuristic", "macos.homebrewCask", "homebrew"],
    ],
    [
      "a cask with another token does not count",
      st("direct"),
      { "macos.homebrewCask": "other" },
      ["direct", "stamp", "stamp", null],
    ],
    [
      "the Steam library moves a direct stamp to steam",
      st("direct"),
      { "steam.libraryManifest": "3166810" },
      ["steam", "declared", "steam.libraryManifest", null],
    ],
    [
      "the Steam environment with this app id",
      st("direct"),
      { "steam.appIdEnv": { appId: "3166810", clientLaunch: true } },
      ["steam", "heuristic", "steam.appIdEnv", null],
    ],
    [
      "the Steam environment with another app id",
      st("direct"),
      { "steam.appIdEnv": { appId: "480", clientLaunch: true } },
      ["direct", "stamp", "stamp", null],
    ],
    [
      "`steam_appid.txt` is diagnostic only",
      st("direct"),
      { "steam.appIdFile": "3166810" },
      ["direct", "stamp", "stamp", null],
    ],
    [
      "a heuristic never widens: AppImage on a steam stamp",
      st("steam"),
      appImage,
      ["steam", "stamp", "stamp", null],
    ],
    [
      "the itch receipt moves a direct stamp to itch",
      st("direct"),
      { "itch.receipt": "1001" },
      ["itch", "declared", "itch.receipt", null],
    ],
    [
      "`ITCHIO_APP` is diagnostic only",
      st("direct"),
      { "itch.appEnv": true },
      ["direct", "stamp", "stamp", null],
    ],
    [
      "Flatpak info with this id overrides a direct stamp",
      st("direct"),
      { "linux.flatpakInfo": "gg.vlad.Diceroll" },
      ["flathub", "attested", "linux.flatpakInfo", null],
    ],
    [
      "Flatpak info keeps a direct + flatpak stamp",
      st("direct", "flatpak"),
      { "linux.flatpakInfo": "gg.vlad.Diceroll" },
      ["direct", "attested", "linux.flatpakInfo", "flatpak"],
    ],
    [
      "a foreign Flatpak is no Flathub evidence",
      st("steam"),
      {
        "linux.flatpakInfo": "com.valvesoftware.Steam",
        "steam.libraryManifest": "3166810",
      },
      ["steam", "declared", "steam.libraryManifest", null],
    ],
    [
      "the snap name restricts a direct stamp",
      st("direct"),
      { "linux.snapEnv": { name: "diceroll", revision: "42" } },
      ["snap", "declared", "linux.snapEnv", null],
    ],
    [
      "a local snap revision vetoes a snap stamp",
      st("snap"),
      { "linux.snapEnv": { name: "diceroll", revision: "x1" } },
      U,
    ],
    [
      "AppImage with APPDIR around the executable",
      st("direct"),
      appImage,
      ["direct", "declared", "linux.appImageEnv", "appimage"],
    ],
    [
      "Android Play, no recorded digest: declared",
      st("direct"),
      and("com.android.vending", "com.android.vending"),
      ["play", "declared", "android.installSource", null],
    ],
    [
      "Android: the shell claiming Play vetoes a play stamp",
      st("play"),
      and("com.android.vending", "com.android.shell"),
      U,
    ],
    [
      "Android: Obtainium",
      st("direct"),
      and("dev.imranr.obtainium", "dev.imranr.obtainium"),
      ["obtainium", "declared", "android.installSource", null],
    ],
    [
      "Android: the F-Droid client",
      st("direct"),
      and("org.fdroid.fdroid", "org.fdroid.fdroid"),
      ["fdroid-repo", "declared", "android.installSource", null],
    ],
    [
      "Android: a browser download confirms direct",
      st("direct"),
      and(
        "com.google.android.packageinstaller",
        "com.google.android.packageinstaller",
      ),
      ["direct", "declared", "android.installSource", null],
    ],
    [
      "iOS: App Store overrides a direct stamp",
      st("direct"),
      { "ios.appDistributor": "appStore" },
      ["app-store", "attested", "ios.appDistributor", null],
    ],
    [
      "iOS: TestFlight with no stamp",
      null,
      { "ios.appDistributor": "testFlight" },
      ["testflight", "attested", "ios.appDistributor", null],
    ],
    [
      "iOS: a timeout is no evidence",
      st("app-store"),
      { "ios.appDistributor": "timeout" },
      ["app-store", "stamp", "stamp", null],
    ],
    [
      "iOS: web distribution is direct",
      null,
      { "ios.appDistributor": "web" },
      ["direct", "attested", "ios.appDistributor", null],
    ],
    [
      "iOS: an AltStore rewrite moves an app-store stamp",
      st("app-store"),
      {
        "ios.bundleIdRewrite": {
          runtimeBundleId: "gg.vlad.diceroll.ABCDE12345",
          altBundleIdentifier: "gg.vlad.diceroll",
        },
      },
      ["altstore", "declared", "ios.bundleIdRewrite", null],
    ],
    [
      "iOS: a provisioning profile vetoes an app-store stamp",
      st("app-store"),
      { "ios.provisioningProfile": true },
      U,
    ],
    [
      "iOS: a marketplace other than AltStore PAL",
      st("app-store"),
      { "ios.appDistributor": "marketplace:com.example" },
      U,
    ],
    [
      "Windows: Store signature with this family name",
      st("direct"),
      { "windows.packageIdentity": ID, "windows.signatureKind": "Store" },
      ["ms-store", "attested", "windows.signatureKind", null],
    ],
    [
      "Windows: an inherited identity is ignored",
      st("steam"),
      {
        "windows.packageIdentity": "Other_xyz",
        "windows.signatureKind": "Store",
      },
      ["steam", "stamp", "stamp", null],
    ],
    [
      "Windows: an App Installer URI",
      st("direct"),
      {
        "windows.packageIdentity": ID,
        "windows.signatureKind": "Developer",
        "windows.appInstallerUri": "https://dl.example/diceroll.appinstaller",
      },
      ["app-installer", "attested", "windows.appInstallerUri", null],
    ],
    [
      "Windows: a Developer signature vetoes an ms-store stamp",
      st("ms-store"),
      { "windows.packageIdentity": ID, "windows.signatureKind": "Developer" },
      U,
    ],
    [
      "Windows: a sparse package keeps the stamp",
      st("direct"),
      {
        "windows.packageIdentity": ID,
        "windows.signatureKind": "Developer",
        "windows.externalLocation": "C:\\Games\\Diceroll",
      },
      ["direct", "stamp", "stamp", null],
    ],
    [
      "Windows: a WinGet path restricts direct to winget",
      st("direct"),
      { "windows.pathConvention": "winget" },
      ["winget", "heuristic", "windows.pathConvention", null],
    ],
    [
      "Windows: a Scoop path",
      st("direct"),
      { "windows.pathConvention": "scoop" },
      ["direct", "heuristic", "windows.pathConvention", "scoop"],
    ],
    [
      "Node: npx",
      st("direct"),
      { "node.packageManager": { manager: "npx", packageMatch: true } },
      ["direct", "heuristic", "node.packageManager", "npx"],
    ],
    [
      "web: display mode confirms the web stamp",
      st("web"),
      { "web.displayMode": "standalone" },
      ["web", "heuristic", "web.displayMode", null],
    ],
    [
      "a Homebrew formula restricts a direct stamp",
      st("direct"),
      { "macos.homebrewFormula": "diceroll" },
      ["direct", "heuristic", "macos.homebrewFormula", "homebrew"],
    ],
    [
      "Android: an installer mismatch leaves a direct stamp",
      st("direct"),
      and("com.android.vending", "com.android.shell"),
      ["direct", "stamp", "stamp", null],
    ],
  ];
  const seen = new Set<string>();
  const rows = spec.map(
    ([name, stamp, signals, [kind, confidence, source, subkind]], k) => {
      const expect = { kind, confidence, source, subkind };
      const got = refDetectOutlet(stamp, signals);
      if (JSON.stringify(got) !== JSON.stringify(expect))
        fail(`row ${k + 1} (${name}) computes ${JSON.stringify(got)}`);
      for (const s of Object.keys(signals)) seen.add(s);
      return { name: `${k + 1}. ${name}`, stamp, signals, expect };
    },
  );
  if (rows.length !== 48) fail(`${rows.length} rows, not 48`);
  for (const { signal } of REF_SIGNALS)
    if (!seen.has(signal)) fail(`${signal} is in no row`);
  const kinds: Record<string, unknown> = {};
  for (const k of [...REF_OUTLET_KINDS, "unknown"]) {
    const row = REF_KIND_TABLE[k];
    if (!row) fail(`no kind row for ${k}`);
    for (const p of row!.platforms)
      if (!REF_RELEASE_PLATFORMS.includes(p)) fail(`${k}: platform ${p}`);
    kinds[k] = row;
  }
  for (const [k, prefixes] of Object.entries(REF_LISTING_PREFIXES)) {
    if (REF_KIND_TABLE[k]?.binaryUpdates !== "store")
      fail(`listing prefixes on a non-store kind ${k}`);
    for (const p of prefixes)
      if (p.startsWith("https://") && !/^https:\/\/[^/]+\//.test(p))
        fail(`${p} has no / after its host`);
  }
  for (const s of REF_SIGNALS)
    if (!REF_VERIFIED.includes(s.verified)) fail(`${s.signal}: verified`);
  const counts = REF_VERIFIED.map(
    (x) => REF_SIGNALS.filter((s) => s.verified === x).length,
  ).join(",");
  if (counts !== "13,3,7,2") fail(`evidence counts ${counts}`);
  return {
    outletMatrixVersion: 1,
    description:
      "Outlet kinds, capabilities and detection (plans/P3-01.md §2.9; WIRE-CONTRACT-V4 §11, client behaviour outside the wire contract). `kinds` is the capability default and platform list per kind (and `unknown`); `platformNarrowing` and `subkinds` narrow it, booleans by AND, `binaryUpdates` to the narrower of none < store < self, and `commerce` only to `none`. `signals` lists the 25 detection signals in vocabulary order with their confidence (null for a diagnostic signal) and evidence (`verified`; no SDK branches on it). Each row runs `detectOutlet({stamp, signals})` and expects `{kind, confidence, source, subkind}`; the generator recomputes every row with its own reference. A runner asserts its compiled tables against `kinds`, `platformNarrowing`, `subkinds` and `platformData.listingUrlPrefixes`.",
    kinds,
    platformNarrowing: REF_PLATFORM_NARROWING,
    subkinds: REF_SUBKIND_NARROWING,
    vocabulary: {
      kinds: [...REF_OUTLET_KINDS],
      confidence: REF_CONFIDENCES,
      signals: REF_SIGNALS.map((s) => s.signal),
      subkinds: REF_SUBKINDS,
      verified: REF_VERIFIED,
    },
    signals: REF_SIGNALS,
    platformData: REF_PLATFORM_DATA,
    rows,
  };
}
