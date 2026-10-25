/**
 * LX-33.4: the materialisation planner (`services/license/migrations/limitsPlan.ts`).
 *
 * The planner decides what the LX-33.5 job writes so a licence's documents and enforcement do not
 * change when the data moves from the old chain to "licence, else tier, else platform". The
 * property matrix below plans many products at once and checks, for every licence:
 *   old chain on old rows = old chain on new rows = new chain on new rows
 * for the enforced values always, and for the stamp projection except for the D4 cases the
 * planner reports in `docDiffs`.
 */
import { describe, expect, it } from "vitest";
import {
  planLimitsMaterialisation,
  projectNew,
  projectOld,
  type LimitColumns,
  type LimitsPlan,
  type PlanLicense,
  type PlanProduct,
  type PlanTier,
} from "../../../src/services/license/migrations/limitsPlan.js";
import { isImplicitTier } from "../../../src/core/licensing/implicitTier.js";

// A small deterministic generator, so a failure names the same case on every run.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const tier = (o: Partial<PlanTier> & { id: string }): PlanTier => ({
  label: o.id,
  policy_device_limit: null,
  channels_json: null,
  min_version: null,
  max_version: null,
  policy_offline_grace_days: null,
  ...o,
});
const lic = (o: Partial<PlanLicense> & { id: string }): PlanLicense => ({
  tier_id: null,
  max_offline_days: null,
  channels_json: null,
  min_version: null,
  max_version: null,
  device_limit: null,
  ...o,
});
const ch = (c: string[] | null): string | null =>
  c ? JSON.stringify(c) : null;
const P5: PlanProduct = { defaultDeviceLimit: 5, defaultMaxOfflineDays: 30 };
const plan = (
  product: PlanProduct,
  tiers: PlanTier[],
  licences: PlanLicense[],
  ent: Record<string, number> = {},
): LimitsPlan =>
  planLimitsMaterialisation({
    product,
    tiers,
    licences,
    mergedDeviceLimit: new Map(Object.entries(ent)),
  });

/** What the LX-33.5 apply does to rows, in memory. */
function apply(
  p: LimitsPlan,
  tiers: PlanTier[],
  licences: PlanLicense[],
): { tiers: PlanTier[]; licences: PlanLicense[] } {
  const nextTiers = tiers.filter((t) => !(p.seed && t.id === p.seed.id));
  if (p.seed) {
    const prior = tiers.find((t) => t.id === p.seed?.id);
    nextTiers.push({
      id: p.seed.id,
      label: prior ? prior.label : p.seed.label,
      ...p.seed.row,
    });
  }
  const byId = new Map(p.writes.map((w) => [w.licenseId, w.after]));
  return {
    tiers: nextTiers,
    licences: licences.map((l) => ({ ...l, ...(byId.get(l.id) ?? {}) })),
  };
}

const ENFORCED = ["offlineDays", "deviceLimit", "channels", "window"] as const;

describe("seeding", () => {
  it("creates Default with the product's defaults, at the first free id", () => {
    const p = plan(
      { defaultDeviceLimit: 7, defaultMaxOfflineDays: 45 },
      [],
      [],
    );
    expect(p.seed).toMatchObject({
      action: "create",
      id: "default",
      label: "Default",
      row: {
        policy_device_limit: 7,
        policy_offline_grace_days: 45,
        channels_json: null,
        min_version: null,
        max_version: null,
        profile_id: null,
        rank: 0,
        implicit: 1,
        source: "console",
      },
    });
    const taken = plan(
      P5,
      [tier({ id: "default" }), tier({ id: "default-2" })],
      [],
    );
    expect(taken.seed?.id).toBe("default-3");
  });

  it("re-seeds drifted values, and does nothing when they match", () => {
    const stale = tier({
      id: "default",
      implicit: 1,
      policy_device_limit: 3,
      policy_offline_grace_days: 30,
    });
    const p = plan(P5, [stale], []);
    expect(p.seed).toMatchObject({ action: "update", id: "default" });
    const ok = tier({
      id: "default",
      implicit: 1,
      policy_device_limit: 5,
      policy_offline_grace_days: 30,
    });
    expect(plan(P5, [ok], []).seed).toBeUndefined();
  });
});

describe("rules (worked examples)", () => {
  const t = (o: Partial<PlanTier> = {}) => tier({ id: "pro", ...o });

  it("assigns a tierless licence to the implicit tier and leaves a dangling id", () => {
    const p = plan(
      P5,
      [],
      [lic({ id: "a" }), lic({ id: "b", tier_id: "gone" })],
    );
    expect(p.writes).toEqual([
      {
        licenseId: "a",
        before: { tier_id: null },
        after: { tier_id: "default" },
      },
    ]);
    expect(p.dangling).toEqual([{ licenseId: "b", tierId: "gone" }]);
  });

  it("writes the channel union verbatim, tier first, and never adds beta", () => {
    const tiers = [
      t({ channels_json: ch(["dev"]) }),
      tier({ id: "x", channels_json: ch(["dev", "stable"]) }),
    ];
    const p = plan(P5, tiers, [
      lic({ id: "a", tier_id: "pro", channels_json: ch(["beta", "dev"]) }),
      lic({ id: "b", tier_id: "pro", channels_json: ch(["dev"]) }),
      lic({ id: "c", tier_id: "x", channels_json: ch(["stable", "alpha"]) }),
    ]);
    const w = (id: string) => p.writes.find((x) => x.licenseId === id)?.after;
    expect(w("a")?.channels_json).toBe('["dev","beta"]');
    expect(w("b")?.channels_json).toBeUndefined();
    expect(w("c")?.channels_json).toBe('["dev","stable","alpha"]');
    expect(p.devOnlyTiers).toEqual(["pro", "x"]);
  });

  it("a dev-only grant stays dev-only", () => {
    const p = plan(
      P5,
      [t({ channels_json: ch(["dev"]) })],
      [lic({ id: "a", tier_id: "pro", channels_json: ch(["dev"]) })],
    );
    expect(
      p.writes.find((x) => x.licenseId === "a")?.after.channels_json,
    ).toBeUndefined();
    const q = plan(
      P5,
      [t({ channels_json: ch(["dev"]) })],
      [lic({ id: "a", tier_id: "pro" })],
    );
    expect(q.writes.find((x) => x.licenseId === "a")).toBeUndefined();
  });

  it("takes the tighter bound where both set it, the tier's on a tie", () => {
    const p = plan(
      P5,
      [t({ min_version: "2.0.0", max_version: "3.0.0" })],
      [
        lic({
          id: "a",
          tier_id: "pro",
          min_version: "1.0.0",
          max_version: "2.5.0",
        }),
        lic({
          id: "b",
          tier_id: "pro",
          min_version: "2.0.0+x",
          max_version: "3.0.0+y",
        }),
        lic({ id: "c", tier_id: "pro", min_version: "2.5.0" }),
      ],
    );
    const w = (id: string) => p.writes.find((x) => x.licenseId === id)?.after;
    expect(w("a")).toEqual({ min_version: "2.0.0" });
    expect(w("b")).toEqual({ min_version: "2.0.0", max_version: "3.0.0" });
    expect(w("c")).toBeUndefined();
  });

  it("D4 (a): an entitlement limit that differs from the tier chain is written, and reported", () => {
    const p = plan(P5, [], [lic({ id: "a" }), lic({ id: "b" })], {
      a: 9,
      b: 5,
    });
    expect(p.writes.find((x) => x.licenseId === "a")?.after.device_limit).toBe(
      9,
    );
    expect(
      p.writes.find((x) => x.licenseId === "b")?.after.device_limit,
    ).toBeUndefined();
    expect(p.docDiffs).toEqual([
      {
        licenseId: "a",
        fields: ["stamp:deviceLimit"],
        reasons: ["device-entitlement"],
      },
    ]);
  });

  it("D4 (b): a non-implicit tier with no limit on a product whose default is not 5", () => {
    const prod = { defaultDeviceLimit: 8, defaultMaxOfflineDays: 30 };
    const p = plan(prod, [t()], [lic({ id: "a", tier_id: "pro" })]);
    expect(p.writes[0]?.after.device_limit).toBe(8);
    expect(p.docDiffs[0]?.reasons).toEqual(["device-tier-unset"]);
    // Equal to the constant: nothing to write.
    expect(plan(P5, [t()], [lic({ id: "a", tier_id: "pro" })]).writes).toEqual(
      [],
    );
  });

  it("offline days: the product default where the tier's (or the constant) differs; no doc diff", () => {
    const prod = { defaultDeviceLimit: 5, defaultMaxOfflineDays: 14 };
    const p = plan(
      prod,
      [t({ policy_offline_grace_days: 10 }), tier({ id: "bare" })],
      [
        lic({ id: "a", tier_id: "pro" }),
        lic({ id: "b", tier_id: "bare" }),
        lic({ id: "c", max_offline_days: 3 }),
        lic({ id: "d" }),
      ],
    );
    const w = (id: string) => p.writes.find((x) => x.licenseId === id)?.after;
    expect(w("a")?.max_offline_days).toBe(14);
    expect(w("b")?.max_offline_days).toBe(14);
    expect(w("c")?.max_offline_days).toBeUndefined();
    expect(w("d")?.max_offline_days).toBeUndefined();
    expect(p.docDiffs).toEqual([]);
  });

  it("never writes outside the six columns", () => {
    const p = plan(
      { defaultDeviceLimit: 8, defaultMaxOfflineDays: 14 },
      [t({ channels_json: ch(["a"]), min_version: "1.0.0" })],
      [
        lic({
          id: "a",
          tier_id: "pro",
          channels_json: ch(["b"]),
          min_version: "2.0.0",
        }),
      ],
      { a: 3 },
    );
    const cols = new Set<keyof LimitColumns>([
      "tier_id",
      "channels_json",
      "min_version",
      "max_version",
      "device_limit",
      "max_offline_days",
    ]);
    for (const w of p.writes)
      for (const k of Object.keys(w.after))
        expect(cols.has(k as never)).toBe(true);
  });
});

describe("property matrix", () => {
  const products: PlanProduct[] = [
    { defaultDeviceLimit: 5, defaultMaxOfflineDays: 30 },
    { defaultDeviceLimit: 7, defaultMaxOfflineDays: 45 },
  ];
  const compats: PlanProduct["compat"][] = [
    undefined,
    { min: "1.1.0", max: "2.2.0" },
  ];
  const channelSets: Array<string[] | null> = [
    null,
    ["beta"],
    ["dev"],
    ["stable", "beta"],
  ];
  const tierVersions: Array<[string | null, string | null]> = [
    [null, null],
    ["1.2.0", null],
    ["1.2.0", "3.0.0"],
    ["1.0.0+a", "2.0.0+a"],
  ];
  const licVersions: Array<[string | null, string | null]> = [
    [null, null],
    ["1.0.0", null],
    ["2.0.0", "2.5.0"],
    ["1.2.0+b", "3.0.0+b"],
    ["abc", "xyz"],
    [null, "1.5.0"],
  ];
  const limits = [null, 3, 5];
  const graces = [null, 10, 30];
  const licChannels: Array<string[] | null> = [
    null,
    ["dev"],
    ["beta", "dev"],
    ["stable"],
    ["alpha", "beta"],
  ];
  const licDevice = [null, 2, 5, 0];
  const licOffline = [null, 7, 30, 0];
  const ents: Array<number | undefined> = [undefined, 5, 9];

  type Kind = "none" | "implicit" | "implicit-stale" | "real" | "dangling";
  interface Config {
    name: string;
    product: PlanProduct;
    tiers: PlanTier[];
    kind: Kind;
    tierId: string | null;
  }
  const configs: Config[] = [];
  for (const base of products)
    for (const compat of compats) {
      const product = { ...base, compat };
      const tag = `${base.defaultDeviceLimit}/${compat ? "compat" : "open"}`;
      configs.push({
        name: `none ${tag}`,
        product,
        tiers: [],
        kind: "none",
        tierId: null,
      });
      configs.push({
        name: `implicit ${tag}`,
        product,
        kind: "implicit",
        tierId: "default",
        tiers: [
          tier({
            id: "default",
            implicit: 1,
            policy_device_limit: base.defaultDeviceLimit,
            policy_offline_grace_days: base.defaultMaxOfflineDays,
          }),
        ],
      });
      configs.push({
        name: `implicit-stale ${tag}`,
        product,
        kind: "implicit-stale",
        tierId: "default",
        tiers: [
          tier({
            id: "default",
            implicit: 1,
            policy_device_limit: 2,
            policy_offline_grace_days: 1,
            channels_json: ch(["beta"]),
            min_version: "9.0.0",
          }),
        ],
      });
      configs.push({
        name: `dangling ${tag}`,
        product,
        kind: "dangling",
        tierId: "gone",
        tiers: [],
      });
      for (const c of channelSets)
        for (const v of tierVersions)
          for (const d of limits)
            for (const g of graces)
              configs.push({
                name: `real ${tag} ch=${c} v=${v} d=${d} g=${g}`,
                product,
                kind: "real",
                tierId: "pro",
                tiers: [
                  tier({
                    id: "pro",
                    channels_json: ch(c),
                    min_version: v[0],
                    max_version: v[1],
                    policy_device_limit: d,
                    policy_offline_grace_days: g,
                  }),
                ],
              });
    }

  const PER_CONFIG = 36;
  let cases = 0;

  it("keeps documents and enforcement, over the whole matrix", () => {
    const rand = lcg(33004);
    const pick = <T>(xs: readonly T[]): T =>
      xs[Math.floor(rand() * xs.length)] as T;
    const failures: string[] = [];
    const seenReasons = new Set<string>();
    let withDiffs = 0;

    for (const cfg of configs) {
      const licences: PlanLicense[] = [];
      const ent: Record<string, number> = {};
      for (let i = 0; i < PER_CONFIG; i++) {
        const [mn, mx] = pick(licVersions);
        const id = `l${i}`;
        licences.push(
          lic({
            id,
            // Half of the tier-bearing configs also hold a tierless licence.
            tier_id: cfg.kind !== "none" && rand() < 0.85 ? cfg.tierId : null,
            channels_json: ch(pick(licChannels)),
            min_version: mn,
            max_version: mx,
            device_limit: pick(licDevice),
            max_offline_days: pick(licOffline),
          }),
        );
        const e = pick(ents);
        if (e !== undefined) ent[id] = e;
      }
      const entMap = new Map(Object.entries(ent));
      const p = planLimitsMaterialisation({
        product: cfg.product,
        tiers: cfg.tiers,
        licences,
        mergedDeviceLimit: entMap,
      });
      const next = apply(p, cfg.tiers, licences);
      const tierOf = (ts: PlanTier[], id: string | null) =>
        id ? (ts.find((t) => t.id === id) ?? null) : null;
      const diffIds = new Map(p.docDiffs.map((d) => [d.licenseId, d]));

      for (const l of licences) {
        cases++;
        const n = next.licences.find((x) => x.id === l.id) as PlanLicense;
        const e = entMap.get(l.id) ?? null;
        const oldOld = projectOld(
          l,
          tierOf(cfg.tiers, l.tier_id),
          cfg.product,
          e,
        );
        const oldNew = projectOld(
          n,
          tierOf(next.tiers, n.tier_id),
          cfg.product,
          e,
        );
        const newNew = projectNew(
          n,
          tierOf(next.tiers, n.tier_id),
          cfg.product,
        );
        const fail = (why: string) =>
          failures.push(`${cfg.name} ${l.id}: ${why}`);

        for (const k of ENFORCED) {
          if (JSON.stringify(oldOld[k]) !== JSON.stringify(oldNew[k]))
            fail(`old/old != old/new on ${k}`);
          if (JSON.stringify(oldOld[k]) !== JSON.stringify(newNew[k]))
            fail(
              `old/old != new/new on ${k}: ${JSON.stringify(oldOld[k])} vs ${JSON.stringify(newNew[k])}`,
            );
        }
        const diff = diffIds.get(l.id);
        if (!diff) {
          // The old chain sees the implicit tier as no tier, so a tierless licence is unchanged.
          if (JSON.stringify(oldOld.stamps) !== JSON.stringify(oldNew.stamps))
            fail("stamps: old/old != old/new");
          if (JSON.stringify(oldOld.stamps) !== JSON.stringify(newNew.stamps))
            fail(
              `stamps: old/old != new/new ${JSON.stringify(oldOld.stamps)} vs ${JSON.stringify(newNew.stamps)}`,
            );
        } else {
          withDiffs++;
          for (const r of diff.reasons) seenReasons.add(r);
          if (diff.reasons.length === 0) fail("a docDiff with no D4 reason");
          if (cfg.kind !== "dangling" || l.tier_id !== cfg.tierId)
            if (diff.fields.join() !== "stamp:deviceLimit")
              fail(`non-device docDiff ${diff.fields.join()}`);
        }
        // Channels: never a name the inputs did not have.
        const before = new Set([
          ...JSON.parse(tierOf(cfg.tiers, l.tier_id)?.channels_json ?? "[]"),
          ...JSON.parse(l.channels_json ?? "[]"),
        ]);
        for (const c of JSON.parse(n.channels_json ?? "[]"))
          if (!before.has(c)) fail(`channel ${c} appeared`);
      }

      // Planning again after applying changes nothing.
      const again = planLimitsMaterialisation({
        product: cfg.product,
        tiers: next.tiers,
        licences: next.licences,
        mergedDeviceLimit: entMap,
      });
      if (again.seed) failures.push(`${cfg.name}: second plan seeds`);
      if (again.writes.length) failures.push(`${cfg.name}: second plan writes`);
      if (again.docDiffs.length)
        failures.push(`${cfg.name}: second plan docDiffs`);
      // Every licence has a tier afterwards, except a dangling one.
      for (const n of next.licences)
        if (!n.tier_id) failures.push(`${cfg.name}: ${n.id} has no tier`);
      // Exactly one implicit tier.
      if (next.tiers.filter((t) => isImplicitTier(t)).length !== 1)
        failures.push(`${cfg.name}: implicit tier count`);
    }

    expect(failures.slice(0, 20)).toEqual([]);
    // The matrix is large and reaches every D4 reason.
    expect(cases).toBeGreaterThan(20000);
    expect(withDiffs).toBeGreaterThan(0);
    expect(seenReasons.has("device-entitlement")).toBe(true);
    expect(seenReasons.has("device-tier-unset")).toBe(true);
    expect(seenReasons.has("dangling-tier")).toBe(true);
    // eslint-disable-next-line no-console
    console.info(
      `limitsPlan matrix: ${configs.length} configs, ${cases} cases`,
    );
  });

  it("negative control: dropping a planned write breaks the invariant", () => {
    const tiers = [tier({ id: "pro", channels_json: ch(["dev"]) })];
    const licences = [
      lic({ id: "a", tier_id: "pro", channels_json: ch(["beta"]) }),
    ];
    const p = plan(P5, tiers, licences);
    expect(p.writes.length).toBe(1);
    const next = apply({ ...p, writes: [] }, tiers, licences);
    const before = projectOld(
      licences[0] as PlanLicense,
      tiers[0] ?? null,
      P5,
      null,
    );
    const after = projectNew(
      next.licences[0] as PlanLicense,
      next.tiers.find((t) => t.id === "pro") ?? null,
      P5,
    );
    expect(after.channels).not.toEqual(before.channels);
  });
});
