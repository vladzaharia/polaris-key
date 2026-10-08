// `update-matrix.json` (plans/P3-01.md §4.6) and its `contentRows` (plans/P4-13.md §4.3).

import {
  AUD_V3,
  CLOCK_SKEW,
  FEED_EXPIRES,
  FEED_ISSUED,
  FEED_NOW,
  ISSUER_V3,
  MAX_WIRE_INTEGER_REF,
} from "./common.js";
import {
  P13_COUNTS,
  P13_RELEASES,
  P13_SALT,
  p13Hash,
  p13PackOf,
  p13PackSets,
  p13Pin,
  p13Rel,
  p13RevRecord,
  type P13Row,
} from "./content-fixture.js";
import {
  APP_STORE_URL,
  LIVE,
  pinOf,
  record,
  RECORDS,
  ROLLOUT_SALT,
} from "./release-records.js";
import { ctxOf } from "./reference/claims.js";
import {
  refBootDecisionV2,
  type RefContentRowInput,
  refDecideWithContent,
  refFeedContent,
  refHoldsOf,
  refPackSetId,
} from "./reference/content.js";
import { refFeedClaims } from "./reference/feed.js";
import {
  REF_BINARY_ORDER,
  REF_KIND_TABLE,
  type RefCaps,
  refEffectiveCapabilities,
} from "./reference/outlet.js";
import { refRecordClaims } from "./reference/record.js";
import {
  refBootDecision,
  refBucket,
  refDecideUpdate,
  type RefInput,
  refResolveUpdateOutlet,
} from "./reference/update.js";
import {
  REF_SCHEMES,
  refCompareVersions,
  refParseVersion,
} from "./reference/versions.js";

// ── §4.6 `update-matrix.json` ────────────────────────────────────────────────────────────────

/** `F`: six targets in `RELEASE_PLATFORMS` order, each pinning R15 (plans/P3-01.md §4.6). */
function matrixFeed(): Record<string, any> {
  const e = (
    kind: string,
    live: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    kind,
    live,
    halted: false,
    ...extra,
  });
  const L15 = LIVE("1.5.0", 15);
  const L14 = LIVE("1.4.0", 14);
  const appStore = e("app-store", L14, { listingUrl: APP_STORE_URL });
  const t = (
    platform: string,
    outlets: Record<string, unknown>,
  ): Record<string, unknown> => ({
    platform,
    release: pinOf("R15"),
    floor: null,
    critical: false,
    outlets,
  });
  return {
    schemaVersion: 1,
    iss: ISSUER_V3,
    aud: AUD_V3,
    channel: "stable",
    selector: {},
    seq: 7,
    issuedAt: FEED_ISSUED,
    expiresAt: FEED_EXPIRES,
    app: {
      deliverable: "app",
      versionScheme: "semver",
      targets: [
        t("macos", {
          direct: e("direct", L15),
          "app-store": structuredClone(appStore),
          steam: e("steam", L15),
        }),
        t("ios", {
          direct: e("direct", L15),
          "app-store": structuredClone(appStore),
          testflight: e("testflight", L15),
          altstore: e("altstore", L15),
          "altstore-beta": e("altstore", L14),
        }),
        t("android", {
          direct: e("direct", L15),
          play: e("play", L14),
          obtainium: e("obtainium", L15),
        }),
        t("windows", {
          direct: e("direct", L15),
          steam: e("steam", L15),
          "ms-store": e("ms-store", L14),
        }),
        t("linux", {
          direct: e("direct", L15),
          steam: e("steam", L15),
          flathub: e("flathub", L14),
        }),
        t("web", { web: e("web", L15) }),
      ],
    },
  };
}

function rescheme(
  feed: Record<string, any>,
  scheme: string,
  pin: string,
  map: (v: string, seq: number) => [string, number],
): void {
  feed.app.versionScheme = scheme;
  for (const t of feed.app.targets) {
    t.release = pinOf(pin);
    for (const en of Object.values<Record<string, any>>(t.outlets))
      if (en.live) {
        const [v, s] = map(en.live.version, en.live.seq);
        en.live = LIVE(v, s);
      }
  }
}

function matrixFeedB(): Record<string, any> {
  const f = matrixFeed();
  rescheme(f, "semver+build", "RB", (v, s) =>
    v === "1.5.0" ? ["1.5.0+46", 16] : [v, s],
  );
  return f;
}
function matrixFeed4(): Record<string, any> {
  const f = matrixFeed();
  rescheme(f, "4part", "R4", (v, s) => [`${v}.0`, s]);
  return f;
}
function matrixFeedBeta(): Record<string, any> {
  return {
    ...matrixFeed(),
    channel: "beta",
    app: {
      deliverable: "app",
      versionScheme: "semver",
      targets: [
        {
          platform: "macos",
          release: pinOf("R16b"),
          floor: null,
          critical: false,
          outlets: {
            direct: {
              kind: "direct",
              live: LIVE("1.6.0-beta.2", 16),
              halted: false,
            },
          },
        },
      ],
    },
  };
}

function baseInput(): RefInput {
  return {
    now: FEED_NOW,
    feed: matrixFeed(),
    record: structuredClone(record("R15").doc),
    installed: {
      version: "1.4.0",
      binaryVersion: "1.4.0",
      buildNumber: "140",
      platform: "macos",
      arch: "arm64",
      format: null,
      engine: "godot-4.7",
    },
    outlet: { id: "direct", kind: "direct" },
    subkind: null,
    staged: null,
    skipVersion: null,
    bucket: null,
    methods: ["download"],
  };
}

/** The delta rule (§4.6), as functions. */
const D = {
  W: (i: RefInput): void => {
    i.installed.platform = "windows";
    i.installed.arch = "x86_64";
    i.installed.format = "zip";
    i.methods = ["sidecar-pck", "download"];
  },
  installed:
    (v: string) =>
    (i: RefInput): void => {
      i.installed.version = v;
      i.installed.binaryVersion = v;
    },
  version:
    (v: string) =>
    (i: RefInput): void =>
      void (i.installed.version = v),
  binary:
    (v: string) =>
    (i: RefInput): void =>
      void (i.installed.binaryVersion = v),
  platform:
    (p: string, arch?: string) =>
    (i: RefInput): void => {
      i.installed.platform = p;
      if (arch) i.installed.arch = arch;
    },
  format:
    (f: string) =>
    (i: RefInput): void =>
      void (i.installed.format = f),
  outlet:
    (id: string | null, kind?: string) =>
    (i: RefInput): void =>
      void (i.outlet = { id, kind: kind ?? (id as string) }),
  subkind:
    (s: string) =>
    (i: RefInput): void =>
      void (i.subkind = s),
  methods:
    (...m: string[]) =>
    (i: RefInput): void =>
      void (i.methods = m),
  staged:
    (version: string, channel: string) =>
    (i: RefInput): void =>
      void (i.staged = { version, channel }),
  skip:
    (v: string) =>
    (i: RefInput): void =>
      void (i.skipVersion = v),
  bucket:
    (n: number | null) =>
    (i: RefInput): void =>
      void (i.bucket = n),
  now:
    (t: number) =>
    (i: RefInput): void =>
      void (i.now = t),
  engine:
    (e: string) =>
    (i: RefInput): void =>
      void (i.installed.engine = e),
  recordNull: (i: RefInput): void => void (i.record = null),
  floor:
    (platform: string, v: string) =>
    (i: RefInput): void => {
      i.feed.app.targets.find(
        (t: Record<string, any>) => t.platform === platform,
      ).floor = { minVersion: v };
    },
  /** An entry change on the decided platform (`installed.platform`). */
  entry:
    (id: string, patch: Record<string, unknown>) =>
    (i: RefInput): void => {
      const t = i.feed.app.targets.find(
        (x: Record<string, any>) => x.platform === i.installed.platform,
      );
      Object.assign(t.outlets[id], patch);
    },
  rollout:
    (bp: number) =>
    (i: RefInput): void => {
      const t = i.feed.app.targets.find(
        (x: Record<string, any>) => x.platform === i.installed.platform,
      );
      t.outlets.direct.rollout = { bp, salt: ROLLOUT_SALT };
    },
  critical: (i: RefInput): void => {
    i.feed.app.targets.find(
      (x: Record<string, any>) => x.platform === i.installed.platform,
    ).critical = true;
  },
  feedRecord:
    (feed: () => Record<string, any>, rec: string) =>
    (i: RefInput): void => {
      i.feed = feed();
      i.record = structuredClone(record(rec).doc);
    },
};

type Delta = (i: RefInput) => void;
/** The plan's expected decision, in its own terms; every given member must match. */
interface Want {
  action: string;
  reason?: string;
  method?: string;
  build?: string;
  release?: string;
  mandatory?: boolean;
  critical?: boolean;
  discardStaged?: boolean;
  listingUrl?: string | null;
  boot: "none" | "optional";
}

function updateRowsSpec(): { name: string; deltas: Delta[]; want: Want }[] {
  const { W } = D;
  const row = (
    name: string,
    deltas: Delta[],
    want: Want,
  ): { name: string; deltas: Delta[]; want: Want } => ({ name, deltas, want });
  const o = "optional" as const;
  const n = "none" as const;
  const r6 = [D.floor("macos", "1.5.0")];
  const r26 = [D.platform("ios"), D.outlet("app-store"), D.installed("1.3.0")];
  const r45 = [D.outlet(null, "unknown")];
  return [
    row("none — up to date", [D.installed("1.5.0")], {
      action: "none",
      reason: "up-to-date",
      boot: n,
    }),
    row(
      "none — behind: the channel head is older, nothing is downgraded",
      [D.installed("1.6.0-beta.1")],
      { action: "none", reason: "behind", boot: n },
    ),
    row(
      "none — behind suppresses the floor",
      [D.installed("1.6.0"), D.binary("1.3.0"), D.floor("macos", "1.4.0")],
      { action: "none", reason: "behind", boot: n },
    ),
    row("binary — download a newer release on `direct` (universal build)", [], {
      action: "binary",
      method: "download",
      build: "macos-dmg",
      boot: o,
    }),
    row(
      "binary — native when the host has a native updater",
      [D.methods("native", "download")],
      { action: "binary", method: "native", build: "macos-dmg", boot: o },
    ),
    row("binary — mandatory below this platform's floor", r6, {
      action: "binary",
      method: "download",
      build: "macos-dmg",
      mandatory: true,
      boot: o,
    }),
    row(
      "binary — the floor is judged against the binary, not the running code",
      [W, D.version("1.5.0"), D.binary("1.3.0"), D.floor("windows", "1.4.0")],
      {
        action: "binary",
        method: "download",
        build: "win-zip",
        mandatory: true,
        boot: o,
      },
    ),
    row("binary — sidecar-pck: same engine, the binary meets minBinary", [W], {
      action: "binary",
      method: "sidecar-pck",
      build: "win-pck",
      boot: o,
    }),
    row(
      "binary — an engine change: the binary supersedes code",
      [W, D.engine("godot-4.6")],
      { action: "binary", method: "download", build: "win-zip", boot: o },
    ),
    row(
      "binary — minBinary not met: the binary supersedes code",
      [W, D.version("1.3.5"), D.binary("1.3.0")],
      { action: "binary", method: "download", build: "win-zip", boot: o },
    ),
    row(
      "binary — a mandatory update never takes the code path",
      [W, D.floor("windows", "1.5.0")],
      {
        action: "binary",
        method: "download",
        build: "win-zip",
        mandatory: true,
        boot: o,
      },
    ),
    row(
      "code-ready — the staged release is the target on the same channel",
      [W, D.staged("1.5.0", "stable")],
      { action: "code-ready", discardStaged: false, boot: o },
    ),
    row(
      "binary — staged code from another channel is discarded",
      [W, D.staged("1.5.0", "beta")],
      { action: "binary", method: "sidecar-pck", discardStaged: true, boot: o },
    ),
    row(
      "binary — a stale staged release is discarded",
      [W, D.staged("1.4.5", "stable")],
      { action: "binary", method: "sidecar-pck", discardStaged: true, boot: o },
    ),
    row(
      "binary — the skipped version is still offered as a download",
      [W, D.skip("1.5.0")],
      { action: "binary", method: "download", build: "win-zip", boot: o },
    ),
    row(
      "none — the skipped version with no other method",
      [W, D.methods("sidecar-pck"), D.skip("1.5.0")],
      { action: "none", reason: "skipped", boot: n },
    ),
    row("none — no method this host can perform", [D.methods()], {
      action: "none",
      reason: "no-method",
      boot: n,
    }),
    row(
      "blocked — below the floor with no method: a prompt, and play goes on",
      [D.methods(), D.floor("macos", "1.5.0")],
      { action: "blocked", reason: "app-floor", boot: o },
    ),
    row(
      "none — halted, and the staged update is discarded",
      [W, D.entry("direct", { halted: true }), D.staged("1.5.0", "stable")],
      { action: "none", reason: "halted", discardStaged: true, boot: n },
    ),
    row(
      "blocked — halted below the floor",
      [D.entry("direct", { halted: true }), D.floor("macos", "1.5.0")],
      { action: "blocked", reason: "app-floor", boot: o },
    ),
    row("none — out of the rollout bucket", [D.rollout(2500), D.bucket(6871)], {
      action: "none",
      reason: "out-of-bucket",
      boot: n,
    }),
    row(
      "binary — inside the rollout bucket",
      [D.rollout(7000), D.bucket(6871)],
      { action: "binary", method: "download", build: "macos-dmg", boot: o },
    ),
    row(
      "none — a bucket equal to bp is out",
      [D.rollout(6871), D.bucket(6871)],
      { action: "none", reason: "out-of-bucket", boot: n },
    ),
    row(
      "binary — a critical release bypasses the rollout",
      [D.rollout(2500), D.bucket(6871), D.critical],
      { action: "binary", method: "download", critical: true, boot: o },
    ),
    row(
      "binary — below the floor bypasses the rollout",
      [D.rollout(2500), D.bucket(6871), D.floor("macos", "1.5.0")],
      { action: "binary", method: "download", mandatory: true, boot: o },
    ),
    row("store — a newer release is live on the App Store", r26, {
      action: "store",
      release: "1.4.0",
      listingUrl: APP_STORE_URL,
      boot: o,
    }),
    row(
      "none — the App Store has nothing newer",
      [D.platform("ios"), D.outlet("app-store"), D.installed("1.4.0")],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "store — mandatory, and the store's release clears the floor",
      [...r26, D.floor("ios", "1.4.0")],
      { action: "store", release: "1.4.0", mandatory: true, boot: o },
    ),
    row(
      "store — mandatory although the store's release is still below the floor",
      [...r26, D.floor("ios", "1.5.0")],
      { action: "store", release: "1.4.0", mandatory: true, boot: o },
    ),
    row(
      "blocked — below the floor, and the store has nothing newer",
      [
        D.platform("ios"),
        D.outlet("app-store"),
        D.installed("1.4.0"),
        D.floor("ios", "1.5.0"),
      ],
      { action: "blocked", reason: "app-floor", boot: o },
    ),
    row(
      "store — store builds never self-update code",
      [
        D.platform("macos"),
        D.outlet("app-store"),
        D.installed("1.3.0"),
        D.methods("sidecar-pck", "download"),
        D.staged("1.4.0", "stable"),
      ],
      { action: "store", release: "1.4.0", discardStaged: true, boot: o },
    ),
    row(
      "platform — Steam has a newer release",
      [D.platform("linux", "x86_64"), D.outlet("steam")],
      { action: "platform", release: "1.5.0", boot: n },
    ),
    row(
      "platform — mandatory through Steam",
      [
        D.platform("linux", "x86_64"),
        D.outlet("steam"),
        D.floor("linux", "1.5.0"),
      ],
      { action: "platform", release: "1.5.0", mandatory: true, boot: o },
    ),
    row(
      "platform — web reloads",
      [D.platform("web", "wasm32"), D.outlet("web")],
      { action: "platform", release: "1.5.0", boot: n },
    ),
    row(
      "none — the outlet has no entry for this platform",
      [D.platform("linux", "x86_64"), D.outlet("itch")],
      { action: "none", reason: "not-available", boot: n },
    ),
    row(
      "none — no target for the platform",
      [
        (i) =>
          void (i.feed.app.targets = i.feed.app.targets.filter(
            (t: Record<string, any>) => t.platform !== "android",
          )),
        D.platform("android", "arm64"),
        D.outlet("obtainium"),
      ],
      { action: "none", reason: "not-available", boot: n },
    ),
    row(
      "binary — another platform's floor does not apply",
      [W, D.floor("macos", "1.5.0")],
      { action: "binary", method: "sidecar-pck", build: "win-pck", boot: o },
    ),
    row("none — no record for a self-updating outlet", [D.recordNull], {
      action: "none",
      reason: "not-available",
      boot: n,
    }),
    row(
      "none — a stale feed freezes, and the staged update is kept",
      [D.now(1700001200), W, D.staged("1.5.0", "stable")],
      { action: "none", reason: "stale", discardStaged: false, boot: n },
    ),
    row(
      "none — a stale feed never blocks below the floor",
      [D.now(1700001200), D.floor("macos", "1.5.0")],
      { action: "none", reason: "stale", boot: n },
    ),
    row("binary — one second before stale", [D.now(1700001199)], {
      action: "binary",
      method: "download",
      boot: o,
    }),
    row(
      "binary — server narrowing turns code updates off",
      [W, D.entry("direct", { capabilities: { codeUpdates: false } })],
      { action: "binary", method: "download", build: "win-zip", boot: o },
    ),
    row(
      "store — the server cannot widen an App Store build to self",
      [
        ...r26,
        D.entry("app-store", { capabilities: { binaryUpdates: "self" } }),
      ],
      { action: "store", release: "1.4.0", boot: o },
    ),
    row(
      "platform — a Homebrew install is updated by brew",
      [D.subkind("homebrew")],
      { action: "platform", release: "1.5.0", boot: n },
    ),
    row("none — an unknown outlet is never offered an update", r45, {
      action: "none",
      reason: "not-available",
      boot: n,
    }),
    row(
      "blocked — an unknown outlet below the floor",
      [...r45, D.floor("macos", "1.5.0")],
      { action: "blocked", reason: "app-floor", boot: o },
    ),
    row(
      "binary — format gating picks the installed format",
      [D.platform("windows", "x86_64"), D.format("exe")],
      { action: "binary", method: "download", build: "win-exe", boot: o },
    ),
    row(
      "binary — the arm64 build on an arm64 Linux device",
      [D.platform("linux", "arm64")],
      { action: "binary", method: "download", build: "linux-arm64", boot: o },
    ),
    row(
      "none — no build for the device's arch",
      [D.platform("linux", "armv7")],
      { action: "none", reason: "no-build", boot: n },
    ),
    row(
      "binary — a prerelease target on beta",
      [D.feedRecord(matrixFeedBeta, "R16b"), D.installed("1.5.0")],
      {
        action: "binary",
        method: "download",
        build: "macos-dmg",
        release: "1.6.0-beta.2",
        boot: o,
      },
    ),
    row(
      "none — an installed version that does not parse",
      [D.installed("1.5")],
      { action: "none", reason: "unknown-version", boot: n },
    ),
    row(
      "store — iOS web distribution opens its page, never installs itself or loads code",
      [D.platform("ios", "arm64"), D.outlet("direct")],
      { action: "store", release: "1.5.0", listingUrl: null, boot: o },
    ),
    row(
      "none — a rollout with no bucket is out",
      [D.rollout(7000), D.bucket(null)],
      { action: "none", reason: "out-of-bucket", boot: n },
    ),
    row(
      "binary — a store-only build is never installed",
      [D.platform("android", "arm64"), D.outlet("direct")],
      { action: "binary", method: "download", build: "apk", boot: o },
    ),
    row(
      "binary — a build with no payload file is never installed",
      [W, D.methods("download")],
      { action: "binary", method: "download", build: "win-zip", boot: o },
    ),
    row(
      "store — an AltStore beta source reads its own entry",
      [
        D.platform("ios"),
        D.outlet("altstore-beta", "altstore"),
        D.installed("1.3.0"),
      ],
      { action: "store", release: "1.4.0", listingUrl: null, boot: o },
    ),
    row(
      "none — two entries of the detected kind, and no id to choose",
      [D.platform("ios"), D.outlet(null, "altstore"), D.installed("1.3.0")],
      { action: "none", reason: "not-available", boot: n },
    ),
    row(
      "store — the one entry of the detected kind",
      [D.platform("ios"), D.outlet(null, "app-store"), D.installed("1.3.0")],
      { action: "store", release: "1.4.0", boot: o },
    ),
    row(
      "binary — `semver+build`: a higher build number is newer",
      [D.feedRecord(matrixFeedB, "RB"), D.installed("1.5.0+45")],
      { action: "binary", method: "download", build: "macos-dmg", boot: o },
    ),
    row(
      "none — `semver+build`: the same build is up to date",
      [D.feedRecord(matrixFeedB, "RB"), D.installed("1.5.0+46")],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "binary — `semver+build`: no build metadata is older",
      [D.feedRecord(matrixFeedB, "RB"), D.installed("1.5.0")],
      { action: "binary", method: "download", build: "macos-dmg", boot: o },
    ),
    row(
      "binary — `4part`: parts compare numerically",
      [D.feedRecord(matrixFeed4, "R4"), D.installed("1.4.9.9")],
      { action: "binary", method: "download", build: "macos-dmg", boot: o },
    ),
    row(
      "none — `4part`: 1.10 is newer than 1.5, so the device is behind",
      [D.feedRecord(matrixFeed4, "R4"), D.installed("1.10.0.0")],
      { action: "none", reason: "behind", boot: n },
    ),
    row(
      "none — `4part`: a three-part version does not parse",
      [D.feedRecord(matrixFeed4, "R4"), D.installed("1.5.0")],
      { action: "none", reason: "unknown-version", boot: n },
    ),
    row(
      "none — `seq` values compare exactly at 2^53 − 1",
      [
        (i) => {
          const t = i.feed.app.targets[0];
          t.release = pinOf("R15max");
          t.outlets.direct.live = LIVE("1.5.0", MAX_WIRE_INTEGER_REF - 1);
          i.record = structuredClone(record("R15max").doc);
        },
      ],
      { action: "none", reason: "not-available", boot: n },
    ),
  ];
}

export function buildUpdateMatrixV1(): unknown {
  const fail = (m: string): never => {
    throw new Error(`update-matrix: ${m}`);
  };
  const vocabulary = {
    // plans/P4-13.md §2.6: P3-01's reserved values, added together with the constants.
    actions: [
      "none",
      "code-ready",
      "binary",
      "store",
      "platform",
      "blocked",
      "packs",
    ],
    noneReasons: [
      "up-to-date",
      "behind",
      "not-available",
      "halted",
      "out-of-bucket",
      "stale",
      "skipped",
      "no-method",
      "no-build",
      "unknown-version",
    ],
    blockedReasons: ["app-floor", "content-floor", "revoked-content"],
    methods: ["native", "download", "sidecar-pck"],
    boot: ["none", "optional", "required"],
    schemes: [...REF_SCHEMES],
  };
  const versionSpec: [string, string, string, number | null, string][] = [
    ["semver", "1.2.3", "1.2.4", -1, "patch"],
    ["semver", "1.10.0", "1.9.0", 1, "numeric, not text"],
    ["semver", "1.0.0-alpha", "1.0.0", -1, "a prerelease is lower"],
    [
      "semver",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      -1,
      "numeric below non-numeric",
    ],
    [
      "semver",
      "1.0.0-9",
      "1.0.0-10a",
      -1,
      "the same, where text order would say otherwise",
    ],
    [
      "semver",
      "1.0.0-alpha.10",
      "1.0.0-alpha.9",
      1,
      "numeric prerelease identifiers",
    ],
    ["semver", "1.2.3+45", "1.2.3+9", 0, "build metadata ignored"],
    [
      "semver",
      "99999999999999999999.0.0",
      "99999999999999999998.0.0",
      1,
      "exact beyond 2^53",
    ],
    ["semver", "01.2.3", "1.2.3", null, "a leading zero does not parse"],
    ["semver", "1.2", "1.2.0", null, "two parts do not parse"],
    [
      "semver+build",
      "1.2.3+45",
      "1.2.3+9",
      1,
      "numeric build metadata breaks the tie",
    ],
    ["semver+build", "1.2.3", "1.2.3+0", -1, "no metadata is lower"],
    [
      "semver+build",
      "1.2.3+build.5",
      "1.2.3",
      0,
      "non-numeric metadata counts as none",
    ],
    ["semver+build", "1.2.4", "1.2.3+99", 1, "SemVer first"],
    [
      "semver+build",
      "1.2.3-rc.1+50",
      "1.2.3+1",
      -1,
      "a prerelease stays lower",
    ],
    ["4part", "1.10.0.0", "1.9.0.0", 1, "numeric parts"],
    ["4part", "1.2.3.4", "1.2.3.4", 0, "equal"],
    ["4part", "1.2.3", "1.2.3.0", null, "three parts do not parse"],
    ["4part", "1.02.3.4", "1.2.3.4", null, "a leading zero does not parse"],
    ["4part", "1.2.3.4-beta", "1.2.3.4", null, "no prerelease in 4part"],
    [
      "semver",
      "1.0.0-a..b",
      "1.0.0-a.0.b",
      null,
      "an empty prerelease identifier does not parse",
    ],
    [
      "semver",
      "1.0.0-01",
      "1.0.0-1",
      null,
      "a numeric prerelease identifier with a leading zero does not parse",
    ],
    [
      "semver+build",
      "1.2.3+",
      "1.2.3",
      null,
      "empty build metadata does not parse",
    ],
    [
      "semver",
      "1.2.3\n",
      "1.2.3",
      null,
      "a trailing U+000A does not parse (whole-string match)",
    ],
    ["4part", "1.2.3.4\n", "1.2.3.4", null, "the same under 4part"],
  ];
  const versionCases = versionSpec.map(([scheme, a, b, expect, name], k) => {
    const got = refCompareVersions(scheme, a, b);
    if (got !== expect)
      fail(`version case ${k + 1} computes ${got}, the plan says ${expect}`);
    return { name: `${k + 1}. ${name}`, scheme, a, b, expect };
  });
  for (const k of [23, 24]) {
    const c = versionCases[k]!;
    if (refParseVersion(c.scheme, c.a.replace(/\n$/, "")) === null)
      fail(`version case ${k + 1} without the terminator must parse`);
  }

  const everything = {
    binaryUpdates: "self",
    codeUpdates: true,
    dataUpdates: true,
    channelSwitch: true,
    commerce: "own",
    downloadedScripts: true,
  };
  const capSpec: [
    string,
    string,
    string,
    string | null,
    Record<string, unknown>,
    Partial<RefCaps>,
  ][] = [
    ["direct defaults", "direct", "macos", null, {}, {}],
    [
      "the server narrows codeUpdates",
      "direct",
      "macos",
      null,
      { codeUpdates: false },
      { codeUpdates: false },
    ],
    [
      "the server cannot widen app-store to self",
      "app-store",
      "macos",
      null,
      { binaryUpdates: "self" },
      {},
    ],
    [
      "the server narrows self to none",
      "direct",
      "macos",
      null,
      { binaryUpdates: "none" },
      { binaryUpdates: "none" },
    ],
    [
      "the server sets commerce: none, which applies",
      "direct",
      "macos",
      null,
      { commerce: "none" },
      { commerce: "none" },
    ],
    [
      "the server sets commerce: store-iap on direct, which is ignored",
      "direct",
      "macos",
      null,
      { commerce: "store-iap" },
      {},
    ],
    [
      "subkind homebrew on direct",
      "direct",
      "macos",
      "homebrew",
      {},
      { binaryUpdates: "none", codeUpdates: false },
    ],
    [
      "unknown stays restrictive under a server that allows everything",
      "unknown",
      "macos",
      null,
      everything,
      {},
    ],
    [
      "a server true over a false default (web codeUpdates) is ignored",
      "web",
      "web",
      null,
      { codeUpdates: true },
      {},
    ],
    [
      "direct on ios: store, no code, no downloaded scripts",
      "direct",
      "ios",
      null,
      everything,
      { binaryUpdates: "store", codeUpdates: false, downloadedScripts: false },
    ],
  ];
  const capabilityCases = capSpec.map(
    ([name, kind, platform, subkind, server, delta], k) => {
      const { platforms: _p, ...defaults } = REF_KIND_TABLE[kind]!;
      const expect = { ...defaults, ...delta };
      const got = refEffectiveCapabilities(kind, { platform, subkind, server });
      if (JSON.stringify(got) !== JSON.stringify(expect))
        fail(`capability case ${k + 1}: ${JSON.stringify(got)}`);
      return {
        name: `${k + 1}. ${name}`,
        kind,
        platform,
        subkind,
        server,
        expect,
      };
    },
  );

  const outletSpec: [
    string,
    unknown,
    Record<string, unknown> | null,
    Record<string, unknown> | null,
    [string | null, string, string | null],
  ][] = [
    [
      "the host wins",
      { id: "altstore-beta", kind: "altstore" },
      { outlet: "direct", outletKind: "direct" },
      null,
      ["altstore-beta", "altstore", null],
    ],
    [
      "a bare kind is its own id",
      "steam",
      null,
      null,
      ["steam", "steam", null],
    ],
    [
      "the stamp's id and kind",
      null,
      { outlet: "direct", outletKind: "direct" },
      null,
      ["direct", "direct", null],
    ],
    [
      "a product outlet id of a kind",
      null,
      { outlet: "itch-beta", outletKind: "itch" },
      null,
      ["itch-beta", "itch", null],
    ],
    [
      "no outletKind, so the id is the kind",
      null,
      { outlet: "steam" },
      null,
      ["steam", "steam", null],
    ],
    [
      "a kind outside the 17",
      null,
      { outlet: "epic-store", outletKind: "epic" },
      null,
      [null, "unknown", null],
    ],
    ["nothing configured", null, null, null, [null, "unknown", null]],
    [
      "the stamp's subkind",
      null,
      { outlet: "direct", outletKind: "direct", outletSubkind: "flatpak" },
      null,
      ["direct", "direct", "flatpak"],
    ],
    [
      "detection moved the kind",
      null,
      { outlet: "direct", outletKind: "direct" },
      {
        kind: "steam",
        confidence: "declared",
        source: "steam.libraryManifest",
        subkind: null,
      },
      [null, "steam", null],
    ],
    [
      "detection confirmed the kind and added a subkind",
      null,
      { outlet: "direct", outletKind: "direct" },
      {
        kind: "direct",
        confidence: "heuristic",
        source: "macos.homebrewCask",
        subkind: "homebrew",
      },
      ["direct", "direct", "homebrew"],
    ],
    [
      "detection with no stamp",
      null,
      null,
      {
        kind: "app-store",
        confidence: "attested",
        source: "ios.appDistributor",
        subkind: null,
      },
      [null, "app-store", null],
    ],
    [
      "an id outside OUTLET_ID_PATTERN",
      null,
      { outlet: "Direct Build", outletKind: "direct" },
      null,
      [null, "direct", null],
    ],
  ];
  const outletCases = outletSpec.map(
    ([name, host, stamp, detected, [id, kind, subkind]], k) => {
      const expect = { id, kind, subkind };
      const got = refResolveUpdateOutlet({ host, stamp, detected });
      if (JSON.stringify(got) !== JSON.stringify(expect))
        fail(`outlet case ${k + 1}: ${JSON.stringify(got)}`);
      return { name: `${k + 1}. ${name}`, host, stamp, detected, expect };
    },
  );

  const bucketSpec: [string, string, string, string, number, number][] = [
    ["corpus device", ROLLOUT_SALT, "dev_7c1e2d", "36cae637", 919266871, 6871],
    [
      "top bit set",
      ROLLOUT_SALT,
      "device-fixture-01",
      "c654abc5",
      3327437765,
      7765,
    ],
    [
      "another salt",
      "0123456789abcdef0123456789abcdef",
      "dev_7c1e2d",
      "1cfbabd6",
      486255574,
      5574,
    ],
    [
      "top bit, small bucket",
      ROLLOUT_SALT,
      "dev_probe_1",
      "fd307c32",
      4247813170,
      3170,
    ],
    ["bucket 0", ROLLOUT_SALT, "dev_probe_9167", "8ee96360", 2397660000, 0],
    [
      "bucket 9999",
      ROLLOUT_SALT,
      "dev_probe_3276",
      "d456100f",
      3562409999,
      9999,
    ],
  ];
  const bucketVectors = bucketSpec.map(
    ([name, salt, installId, first4, u32, bucket]) => {
      const got = refBucket(salt, installId);
      if (got.first4 !== first4 || got.u32 !== u32 || got.bucket !== bucket)
        fail(`bucket vector ${name}: ${JSON.stringify(got)}`);
      return { name, salt, installId, sha256: got.sha256, first4, u32, bucket };
    },
  );

  const used = {
    actions: new Set<string>(),
    none: new Set<string>(),
    blocked: new Set<string>(),
    methods: new Set<string>(),
    schemes: new Set<string>(),
    classes: new Set<string>(),
  };
  const rows = updateRowsSpec().map((spec, k) => {
    const input = baseInput();
    for (const d of spec.deltas) d(input);
    const decision = refDecideUpdate(input);
    const boot = refBootDecision(decision);
    const where = `row ${k + 1} (${spec.name})`;
    const w = spec.want;
    if (decision.action !== w.action)
      fail(`${where}: ${decision.action} != ${w.action}`);
    for (const key of [
      "reason",
      "method",
      "build",
      "mandatory",
      "critical",
      "discardStaged",
      "listingUrl",
    ] as const)
      if (w[key] !== undefined && decision[key] !== w[key])
        fail(`${where}: ${key} ${String(decision[key])} != ${String(w[key])}`);
    if (
      w.release !== undefined &&
      (decision.release as Record<string, unknown>).version !== w.release
    )
      fail(`${where}: release`);
    if (boot !== w.boot) fail(`${where}: boot ${boot} != ${w.boot}`);
    if (boot === "required") fail(`${where}: no v4 row answers required`);
    // Every row's feed passes the feed claims, and its record the record claims and the pin.
    const feedText = JSON.stringify(input.feed);
    if (
      refFeedClaims(input.feed, ctxOf(feedText), {
        aud: AUD_V3,
        channel: input.feed.channel,
      }) !== null
    )
      fail(`${where}: its feed fails the claims`);
    if (input.record) {
      if (
        !refRecordClaims(
          input.record,
          ctxOf(JSON.stringify(input.record)),
          AUD_V3,
        )
      )
        fail(`${where}: its record fails the claims`);
      const target = input.feed.app.targets.find(
        (t: Record<string, any>) => t.platform === input.installed.platform,
      );
      if (target) {
        const named = [...RECORDS!.values()].find(
          (r) => r.sha256 === target.release.sha256,
        );
        if (
          !named ||
          JSON.stringify(named.doc) !== JSON.stringify(input.record)
        )
          fail(`${where}: the record is not the pin's`);
      }
    }
    used.actions.add(decision.action as string);
    if (decision.action === "none") used.none.add(decision.reason as string);
    if (decision.action === "blocked")
      used.blocked.add(decision.reason as string);
    if (decision.action === "binary")
      used.methods.add(decision.method as string);
    used.schemes.add(input.feed.app.versionScheme);
    used.classes.add(
      refEffectiveCapabilities(input.outlet.kind, {
        platform: input.installed.platform,
        subkind: input.subkind,
      }).binaryUpdates,
    );
    return {
      name: `${k + 1}. ${spec.name}`,
      input,
      expect: { decision, boot },
    };
  });
  if (rows.length !== 65) fail(`${rows.length} rows, not 65`);
  // plans/P4-13.md §4.3: the content rows, after `rows`.
  const content = buildContentRows(fail);
  const usedBoot = new Set<string>(content.used.boot);
  for (const r of rows) usedBoot.add((r.expect as { boot: string }).boot);
  for (const v of content.used.actions) used.actions.add(v);
  for (const v of content.used.blocked) used.blocked.add(v);
  // Every vocabulary value, `required` included (no longer exempt), is produced by a row.
  for (const [list, set] of [
    [vocabulary.actions, used.actions],
    [vocabulary.noneReasons, used.none],
    [vocabulary.blockedReasons, used.blocked],
    [vocabulary.methods, used.methods],
    [vocabulary.schemes, used.schemes],
    [vocabulary.boot, usedBoot],
    [REF_BINARY_ORDER, used.classes],
  ] as const)
    for (const v of list) if (!set.has(v)) fail(`${v} is produced by no row`);

  return {
    updateMatrixVersion: 1,
    description:
      "The update decision (plans/P3-01.md §2.8; WIRE-CONTRACT-V4 §11, client behaviour outside the wire contract). `versionCases` pin `compareVersions(scheme, a, b)` (null when either side does not parse); `capabilityCases` pin `effectiveCapabilities(kind, {platform, subkind, server})`; `outletCases` pin `resolveUpdateOutlet({host, stamp, detected})` (a host value that is invalid raises `invalid-options`, so none is listed); `bucketVectors` pin `rolloutBucket(salt, installId)`, the first four bytes of SHA-256(UTF-8(salt) ‖ UTF-8(installId)) read big-endian, mod 10000; each row's `input` is a complete `UpdateDecisionInput` with the decoded feed and record, and `expect` is the `decideUpdate` decision, compared by value, and its `bootDecision`. The generator recomputes every case and row with its own reference implementation. A runner also asserts its compiled tables against `outlet-matrix.json`.",
    vocabulary,
    versionCases,
    capabilityCases,
    outletCases,
    bucketVectors,
    rows,
    contentRows: content.rows,
  };
}

// ── `update-matrix.json#/contentRows` (plans/P4-13.md §4.3) ──────────────────────────────────

const P13_EXPECTS = [
  { pack: "diceroll.foes", required: true, delivery: "essential" },
  { pack: "diceroll.l10n", required: false, delivery: "prefetch" },
  { pack: "diceroll.skins", required: false, delivery: "on-demand" },
  { pack: "diceroll.textures", required: true, delivery: "essential" },
];

/** The rows of the base feed: android, `godot-4.4`, levels 3 and 4. */
function p13MatrixRows(): P13Row[] {
  const rows: P13Row[] = [];
  for (const [level, foes] of [
    [3, "foes@1.3.3"],
    [4, "foes@2.0.1"],
  ] as const) {
    rows.push([
      level,
      "android",
      "godot-4.4",
      {},
      [foes, "l10n@1.1.0", "skins@1.0.0"],
    ]);
    rows.push([
      level,
      "android",
      "godot-4.4",
      { texture: "astc" },
      ["tex@1.1.0"],
    ]);
    rows.push([
      level,
      "android",
      "godot-4.4",
      { texture: "etc2" },
      ["tex@1.0.0"],
    ]);
  }
  return rows;
}

/** The base `contentRows` input: CONTENT §6.8's Diceroll on android, level 4, up to date. */
function contentBaseInput(): RefContentRowInput {
  const i = baseInput() as RefContentRowInput;
  i.installed = {
    version: "1.5.0",
    binaryVersion: "1.5.0",
    buildNumber: "150",
    platform: "android",
    arch: "arm64",
    format: null,
    engine: "godot-4.4",
  };
  Object.assign(i.feed, {
    packSets: p13PackSets(p13MatrixRows(), {
      play: { pinned: ["diceroll.foes"] },
    }),
    packFloors: [
      {
        pack: "diceroll.foes",
        contentApi: 3,
        minVersion: "1.3.3",
        versionScheme: "semver",
      },
      {
        pack: "diceroll.foes",
        contentApi: 4,
        minVersion: "2.0.0",
        versionScheme: "semver",
      },
    ],
    revocations: [],
  });
  i.content = {
    stamp: {
      contentApi: 4,
      pins: [],
      expects: structuredClone(P13_EXPECTS),
      holds: [],
    },
    active: {
      "diceroll.foes": p13Pin("foes@2.0.1"),
      "diceroll.l10n": p13Pin("l10n@1.1.0"),
      "diceroll.skins": p13Pin("skins@1.0.0"),
      "diceroll.textures": p13Pin("tex@1.1.0"),
    },
    axes: { texture: ["astc", "etc2"] },
    revocations: [],
    buckets: {},
  };
  return i;
}

type CDelta = (i: RefContentRowInput) => void;
/** The deltas of `contentRows`, as functions. */
const C = {
  active:
    (pack: string, name: string | null) =>
    (i: RefContentRowInput): void => {
      if (name === null) delete i.content.active[`diceroll.${pack}`];
      else i.content.active[`diceroll.${pack}`] = p13Pin(name);
    },
  level:
    (n: number) =>
    (i: RefContentRowInput): void =>
      void (i.content.stamp.contentApi = n),
  /** A level-3 device: its stamp and the level-3 releases active. */
  level3: (i: RefContentRowInput): void => {
    i.content.stamp.contentApi = 3;
    i.content.active["diceroll.foes"] = p13Pin("foes@1.3.3");
  },
  pin:
    (name: string) =>
    (i: RefContentRowInput): void =>
      void i.content.stamp.pins.push({
        pack: p13PackOf(name),
        release: p13Pin(name),
      }),
  hold:
    (name: string) =>
    (i: RefContentRowInput): void =>
      void i.content.stamp.holds!.push({
        pack: p13PackOf(name),
        release: p13Pin(name),
      }),
  holdsUnusable: (i: RefContentRowInput): void =>
    void (i.content.stamp.holds = null),
  rows:
    (rows: P13Row[], outlets?: Record<string, unknown>) =>
    (i: RefContentRowInput): void =>
      void (i.feed.packSets = p13PackSets(
        rows,
        outlets ?? i.feed.packSets.outlets,
      )),
  floor:
    (level: number, min: string) =>
    (i: RefContentRowInput): void => {
      const f = (i.feed.packFloors as Record<string, any>[]).find(
        (x) => x.contentApi === level,
      )!;
      f.minVersion = min;
    },
  gate:
    (name: string, gate: Record<string, unknown>, fallback: string | null) =>
    (i: RefContentRowInput): void => {
      const ps = i.feed.packSets;
      if (fallback !== null) {
        const [pack, version, seq] = p13Rel(fallback);
        ps.releases[p13Hash(fallback)] = { pack, version, seq };
      }
      const o = (ps.outlets ??= {});
      o.direct = {
        gates: {
          [p13Hash(name)]: {
            ...gate,
            fallback: fallback === null ? null : p13Hash(fallback),
          },
        },
      };
    },
  bucket:
    (n: number | null) =>
    (i: RefContentRowInput): void =>
      void (i.content.buckets = { [P13_SALT]: n }),
  /** A revocation of `name`, in the feed and stored (`replacement` usable unless stated). */
  revoke:
    (name: string, replacement: string | null, usable = true, n = 1) =>
    (i: RefContentRowInput): void => {
      const [pack, version, seq] = p13Rel(name);
      (i.feed.revocations as unknown[]).push({
        record: p13RevRecord(name, n),
        pack,
        target: p13Hash(name),
        version,
        seq,
      });
      i.content.revocations.push({
        target: p13Hash(name),
        pack,
        replacement: replacement === null ? null : p13Pin(replacement),
        replacementUsable: replacement !== null && usable,
      });
    },
  outletPlay: (i: RefContentRowInput): void => {
    i.outlet = { id: "play", kind: "play" };
  },
  playLive:
    (version: string, seq: number) =>
    (i: RefContentRowInput): void => {
      const t = i.feed.app.targets.find((x: any) => x.platform === "android");
      t.outlets.play.live = LIVE(version, seq);
    },
  /** The android target pins RC16 (1.6.0, level 4 content), offered on `direct`. */
  offerRC16: (i: RefContentRowInput): void => {
    const t = i.feed.app.targets.find((x: any) => x.platform === "android");
    t.release = pinOf("RC16");
    t.outlets.direct.live = LIVE("1.6.0", 16);
    i.record = structuredClone(record("RC16").doc);
  },
  appFloor:
    (v: string) =>
    (i: RefContentRowInput): void => {
      i.feed.app.targets.find((x: any) => x.platform === "android").floor = {
        minVersion: v,
      };
    },
  installed:
    (v: string) =>
    (i: RefContentRowInput): void => {
      i.installed.version = v;
      i.installed.binaryVersion = v;
    },
  engine:
    (e: string | null) =>
    (i: RefContentRowInput): void =>
      void (i.installed.engine = e),
  methods:
    (...m: string[]) =>
    (i: RefContentRowInput): void =>
      void (i.methods = m),
  stale: (i: RefContentRowInput): void =>
    void (i.now = (i.feed.expiresAt as number) + CLOCK_SKEW),
  staged:
    (version: string) =>
    (i: RefContentRowInput): void =>
      void (i.staged = { version, channel: "stable" }),
  entryCaps:
    (caps: Record<string, unknown>) =>
    (i: RefContentRowInput): void => {
      const t = i.feed.app.targets.find((x: any) => x.platform === "android");
      t.outlets.direct.capabilities = caps;
    },
  noPackSets: (i: RefContentRowInput): void => void delete i.feed.packSets,
};

interface CWant {
  action: string;
  reason?: string;
  install?: string[];
  revoke?: string[];
  prestage?: string[];
  mandatory?: boolean;
  contentBlock?: string;
  boot: "none" | "optional" | "required";
}

function contentRowsSpec(): { name: string; deltas: CDelta[]; want: CWant }[] {
  const row = (name: string, deltas: CDelta[], want: CWant) => ({
    name,
    deltas,
    want,
  });
  const n = "none" as const;
  const o = "optional" as const;
  const r = "required" as const;
  const base = p13MatrixRows();
  const withSet = (level: number, members: string[]): P13Row[] =>
    base.map((x) =>
      x[0] === level && Object.keys(x[3]).length === 0
        ? [x[0], x[1], x[2], x[3], members]
        : x,
    );
  return [
    row("packs-new-compatible-release", [C.active("foes", "foes@2.0.0")], {
      action: "packs",
      install: ["foes@2.0.1"],
      boot: n,
    }),
    row("packs-active-equals-target", [], {
      action: "none",
      reason: "up-to-date",
      boot: n,
    }),
    row(
      "packs-standalone-any-level",
      [C.level3, C.active("l10n", "l10n@1.0.0")],
      { action: "packs", install: ["l10n@1.1.0"], boot: n },
    ),
    row(
      "packs-hold-overrides-feed",
      [
        C.active("foes", "foes@2.0.0"),
        C.active("l10n", "l10n@1.0.0"),
        C.hold("foes@2.0.0"),
      ],
      { action: "packs", install: ["l10n@1.1.0"], boot: n },
    ),
    row(
      "packs-pinned-never-from-feed",
      [C.active("foes", "foes@2.0.0"), C.pin("foes@2.0.0")],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "packs-narrowed-to-pinned-on-play",
      [C.outletPlay, C.playLive("1.5.0", 15), C.active("foes", "foes@2.0.0")],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "packs-variant-row-by-preference",
      [C.active("textures", "tex@1.0.0")],
      { action: "packs", install: ["tex@1.1.0"], boot: n },
    ),
    row(
      "packs-engine-exact-row-only",
      [
        C.active("l10n", "l10n@1.0.0"),
        C.rows([
          ...base,
          [4, "android", "", {}, ["foes@2.0.1", "l10n@1.0.0", "skins@1.0.0"]],
        ]),
      ],
      { action: "packs", install: ["l10n@1.1.0"], boot: n },
    ),
    row(
      "packs-engine-no-exact-row-no-target",
      [
        C.engine("godot-4.5"),
        C.active("l10n", "l10n@1.0.0"),
        C.rows(base.map((x) => [x[0], x[1], "", x[3], x[4]] as P13Row)),
      ],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "packs-engine-null-takes-empty-row",
      [
        C.engine(null),
        C.active("l10n", "l10n@1.0.0"),
        C.rows(base.map((x) => [x[0], x[1], "", x[3], x[4]] as P13Row)),
      ],
      { action: "packs", install: ["l10n@1.1.0"], boot: n },
    ),
    row(
      "packs-yanked-head-no-downgrade",
      [C.rows(withSet(4, ["foes@2.0.0", "l10n@1.1.0", "skins@1.0.0"]))],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "packs-gate-in-bucket",
      [
        C.active("foes", "foes@2.0.0"),
        C.gate(
          "foes@2.0.1",
          { halted: false, rollout: { bp: 5000, salt: P13_SALT } },
          "foes@2.0.0",
        ),
        C.bucket(100),
      ],
      { action: "packs", install: ["foes@2.0.1"], boot: n },
    ),
    row(
      "packs-gate-out-of-bucket-fallback",
      [
        C.active("foes", "foes@2.0.0"),
        C.gate(
          "foes@2.0.1",
          { halted: false, rollout: { bp: 5000, salt: P13_SALT } },
          "foes@2.0.0",
        ),
        C.bucket(9000),
      ],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "packs-gate-halted-fallback",
      [
        C.active("foes", null),
        C.gate("foes@2.0.1", { halted: true }, "foes@2.0.0"),
      ],
      { action: "packs", install: ["foes@2.0.0"], boot: n },
    ),
    row(
      "packs-no-data-updates",
      [C.active("foes", "foes@2.0.0"), C.entryCaps({ dataUpdates: false })],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row("packs-member-absent", [C.active("foes", "foes@2.0.0"), C.noPackSets], {
      action: "none",
      reason: "up-to-date",
      boot: n,
    }),
    row(
      "packs-non-mandatory-store-with-pack-update",
      [C.outletPlay, C.playLive("1.6.0", 16), C.active("l10n", "l10n@1.0.0")],
      { action: "packs", install: ["l10n@1.1.0"], boot: n },
    ),
    row("binary-prestage-on-contentapi-change", [C.level3, C.offerRC16], {
      action: "binary",
      prestage: ["foes@2.0.1"],
      mandatory: false,
      boot: o,
    }),
    row("binary-same-contentapi-no-prestage", [C.offerRC16], {
      action: "binary",
      prestage: [],
      mandatory: false,
      boot: o,
    }),
    row(
      "non-mandatory-binary-with-pack-update",
      [C.offerRC16, C.active("l10n", "l10n@1.0.0")],
      { action: "binary", prestage: [], mandatory: false, boot: o },
    ),
    row("store-new-level-fetch-at-boot", [C.active("foes", "foes@1.3.3")], {
      action: "packs",
      install: ["foes@2.0.1"],
      boot: n,
    }),
    row("blocked-content-floor-no-backport", [C.level3, C.floor(3, "1.3.4")], {
      action: "blocked",
      reason: "content-floor",
      boot: o,
    }),
    row(
      "content-floor-met-by-backport",
      [
        C.level3,
        C.floor(3, "1.3.4"),
        C.rows(withSet(3, ["foes@1.3.4", "l10n@1.1.0", "skins@1.0.0"])),
      ],
      { action: "packs", install: ["foes@1.3.4"], boot: n },
    ),
    row(
      "blocked-content-floor-pinned-below-floor",
      [
        C.active("foes", "foes@2.0.0"),
        C.pin("foes@2.0.0"),
        C.floor(4, "2.0.1"),
      ],
      { action: "blocked", reason: "content-floor", boot: o },
    ),
    row(
      "content-floor-with-store-offer",
      [
        C.active("foes", "foes@2.0.0"),
        C.pin("foes@2.0.0"),
        C.floor(4, "2.0.1"),
        C.outletPlay,
        C.playLive("1.6.0", 16),
      ],
      {
        action: "store",
        mandatory: true,
        contentBlock: "content-floor",
        boot: o,
      },
    ),
    row(
      "revoked-with-compatible-replacement",
      [C.revoke("foes@2.0.1", "foes@2.0.2")],
      { action: "packs", install: ["foes@2.0.2"], boot: n },
    ),
    row(
      "revoked-pinned-with-record-replacement",
      [
        C.active("foes", "foes@2.0.0"),
        C.pin("foes@2.0.0"),
        C.revoke("foes@2.0.0", "foes@2.0.1"),
      ],
      { action: "packs", install: ["foes@2.0.1"], boot: n },
    ),
    row(
      "blocked-revoked-no-compatible-replacement",
      [C.revoke("foes@2.0.1", null)],
      { action: "blocked", reason: "revoked-content", boot: r },
    ),
    row(
      "revoked-replacement-unusable",
      [C.revoke("foes@2.0.1", "foes@2.0.2", false)],
      { action: "blocked", reason: "revoked-content", boot: r },
    ),
    row(
      "revoked-embedded-baseline",
      [
        C.active("foes", "foes@2.0.0"),
        C.pin("foes@2.0.0"),
        C.revoke("foes@2.0.0", "foes@2.0.1"),
      ],
      { action: "packs", install: ["foes@2.0.1"], boot: n },
    ),
    row("revoked-optional-pack-unmounted", [C.revoke("skins@1.0.0", null)], {
      action: "packs",
      install: [],
      revoke: ["diceroll.skins"],
      boot: n,
    }),
    row(
      "revoked-feed-target-not-installed",
      [C.active("foes", "foes@2.0.0"), C.revoke("foes@2.0.1", null)],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "revoked-with-binary-offer",
      [C.offerRC16, C.revoke("foes@2.0.1", null)],
      {
        action: "binary",
        mandatory: true,
        contentBlock: "revoked-content",
        prestage: [],
        boot: r,
      },
    ),
    row(
      "app-floor-precedes-content-floor",
      [
        C.level3,
        C.floor(3, "1.3.4"),
        C.installed("1.4.0"),
        C.appFloor("1.5.0"),
        C.methods(),
      ],
      {
        action: "blocked",
        reason: "app-floor",
        contentBlock: "content-floor",
        boot: o,
      },
    ),
    row(
      "app-floor-with-revoked-required",
      [
        C.revoke("foes@2.0.1", null),
        C.installed("1.4.0"),
        C.appFloor("1.5.0"),
        C.methods(),
      ],
      {
        action: "blocked",
        reason: "app-floor",
        contentBlock: "revoked-content",
        boot: r,
      },
    ),
    row(
      "mandatory-binary-supersedes-optional-packs",
      [
        C.level3,
        C.active("l10n", "l10n@1.0.0"),
        C.offerRC16,
        C.installed("1.4.0"),
        C.appFloor("1.5.0"),
      ],
      { action: "binary", mandatory: true, prestage: ["foes@2.0.1"], boot: o },
    ),
    row(
      "mandatory-store-supersedes-packs",
      [
        C.outletPlay,
        C.playLive("1.6.0", 16),
        C.installed("1.4.0"),
        C.appFloor("1.5.0"),
        C.active("l10n", "l10n@1.0.0"),
      ],
      { action: "store", mandatory: true, boot: o },
    ),
    row(
      "stale-feed-revoked-required-blocks",
      [C.stale, C.revoke("foes@2.0.1", null)],
      {
        action: "blocked",
        reason: "revoked-content",
        boot: r,
      },
    ),
    row(
      "stale-feed-content-floor-frozen",
      [C.stale, C.level3, C.floor(3, "1.3.4")],
      {
        action: "none",
        reason: "stale",
        boot: n,
      },
    ),
    row(
      "code-ready-with-pack-update",
      [C.installed("1.4.0"), C.staged("1.5.0"), C.active("l10n", "l10n@1.0.0")],
      { action: "code-ready", boot: o },
    ),
    row(
      "holds-unusable-no-feed-targets",
      [C.holdsUnusable, C.active("l10n", "l10n@1.0.0")],
      { action: "none", reason: "up-to-date", boot: n },
    ),
    row(
      "pack-in-two-selected-rows-ignored",
      [
        C.active("foes", "foes@2.0.0"),
        C.active("l10n", "l10n@1.0.0"),
        C.rows(
          base.map((x) =>
            x[0] === 4 && x[3].texture === "astc"
              ? ([
                  x[0],
                  x[1],
                  x[2],
                  x[3],
                  ["tex@1.1.0", "l10n@1.1.0"],
                ] as P13Row)
              : x,
          ),
        ),
      ],
      { action: "packs", install: ["foes@2.0.1"], boot: n },
    ),
    row(
      "revoked-superseded-replacement",
      [
        C.active("foes", "foes@2.0.0"),
        C.pin("foes@2.0.0"),
        C.revoke("foes@2.0.0", "foes@2.0.2", true, 2),
      ],
      { action: "packs", install: ["foes@2.0.2"], boot: n },
    ),
    row(
      "stale-feed-revoked-pin-replacement-active",
      [C.stale, C.pin("foes@2.0.0"), C.revoke("foes@2.0.0", "foes@2.0.1")],
      { action: "none", reason: "stale", boot: n },
    ),
  ];
}

/** `contentRows`: computed by the reference, checked against the plan's table. */
function buildContentRows(fail: (m: string) => never): {
  rows: unknown[];
  used: { actions: Set<string>; blocked: Set<string>; boot: Set<string> };
} {
  const used = {
    actions: new Set<string>(),
    blocked: new Set<string>(),
    boot: new Set<string>(),
  };
  const nameOf = (pin: Record<string, any>): string => {
    const hit = Object.keys(P13_RELEASES).find(
      (k) => p13Hash(k) === pin.sha256,
    );
    if (!hit) fail(`contentRows: an unknown release ${pin.sha256}`);
    return hit!;
  };
  const rows = contentRowsSpec().map((spec, k) => {
    const input = contentBaseInput();
    for (const d of spec.deltas) d(input);
    const decision = refDecideWithContent(input);
    const boot = refBootDecisionV2(decision);
    const label = k < 9 ? `C${k + 1}` : k === 9 ? "C9b" : `C${k}`;
    const where = `contentRow ${label} (${spec.name})`;
    const w = spec.want;
    if (decision.action !== w.action)
      fail(`${where}: ${decision.action} != ${w.action}`);
    for (const key of ["reason", "mandatory", "contentBlock"] as const)
      if (w[key] !== undefined && decision[key] !== w[key])
        fail(`${where}: ${key} ${String(decision[key])} != ${String(w[key])}`);
    if (w.contentBlock === undefined && decision.contentBlock !== undefined)
      fail(`${where}: an unexpected contentBlock`);
    if (w.install !== undefined) {
      const got = (decision.install as { release: Record<string, any> }[]).map(
        (x) => nameOf(x.release),
      );
      if (JSON.stringify(got) !== JSON.stringify(w.install))
        fail(`${where}: install ${JSON.stringify(got)}`);
    }
    if (
      w.revoke !== undefined &&
      JSON.stringify(decision.revoke) !== JSON.stringify(w.revoke)
    )
      fail(`${where}: revoke ${JSON.stringify(decision.revoke)}`);
    if (w.prestage !== undefined) {
      const got = (decision.prestage as { release: Record<string, any> }[]).map(
        (x) => nameOf(x.release),
      );
      if (JSON.stringify(got) !== JSON.stringify(w.prestage))
        fail(`${where}: prestage ${JSON.stringify(got)}`);
    }
    if (boot !== w.boot) fail(`${where}: boot ${boot} != ${w.boot}`);
    // `required` exactly on the revoked-content rows.
    const revokedRow =
      decision.reason === "revoked-content" ||
      decision.contentBlock === "revoked-content";
    if ((boot === "required") !== revokedRow)
      fail(`${where}: required off the revoked-content rows`);
    // The feed passes the claims; its content members are usable unless the row removes one.
    const feedText = JSON.stringify(input.feed);
    if (
      refFeedClaims(input.feed, ctxOf(feedText), {
        aud: AUD_V3,
        channel: input.feed.channel,
      }) !== null
    )
      fail(`${where}: its feed fails the claims`);
    const fc = refFeedContent(input.feed, ctxOf(feedText));
    if (spec.name !== "packs-member-absent" && fc.packSets === null)
      fail(`${where}: packSets unusable`);
    if (fc.packFloors === null || fc.revocations === null)
      fail(`${where}: floors or revocations unusable`);
    const ps = fc.packSets as Record<string, any> | null;
    if (ps)
      for (const [id, members] of Object.entries<string[]>(ps.sets))
        if (id !== refPackSetId(members.map((m) => [ps.releases[m].pack, m])))
          fail(`${where}: set ${id} is not its packSetId`);
    if (input.record) {
      if (
        !refRecordClaims(
          input.record,
          ctxOf(JSON.stringify(input.record)),
          AUD_V3,
        )
      )
        fail(`${where}: its record fails the claims`);
      const t = input.feed.app.targets.find(
        (x: any) => x.platform === input.installed.platform,
      );
      const named = [...RECORDS!.values()].find(
        (x) => x.sha256 === t.release.sha256,
      );
      if (!named || JSON.stringify(named.doc) !== JSON.stringify(input.record))
        fail(`${where}: the record is not the pin's`);
    }
    // The stamp's content passes the content claims; holds, when usable, pass `holdsOf`.
    const stamp = input.content.stamp;
    if (stamp.holds !== null && refHoldsOf(stamp, null, "/content") === null)
      fail(`${where}: the stamp's holds are unusable`);
    used.actions.add(decision.action as string);
    if (decision.action === "blocked")
      used.blocked.add(decision.reason as string);
    used.boot.add(boot);
    const expect: Record<string, unknown> = { decision, boot };
    if (decision.action === "packs")
      expect.packSetId = refPackSetId(
        (decision.set as { pack: string; sha256: string }[]).map((x) => [
          x.pack,
          x.sha256,
        ]),
      );
    return { name: `${label}. ${spec.name}`, input, expect };
  });
  if (rows.length !== P13_COUNTS.contentRows)
    fail(`${rows.length} contentRows, not ${P13_COUNTS.contentRows}`);
  return { rows, used };
}
