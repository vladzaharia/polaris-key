/**
 * U-09.8: records through the real account merge and the object's wire: export carries records,
 * parked copies and the key id; the survivor absorbs them (D3 parks a collision); the absorbed
 * object is left with nothing; erasure removes the parked copies too.
 */
import { describe, expect, it } from "vitest";
import "../../../src/index.js";
import type { SyncMutation } from "@polaris-key/protocol/sync";
import { runSubjectMerge } from "../../../src/core/accounts/subjectHooks.js";
import {
  absorbCloudSync,
  callCloudSync,
  exportCloudSync,
} from "../../../src/services/sync/do/client.js";
import type { ExportDocument } from "../../../src/services/sync/do/protocol.js";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import type { Classification } from "../../../src/services/sync/engine/types.js";
import { makeTestDb } from "../../helpers.js";
import {
  CloudSyncNamespaceMock,
  ERASED_LEFTOVERS,
  asCloudSyncNamespace,
  erasureLeftovers,
} from "../../cloudSyncDoMock.js";
import {
  blinded as BLIND,
  kidOf,
  sealedBox as envelope,
} from "./cloudSyncRecordsHarness.js";

const P = "acme";
const T0 = 1_760_000_000_000;
const C1 = "c_000000000000000client1";
const C2 = "c_000000000000000client2";
const at = (n: number) => formatHlc(T0 + n * 1000, 0);

const REVISION: Classification = {
  verdict: "record",
  policy: "revision",
  maxRecords: 100,
};
const MERGE_REC: Classification = {
  verdict: "record",
  policy: "merge",
  maxRecords: 100,
};
const UNION_REC: Classification = {
  verdict: "record",
  policy: "union",
  maxRecords: 100,
};
const SEALED_LAST: Classification = {
  verdict: "accept",
  scope: "user",
  policy: "lastWrite",
  sealed: true,
};

type Cs = { CLOUD_SYNC: DurableObjectNamespace };
const world = () => {
  const ns = new CloudSyncNamespaceMock();
  const env: Cs = { CLOUD_SYNC: asCloudSyncNamespace(ns) };
  return { ns, env };
};

let nextId = 1;
const rec = (
  collection: string,
  id: string,
  op: SyncMutation["op"],
  n: number,
  extra: Partial<SyncMutation> = {},
): SyncMutation => ({
  mutationId: nextId++,
  target: { record: [collection, id] },
  op,
  editedHlc: at(n),
  ...extra,
});

async function push(
  env: Cs,
  subject: string,
  items: [SyncMutation, Classification][],
  clientId = C1,
  deviceId = "d1",
) {
  const r = await callCloudSync<"push">(
    env,
    { product: P, subject },
    {
      op: "push",
      deviceId,
      family: "desktop",
      limits: { quotaBytes: 1_000_000_000 },
      request: { clientId, cursor: 0, mutations: items.map(([m]) => m) },
      classified: items.map(([, c]) => c),
      serverNow: T0 + 3_600_000,
    },
  );
  if (!r.outcome.ok) throw new Error(JSON.stringify(r.outcome));
  for (const x of r.outcome.results)
    if (x.status !== "ok") throw new Error(JSON.stringify(x));
}

const merge = (env: Cs, from: string, to: string) =>
  runSubjectMerge(
    { db: makeTestDb(), env: env as never, now: 1 },
    { product: P, from, to },
  );

const ex = (env: Cs, subject: string) =>
  exportCloudSync(env, { product: P, subject });

async function seed(env: Cs) {
  await push(env, "to", [
    [rec("saves", "a", "set", 1, { value: { hp: 1 } }), REVISION],
    [rec("notes", "n", "setField", 2, { field: "x", value: 1 }), MERGE_REC],
    [rec("tags", "t", "add", 3, { element: "p" }), UNION_REC],
  ]);
  await push(
    env,
    "from",
    [
      [rec("saves", "a", "set", 4, { value: { hp: 9 } }), REVISION],
      [rec("saves", "b", "set", 5, { value: { hp: 2 } }), REVISION],
      [rec("notes", "n", "setField", 6, { field: "y", value: 2 }), MERGE_REC],
      [rec("tags", "t", "add", 7, { element: "q" }), UNION_REC],
    ],
    C2,
    "d2",
  );
}

describe("a merge moves records", () => {
  it("joins every shape, parks the colliding revision record, and leaves the absorbed object empty", async () => {
    const { ns, env } = world();
    await seed(env);
    await merge(env, "from", "to");
    const doc = (await ex(env, "to"))!;
    const by = (c: string, id: string) =>
      doc.records?.find((r) => r.collection === c && r.id === id);
    expect(by("saves", "a")?.value).toEqual({ hp: 1 });
    expect(by("saves", "b")?.value).toEqual({ hp: 2 });
    expect(
      by("notes", "n")
        ?.fields?.map(([name]) => name)
        .sort(),
    ).toEqual(["x", "y"]);
    expect(
      by("tags", "t")
        ?.elements?.map(([, e]) => e.element)
        .sort(),
    ).toEqual(["p", "q"]);
    expect(doc.parked).toEqual([
      expect.objectContaining({
        collection: "saves",
        id: "a",
        fromSubject: "from",
        value: { hp: 9 },
      }),
    ]);
    // The usage counts the live records, and a pull sees them all from cursor 0.
    const u = await callCloudSync<"usage">(
      env,
      { product: P, subject: "to" },
      { op: "usage" },
    );
    expect(u.usage.records).toBe(4);
    const pulled = await callCloudSync<"pull">(
      env,
      { product: P, subject: "to" },
      { op: "pull", deviceId: "d1", family: "desktop" },
    );
    expect(pulled.outcome.ok && pulled.outcome.changes).toHaveLength(4);
    // The absorbed object keeps its pin and marker, no row.
    expect(await ex(env, "from")).toBeNull();
    const db = ns.instance(`${P}:from`).storage.sql.db;
    for (const t of [
      "records",
      "record_fields",
      "set_elements",
      "parked_records",
    ])
      expect(db.prepare(`SELECT count(*) AS n FROM ${t}`).get(), t).toEqual({
        n: 0,
      });
  });

  it("a repeat absorb of the same export writes nothing", async () => {
    const { env } = world();
    await seed(env);
    const doc = (await ex(env, "from"))!;
    const to = { product: P, subject: "to" };
    expect(await absorbCloudSync(env, to, doc)).toBeGreaterThan(0);
    const after = await ex(env, "to");
    expect(await absorbCloudSync(env, to, doc)).toBe(0);
    expect(await ex(env, "to")).toEqual(after);
  });

  it("the parked copy moves on when the survivor is itself absorbed", async () => {
    const { env } = world();
    await seed(env);
    await merge(env, "from", "to");
    await merge(env, "to", "third");
    const doc = (await ex(env, "third"))!;
    expect(doc.parked).toHaveLength(1);
    expect(doc.parked?.[0]).toMatchObject({ fromSubject: "from" });
    expect(doc.records).toHaveLength(4);
  });

  it("export carries the key id of sealed settings through a merge", async () => {
    const { env } = world();
    await push(
      env,
      "from",
      [
        [
          {
            mutationId: nextId++,
            target: { setting: BLIND(1), scope: "user" },
            op: "set",
            editedHlc: at(1),
            ct: envelope(7),
          },
          SEALED_LAST,
        ],
      ],
      C2,
      "d2",
    );
    const doc = (await ex(env, "from"))!;
    expect(doc.settings[0]).toMatchObject({ kid: kidOf(7) });
    await merge(env, "from", "to");
    expect((await ex(env, "to"))!.settings[0]).toMatchObject({
      kid: kidOf(7),
    });
  });

  it("the object refuses a malformed record, a bad key id and a bad policy table, and writes nothing", async () => {
    const { ns, env } = world();
    await seed(env);
    const doc = (await ex(env, "from"))!;
    const to = { product: P, subject: "to" };
    const first = doc.records![0]!;
    const bad: ExportDocument[] = [
      { ...doc, records: [{ ...first, collection: "bad name" }] },
      { ...doc, records: [{ ...first, kind: "blob" as never }] },
      { ...doc, records: [{ ...first, kid: "zz" }] },
      { ...doc, records: "nope" as never },
      { ...doc, parked: [{ ...first, fromSubject: "", parkedAt: 1 }] as never },
    ];
    const before = ns.instance(`${P}:to`).storage.sql.rowsWritten;
    const statuses = await Promise.all(
      bad.map((d) => absorbCloudSync(env, to, d).catch((e: unknown) => e)),
    );
    expect(statuses.map((e) => (e as { status?: number }).status)).toEqual(
      bad.map(() => 400),
    );
    expect(ns.instance(`${P}:to`).storage.sql.rowsWritten).toBe(before);
    await expect(
      callCloudSync(env, to, {
        op: "absorb",
        document: doc,
        recordPolicies: [["saves", { policy: "nonsense" as never }]],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(ns.instance(`${P}:to`).storage.sql.rowsWritten).toBe(before);
  });

  it("a record policy table from the caller joins a collision by stamp instead of parking it", async () => {
    const { env } = world();
    await seed(env);
    const doc = (await ex(env, "from"))!;
    await callCloudSync(
      env,
      { product: P, subject: "to" },
      {
        op: "absorb",
        document: doc,
        recordPolicies: [["saves", { policy: "lastWrite" }]],
      },
    );
    const after = (await ex(env, "to"))!;
    // The absorbed copy was written later (a later `editedHlc`), so it wins; nothing is parked.
    expect(after.records?.find((r) => r.id === "a")?.value).toEqual({ hp: 9 });
    expect(after.parked).toBeUndefined();
  });
});

describe("erasure", () => {
  it("erasing an object removes its records and its parked copies", async () => {
    const { ns, env } = world();
    await seed(env);
    await merge(env, "from", "to");
    await callCloudSync(
      env,
      { product: P, subject: "to" },
      { op: "deleteAll" },
    );
    expect(erasureLeftovers(ns, `${P}:to`)).toEqual(ERASED_LEFTOVERS);
  });
});
