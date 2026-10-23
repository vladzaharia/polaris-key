/**
 * U-27.5: the provisioned-secret backfill planner is pure and moves a licence's provisioned secret
 * to the owner's account row only when no device's merged document changes. The property test
 * runs the real `mergePayloads` over the layers a device reads (base, licence column, account
 * layer as `accountOverrideLayer` builds it) before and after applying each plan.
 */
import { describe, expect, it } from "vitest";
import type { ManagedEntry } from "@polaris-key/protocol";
import {
  planProvisionedSecretMoves,
  summarizePlan,
  type PlanDevice,
  type PlanInput,
  type PlanLicence,
  type ProvisionedSecretPlan,
} from "../src/core/migrate/provisionedSecrets.js";
import { mergePayloads } from "../src/core/licensing/merge.js";

const KEY = "proxy.subscriptionUrl";
const OWNER = "subj-owner";
const OTHER = "subj-other";

const entry = (
  value: string,
  updatedAt = 100,
  state: ManagedEntry["state"] = "default",
): ManagedEntry => ({ state, value: `sealed:${value}`, updatedAt });

const column = (e?: ManagedEntry, extra: object = {}): string =>
  JSON.stringify({
    config: {},
    secrets: e ? { [KEY]: e, ...extra } : { ...extra },
    entitlements: {},
  });

const row = (e?: ManagedEntry, extra: object = {}): string =>
  JSON.stringify({ config: {}, secrets: e ? { [KEY]: e, ...extra } : extra });

function input(over: {
  licences: PlanLicence[];
  rows?: [string, string | null][];
  devices?: [string | null, PlanDevice[]][];
}): PlanInput {
  return {
    product: "djdl",
    declared: new Set([KEY]),
    licences: over.licences,
    accountRows: new Map(over.rows ?? []),
    devicesBySubject: new Map(over.devices ?? []),
  };
}

const lic = (id: string, e?: ManagedEntry, owner: string | null = OWNER) => ({
  id,
  ownerSubject: owner,
  overridesJson: column(e),
});
const signed = (licenseId: string): PlanDevice => ({
  licenseId,
  signedIn: true,
});
const keyEntry = (licenseId: string): PlanDevice => ({
  licenseId,
  signedIn: false,
});

describe("planProvisionedSecretMoves: output classes", () => {
  it("moves an owned licence's secret when its devices are signed in as the owner", () => {
    const e = entry("a");
    const plan = planProvisionedSecretMoves(
      input({
        licences: [lic("L1", e)],
        devices: [[OWNER, [signed("L1")]]],
      }),
    );
    expect(plan.moves).toEqual([
      {
        licenseId: "L1",
        key: KEY,
        subject: OWNER,
        entry: e,
        addToAccount: true,
      },
    ]);
    expect(plan.shadowed).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.otherSubject).toEqual([]);
    expect(plan.unowned).toBe(0);
  });

  it("moves a licence with no devices (nothing to change)", () => {
    const plan = planProvisionedSecretMoves(
      input({ licences: [lic("L1", entry("a"))] }),
    );
    expect(plan.moves).toHaveLength(1);
  });

  it("counts unowned licences and leaves their column", () => {
    const plan = planProvisionedSecretMoves(
      input({
        licences: [lic("F1", entry("a"), null), lic("F2", undefined, null)],
      }),
    );
    expect(plan).toMatchObject({ moves: [], unowned: 1 });
  });

  it("shadowed: the row already holds the key, so the copy leaves the column only", () => {
    const plan = planProvisionedSecretMoves(
      input({
        licences: [lic("L1", entry("a", 100))],
        rows: [[OWNER, row(entry("b", 200))]],
        devices: [[OWNER, [signed("L1")]]],
      }),
    );
    expect(plan.shadowed).toEqual([
      { licenseId: "L1", key: KEY, subject: OWNER },
    ]);
    expect(plan.moves).toEqual([]);
  });

  it("a shadowed copy that still shows through the merge is a conflict, not removed", () => {
    // newer than the account entry
    const newer = planProvisionedSecretMoves(
      input({
        licences: [lic("L1", entry("a", 300))],
        rows: [[OWNER, row(entry("b", 200))]],
      }),
    );
    expect(newer.shadowed).toEqual([]);
    expect(newer.conflicts).toEqual([
      { subject: OWNER, key: KEY, reason: "shadowVisible", licenseIds: ["L1"] },
    ]);
    // an enforced copy under a default account entry wins the merge
    const enforced = planProvisionedSecretMoves(
      input({
        licences: [lic("L1", entry("a", 100, "enforced"))],
        rows: [[OWNER, row(entry("b", 200))]],
      }),
    );
    expect(enforced.conflicts).toHaveLength(1);
    // an enforced account entry hides any older copy
    const hidden = planProvisionedSecretMoves(
      input({
        licences: [lic("L1", entry("a", 100, "enforced"))],
        rows: [[OWNER, row(entry("b", 200, "enforced"))]],
      }),
    );
    expect(hidden.shadowed).toHaveLength(1);
  });

  it("conflicts: different entries on siblings, row lacks the key: all skipped", () => {
    const plan = planProvisionedSecretMoves(
      input({
        licences: [
          lic("L2", entry("b")),
          lic("L1", entry("a")),
          lic("L3", entry("a")),
        ],
      }),
    );
    expect(plan.moves).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        subject: OWNER,
        key: KEY,
        reason: "differentValues",
        licenseIds: ["L1", "L2", "L3"],
      },
    ]);
  });

  it("equal siblings: the lowest licence id adds to the account, the rest only remove", () => {
    const e = entry("a");
    const plan = planProvisionedSecretMoves(
      input({ licences: [lic("L2", e), lic("L1", e)] }),
    );
    expect(plan.moves.map((m) => [m.licenseId, m.addToAccount])).toEqual([
      ["L1", true],
      ["L2", false],
    ]);
  });

  it("different siblings are fine once the row holds the key (shadowed each)", () => {
    const plan = planProvisionedSecretMoves(
      input({
        licences: [lic("L1", entry("a", 1)), lic("L2", entry("b", 1))],
        rows: [[OWNER, row(entry("c", 50))]],
      }),
    );
    expect(plan.shadowed.map((s) => s.licenseId)).toEqual(["L1", "L2"]);
  });

  it("otherSubject: a device signed in as another subject, or with no subject", () => {
    for (const devices of [
      [[OTHER, [signed("L1")]]],
      [[null, [keyEntry("L1")]]],
    ] as [string | null, PlanDevice[]][][]) {
      const plan = planProvisionedSecretMoves(
        input({ licences: [lic("L1", entry("a"))], devices }),
      );
      expect(plan.moves).toEqual([]);
      expect(plan.otherSubject).toEqual([
        { licenseId: "L1", key: KEY, reason: "otherSubject" },
      ]);
    }
  });

  it("a licence-key device on the owner line cannot see account secrets: skipped", () => {
    const plan = planProvisionedSecretMoves(
      input({
        licences: [lic("L1", entry("a"))],
        devices: [[OWNER, [signed("L1"), keyEntry("L1")]]],
      }),
    );
    expect(plan.moves).toEqual([]);
    expect(plan.otherSubject).toEqual([
      { licenseId: "L1", key: KEY, reason: "licenceKeyDevice" },
    ]);
  });

  it("exposure: an owner-signed-in device on a licence without the copy would gain it", () => {
    const plan = planProvisionedSecretMoves(
      input({
        licences: [lic("L1", entry("a")), lic("L2")],
        devices: [[OWNER, [signed("L1"), signed("L2")]]],
      }),
    );
    expect(plan.moves).toEqual([]);
    expect(plan.otherSubject).toEqual([
      { licenseId: "L1", key: KEY, reason: "exposure" },
    ]);
  });

  it("an owner-signed-in device on a foreign licence holding the same entry is no exposure", () => {
    const e = entry("a");
    const plan = planProvisionedSecretMoves(
      input({
        licences: [lic("L1", e), lic("X1", e, "subj-third")],
        devices: [[OWNER, [signed("L1"), signed("X1")]]],
      }),
    );
    expect(plan.moves).toHaveLength(1);
  });

  it("keeps operator keys and reports unparseable or malformed copies without moving them", () => {
    const plan = planProvisionedSecretMoves(
      input({
        licences: [
          { id: "A", ownerSubject: OWNER, overridesJson: "not json" },
          {
            id: "B",
            ownerSubject: OWNER,
            overridesJson: JSON.stringify({ secrets: { [KEY]: "oops" } }),
          },
          { id: "C", ownerSubject: OWNER, overridesJson: null },
        ],
      }),
    );
    expect(plan.moves).toEqual([]);
    expect(plan.malformed).toEqual([{ licenseId: "B", key: KEY }]);
  });

  it("only declared keys are planned", () => {
    const p = planProvisionedSecretMoves({
      ...input({ licences: [lic("L1", entry("a"))] }),
      declared: new Set(["other.key"]),
    });
    expect(p.moves).toEqual([]);
  });
});

describe("planProvisionedSecretMoves: determinism and report", () => {
  const build = (order: number[]): PlanInput => {
    const e = entry("a");
    const licences = [
      lic("L1", e),
      lic("L2", e),
      lic("L3", entry("z"), "subj-b"),
      lic("L4", entry("y"), "subj-b"),
      lic("L5", entry("q"), null),
      lic("L6", entry("a", 1, "enforced")),
    ];
    const devices: [string | null, PlanDevice[]][] = [
      [OWNER, [signed("L1"), signed("L2"), signed("L6")]],
      ["subj-b", [signed("L3")]],
    ];
    return input({
      licences: order.map((i) => licences[i] as PlanLicence),
      rows: [[OWNER, null]],
      devices: order.map((i) => devices[i % 2] as (typeof devices)[0]),
    });
  };

  it("is independent of input order and repeatable", () => {
    const a = planProvisionedSecretMoves(build([0, 1, 2, 3, 4, 5]));
    const b = planProvisionedSecretMoves(build([5, 4, 3, 2, 1, 0]));
    const c = planProvisionedSecretMoves(build([2, 0, 5, 1, 4, 3]));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(planProvisionedSecretMoves(build([0, 1, 2, 3, 4, 5]))).toEqual(a);
    expect(a.conflicts.map((x) => x.subject)).toContain("subj-b");
  });

  it("does not mutate its input", () => {
    const i = build([0, 1, 2, 3, 4, 5]);
    const before = JSON.stringify([
      i.licences,
      [...i.accountRows],
      [...i.devicesBySubject],
    ]);
    planProvisionedSecretMoves(i);
    expect(
      JSON.stringify([i.licences, [...i.accountRows], [...i.devicesBySubject]]),
    ).toBe(before);
  });

  it("the report summary carries counts and capped ids, never a value", () => {
    const licences = Array.from({ length: 30 }, (_, n) =>
      lic(`L${String(n).padStart(2, "0")}`, entry(`secret-${n}`), `s${n}`),
    );
    const plan = planProvisionedSecretMoves(input({ licences }));
    const summary = summarizePlan(plan, 5);
    expect(summary.moves).toBe(30);
    expect(summary.moveLicenceIds).toHaveLength(5);
    expect(JSON.stringify(summary)).not.toMatch(/sealed|secret-/);
  });
});

// ── the property: every device's merged document is unchanged by an applied plan ─────────────

/** One entry per declared key (absent = the layer lacks the key). */
type Held = Record<string, ManagedEntry | undefined>;

interface World {
  /** The declared secret keys, 1 to 3 of them: with several, `mergeMap` orders keys by layer
   *  insertion, so a move can reorder them inside a document (value-equal, not byte-equal). */
  keys: string[];
  licences: { id: string; owner: string | null; col: Held }[];
  rows: Map<string, Held>;
  devices: { licenseId: string; subject: string | null; signedIn: boolean }[];
  base: Held;
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const POOL: ManagedEntry[] = [
  entry("a", 100),
  entry("a", 100), // same bytes as the first
  entry("a", 150),
  entry("b", 100),
  entry("b", 300, "enforced"),
  entry("c", 50, "hidden"),
];

const ALL_KEYS = [KEY, "proxy.token", "api.secret"];

const heldJson = (h: Held, withEntitlements: boolean): string =>
  JSON.stringify({
    config: {},
    secrets: Object.fromEntries(
      Object.entries(h).filter(([, e]) => e !== undefined),
    ),
    ...(withEntitlements ? { entitlements: {} } : {}),
  });

function makeWorld(rand: () => number): World {
  const pick = <T>(xs: readonly T[]): T =>
    xs[Math.floor(rand() * xs.length)] as T;
  const keys = ALL_KEYS.slice(0, 1 + Math.floor(rand() * 3));
  /** Keys are filled in a random order, so insertion order differs between layers. */
  const held = (absent: number): Held => {
    const h: Held = {};
    for (const k of [...keys].sort(() => rand() - 0.5))
      h[k] = rand() < absent ? undefined : pick(POOL);
    return h;
  };
  const owners = [OWNER, OWNER, OWNER, "subj-b", null];
  const licences = ["L1", "L2", "L3", "L4"]
    .slice(0, 1 + Math.floor(rand() * 4))
    .map((id) => ({ id, owner: pick(owners), col: held(0.2) }));
  const devices: World["devices"] = [];
  for (const l of licences) {
    const n = Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const kind = pick([
        "owner",
        "owner",
        "owner",
        "keyEntry",
        "other",
        "none",
      ]);
      if (kind === "owner")
        devices.push({ licenseId: l.id, subject: OWNER, signedIn: true });
      else if (kind === "keyEntry")
        devices.push({ licenseId: l.id, subject: l.owner, signedIn: false });
      else if (kind === "other")
        devices.push({ licenseId: l.id, subject: OTHER, signedIn: true });
      else devices.push({ licenseId: l.id, subject: null, signedIn: false });
    }
  }
  return {
    keys,
    licences,
    rows: new Map([
      [OWNER, held(rand() < 0.35 ? 0.3 : 1)],
      ["subj-b", held(rand() < 0.2 ? 0.3 : 1)],
    ]),
    devices,
    base: held(0.7),
  };
}

function toInput(w: World): PlanInput {
  const bySubject = new Map<string | null, PlanDevice[]>();
  for (const d of w.devices) {
    const list = bySubject.get(d.subject) ?? [];
    list.push({ licenseId: d.licenseId, signedIn: d.signedIn });
    bySubject.set(d.subject, list);
  }
  return {
    product: "djdl",
    declared: new Set(w.keys),
    licences: w.licences.map((l) => ({
      id: l.id,
      ownerSubject: l.owner,
      overridesJson: heldJson(l.col, true),
    })),
    accountRows: new Map(
      [...w.rows].map(([s, h]) => [
        s,
        Object.values(h).some((e) => e !== undefined)
          ? heldJson(h, false)
          : null,
      ]),
    ),
    devicesBySubject: bySubject,
  };
}

/** What each device receives: the layers `buildPayload` merges, with `accountOverrideLayer`'s
 *  rule that the owner line carries no secrets. Returned as objects, compared by value: the order
 *  of keys inside `secrets` may change once after a move. */
function documents(w: World): unknown[] {
  return w.devices.map((d) => {
    const l = w.licences.find((x) => x.id === d.licenseId)!;
    const rowHeld = d.subject === null ? undefined : w.rows.get(d.subject);
    const account =
      d.subject === null
        ? null
        : d.signedIn
          ? rowHeld && Object.values(rowHeld).some((e) => e !== undefined)
            ? heldJson(rowHeld, false)
            : null
          : JSON.stringify({ config: {}, secrets: {}, entitlements: {} });
    return mergePayloads(
      Object.values(w.base).some((e) => e !== undefined)
        ? heldJson(w.base, false)
        : null,
      heldJson(l.col, true),
      account,
    );
  });
}

function apply(w: World, plan: ProvisionedSecretPlan): World {
  const next: World = {
    ...w,
    licences: w.licences.map((l) => ({ ...l, col: { ...l.col } })),
    rows: new Map([...w.rows].map(([s, h]) => [s, { ...h }])),
  };
  const drop = (id: string, key: string): void => {
    next.licences.find((l) => l.id === id)!.col[key] = undefined;
  };
  for (const m of plan.moves) {
    drop(m.licenseId, m.key);
    if (m.addToAccount) next.rows.get(m.subject)![m.key] = m.entry;
  }
  for (const s of plan.shadowed) drop(s.licenseId, s.key);
  return next;
}

describe("planProvisionedSecretMoves: value identity property", () => {
  it("no applied plan changes the value of any device's merged document (key order inside secrets may change); a second plan moves nothing", () => {
    const rand = seeded(27);
    const seen = {
      moves: 0,
      shadowed: 0,
      conflicts: 0,
      other: 0,
      unowned: 0,
      add: 0,
      multiKey: 0,
    };
    for (let n = 0; n < 4000; n++) {
      const w = makeWorld(rand);
      const plan = planProvisionedSecretMoves(toInput(w));
      const after = apply(w, plan);
      // toEqual ignores key order inside the objects: value-equal, not byte-equal.
      expect(documents(after), JSON.stringify(w)).toEqual(documents(w));
      const again = planProvisionedSecretMoves(toInput(after));
      expect(again.moves).toEqual([]);
      expect(again.shadowed).toEqual([]);
      seen.moves += plan.moves.length;
      seen.add += plan.moves.filter((m) => m.addToAccount).length;
      seen.shadowed += plan.shadowed.length;
      seen.conflicts += plan.conflicts.length;
      seen.other += plan.otherSubject.length;
      seen.unowned += plan.unowned;
      if (w.keys.length > 1 && plan.moves.length > 0) seen.multiKey++;
    }
    // the matrix reaches every output class
    for (const [k, v] of Object.entries(seen)) expect(v, k).toBeGreaterThan(0);
  });

  it("shuffling licences and devices never changes the plan", () => {
    const rand = seeded(5);
    for (let n = 0; n < 500; n++) {
      const w = makeWorld(rand);
      const base = planProvisionedSecretMoves(toInput(w));
      const shuffled: World = {
        ...w,
        licences: [...w.licences].reverse(),
        devices: [...w.devices].reverse(),
      };
      expect(planProvisionedSecretMoves(toInput(shuffled))).toEqual(base);
    }
  });
});
