// U-09.6: the record half of `classifyMutations` (V5 §13.3 checks 1 to 4, plans/U-09-slices.md
// §2.3), driven directly: which Classification each record mutation gets, and in which order the
// checks answer. The object adds the stateful checks and check 5 (the engine suite).
import { describe, expect, it } from "vitest";
import { Catalog } from "@polaris-key/catalog";
import type { SyncJson, SyncMutation } from "@polaris-key/protocol/sync";
import { classifyMutations } from "../../../src/services/sync/handlers/classify.js";
import type { Classification } from "../../../src/services/sync/engine/types.js";

const NO_MIGRATIONS = {
  renamedTo: new Map<string, string>(),
  dropped: new Set<string>(),
};

const catalog = (collections: object[]) =>
  new Catalog({
    schemaVersion: 1,
    entries: [],
    cloudSync: { collections },
  } as never);

const CATALOG = catalog([
  { name: "saves", template: "saves" },
  { name: "scores", conflict: "max", conflictField: "best", maxRecords: 40 },
  {
    name: "notes",
    conflict: "merge",
    schema: {
      type: "object",
      properties: { title: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "tags",
    conflict: "union",
    schema: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", maxLength: 8 },
    },
  },
  { name: "vip", requires: "game.vip" },
  { name: "scratch.*", conflict: "lastWrite", maxRecords: 3 },
  { name: "scratch.fixed", conflict: "revision", maxRecords: 9 },
]);

let n = 0;
const mut = (
  record: [string, string],
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> = {},
): SyncMutation => ({
  mutationId: ++n,
  target: { record },
  op,
  ...extra,
});

const one = (
  m: SyncMutation,
  mode: "server" | "e2e" = "server",
  entitlements: Record<string, unknown> = {},
  cat: Catalog | null = CATALOG,
): Classification =>
  classifyMutations(
    [m],
    cat,
    NO_MIGRATIONS,
    mode,
    entitlements,
  )[0] as Classification;

const reject = (code: string) => ({ verdict: "reject", code });

/** A shaped envelope: byte 0 = 1, `blocks` padded blocks of payload. */
function envelope(blocks = 1, byte0 = 1, extra = 0): string {
  const bytes = new Uint8Array(49 + 64 * blocks + extra).fill(7);
  bytes[0] = byte0;
  return Buffer.from(bytes).toString("base64url");
}
const BLIND = (c: number) => `x:${String(c).padStart(43, "A")}`;

describe("classify: record targets, server mode", () => {
  it("1: a collection no declaration matches is collection_unknown", () => {
    expect(one(mut(["nope", "a"], "set", { value: 1 }))).toEqual(
      reject("collection_unknown"),
    );
    expect(
      one(mut(["saves", "a"], "set", { value: {} }), "server", {}, null),
    ).toEqual(reject("collection_unknown"));
  });

  it("accepts a declared collection with its policy, limits and field", () => {
    expect(one(mut(["scores", "a"], "set", { value: { best: 3 } }))).toEqual({
      verdict: "record",
      policy: "max",
      maxRecords: 40,
      conflictField: "best",
    });
    expect(
      one(mut(["saves", "slot1"], "set", { value: { playtime: 5 } })),
    ).toEqual({
      verdict: "record",
      policy: "revision",
      maxRecords: 16,
    });
  });

  it("matches a pattern per concrete name; an exact name beats it", () => {
    expect(one(mut(["scratch.a", "1"], "set", { value: 1 }))).toMatchObject({
      policy: "lastWrite",
      maxRecords: 3,
    });
    expect(one(mut(["scratch.fixed", "1"], "set", { value: 1 }))).toMatchObject(
      {
        policy: "revision",
        maxRecords: 9,
      },
    );
    expect(one(mut(["scratch", "1"], "set", { value: 1 }))).toEqual(
      reject("collection_unknown"),
    );
  });

  it("2: a lapsed requires is entitlement_required, a delete passes", () => {
    expect(one(mut(["vip", "a"], "set", { value: 1 }))).toEqual(
      reject("entitlement_required"),
    );
    expect(
      one(mut(["vip", "a"], "set", { value: 1 }), "server", {
        "game.vip": false,
      }),
    ).toEqual(reject("entitlement_required"));
    expect(
      one(mut(["vip", "a"], "set", { value: 1 }), "server", {
        "game.vip": true,
      }),
    ).toMatchObject({ verdict: "record" });
    expect(one(mut(["vip", "a"], "delete"))).toMatchObject({
      verdict: "record",
    });
  });

  it("1 before 2 before 3: an unknown collection beats the others", () => {
    expect(one(mut(["nope", "a"], "set", { ct: envelope() }))).toEqual(
      reject("collection_unknown"),
    );
    expect(one(mut(["vip", "a"], "set", { ct: envelope() }))).toEqual(
      reject("entitlement_required"),
    );
    expect(one(mut(["saves", "a"], "set", { ct: envelope() }))).toEqual(
      reject("encryption_mismatch"),
    );
  });

  it("4: value_invalid for a schema failure, an oversize value, an unrepresentable one", () => {
    expect(
      one(mut(["saves", "a"], "set", { value: { playtime: -1 } })),
    ).toMatchObject({ valueInvalid: true });
    expect(
      one(mut(["saves", "a"], "set", { value: "not an object" })),
    ).toMatchObject({
      valueInvalid: true,
    });
    expect(one(mut(["scores", "a"], "set"))).toMatchObject({
      valueInvalid: true,
    });
    const big: SyncJson = { s: "x".repeat(70_000) };
    expect(one(mut(["scores", "a"], "set", { value: big }))).toMatchObject({
      valueInvalid: true,
    });
    const fits: SyncJson = { s: "x".repeat(65_000) };
    expect(
      one(mut(["scores", "a"], "set", { value: fits })),
    ).not.toHaveProperty("valueInvalid");
  });

  it("4: a setField value against schema.properties[field]; a long field name", () => {
    const ok = one(
      mut(["notes", "n"], "setField", { field: "title", value: "t" }),
    );
    expect(ok).toEqual({
      verdict: "record",
      policy: "merge",
      maxRecords: 10_000,
    });
    expect(
      one(mut(["notes", "n"], "setField", { field: "title", value: 3 })),
    ).toMatchObject({ valueInvalid: true });
    expect(
      one(mut(["notes", "n"], "setField", { field: "other", value: "t" })),
    ).toMatchObject({ valueInvalid: true });
    expect(
      one(mut(["notes", "n"], "removeField", { field: "y".repeat(1025) })),
    ).toMatchObject({ valueInvalid: true });
    expect(
      one(mut(["notes", "n"], "removeField", { field: "title" })),
    ).not.toHaveProperty("valueInvalid");
  });

  it("4: an element over 1 KiB or off the items schema; a remove needs observedSeq", () => {
    expect(one(mut(["tags", "t"], "add", { element: "a" }))).not.toHaveProperty(
      "valueInvalid",
    );
    expect(
      one(mut(["tags", "t"], "add", { element: "x".repeat(2000) })),
    ).toMatchObject({ valueInvalid: true });
    expect(
      one(mut(["tags", "t"], "add", { element: "toolongvalue" })),
    ).toMatchObject({
      valueInvalid: true,
    });
    expect(one(mut(["tags", "t"], "add"))).toMatchObject({
      valueInvalid: true,
    });
    expect(one(mut(["tags", "t"], "remove", { element: "a" }))).toMatchObject({
      valueInvalid: true,
    });
    expect(
      one(mut(["tags", "t"], "remove", { element: "a", observedSeq: -1 })),
    ).toMatchObject({ valueInvalid: true });
    expect(
      one(mut(["tags", "t"], "remove", { element: "a", observedSeq: 4 })),
    ).not.toHaveProperty("valueInvalid");
  });

  it("4: a baseVersion that is neither * nor a count; a delete with stray members", () => {
    for (const bad of [-1, 1.5, "7"])
      expect(
        one(
          mut(["saves", "a"], "set", { value: {}, baseVersion: bad as never }),
        ),
      ).toMatchObject({ valueInvalid: true });
    for (const ok of [0, 3, "*" as const])
      expect(
        one(mut(["saves", "a"], "set", { value: {}, baseVersion: ok })),
      ).not.toHaveProperty("valueInvalid");
    expect(
      one(mut(["saves", "a"], "delete", { baseVersion: 2 })),
    ).not.toHaveProperty("valueInvalid");
    for (const stray of [
      { value: 1 },
      { field: "f" },
      { element: "e" },
      { observedSeq: 1 },
    ])
      expect(one(mut(["saves", "a"], "delete", stray))).toMatchObject({
        valueInvalid: true,
      });
  });

  it("3: a ct on a server-mode product is encryption_mismatch (not for a delete)", () => {
    expect(one(mut(["saves", "a"], "set", { ct: envelope() }))).toEqual(
      reject("encryption_mismatch"),
    );
    expect(
      one(mut(["saves", "a"], "delete", { ct: envelope() })),
    ).toMatchObject({
      verdict: "record",
      valueInvalid: true,
    });
  });
});

describe("classify: record targets, E2E mode", () => {
  const e2e = (m: SyncMutation, ent: Record<string, unknown> = {}) =>
    one(m, "e2e", ent);

  it("3: a record id, field or element that is not blinded is encryption_mismatch", () => {
    expect(e2e(mut(["saves", "slot1"], "set", { ct: envelope() }))).toEqual(
      reject("encryption_mismatch"),
    );
    expect(e2e(mut(["saves", BLIND(1)], "delete"))).toMatchObject({
      verdict: "record",
    });
    expect(e2e(mut(["saves", "slot1"], "delete"))).toEqual(
      reject("encryption_mismatch"),
    );
    expect(
      e2e(
        mut(["notes", BLIND(1)], "setField", {
          field: "title",
          ct: envelope(),
        }),
      ),
    ).toEqual(reject("encryption_mismatch"));
    expect(
      e2e(mut(["notes", BLIND(1)], "removeField", { field: "title" })),
    ).toEqual(reject("encryption_mismatch"));
    expect(
      e2e(mut(["tags", BLIND(1)], "add", { element: "a", ct: envelope() })),
    ).toEqual(reject("encryption_mismatch"));
    expect(
      e2e(mut(["tags", BLIND(1)], "remove", { element: 3, observedSeq: 1 })),
    ).toEqual(reject("encryption_mismatch"));
  });

  it("3: value where ct is expected is encryption_mismatch", () => {
    expect(e2e(mut(["saves", BLIND(1)], "set", { value: {} }))).toEqual(
      reject("encryption_mismatch"),
    );
  });

  it("accepts sealed writes; the E2E max/min record carries no conflictField", () => {
    expect(
      e2e(mut(["scores", BLIND(1)], "set", { ct: envelope(), baseVersion: 2 })),
    ).toEqual({
      verdict: "record",
      policy: "max",
      maxRecords: 40,
      sealed: true,
    });
    expect(
      e2e(
        mut(["notes", BLIND(1)], "setField", {
          field: BLIND(2),
          ct: envelope(),
        }),
      ),
    ).toMatchObject({ policy: "merge", sealed: true });
    expect(
      e2e(
        mut(["tags", BLIND(1)], "add", { element: BLIND(3), ct: envelope() }),
      ),
    ).toMatchObject({ policy: "union", sealed: true });
    expect(
      e2e(
        mut(["tags", BLIND(1)], "remove", {
          element: BLIND(3),
          observedSeq: 2,
        }),
      ),
    ).not.toHaveProperty("valueInvalid");
  });

  it("4: a malformed envelope, or one over the record budget, is value_invalid", () => {
    for (const ct of [
      envelope(1, 2),
      envelope(1, 1, 1),
      `${envelope()}=`,
      "",
      5 as never,
    ])
      expect(e2e(mut(["saves", BLIND(1)], "set", { ct }))).toMatchObject({
        valueInvalid: true,
      });
    expect(e2e(mut(["saves", BLIND(1)], "set"))).toMatchObject({
      valueInvalid: true,
    });
    // 64 KiB + 113 bytes of envelope is the largest value; 49 + 64k steps by 64.
    const fits = (65_536 + 113 - 49) / 64;
    expect(Number.isInteger(fits)).toBe(true);
    expect(
      e2e(mut(["saves", BLIND(1)], "set", { ct: envelope(fits) })),
    ).not.toHaveProperty("valueInvalid");
    expect(
      e2e(mut(["saves", BLIND(1)], "set", { ct: envelope(fits + 1) })),
    ).toMatchObject({ valueInvalid: true });
  });

  it("4: a field or element is charged 45 more for its blinded name", () => {
    const fits = (65_536 - 45 + 113 - 49) / 64;
    // (65536 - 45 + 113 - 49) / 64 is not an integer, so the largest block count is below it.
    const blocks = Math.floor(fits);
    expect(
      e2e(
        mut(["notes", BLIND(1)], "setField", {
          field: BLIND(2),
          ct: envelope(blocks),
        }),
      ),
    ).not.toHaveProperty("valueInvalid");
    expect(
      e2e(
        mut(["notes", BLIND(1)], "setField", {
          field: BLIND(2),
          ct: envelope(blocks + 1),
        }),
      ),
    ).toMatchObject({ valueInvalid: true });
  });

  it("4: an E2E max/min delete with a baseVersion is value_invalid", () => {
    expect(
      e2e(mut(["scores", BLIND(1)], "delete", { baseVersion: 2 })),
    ).toMatchObject({
      valueInvalid: true,
    });
    expect(e2e(mut(["scores", BLIND(1)], "delete"))).not.toHaveProperty(
      "valueInvalid",
    );
    expect(
      e2e(mut(["saves", BLIND(1)], "delete", { baseVersion: 2 })),
    ).not.toHaveProperty("valueInvalid");
  });

  it("2 before 3: a lapsed requires answers before an unblinded id", () => {
    expect(e2e(mut(["vip", "plain"], "set", { ct: envelope() }))).toEqual(
      reject("entitlement_required"),
    );
    expect(
      e2e(mut(["vip", BLIND(1)], "set", { ct: envelope() }), {
        "game.vip": true,
      }),
    ).toMatchObject({
      verdict: "record",
    });
  });
});

describe("classify: a value nested too deep (U-09.R B4)", () => {
  const deep = (n: number): SyncJson =>
    JSON.parse("[".repeat(n) + "]".repeat(n)) as SyncJson;

  it.each([
    ["setField", ["notes", "a"], { field: "title" }, "value"],
    ["set", ["saves", "a"], {}, "value"],
    ["add", ["tags", "a"], {}, "element"],
  ] as const)(
    "%s answers value_invalid and does not throw",
    (op, rec, extra, member) => {
      const m = mut([rec[0], rec[1]], op, {
        ...extra,
        [member]: deep(5000),
      } as Partial<SyncMutation>);
      expect(one(m)).toMatchObject({ verdict: "record", valueInvalid: true });
    },
  );
});
