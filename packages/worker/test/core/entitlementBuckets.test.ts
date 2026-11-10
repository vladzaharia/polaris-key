// LX-34.7: the entitlement bucket planner. A property matrix over random worlds: the old chain on
// the old rows equals the new chain on the new rows (values and key order) for every licence the
// plan does not report, and planning the written rows again writes nothing.
import { describe, expect, it } from "vitest";
import type { Db } from "../../src/db/types.js";
import {
  planEntitlementBuckets,
  type BucketLicence,
  type BucketPlan,
  type BucketTier,
} from "../../src/core/licensing/entitlementBuckets.js";
import {
  resolveMergedPayload,
  type PayloadLayerSource,
} from "../../src/core/licensing/payload.js";
import { oidcGrantLayerOf } from "../../src/core/licensing/grants.js";
import { storeGrantLayerOf } from "../../src/core/licensing/storeGrants.js";
import type { LicenseRow, ProfileRow, TierRow } from "../../src/core/repo.js";

/** A small seeded generator (xorshift32), so a failing world reproduces from its seed. */
function rng(seed: number): () => number {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

const KEYS = ["a", "b", "c", "d", "e", "f"];
const STATES = ["default", "enforced", "hidden"] as const;

interface World {
  profiles: Map<string, string>;
  tiers: BucketTier[];
  licences: BucketLicence[];
}

function entries(r: () => number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = KEYS.filter(() => r() < 0.45).sort(() => r() - 0.5);
  for (const k of keys)
    out[k] = {
      state: STATES[Math.floor(r() * 3)],
      value: r() < 0.5 ? r() < 0.5 : Math.floor(r() * 9),
      updatedAt: 1 + Math.floor(r() * 9),
    };
  return out;
}

function world(seed: number): World {
  const r = rng(seed);
  const profiles = new Map<string, string>();
  for (let i = 0; i < 4; i++)
    profiles.set(
      `p${i}`,
      JSON.stringify({
        config:
          r() < 0.5 ? { c: { state: "default", value: 1, updatedAt: 1 } } : {},
        entitlements: entries(r),
      }),
    );
  const tiers: BucketTier[] = [];
  for (let i = 0; i < 3; i++) {
    const profile_id = r() < 0.75 ? `p${Math.floor(r() * 4)}` : null;
    const t: BucketTier = {
      id: `t${i}`,
      profile_id,
      implicit: i === 2 && r() < 0.5 ? 1 : 0,
    };
    // A preset bucket only on a tier whose profile has one: a bucket beside an empty profile is
    // new data, not something the job moves.
    const hasBucket =
      profile_id !== null &&
      Object.keys(JSON.parse(profiles.get(profile_id)!).entitlements).length >
        0;
    const pre = hasBucket ? r() : 1;
    if (profile_id && pre < 0.2)
      t.entitlements_json = JSON.stringify(
        JSON.parse(profiles.get(profile_id)!).entitlements,
      );
    else if (profile_id && pre < 0.3)
      t.entitlements_json = JSON.stringify({
        z: { state: "default", value: 1, updatedAt: 1 },
      });
    tiers.push(t);
  }
  const licences: BucketLicence[] = [];
  for (let i = 0; i < 14; i++) {
    const o = r();
    const overrides_json =
      o < 0.25
        ? null
        : o < 0.3
          ? "not json"
          : JSON.stringify({
              config: { c: { state: "default", value: 2, updatedAt: 3 } },
              entitlements: entries(r),
            });
    licences.push({
      row: {
        id: `l${String(i).padStart(2, "0")}`,
        tier_id:
          r() < 0.15 ? null : r() < 0.1 ? "gone" : `t${Math.floor(r() * 3)}`,
        overrides_json,
      },
      profileIds: [0, 1, 2, 3].filter(() => r() < 0.3).map((n) => `p${n}`),
      storeGrants: KEYS.filter(() => r() < 0.12).map((flag) => ({
        flag,
        granted_at: 1 + Math.floor(r() * 9),
      })),
      oidcGrants: KEYS.filter(() => r() < 0.12).map((key) => ({
        key,
        value_json: JSON.stringify(Math.floor(r() * 5)),
        state: "default",
        updated_at: 1 + Math.floor(r() * 9),
      })),
    });
  }
  return { profiles, tiers, licences };
}

const plan = (w: World): BucketPlan =>
  planEntitlementBuckets({
    catalogDefault: null,
    tiers: w.tiers,
    profiles: w.profiles,
    licences: w.licences,
  });

/** The resolver's own walk over the rows; `bucket` reads a tier's bucket where its profile sat. */
async function chain(
  w: World,
  l: BucketLicence,
  mode: "old" | "new",
): Promise<Record<string, unknown>> {
  const tierRow = (id: string): TierRow | null => {
    const t = w.tiers.find((x) => x.id === id);
    if (!t) return null;
    return {
      ...t,
      profile_id: mode === "new" ? `bucket:${id}` : t.profile_id,
    } as unknown as TierRow;
  };
  const source: PayloadLayerSource = {
    catalogDefault: async () => null,
    tier: async (id) => tierRow(id),
    profile: async (id) => {
      if (id.startsWith("bucket:")) {
        const t = w.tiers.find((x) => x.id === id.slice(7));
        return {
          payload_json: t?.entitlements_json
            ? JSON.stringify({ entitlements: JSON.parse(t.entitlements_json) })
            : null,
        } as unknown as ProfileRow;
      }
      const j = w.profiles.get(id);
      return j === undefined
        ? null
        : ({ payload_json: j } as unknown as ProfileRow);
    },
    licenseProfiles: async () =>
      mode === "old"
        ? l.profileIds.map((profile_id) => ({ profile_id }) as never)
        : [],
    storeGrant: async () => storeGrantLayerOf(l.storeGrants),
    oidcGrant: async (_id, overrides) =>
      oidcGrantLayerOf(l.oidcGrants, overrides),
  };
  const { payload } = await resolveMergedPayload(
    {} as Db,
    "p",
    { ...l.row } as unknown as LicenseRow,
    null,
    1,
    { entitlementsOnly: true, source },
  );
  return payload.entitlements as unknown as Record<string, unknown>;
}

function apply(w: World, p: BucketPlan): World {
  const tierWrite = new Map(p.tierWrites.map((x) => [x.tierId, x.after]));
  const licWrite = new Map(p.licenceWrites.map((x) => [x.licenseId, x.after]));
  return {
    profiles: w.profiles,
    tiers: w.tiers.map((t) =>
      tierWrite.has(t.id)
        ? { ...t, entitlements_json: tierWrite.get(t.id)! }
        : t,
    ),
    licences: w.licences.map((l) =>
      licWrite.has(l.row.id)
        ? { ...l, row: { ...l.row, overrides_json: licWrite.get(l.row.id)! } }
        : l,
    ),
  };
}

const same = (a: Record<string, unknown>, b: Record<string, unknown>): void => {
  expect(Object.keys(b)).toEqual(Object.keys(a));
  expect(b).toEqual(a);
};

describe("planEntitlementBuckets: property matrix", () => {
  it("the old chain on the old rows == the new chain on the new rows, and a second plan writes nothing", async () => {
    let written = 0;
    let reported = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const w = world(seed);
      const p = plan(w);
      const next = apply(w, p);
      const diff = new Set(
        p.docDiffs
          .filter((d) => d.subjectKind === "license")
          .map((d) => d.subjectId),
      );
      for (const l of w.licences) {
        if (diff.has(l.row.id)) {
          reported++;
          expect(p.licenceWrites.some((x) => x.licenseId === l.row.id)).toBe(
            false,
          );
          continue;
        }
        const before = await chain(w, l, "old");
        const after = await chain(
          next,
          next.licences.find((x) => x.row.id === l.row.id)!,
          "new",
        );
        try {
          same(before, after);
          // The written rows are also safe for the old chain (the rollout order).
          same(
            before,
            await chain(
              next,
              next.licences.find((x) => x.row.id === l.row.id)!,
              "old",
            ),
          );
        } catch (e) {
          throw new Error(`seed ${seed} licence ${l.row.id}: ${String(e)}`);
        }
      }
      written += p.licenceWrites.length + p.tierWrites.length;
      const again = plan(next);
      expect(again.tierWrites, `seed ${seed}`).toEqual([]);
      expect(again.licenceWrites, `seed ${seed}`).toEqual([]);
      expect(again.docDiffs, `seed ${seed}`).toEqual(p.docDiffs);
    }
    // The matrix reaches both outcomes.
    expect(written).toBeGreaterThan(300);
    expect(reported).toBeGreaterThan(30);
  });

  it("leaves every other overrides key and untouched licence row as it was", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const w = world(seed);
      const p = plan(w);
      for (const wr of p.licenceWrites) {
        const before = JSON.parse(wr.before ?? "{}") as Record<string, unknown>;
        const after = JSON.parse(wr.after) as Record<string, unknown>;
        for (const k of Object.keys(before))
          if (k !== "entitlements") expect(after[k]).toEqual(before[k]);
      }
    }
  });
});

describe("planEntitlementBuckets: cases", () => {
  const entry = (v: unknown, state = "default", updatedAt = 5) => ({
    state,
    value: v,
    updatedAt,
  });
  const prof = (e: Record<string, unknown>) =>
    JSON.stringify({ entitlements: e });
  const base = (over: Partial<Parameters<typeof planEntitlementBuckets>[0]>) =>
    planEntitlementBuckets({
      catalogDefault: null,
      tiers: [],
      profiles: new Map(),
      licences: [],
      ...over,
    });
  const lic = (
    over: Partial<BucketLicence["row"]> & {
      profileIds?: string[];
      oidc?: BucketLicence["oidcGrants"];
      store?: BucketLicence["storeGrants"];
    },
  ): BucketLicence => ({
    row: { id: "l1", tier_id: null, overrides_json: null, ...over },
    profileIds: over.profileIds ?? [],
    storeGrants: over.store ?? [],
    oidcGrants: over.oidc ?? [],
  });

  it("copies a tier profile's bucket verbatim and skips the implicit tier", () => {
    const e = { b: entry(2, "enforced", 7), a: entry(true) };
    const p = base({
      tiers: [
        { id: "pro", profile_id: "p" },
        { id: "def", profile_id: "p", implicit: 1 },
        { id: "bare", profile_id: null },
      ],
      profiles: new Map([["p", prof(e)]]),
    });
    expect(p.tierWrites).toEqual([
      { tierId: "pro", before: null, after: JSON.stringify(e) },
    ]);
    expect(p.docDiffs).toEqual([]);
  });

  it("reports a tier bucket that holds something else, and rewrites one the job wrote", () => {
    const e = { a: entry(true) };
    const old = JSON.stringify({ a: entry(false) });
    const tiers = [{ id: "pro", profile_id: "p", entitlements_json: old }];
    const profiles = new Map([["p", prof(e)]]);
    expect(base({ tiers, profiles }).docDiffs).toMatchObject([
      {
        subjectKind: "tier",
        subjectId: "pro",
        reasons: ["tier-bucket-differs"],
      },
    ]);
    expect(
      base({ tiers, profiles, ownedTierBuckets: new Map([["pro", old]]) })
        .tierWrites,
    ).toEqual([{ tierId: "pro", before: old, after: JSON.stringify(e) }]);
  });

  it("proves a reordered stored tier bucket as stored: no write, a key-order report", () => {
    const e = { a: entry(1), b: entry(2) };
    const p = base({
      tiers: [
        {
          id: "pro",
          profile_id: "p",
          entitlements_json: JSON.stringify({ b: e.b, a: e.a }),
        },
      ],
      profiles: new Map([["p", prof(e)]]),
      licences: [lic({ tier_id: "pro" })],
    });
    expect(p.tierWrites).toEqual([]);
    expect(p.licenceWrites).toEqual([]);
    expect(p.docDiffs).toMatchObject([
      { subjectKind: "license", reasons: ["key-order"] },
    ]);
  });

  it("puts a licence profile's keys under the overrides' own entries", () => {
    const p = base({
      profiles: new Map([
        ["p", prof({ a: entry(1, "default", 3), b: entry(2) })],
      ]),
      licences: [
        lic({
          profileIds: ["p"],
          overrides_json: JSON.stringify({
            config: { c: entry(9) },
            entitlements: { a: entry(7, "default", 4) },
          }),
        }),
      ],
    });
    expect(p.docDiffs).toEqual([]);
    const after = JSON.parse(p.licenceWrites[0]!.after) as {
      config: unknown;
      entitlements: Record<string, unknown>;
    };
    expect(after.config).toEqual({ c: entry(9) });
    expect(Object.keys(after.entitlements)).toEqual(["a", "b"]);
    expect(after.entitlements["a"]).toEqual(entry(7, "default", 4));
  });

  it("reports and stops on a key a store or OIDC grant also sets", () => {
    const profiles = new Map([["p", prof({ a: entry(1) })]]);
    for (const extra of [
      { store: [{ flag: "a", granted_at: 2 }] },
      {
        oidc: [
          { key: "a", value_json: "true", state: "default", updated_at: 2 },
        ],
      },
    ]) {
      const p = base({
        profiles,
        licences: [lic({ profileIds: ["p"], ...extra })],
      });
      expect(p.licenceWrites).toEqual([]);
      expect(p.docDiffs).toMatchObject([
        { subjectKind: "license", reasons: ["grant-key"], keys: ["a"] },
      ]);
    }
  });

  it("reports unreadable overrides instead of rewriting them", () => {
    const p = base({
      profiles: new Map([["p", prof({ a: entry(1) })]]),
      licences: [lic({ profileIds: ["p"], overrides_json: "{broken" })],
    });
    expect(p.licenceWrites).toEqual([]);
    expect(p.docDiffs[0]!.reasons).toEqual(["overrides-unreadable"]);
  });

  it("writes nothing for a licence with no licence-profile entitlements", () => {
    const p = base({
      profiles: new Map([["p", JSON.stringify({ config: {} })]]),
      licences: [lic({ profileIds: ["p", "missing"] })],
    });
    expect(p).toEqual({ tierWrites: [], licenceWrites: [], docDiffs: [] });
  });
});
