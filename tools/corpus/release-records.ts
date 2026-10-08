// The release-record vectors (V4 §2.4) every feed pin and update-matrix row names, built once per
// run, and `FC`, the channel feed the feed families start from.

import {
  AUD_V3,
  FEED_EXPIRES,
  FEED_ISSUED,
  ISSUER_V3,
  MAX_WIRE_INTEGER_REF,
  pointerToken,
  REL_KID,
  sha256Hex,
  signAs,
  V3_ISSUED,
} from "./common.js";
import { isObj } from "./reference/claims.js";

// ── Release records (V4 §2.4) — the fixtures every feed pin and update-matrix row names ───────

/** One artifact, with a deterministic digest and size. */
export function artifact(
  id: string,
  version: string,
  ext: string,
  role = "payload",
  index = 0,
): Record<string, unknown> {
  return {
    name: `diceroll-${version}-${id}.${ext}`,
    role,
    sha256: sha256Hex(`pkey-corpus-artifact:${version}:${id}:${role}`),
    size: 10_000_000 + index * 1_000_003,
  };
}

/** `R15`'s builds (plans/P3-01.md §4.6), each with one `payload` artifact unless stated. */
export function r15Builds(
  version: string,
  only?: string[],
): Record<string, unknown>[] {
  const b = (
    i: number,
    id: string,
    platform: string,
    arch: string,
    format: string,
    o: {
      buildNumber?: boolean;
      role?: string;
      none?: boolean;
      requires?: Record<string, unknown>;
    } = {},
  ): Record<string, unknown> => ({
    id,
    platform,
    arch,
    format,
    ...(o.buildNumber === false ? {} : { buildNumber: String(150 + i) }),
    ...(o.requires ? { requires: o.requires } : {}),
    artifacts: o.none
      ? []
      : [artifact(id, version, format, o.role ?? "payload", i)],
  });
  const all = [
    b(0, "macos-dmg", "macos", "universal", "dmg"),
    b(1, "win-chunks", "windows", "x86_64", "zip", { role: "chunk-bundle" }),
    b(2, "win-exe", "windows", "x86_64", "exe"),
    b(3, "win-pck", "windows", "any", "pck", {
      requires: { engine: "godot-4.7", minBinary: "1.4.0" },
    }),
    b(4, "win-zip", "windows", "x86_64", "zip"),
    b(5, "linux-arm64", "linux", "arm64", "tar.gz", { buildNumber: false }),
    b(6, "linux-x64", "linux", "x86_64", "tar.gz"),
    b(7, "aab", "android", "any", "aab", { none: true }),
    b(8, "apk", "android", "any", "apk"),
    b(9, "ipa", "ios", "arm64", "ipa"),
    b(10, "web", "web", "wasm32", "zip"),
  ];
  return only ? all.filter((x) => only.includes(x.id as string)) : all;
}

export const RECORD_ISSUED = V3_ISSUED - 10_000;

export function recordDoc(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const version = (over.version as string | undefined) ?? "1.5.0";
  return {
    schemaVersion: 1,
    aud: AUD_V3,
    deliverable: "app",
    kind: "app",
    version,
    seq: 15,
    issuedAt: RECORD_ISSUED,
    tag: `v${version}`,
    channel: "stable",
    title: `Diceroll ${version}`,
    builds: r15Builds(typeof version === "string" ? version : "1.5.0"),
    ...over,
  };
}

export interface RecordVector {
  name: string;
  doc: Record<string, unknown>;
  jws: string;
  sha256: string;
}

/** The record vectors the feeds and update-matrix rows pin, by name. */
async function buildRecordVectors(): Promise<Map<string, RecordVector>> {
  const out = new Map<string, RecordVector>();
  const add = async (
    name: string,
    doc: Record<string, unknown>,
  ): Promise<void> => {
    const jws = await signAs(doc, REL_KID, "pkey-release+jws");
    out.set(name, { name, doc, jws, sha256: sha256Hex(jws) });
  };
  await add("R15", recordDoc());
  await add(
    "RB",
    recordDoc({ version: "1.5.0+46", seq: 16, builds: r15Builds("1.5.0+46") }),
  );
  await add(
    "R4",
    recordDoc({ version: "1.5.0.0", builds: r15Builds("1.5.0.0") }),
  );
  await add(
    "R16b",
    recordDoc({
      version: "1.6.0-beta.2",
      seq: 16,
      channel: "beta",
      builds: r15Builds("1.6.0-beta.2", ["macos-dmg"]),
    }),
  );
  await add("R15max", recordDoc({ seq: MAX_WIRE_INTEGER_REF }));
  // plans/P4-13.md §4.3: the level-4 app release `contentRows` offers (prestage), its apk build
  // embedding the texture pack.
  {
    const builds = r15Builds("1.6.0");
    for (const b of builds)
      if (b.id === "apk") b.embeds = ["diceroll.textures"];
    await add(
      "RC16",
      recordDoc({
        version: "1.6.0",
        seq: 16,
        builds,
        content: {
          contentApi: 4,
          pins: [],
          expects: [
            { pack: "diceroll.foes", required: true, delivery: "essential" },
            { pack: "diceroll.l10n", required: false, delivery: "prefetch" },
            { pack: "diceroll.skins", required: false, delivery: "on-demand" },
            {
              pack: "diceroll.textures",
              required: true,
              delivery: "essential",
            },
          ],
        },
      }),
    );
  }
  return out;
}

// ── The channel feed (V4 §2.3) ───────────────────────────────────────────────────────────────

/** The record vectors, built once per run before any feed (feeds pin their hashes). */
export let RECORDS: Map<string, RecordVector> | null = null;
export const record = (name: string): RecordVector => {
  const r = RECORDS?.get(name);
  if (!r) throw new Error(`record vector ${name} not built`);
  return r;
};

export /** Build the record vectors for this run (`cases.json`'s first step: every feed pins one by
 *  its hash) and keep them for `record`. */
async function buildRecords(): Promise<Map<string, RecordVector>> {
  RECORDS = await buildRecordVectors();
  return RECORDS;
}

export const LIVE = (
  version: string,
  seq: number,
): Record<string, unknown> => ({
  version,
  seq,
});
export const APP_STORE_URL = "https://apps.apple.com/app/id1234567890";
export const ROLLOUT_SALT = "00112233445566778899aabbccddeeff";

export function pinOf(name: string): Record<string, unknown> {
  const r = record(name);
  return { sha256: r.sha256, seq: r.doc.seq, version: r.doc.version };
}

/** `FC`, the feed the `feedCases` start from: a macOS and a Windows target pinning R15. */
export function feedPayload(): Record<string, unknown> {
  const target = (
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
        target("macos", {
          direct: { kind: "direct", live: LIVE("1.5.0", 15), halted: false },
          "app-store": {
            kind: "app-store",
            live: LIVE("1.4.0", 14),
            halted: false,
            listingUrl: APP_STORE_URL,
          },
        }),
        target("windows", {
          direct: { kind: "direct", live: LIVE("1.5.0", 15), halted: false },
          steam: { kind: "steam", live: LIVE("1.5.0", 15), halted: false },
        }),
      ],
    },
  };
}

/** Leaf pointers where two JSON values differ (for the one-property twin check). */
export function leafDiff(a: unknown, b: unknown, at = ""): string[] {
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) =>
      leafDiff(a[k], b[k], `${at}/${pointerToken(k)}`),
    );
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    return Array.from({ length: n }, (_, k) =>
      leafDiff(a[k], b[k], `${at}/${k}`),
    ).flat();
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [at];
}
