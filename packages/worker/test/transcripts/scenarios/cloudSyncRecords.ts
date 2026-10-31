/// <reference types="@cloudflare/workers-types" />
// The Cloud Sync records conversations (U-09.10; WIRE-CONTRACT-V5 §13.3, §13.4, §13.7, §13.10),
// recorded through the real router and the real `CloudSyncDO` over its SQLite mock. Each proves
// `sync.records`, which every SDK still lists as planned, so no replayer runs them yet; they pin the
// routes the SDKs' records ports (U-22, U-23) will be held to.
//
//   cloudsync-records-cas     a `revision` record: create-only, a stale compare-and-swap, delete
//   cloudsync-records-merge   a `merge` record: cells by clock, a tombstone a later write beats
//   cloudsync-records-orset   a `union` record: a stale remove leaves a concurrent add alive
//   cloudsync-records-max     a `max` record: the server keeps the larger `conflictField`
//   cloudsync-records-forget  a merge record keeps 256 removed cells; the oldest are forgotten
//   cloudsync-records-quota   the collection scope, `requires`, and the per-entry charge
//   cloudsync-records-e2e     blinded ids, fields and elements; encryption_mismatch both ways
//
// Server mode except the last (the launch gate `launch.syncE2e` is off, as in the settings
// conversations). The client's own state (its `clientId`, mutation ids) is not asserted.

import { expect } from "vitest";
import type {
  MutationResult,
  PullResponse,
  SyncJson,
  SyncMutation,
} from "@polaris-key/protocol/sync";
import type { TranscriptRecorder, World } from "../recorder.js";
import { T0 } from "../client.js";
import { pinned, PRODUCT, type Scenario } from "../world.js";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import {
  OTHER_CLIENT,
  blinded,
  hlcAt,
  nextMutationId,
  pullStep,
  pushStep,
  recorder,
  resetMutationIds,
  sealed,
  statuses,
  syncWorld,
} from "./cloudSync.js";

const FEATURES = ["sync.records"];

const rec = (
  collection: string,
  id: string,
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> = {},
): SyncMutation => ({
  mutationId: nextMutationId(),
  target: { record: [collection, id] },
  op,
  editedHlc: hlcAt(-1000),
  ...extra,
});

/** A `revision` write is ordered by `baseVersion`, not by a clock. */
const revision = (
  id: string,
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> = {},
): SyncMutation => {
  const m = rec("profiles", id, op, extra);
  delete m.editedHlc;
  return m;
};

/** The collections every server-mode conversation shares. */
const CATALOG = {
  schemaVersion: 1,
  entries: [],
  cloudSync: {
    encryption: "server",
    collections: [
      { name: "profiles", conflict: "revision" },
      {
        name: "cards",
        conflict: "merge",
        schema: {
          type: "object",
          properties: { title: { type: "string" }, hp: { type: "number" } },
          additionalProperties: false,
        },
      },
      {
        name: "tags",
        conflict: "union",
        schema: { type: "array", uniqueItems: true, items: { type: "string" } },
      },
      { name: "scores", conflict: "max", conflictField: "best" },
    ],
  },
};

/** Runs `body` as one scenario: the recorder is built inside the pinned clock. */
function scenario(
  id: string,
  description: string,
  body: (r: TranscriptRecorder, world: World) => Promise<void>,
  catalog: unknown = CATALOG,
  opts: { e2eGate?: boolean } = {},
): Scenario {
  return {
    id,
    record: () =>
      pinned(id, async (pin) => {
        resetMutationIds();
        const { world, token } = await syncWorld({ catalog, ...opts });
        const r = recorder(id, description, pin, world, token, FEATURES);
        await body(r, world);
        return r.transcript();
      }),
  };
}

const copyOf = (res: MutationResult | undefined) =>
  (res as Extract<MutationResult, { status: "conflict" }>).server;

const changeOf = (body: PullResponse | null, collection: string, id: string) =>
  body?.changes.find(
    (c) => "record" in c && c.record[0] === collection && c.record[1] === id,
  );

// ── cas ────────────────────────────────────────────────────────────────────────────────────────

export const recordsCas = scenario(
  "cloudsync-records-cas",
  'A revision record (§13.3). baseVersion "*" creates and is refused while the record is live; a number is compare-and-swap and a stale one answers conflict with the server\'s copy; an absent baseVersion overwrites; delete removes the record, the pull then carries its tombstone, and "*" creates it again.',
  async (r) => {
    const created = await pushStep(
      r,
      [revision("p1", "set", { value: { name: "Ada" }, baseVersion: "*" })],
      "Create-only: no such record, so it lands as version 1.",
    );
    expect(statuses(created.body)).toEqual(["ok"]);
    const again = await pushStep(
      r,
      [
        revision("p1", "set", { value: { name: "Bea" }, baseVersion: "*" }),
        revision("p1", "set", { value: { name: "Ada L." }, baseVersion: 1 }),
        revision("p1", "set", { value: { name: "stale" }, baseVersion: 1 }),
      ],
      "Create-only on a live record conflicts; the right version swaps; the same version again is stale.",
      { cursor: created.body!.cursor },
    );
    expect(statuses(again.body)).toEqual(["conflict", "ok", "conflict"]);
    expect(copyOf(again.body!.results[2])).toMatchObject({
      value: { name: "Ada L." },
      version: 2,
    });
    const snap = await pullStep(r, 0, "A snapshot: the live record.");
    expect(changeOf(snap.body, "profiles", "p1")).toMatchObject({
      value: { name: "Ada L." },
      version: 2,
    });
    const gone = await pushStep(
      r,
      [revision("p1", "delete", { baseVersion: 2 })],
      "A delete on the current version.",
      { cursor: snap.body!.cursor },
    );
    expect(statuses(gone.body)).toEqual(["ok"]);
    const after = await pullStep(
      r,
      snap.body!.cursor,
      "The pull since the snapshot carries the tombstone and no change.",
    );
    expect(after.body?.tombstones.length).toBe(1);
    const reborn = await pushStep(
      r,
      [
        revision("p2", "delete"),
        revision("p1", "set", { value: { name: "Ada" }, baseVersion: "*" }),
      ],
      "A delete of a record that was never stored is ok and stores nothing; create-only works again over a tombstone.",
      { cursor: gone.body!.cursor },
    );
    expect(statuses(reborn.body)).toEqual(["ok", "ok"]);
  },
);

// ── merge ──────────────────────────────────────────────────────────────────────────────────────

export const recordsMerge = scenario(
  "cloudsync-records-merge",
  "A merge record (§13.3): each field is its own last-write-wins cell. Two devices' edits of different fields both stand; a concurrent edit of one field is decided by editedHlc whatever the arrival order (the loser is answered conflict); removeField is a tombstone that only a later setField beats; a whole set is op_invalid_for_policy. The pull carries the live object.",
  async (r) => {
    const first = await pushStep(
      r,
      [
        rec("cards", "c1", "setField", {
          field: "title",
          value: "Dragon",
          editedHlc: hlcAt(-3000),
        }),
        rec("cards", "c1", "setField", {
          field: "hp",
          value: 10,
          editedHlc: hlcAt(-3000),
        }),
      ],
      "Two fields of one record.",
    );
    expect(statuses(first.body)).toEqual(["ok", "ok"]);
    const second = await pushStep(
      r,
      [
        rec("cards", "c1", "setField", {
          field: "hp",
          value: 30,
          editedHlc: hlcAt(-1000),
        }),
        // Concurrent with the first push, older than the cell: it arrives later and loses.
        rec("cards", "c1", "setField", {
          field: "hp",
          value: 20,
          editedHlc: hlcAt(-2000),
        }),
        rec("cards", "c1", "removeField", {
          field: "title",
          editedHlc: hlcAt(-1500),
        }),
        // Older than the removal: the tombstone wins.
        rec("cards", "c1", "setField", {
          field: "title",
          value: "Wyrm",
          editedHlc: hlcAt(-2500),
        }),
        rec("cards", "c1", "set", { value: { hp: 1 } }),
        rec("cards", "c1", "setField", { field: "mana", value: 3 }),
      ],
      "A later hp wins, an older one loses; a removal beats an older write; a whole set and an undeclared field are refused.",
      { cursor: first.body!.cursor },
    );
    expect(statuses(second.body)).toEqual([
      "ok",
      "conflict",
      "ok",
      "conflict",
      "rejected:op_invalid_for_policy",
      "rejected:value_invalid",
    ]);
    const mid = await pullStep(
      r,
      0,
      "The live object: title is gone, hp is 30.",
    );
    expect(changeOf(mid.body, "cards", "c1")).toMatchObject({
      value: { hp: 30 },
    });
    const back = await pushStep(
      r,
      [
        rec("cards", "c1", "setField", {
          field: "title",
          value: "Drake",
          editedHlc: hlcAt(-500),
        }),
      ],
      "A write later than the removal brings the field back.",
      { cursor: second.body!.cursor },
    );
    expect(statuses(back.body)).toEqual(["ok"]);
    const end = await pullStep(r, 0, "The object with both fields.");
    expect(changeOf(end.body, "cards", "c1")).toMatchObject({
      value: { hp: 30, title: "Drake" },
    });
    const del = await pushStep(
      r,
      [rec("cards", "c1", "delete", { editedHlc: hlcAt(-200) })],
      "delete removes the record and every cell.",
      { cursor: back.body!.cursor },
    );
    expect(statuses(del.body)).toEqual(["ok"]);
  },
);

// ── orset ──────────────────────────────────────────────────────────────────────────────────────

export const recordsOrset = scenario(
  "cloudsync-records-orset",
  "A union record is an observed-remove set (§13.3). add stamps the element with the store sequence; remove drops the tags at or below observedSeq, so an add the remover has not seen survives. A remove without observedSeq, or with one above the store sequence, is value_invalid. The pull lists the elements in the order of their first surviving add.",
  async (r) => {
    const a = await pushStep(
      r,
      [
        rec("tags", "t1", "add", { element: "red" }),
        rec("tags", "t1", "add", { element: "blue" }),
      ],
      "Device one adds two elements; they take sequences 1 and 2.",
    );
    expect(statuses(a.body)).toEqual(["ok", "ok"]);
    const b = await pushStep(
      r,
      [rec("tags", "t1", "add", { element: "red" })],
      "Device two, which had not seen device one's add, adds red again: a second tag at sequence 3.",
      { cursor: a.body!.cursor, clientId: OTHER_CLIENT },
    );
    expect(statuses(b.body)).toEqual(["ok"]);
    const stale = await pushStep(
      r,
      [
        rec("tags", "t1", "remove", { element: "red", observedSeq: 1 }),
        rec("tags", "t1", "remove", { element: "blue" }),
        rec("tags", "t1", "remove", { element: "blue", observedSeq: 9999 }),
      ],
      "Device one removes red having seen only sequence 1; a remove with no observedSeq, or one above the store sequence, is refused.",
      { cursor: b.body!.cursor },
    );
    expect(statuses(stale.body)).toEqual([
      "ok",
      "rejected:value_invalid",
      "rejected:value_invalid",
    ]);
    const mid = await pullStep(
      r,
      0,
      "Red survived on device two's tag; both elements are listed.",
    );
    expect(changeOf(mid.body, "tags", "t1")).toMatchObject({
      value: ["blue", "red"],
    });
    const done = await pushStep(
      r,
      [
        rec("tags", "t1", "remove", { element: "red", observedSeq: 3 }),
        rec("tags", "t1", "remove", { element: "blue", observedSeq: 2 }),
      ],
      "Having seen sequence 3, the remove takes red's last tag; blue's only tag goes too.",
      { cursor: stale.body!.cursor },
    );
    expect(statuses(done.body)).toEqual(["ok", "ok"]);
    const end = await pullStep(
      r,
      0,
      "A set whose last element is removed is a deleted record: the pull carries its tombstone.",
    );
    expect(end.body?.changes).toEqual([]);
    expect(end.body?.tombstones.length).toBe(1);
  },
);

// ── max ────────────────────────────────────────────────────────────────────────────────────────

export const recordsMax = scenario(
  "cloudsync-records-max",
  "A max record (§13.3): the server keeps the value whose conflictField is larger. A worse write is answered conflict with the stored record; an equal or better one lands; a value without a numeric conflictField is op_invalid_for_policy; delete is decided by editedHlc alone.",
  async (r) => {
    const first = await pushStep(
      r,
      [
        rec("scores", "run1", "set", {
          value: { best: 100, who: "ada" },
          editedHlc: hlcAt(-3000),
        }),
        rec("scores", "run1", "set", {
          value: { best: 40, who: "bea" },
          editedHlc: hlcAt(-2000),
        }),
        rec("scores", "run1", "set", {
          value: { best: 180, who: "cyd" },
          editedHlc: hlcAt(-1500),
        }),
        rec("scores", "run1", "set", { value: { who: "dee" } }),
        rec("scores", "run1", "set", { value: { best: "high" } }),
      ],
      "A first write, a worse one, a better one, and two values with no numeric best.",
    );
    expect(statuses(first.body)).toEqual([
      "ok",
      "conflict",
      "ok",
      "rejected:op_invalid_for_policy",
      "rejected:op_invalid_for_policy",
    ]);
    expect(copyOf(first.body!.results[1])).toMatchObject({
      value: { best: 100, who: "ada" },
    });
    const snap = await pullStep(r, 0, "The best value stands.");
    expect(changeOf(snap.body, "scores", "run1")).toMatchObject({
      value: { best: 180, who: "cyd" },
    });
    const del = await pushStep(
      r,
      [
        rec("scores", "run1", "delete", { editedHlc: hlcAt(-4000) }),
        rec("scores", "run1", "delete", { editedHlc: hlcAt(-100) }),
        rec("scores", "run1", "set", {
          value: { best: 5 },
          editedHlc: hlcAt(-50),
        }),
      ],
      "A delete older than the record loses to it; a later delete removes it; a later set re-creates it.",
      { cursor: first.body!.cursor },
    );
    expect(statuses(del.body)).toEqual(["conflict", "ok", "ok"]);
  },
);

// ── forget ─────────────────────────────────────────────────────────────────────────────────────

const FORGET_CATALOG = {
  schemaVersion: 1,
  entries: [],
  cloudSync: {
    encryption: "server",
    collections: [{ name: "cards", conflict: "merge" }],
  },
};

const names = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_, i) => `f${from + i}`);

export const recordsForget = scenario(
  "cloudsync-records-forget",
  "A merge record keeps at most 256 removed cells (§13.3, Forgotten state): the oldest by clock are forgotten first. A live field is written and 260 others are removed in order; a write older than the oldest removal then lands on a field whose tombstone was forgotten (f0), and still loses to one that is kept (f259).",
  async (r) => {
    let at = -90_000;
    const live = rec("cards", "c1", "setField", {
      field: "title",
      value: "Dragon",
      editedHlc: hlcAt(-1000),
    });
    const batches: SyncMutation[][] = [];
    for (const group of [names(0, 99), names(99, 199), names(199, 260)])
      batches.push(
        group.map((f) =>
          rec("cards", "c1", "removeField", {
            field: f,
            editedHlc: hlcAt(at++),
          }),
        ),
      );
    batches[0]!.unshift(live);
    let cursor = 0;
    for (const [i, batch] of batches.entries()) {
      const res = await pushStep(
        r,
        batch,
        `Removals ${i + 1} of 3: each is a cell tombstone with a later clock than the last.`,
        { cursor },
      );
      expect([res.status, res.code]).toEqual([200, undefined]);
      expect(statuses(res.body).every((s) => s === "ok")).toBe(true);
      cursor = res.body!.cursor;
    }
    const late = await pushStep(
      r,
      [
        rec("cards", "c1", "setField", {
          field: "f0",
          value: 1,
          editedHlc: hlcAt(-95_000),
        }),
        rec("cards", "c1", "setField", {
          field: "f259",
          value: 1,
          editedHlc: hlcAt(-95_000),
        }),
      ],
      "A write older than every removal: f0's tombstone was forgotten, so it lands; f259's is kept, so it conflicts.",
      { cursor },
    );
    expect(statuses(late.body)).toEqual(["ok", "conflict"]);
  },
  FORGET_CATALOG,
);

// ── quota ──────────────────────────────────────────────────────────────────────────────────────

const QUOTA_CATALOG = {
  schemaVersion: 1,
  entries: [],
  cloudSync: {
    encryption: "server",
    collections: [
      { name: "slots", conflict: "revision", maxRecords: 2 },
      { name: "vip", conflict: "lastWrite", requires: "game.vip" },
      { name: "bag", conflict: "union" },
    ],
  },
};

const grant = (value: boolean) =>
  JSON.stringify({
    config: {},
    secrets: {},
    entitlements: {
      "game.vip": { state: "enforced", value, updatedAt: T0 },
    },
  });

export const recordsQuota = scenario(
  "cloudsync-records-quota",
  "The limits on records (§13.3). maxRecords bounds a collection and answers quota_exceeded with scope collection to a create only; an update and a delete never hit it. A collection's requires, an entitlement the licence must grant, answers entitlement_required, except to a delete. The person's byte quota charges every live element of a union record 45 bytes beyond its value, so many tiny elements cannot slip under it. A collection no declaration names is collection_unknown.",
  async (r, world) => {
    const slots = await pushStep(
      r,
      [
        rec("slots", "a", "set", { value: 1, baseVersion: "*" }),
        rec("slots", "b", "set", { value: 2, baseVersion: "*" }),
        rec("slots", "c", "set", { value: 3, baseVersion: "*" }),
        rec("slots", "a", "set", { value: 4, baseVersion: 1 }),
        rec("slots", "a", "delete"),
        rec("slots", "c", "set", { value: 3, baseVersion: "*" }),
      ].map((m) => {
        delete m.editedHlc;
        return m;
      }),
      "Two slots fill the collection: a third create is refused with scope collection, an update still lands, and a delete frees a slot.",
    );
    expect(statuses(slots.body)).toEqual([
      "ok",
      "ok",
      "rejected:quota_exceeded:collection",
      "ok",
      "ok",
      "ok",
    ]);

    const lapsed = await pushStep(
      r,
      [
        rec("vip", "perk", "set", { value: "gold" }),
        rec("vip", "perk", "delete"),
        rec("nope", "x", "set", { value: 1 }),
      ],
      "The vip collection requires game.vip, which the licence lacks: a write is refused, a delete of an absent record is ok; an unknown collection is refused.",
      { cursor: slots.body!.cursor },
    );
    expect(statuses(lapsed.body)).toEqual([
      "rejected:entitlement_required",
      "ok",
      "rejected:collection_unknown",
    ]);

    await world.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ?",
      grant(true),
      PRODUCT,
    );
    const granted = await pushStep(
      r,
      [rec("vip", "perk", "set", { value: "gold" })],
      "The licence now grants game.vip.",
      { cursor: lapsed.body!.cursor },
    );
    expect(statuses(granted.body)).toEqual(["ok"]);
    await world.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ?",
      grant(false),
      PRODUCT,
    );
    const revoked = await pushStep(
      r,
      [
        rec("vip", "perk", "set", { value: "silver" }),
        rec("vip", "perk", "delete", { editedHlc: hlcAt(-100) }),
      ],
      "The entitlement lapsed: a write is refused, but a delete of the stored record passes, so a lapse never traps the person's data.",
      { cursor: granted.body!.cursor },
    );
    expect(statuses(revoked.body)).toEqual([
      "rejected:entitlement_required",
      "ok",
    ]);

    await world.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ?",
      JSON.stringify({
        config: {},
        secrets: {},
        entitlements: {
          "pkey.cloudSync.bytes": {
            state: "enforced",
            value: 200,
            updatedAt: T0,
          },
        },
      }),
      PRODUCT,
    );
    const bag = await pushStep(
      r,
      ["a", "b", "c", "d", "e", "f"].map((e) =>
        rec("bag", "b1", "add", { element: e }),
      ),
      "A person quota of 200 bytes. Each one-character element is charged its value plus 45, so the set holds a few of them and the rest are refused with scope user.",
      { cursor: revoked.body!.cursor, quota: true },
    );
    expect(statuses(bag.body)).toEqual([
      "ok",
      "ok",
      "ok",
      "rejected:quota_exceeded:user",
      "rejected:quota_exceeded:user",
      "rejected:quota_exceeded:user",
    ]);
  },
  QUOTA_CATALOG,
);

// ── e2e ────────────────────────────────────────────────────────────────────────────────────────

const E2E_CATALOG = {
  schemaVersion: 1,
  entries: [],
  cloudSync: {
    collections: [
      { name: "profiles", conflict: "revision" },
      { name: "cards", conflict: "merge" },
      { name: "tags", conflict: "union" },
      { name: "scores", conflict: "max", conflictField: "best" },
    ],
  },
};

const ct = (m: SyncJson | undefined): m is string => typeof m === "string";

export const recordsE2e = scenario(
  "cloudsync-records-e2e",
  "Records in end-to-end mode (§13.3, §13.10). The record id, a merge field and a union element are blinded names (x: and 43 characters) and the value is a sealed ct. A value, an unblinded id, field or element is encryption_mismatch; a malformed envelope is value_invalid. The pull answers ct for a record, fields [{field, ct, editedHlc}] for a merge record and elements [{element, ct}] for a union record, with encryption and encryptionSince. A max record is a compare-and-swap register. Once the store holds sealed rows, a plaintext write made in server mode is refused encryption_mismatch.",
  async (r, world) => {
    const first = await pullStep(
      r,
      0,
      "An empty store names its first sealed sequence.",
    );
    expect(first.body?.encryptionSince).toBe(1);

    const landed = await pushStep(
      r,
      [
        rec("profiles", blinded("A"), "set", {
          ct: sealed(1),
          baseVersion: "*",
        }),
        rec("cards", blinded("B"), "setField", {
          field: blinded("F"),
          ct: sealed(2),
          editedHlc: hlcAt(-2000),
        }),
        rec("cards", blinded("B"), "setField", {
          field: blinded("G"),
          ct: sealed(3, 2),
          editedHlc: hlcAt(-1000),
        }),
        rec("tags", blinded("C"), "add", {
          element: blinded("H"),
          ct: sealed(4),
        }),
        rec("tags", blinded("C"), "add", {
          element: blinded("I"),
          ct: sealed(5),
        }),
        rec("scores", blinded("D"), "set", {
          ct: sealed(6),
          baseVersion: "*",
        }),
      ],
      "One sealed record of each policy: a revision value, two merge fields, two union elements and a max register.",
    );
    expect(statuses(landed.body)).toEqual(Array(6).fill("ok"));

    const snap = await pullStep(
      r,
      0,
      "The snapshot: ct, fields and elements, no value.",
    );
    const bodies = snap.body!.changes;
    expect(bodies.length).toBe(4);
    expect(bodies.every((c) => !("value" in c))).toBe(true);
    const fields = bodies.find((c) => "fields" in c);
    expect(fields && "fields" in fields && fields.fields.length).toBe(2);
    const elements = bodies.find((c) => "elements" in c);
    expect(elements && "elements" in elements && elements.elements.length).toBe(
      2,
    );

    const refused = await pushStep(
      r,
      [
        rec("profiles", blinded("A"), "set", { value: { name: "Ada" } }),
        rec("profiles", "plain-id", "set", { ct: sealed(7) }),
        rec("cards", blinded("B"), "setField", {
          field: "title",
          ct: sealed(8),
        }),
        rec("tags", blinded("C"), "add", { element: "red", ct: sealed(9) }),
        rec("profiles", blinded("A"), "set", { ct: "not-an-envelope" }),
      ],
      "A value, an unblinded id, an unblinded field and an unblinded element are encryption_mismatch; a malformed envelope is value_invalid.",
      { cursor: landed.body!.cursor },
    );
    expect(statuses(refused.body)).toEqual([
      "rejected:encryption_mismatch",
      "rejected:encryption_mismatch",
      "rejected:encryption_mismatch",
      "rejected:encryption_mismatch",
      "rejected:value_invalid",
    ]);

    const register = await pushStep(
      r,
      [
        rec("scores", blinded("D"), "set", {
          ct: sealed(10),
          baseVersion: 6,
        }),
        rec("scores", blinded("D"), "set", {
          ct: sealed(11),
          baseVersion: 6,
        }),
      ],
      "A max record is decided by baseVersion alone: the current version lands, the same version again is stale and answers the server's ct.",
      { cursor: refused.body!.cursor },
    );
    expect(statuses(register.body)).toEqual(["ok", "conflict"]);
    expect(ct((copyOf(register.body!.results[1]) as { ct?: string }).ct)).toBe(
      true,
    );

    // The launch gate goes off: the Worker now serves the product in server mode, whose plaintext
    // write the sealed store must refuse (§13.10.7).
    (world.env as unknown as Record<string, string>).LAUNCH_SYNC_E2E = "off";
    invalidatePlatformSettings(world.env, world.db);
    const plain = await pushStep(
      r,
      [
        rec("profiles", "plain", "set", { value: { name: "Ada" } }),
        rec("profiles", blinded("A"), "delete"),
      ],
      "With the launch gate off the product is served in server mode; a plaintext value into the sealed store is encryption_mismatch, and a delete still works.",
      { cursor: register.body!.cursor },
    );
    expect(statuses(plain.body)).toEqual([
      "rejected:encryption_mismatch",
      "ok",
    ]);
  },
  E2E_CATALOG,
  { e2eGate: true },
);

export const CLOUD_SYNC_RECORDS_SCENARIOS: Scenario[] = [
  recordsCas,
  recordsMerge,
  recordsOrset,
  recordsMax,
  recordsForget,
  recordsQuota,
  recordsE2e,
];
