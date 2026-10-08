// The content fixture (CONTENT §6.8, Diceroll) the P4-13 families share.

import { sha256Hex } from "./common.js";
import { refCmpBytes, refPackSetId } from "./reference/content.js";

// ── The content fixture (CONTENT §6.8, Diceroll) ─────────────────────────────────────────────

/** The pack releases every P4-13 vector names, by short name: [pack, version, seq]. */
export const P13_RELEASES: Record<string, [string, string, number]> = {
  "foes@1.3.3": ["diceroll.foes", "1.3.3", 10],
  "foes@1.3.4": ["diceroll.foes", "1.3.4", 11],
  "foes@2.0.0": ["diceroll.foes", "2.0.0", 20],
  "foes@2.0.1": ["diceroll.foes", "2.0.1", 21],
  "foes@2.0.2": ["diceroll.foes", "2.0.2", 22],
  "l10n@1.0.0": ["diceroll.l10n", "1.0.0", 1],
  "l10n@1.1.0": ["diceroll.l10n", "1.1.0", 2],
  "tex@1.0.0": ["diceroll.textures", "1.0.0", 1],
  "tex@1.1.0": ["diceroll.textures", "1.1.0", 2],
  "skins@1.0.0": ["diceroll.skins", "1.0.0", 1],
};
export const p13Rel = (name: string): [string, string, number] => {
  const r = P13_RELEASES[name];
  if (!r) throw new Error(`P4-13 fixture: no release ${name}`);
  return r;
};
export const p13Hash = (name: string): string => {
  const [pack, version] = p13Rel(name);
  return sha256Hex(`pkey-corpus-pack:${pack}@${version}`);
};
export const p13Pin = (name: string): Record<string, unknown> => {
  const [, version, seq] = p13Rel(name);
  return { sha256: p13Hash(name), seq, version };
};
export const p13PackOf = (name: string): string => p13Rel(name)[0];
/** A revocation record's hash in the decision fixtures (a record the rows never sign). */
export const p13RevRecord = (name: string, n = 1): string =>
  sha256Hex(`pkey-corpus-revocation:${name}:${n}`);

export type P13Row = [
  contentApi: number,
  platform: string,
  engine: string,
  variant: Record<string, string>,
  members: string[],
];

/** `packSets` from rows of release names: the release table, the sets keyed by `packSetId`. */
export function p13PackSets(
  rows: P13Row[],
  outlets?: Record<string, unknown>,
): Record<string, any> {
  const names = [...new Set(rows.flatMap((r) => r[4]))];
  const releases: Record<string, unknown> = {};
  for (const n of [...names].sort((a, b) =>
    refCmpBytes(p13Hash(a), p13Hash(b)),
  )) {
    const [pack, version, seq] = p13Rel(n);
    releases[p13Hash(n)] = { pack, version, seq };
  }
  const sets: Record<string, string[]> = {};
  const outRows = rows.map(
    ([contentApi, platform, engine, variant, members]) => {
      const sorted = [...members].sort((a, b) =>
        refCmpBytes(p13PackOf(a), p13PackOf(b)),
      );
      const id = refPackSetId(sorted.map((m) => [p13PackOf(m), p13Hash(m)]));
      sets[id] = sorted.map(p13Hash);
      return { contentApi, platform, engine, variant, set: id };
    },
  );
  return {
    releases,
    sets,
    rows: outRows,
    ...(outlets ? { outlets } : {}),
  };
}

export const P13_SALT = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** The `feedContentCases` base: FC's two platforms. */
export function p13FeedMembers(): Record<string, unknown> {
  return {
    packSets: p13PackSets(
      [
        [3, "macos", "godot-4.4", {}, ["foes@1.3.4", "l10n@1.1.0"]],
        [4, "macos", "godot-4.4", {}, ["foes@2.0.1", "l10n@1.1.0"]],
        [4, "macos", "godot-4.4", { texture: "astc" }, ["tex@1.1.0"]],
        [4, "macos", "godot-4.4", { texture: "etc2" }, ["tex@1.0.0"]],
        [4, "windows", "", {}, ["foes@2.0.1", "l10n@1.1.0"]],
      ],
      {
        steam: { pinned: ["diceroll.foes"] },
        direct: {
          gates: {
            [p13Hash("foes@2.0.1")]: {
              halted: false,
              rollout: { bp: 2500, salt: P13_SALT },
              fallback: null,
            },
            [p13Hash("tex@1.1.0")]: {
              halted: true,
              fallback: p13Hash("tex@1.0.0"),
            },
          },
        },
      },
    ),
    packFloors: [
      {
        pack: "diceroll.foes",
        contentApi: 3,
        minVersion: "1.3.4",
        versionScheme: "semver",
      },
      {
        pack: "diceroll.foes",
        contentApi: 4,
        minVersion: "2.0.0",
        versionScheme: "semver",
      },
      {
        pack: "diceroll.l10n",
        contentApi: 4,
        minVersion: "1.0.0",
        versionScheme: "semver",
      },
    ],
    revocations: [
      {
        record: p13RevRecord("foes@1.3.3"),
        pack: "diceroll.foes",
        target: p13Hash("foes@1.3.3"),
        version: "1.3.3",
        seq: 10,
      },
    ],
  };
}

/** The exact counts of plans/P4-13.md's new sections (the self-check's "counts are exact"),
 *  with plans/P4-29.md §4.2's 28 appended `feedContentCases`. */
export const P13_COUNTS = {
  feedContentCases: 76,
  revocationCases: 27,
  contentRows: 44,
};
