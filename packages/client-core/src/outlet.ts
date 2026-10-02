// Outlet detection — plans/P3-01.md §2.9 "Detection" and §4.7 (`outlet-matrix.json`).
//
// "Where did this install come from?" A pure, synchronous `detectOutlet({stamp, signals})` maps
// the signals a runtime observed, and the build stamp, to `{kind, confidence, source, subkind}`.
// Every SDK holds this same function (`detect_outlet` in Python and GDScript), and
// `outlet-matrix.json`'s rows pin it, row for row, in every runner. READING the signals is not
// shared: each runtime sees different ones, so each SDK has its own readers, unit-tested with
// faked environments, and only this mapping is conformance-tested.
//
// The result never goes straight into the decision: the SDK passes it to `resolveUpdateOutlet`
// as `detected` (§2.8), where a host value always wins. Detection chooses an outlet; it never
// widens what that outlet may do (the compiled defaults and the feed decide that).
//
// Nothing here does I/O or throws. Raw signal values never leave the device.

import {
  OUTLET_KINDS,
  OUTLET_SUBKINDS,
  OUTLET_UNKNOWN,
  BINARY_UPDATES_ORDER,
  type OutletConfidence,
  type OutletKind,
  type OutletSubkind,
} from "@polaris-key/protocol/distribution";
import { effectiveCapabilities, type DetectedOutlet } from "./decide.js";

export type { DetectedOutlet } from "./decide.js";

/** One detection signal, in vocabulary order, with its confidence: `null` for the two
 *  diagnostic signals, which are recorded and never count (`outlet-matrix.json#/signals`). */
export interface OutletSignalSpec {
  signal: string;
  confidence: OutletConfidence | null;
}

/** The 25 signals in vocabulary order (§4.7's table). "Vocabulary order" decides which signal
 *  is the `source` when several agree, and which restricting signal acts first. */
export const OUTLET_SIGNALS: readonly OutletSignalSpec[] = [
  { signal: "ios.appDistributor", confidence: "attested" },
  { signal: "ios.bundleIdRewrite", confidence: "declared" },
  { signal: "ios.provisioningProfile", confidence: "heuristic" },
  { signal: "macos.masReceipt", confidence: "attested" },
  { signal: "macos.receiptSandbox", confidence: "attested" },
  { signal: "macos.signingLeaf", confidence: "attested" },
  { signal: "macos.homebrewCask", confidence: "heuristic" },
  { signal: "macos.homebrewFormula", confidence: "heuristic" },
  { signal: "windows.packageIdentity", confidence: "attested" },
  { signal: "windows.signatureKind", confidence: "attested" },
  { signal: "windows.appInstallerUri", confidence: "attested" },
  { signal: "windows.externalLocation", confidence: "attested" },
  { signal: "windows.pathConvention", confidence: "heuristic" },
  { signal: "linux.flatpakInfo", confidence: "attested" },
  { signal: "linux.snapEnv", confidence: "declared" },
  { signal: "linux.appImageEnv", confidence: "declared" },
  { signal: "steam.libraryManifest", confidence: "declared" },
  { signal: "steam.appIdEnv", confidence: "heuristic" },
  { signal: "steam.appIdFile", confidence: null },
  { signal: "itch.receipt", confidence: "declared" },
  { signal: "itch.appEnv", confidence: null },
  { signal: "android.installSource", confidence: "declared" },
  { signal: "android.installerMismatch", confidence: "declared" },
  { signal: "web.displayMode", confidence: "heuristic" },
  { signal: "node.packageManager", confidence: "heuristic" },
];

/** The platform facts detection reads (`outlet-matrix.json#/platformData`, less the listing
 *  prefixes, which are `LISTING_URL_PREFIXES`). The Android package names beyond
 *  `com.android.vending`, `dev.imranr.obtainium` and `org.fdroid.fdroid` are [I]; the two digest
 *  and marketplace lists stay empty until P5-06 and P5-05 record them. */
export const OUTLET_PLATFORM_DATA = {
  playStoreCertSha256s: [] as readonly string[],
  altStorePalMarketplaceIds: [] as readonly string[],
  playPackages: ["com.android.vending"] as readonly string[],
  obtainiumPackages: [
    "dev.imranr.obtainium",
    "dev.imranr.obtainium.fdroid",
  ] as readonly string[],
  fdroidClientPackages: [
    "org.fdroid.fdroid",
    "com.looker.droidify",
    "com.machiav3lli.fdroid",
  ] as readonly string[],
  systemInstallerPackages: [
    "com.google.android.packageinstaller",
    "com.android.packageinstaller",
  ] as readonly string[],
  /** The only two macOS signing leaves that select an outlet. Every other leaf vetoes. */
  macosStoreLeaves: {
    "Apple Mac OS Application Signing": "app-store",
    "TestFlight Beta Distribution": "testflight",
  } as Readonly<Record<string, OutletKind>>,
  /** The deadline for an async platform call (iOS `AppDistributor.current`); a timeout is no
   *  evidence. */
  deadlineMs: 2000,
} as const;

/** The product's outlet identities, from the stamp (P1-11's `outletIds`, which CI fills from
 *  `pkey distribution outlet-ids`). A launcher signal counts only when it names one of these. */
export interface OutletIds {
  steamAppId?: string;
  itchGameId?: string;
  flatpakId?: string;
  snapName?: string;
  caskToken?: string;
  homebrewFormula?: string;
  msixFamilyName?: string;
  bundleId?: string;
  [key: string]: string | undefined;
}

/** The stamp as detection reads it (`outlet-matrix.json` rows' `stamp`): its outlet KIND, its
 *  subkind and the product's outlet identities. */
export interface DetectionStamp {
  outletKind: OutletKind;
  subkind: OutletSubkind | null;
  outletIds: OutletIds;
}

/** The signals a runtime observed, keyed by signal name (`<platform>.<signal>`). A signal the
 *  runtime could not read is absent; a key outside the vocabulary is ignored. */
export type OutletSignals = Record<string, unknown>;

/** `{kind: "unknown", confidence: null, source: null, subkind: null}`. */
export const UNKNOWN_DETECTION: DetectedOutlet = Object.freeze({
  kind: OUTLET_UNKNOWN,
  confidence: null,
  source: null,
  subkind: null,
});

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function has(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

const isKind = (v: unknown): v is OutletKind =>
  typeof v === "string" && (OUTLET_KINDS as readonly string[]).includes(v);
const isSubkind = (v: unknown): v is OutletSubkind =>
  typeof v === "string" && (OUTLET_SUBKINDS as readonly string[]).includes(v);

/**
 * The detection stamp of a build stamp (P1-11's `{outlet, outletKind?, outletSubkind?,
 * outletIds?}`): the kind as `resolveUpdateOutlet` reads it (`outletKind`, else `outlet`; a kind
 * outside the 17 is no kind), the subkind when it is one of the 8, and the string-valued
 * identities. Null when the stamp names no kind, so detection runs as if there were no stamp.
 */
export function detectionStamp(stamp: unknown): DetectionStamp | null {
  if (!isObject(stamp)) return null;
  const rawKind = has(stamp, "outletKind") ? stamp.outletKind : stamp.outlet;
  if (!isKind(rawKind)) return null;
  const outletIds: OutletIds = {};
  if (isObject(stamp.outletIds))
    for (const [k, v] of Object.entries(stamp.outletIds))
      if (typeof v === "string") outletIds[k] = v;
  const sub = has(stamp, "outletSubkind") ? stamp.outletSubkind : stamp.subkind;
  return {
    outletKind: rawKind,
    subkind: isSubkind(sub) ? sub : null,
    outletIds,
  };
}

/** The synthesised stamp of a web runtime (§2.9: the React browser adapter and Godot web
 *  exports have no export-time stamp, and are `web` by construction). */
export const WEB_DETECTION_STAMP: DetectionStamp = Object.freeze({
  outletKind: "web",
  subkind: null,
  outletIds: Object.freeze({}) as OutletIds,
}) as DetectionStamp;

interface Evidence {
  signal: string;
  confidence: OutletConfidence;
  names: { kind: OutletKind; subkind: OutletSubkind | null } | null;
  vetoes: readonly string[];
}

/** `binaryUpdates`'s width of a kind narrowed by a subkind (no platform): the index in
 *  `none` < `store` < `self`. */
function width(kind: string, subkind: string | null): number {
  return (BINARY_UPDATES_ORDER as readonly string[]).indexOf(
    effectiveCapabilities(kind, { platform: "", subkind }).binaryUpdates,
  );
}

/**
 * Detect the outlet from the build stamp and the observed signals, in §2.9's five steps:
 *
 * 1. **Filter**: drop the diagnostic signals and every signal whose identity condition fails
 *    (a launcher signal must name THIS product, through the stamp's `outletIds`).
 * 2. **Attested naming**: two kinds named by attested signals give `unknown`; one gives that
 *    kind (confidence `attested`, the first naming signal in vocabulary order as `source`),
 *    subject only to the vetoes of step 4.
 * 3. **Stamp**: otherwise the stamp's kind and subkind (`stamp`, `"stamp"`); with no stamp,
 *    `unknown`: declared and heuristic evidence never selects on its own.
 * 4. **Vetoes**: a surviving signal that vetoes the current kind gives `unknown`.
 * 5. **Restricting signals** (the stamp path): the first declared, then heuristic, naming
 *    signal whose kind (narrowed by its subkind) updates no wider than the current one decides.
 *
 * Never throws; a malformed signal value is no evidence (`outlet-matrix.json#/rows`).
 */
export function detectOutlet(opts: {
  stamp?: DetectionStamp | null;
  signals?: OutletSignals | null;
}): DetectedOutlet {
  const stamp =
    isObject(opts.stamp) && isKind(opts.stamp.outletKind) ? opts.stamp : null;
  const signals: OutletSignals = isObject(opts.signals) ? opts.signals : {};
  const ids: Record<string, unknown> =
    stamp && isObject(stamp.outletIds) ? stamp.outletIds : {};
  const present = (s: string): boolean => has(signals, s);
  const v = (s: string): unknown => (present(s) ? signals[s] : undefined);
  const field = (s: string, key: string): unknown => {
    const o = v(s);
    return isObject(o) && has(o, key) ? o[key] : undefined;
  };
  /** True when the stamp declares the identity `key` and `value` equals it. A missing
   *  identity never matches. */
  const names = (key: string, value: unknown): boolean =>
    typeof ids[key] === "string" && value === ids[key];
  const packageIdentityHolds = (): boolean =>
    names("msixFamilyName", v("windows.packageIdentity"));

  const identityHolds = (s: string): boolean => {
    switch (s) {
      case "ios.bundleIdRewrite":
        return names("bundleId", field(s, "altBundleIdentifier"));
      case "macos.receiptSandbox":
        return v("macos.masReceipt") === true;
      case "macos.homebrewCask":
        return names("caskToken", v(s));
      case "macos.homebrewFormula":
        return names("homebrewFormula", v(s));
      case "windows.packageIdentity":
      case "windows.signatureKind":
      case "windows.appInstallerUri":
      case "windows.externalLocation":
        return packageIdentityHolds();
      case "linux.flatpakInfo":
        return names("flatpakId", v(s));
      case "linux.snapEnv":
        return names("snapName", field(s, "name"));
      case "linux.appImageEnv": {
        const exe = field(s, "exePath");
        const dir = field(s, "appDir");
        return (
          typeof exe === "string" &&
          typeof dir === "string" &&
          exe.startsWith(dir)
        );
      }
      case "steam.libraryManifest":
        return names("steamAppId", v(s));
      case "steam.appIdEnv":
        return names("steamAppId", field(s, "appId"));
      case "itch.receipt":
        return names("itchGameId", v(s));
      case "android.installSource": {
        const installer = field(s, "installer");
        const initiator = field(s, "initiator");
        return (
          (installer === null || typeof installer === "string") &&
          installer === initiator
        );
      }
      case "node.packageManager":
        return field(s, "packageMatch") === true;
      default:
        return true;
    }
  };

  // 1. Filter, and read each surviving signal's effect.
  const evidence: Evidence[] = [];
  for (const { signal, confidence } of OUTLET_SIGNALS) {
    if (confidence === null || !present(signal) || !identityHolds(signal))
      continue;
    const value = v(signal);
    const e: Evidence = { signal, confidence, names: null, vetoes: [] };
    const name = (kind: OutletKind, subkind: OutletSubkind | null = null) => {
      e.names = { kind, subkind };
    };
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
            OUTLET_PLATFORM_DATA.altStorePalMarketplaceIds.includes(
              value.slice("marketplace:".length),
            )
          )
            name("altstore-pal");
          else e.vetoes = ["app-store", "testflight"];
        }
        // `other` and `timeout` are no evidence.
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
      case "macos.signingLeaf": {
        const leaves = OUTLET_PLATFORM_DATA.macosStoreLeaves;
        if (typeof value === "string" && has(leaves, value))
          name(leaves[value]!);
        else e.vetoes = ["app-store", "testflight"];
        break;
      }
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
        if (value !== null && value !== undefined) name("app-installer");
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
      case "linux.snapEnv": {
        const revision = field(signal, "revision");
        if (typeof revision === "string" && revision.startsWith("x"))
          e.vetoes = ["snap"];
        else name("snap");
        break;
      }
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
        const installer = field(signal, "installer") as string | null;
        const data = OUTLET_PLATFORM_DATA;
        if (installer !== null && data.playPackages.includes(installer)) {
          name("play");
          const digest = field(signal, "initiatorCertSha256");
          if (
            typeof digest === "string" &&
            data.playStoreCertSha256s.includes(digest)
          )
            e.confidence = "attested";
        } else if (
          installer !== null &&
          data.obtainiumPackages.includes(installer)
        )
          name("obtainium");
        else if (
          installer !== null &&
          data.fdroidClientPackages.includes(installer)
        )
          name("fdroid-repo");
        else if (
          installer === null ||
          installer === "com.android.shell" ||
          data.systemInstallerPackages.includes(installer)
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
      case "node.packageManager": {
        const manager = field(signal, "manager");
        if (manager === "npm" || manager === "pnpm" || manager === "npx")
          name("direct", manager);
        break;
      }
      default:
        break;
    }
    evidence.push(e);
  }
  const vetoed = (kind: string): boolean =>
    evidence.some((e) => e.vetoes.includes(kind));

  // 2. Attested naming.
  const attested = evidence.filter(
    (e) => e.confidence === "attested" && e.names !== null,
  );
  if (attested.length > 0) {
    const first = attested[0]!;
    if (attested.some((e) => e.names!.kind !== first.names!.kind))
      return { ...UNKNOWN_DETECTION };
    if (vetoed(first.names!.kind)) return { ...UNKNOWN_DETECTION };
    return {
      kind: first.names!.kind,
      confidence: "attested",
      source: first.signal,
      subkind: first.names!.subkind,
    };
  }

  // 3. The stamp.
  if (!stamp) return { ...UNKNOWN_DETECTION };
  const current: DetectedOutlet = {
    kind: stamp.outletKind,
    confidence: "stamp",
    source: "stamp",
    subkind: isSubkind(stamp.subkind) ? stamp.subkind : null,
  };

  // 4. Vetoes.
  if (vetoed(current.kind)) return { ...UNKNOWN_DETECTION };

  // 5. Restricting signals: declared, then heuristic, each in vocabulary order.
  const ceiling = width(current.kind, current.subkind);
  for (const conf of ["declared", "heuristic"] as const)
    for (const e of evidence) {
      if (e.confidence !== conf || e.names === null) continue;
      if (width(e.names.kind, e.names.subkind) > ceiling) continue;
      return {
        kind: e.names.kind,
        confidence: conf,
        source: e.signal,
        subkind:
          e.names.subkind ??
          (e.names.kind === current.kind ? current.subkind : null),
      };
    }
  return current;
}
