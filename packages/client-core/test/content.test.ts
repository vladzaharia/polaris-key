// Unit proofs for P4-13's client side (plans/P4-13.md §2.5): the sibling `revocations.json`
// (written only with a first entry, re-verified on load, `relearn`, the 256-target cap, torn and
// unreadable files), the pack engine's `pack-revoked` refusals, and `runUpdateCheck`'s content
// steps 10–14. The corpus pins every verdict and decision row across SDKs; these pin the
// persistence and the I/O around them, which no corpus row can carry.
//
// @pkey-feature packs.revoke update.content

import { describe, expect, it } from "vitest";
import {
  decode as wasmDecode,
  decodeWithPrefix as wasmDecodeWithPrefix,
} from "@polaris-key/zstd-wasm";
import type { ChannelFeedDoc } from "@polaris-key/protocol/update";
import {
  MAX_STORED_REVOCATIONS,
  PackEngine,
  PackError,
  memoryPackStateStore,
  memoryPackStorage,
  newerRevocation,
  runUpdateCheck,
  stampHolds,
  verifyRevocation,
  type PackEngineOptions,
  type VerifiedRevocation,
  type ZstdPort,
} from "../src/index.js";
import {
  capRevocations,
  clearRelearn,
  emptyRevocations,
  parseRevocations,
  reloadRevocations,
  serializeRevocations,
  storeRevocation,
} from "../src/packs/index.js";
import {
  PRODUCT,
  PRODUCT_TRUST,
  RELEASE_KEYS,
  byteServer,
  markerFor,
  revocationFor,
  sha,
  signFeedDoc,
  signReleaseDoc,
  stampFor,
  treePack,
  type TreePack,
} from "./packFixtures.js";

const zstd: ZstdPort = {
  pointerBits: 30,
  decode: wasmDecode,
  decodeWithPrefix: wasmDecodeWithPrefix,
};

let plans = 0;
function engine(
  o: Partial<PackEngineOptions> & { server: ReturnType<typeof byteServer> },
): PackEngine {
  const { server, ...rest } = o;
  return new PackEngine({
    product: PRODUCT,
    releaseKeys: RELEASE_KEYS,
    productTrust: () => PRODUCT_TRUST,
    stamp: null,
    prefs: { engine: null, axes: {} },
    zstd,
    sha256: () => {
      const chunks: Uint8Array[] = [];
      return {
        update: (b) => void chunks.push(b),
        digest: () => sha(Buffer.concat(chunks)),
      };
    },
    patchMethods: [],
    memBudget: 1 << 30,
    storage: memoryPackStorage(),
    state: memoryPackStateStore(),
    fetchRecord: (h) => server.fetchRecord(h),
    fetchObject: (r) => server.fetchObject(r),
    now: () => 1759400000,
    newPlanId: () => `plan-${++plans}`,
    ...rest,
  });
}

async function l10n(): Promise<{ v1: TreePack; v2: TreePack }> {
  const v1 = await treePack({
    packId: "djdl.l10n",
    version: "1.0.0",
    seq: 1,
    files: { "fr.json": '{"a":"b"}' },
  });
  const v2 = await treePack({
    packId: "djdl.l10n",
    version: "1.1.0",
    seq: 2,
    files: { "fr.json": '{"a":"c"}' },
  });
  return { v1, v2 };
}

async function verified(
  r: Awaited<ReturnType<typeof revocationFor>>,
): Promise<VerifiedRevocation> {
  const v = await verifyRevocation(r.jws, {
    releaseKeys: RELEASE_KEYS,
    productTrust: PRODUCT_TRUST,
    expectedAud: PRODUCT,
    entry: r.entry,
  });
  if (!v.ok) throw new Error(`revocation refused at ${v.step}`);
  return v.revocation;
}

describe("revocations.json (pure)", () => {
  it("parses nothing torn, and drops a malformed entry into relearn", () => {
    expect(parseRevocations("not json")).toBeNull();
    expect(parseRevocations(JSON.stringify({ v: 2 }))).toBeNull();
    const doc = parseRevocations(
      JSON.stringify({
        v: 1,
        revoked: { [sha("t")]: { pack: "djdl.l10n", jws: 5 } },
        relearn: ["djdl.other", "Not A Pack"],
      }),
    );
    expect(doc).toEqual({
      v: 1,
      revoked: {},
      relearn: ["djdl.l10n", "djdl.other"],
    });
  });

  it("stores a new target, supersedes with a newer one, ignores an older one", async () => {
    const { v1, v2 } = await l10n();
    const a = await revocationFor(v1, { issuedAt: 1000 });
    const b = await revocationFor(v1, { issuedAt: 2000, replacement: v2 });
    const old = await revocationFor(v1, { issuedAt: 500, reason: "older" });
    const va = await verified(a);
    const vb = await verified(b);
    const vo = await verified(old);
    let s = storeRevocation(emptyRevocations(), va, a.jws);
    expect(s.changed).toBe(true);
    expect(storeRevocation(s.doc, va, a.jws).changed).toBe(false);
    s = storeRevocation(s.doc, vb, b.jws, () => va);
    expect(s.doc.revoked[v1.recordSha256]!.record).toBe(b.record);
    const t = storeRevocation(s.doc, vo, old.jws, () => vb);
    expect(t.changed).toBe(false);
    expect(newerRevocation(va, vb)).toBe(vb);
  });

  it("keeps at most 256 targets, dropping the oldest without relearn", () => {
    const doc = emptyRevocations();
    for (let i = 0; i < MAX_STORED_REVOCATIONS + 3; i++)
      doc.revoked[sha(`t${i}`)] = {
        jws: "x",
        pack: "djdl.l10n",
        version: "1.0.0",
        seq: 1,
        record: sha(`r${i}`),
        issuedAt: 1000 + i,
      };
    const capped = capRevocations(doc);
    expect(Object.keys(capped.revoked).length).toBe(MAX_STORED_REVOCATIONS);
    for (const i of [0, 1, 2])
      expect(capped.revoked[sha(`t${i}`)]).toBeUndefined();
    expect(capped.relearn).toEqual([]);
  });

  it("re-verifies on load: a rotated key forgets, any other failure relearns", async () => {
    const { v1, v2 } = await l10n();
    const good = await revocationFor(v1);
    const rotated = await revocationFor(v2, { kid: "djdl-release-test-2027" });
    const doc = emptyRevocations();
    doc.revoked[v1.recordSha256] = {
      jws: good.jws,
      pack: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      record: good.record,
      issuedAt: 1759350000,
    };
    doc.revoked[v2.recordSha256] = {
      jws: rotated.jws,
      pack: "djdl.l10n",
      version: "1.1.0",
      seq: 2,
      record: rotated.record,
      issuedAt: 1759350000,
    };
    const r = await reloadRevocations(doc, {
      releaseKeys: RELEASE_KEYS,
      productTrust: PRODUCT_TRUST,
      expectedAud: PRODUCT,
    });
    expect(Object.keys(r.doc.revoked)).toEqual([v1.recordSha256]);
    expect(r.doc.relearn).toEqual([]);
    // A pin mismatch (the stored seq is wrong) relearns the pack.
    doc.revoked[v1.recordSha256] = { ...doc.revoked[v1.recordSha256]!, seq: 9 };
    const r2 = await reloadRevocations(doc, {
      releaseKeys: RELEASE_KEYS,
      productTrust: PRODUCT_TRUST,
      expectedAud: PRODUCT,
    });
    expect(r2.doc.revoked).toEqual({});
    expect(r2.doc.relearn).toEqual(["djdl.l10n"]);
    expect(clearRelearn(r2.doc, ["djdl.l10n"]).doc.relearn).toEqual([]);
  });

  it("reads a stamp's holds beside parseContentStamp, with the token rule", () => {
    const pin = { sha256: sha("h"), seq: 3, version: "1.0.0" };
    const stamp = {
      format: "pkey-content/1",
      contentApi: 1,
      pins: [],
      expects: [],
      holds: [{ pack: "djdl.l10n", release: pin }],
    };
    expect(stampHolds(JSON.stringify(stamp))).toEqual([
      { pack: "djdl.l10n", release: pin },
    ]);
    expect(
      stampHolds(JSON.stringify(stamp).replace('"seq":3', '"seq":3.0')),
    ).toBeNull();
    expect(stampHolds(JSON.stringify({ ...stamp, holds: undefined }))).toEqual(
      [],
    );
  });
});

describe("PackEngine and revocations (plans/P4-13.md §2.5)", () => {
  it("a product with no revocations writes no revocations.json and no flag", async () => {
    const { v1 } = await l10n();
    const state = memoryPackStateStore();
    const revs = memoryPackStateStore();
    const e = engine({
      server: byteServer(v1),
      state,
      revocations: revs,
      stamp: stampFor(v1),
    });
    await e.load();
    await e.ensure(["djdl.l10n"]);
    await e.recordRevocations([]);
    expect(revs.text).toBeNull();
    expect(JSON.parse(state.text!).revocationsStored).toBeUndefined();
  });

  it("stores a revocation (flag first, then the file), unmounts the release and refuses it", async () => {
    const { v1 } = await l10n();
    const state = memoryPackStateStore();
    const revs = memoryPackStateStore();
    const order: string[] = [];
    const watched = {
      ...state,
      replace: async (t: string) => {
        order.push("state");
        await state.replace(t);
      },
    };
    const watchedRevs = {
      ...revs,
      replace: async (t: string) => {
        order.push("revocations");
        await revs.replace(t);
      },
    };
    const e = engine({
      server: byteServer(v1),
      state: watched,
      revocations: watchedRevs,
      stamp: stampFor(v1),
    });
    await e.load();
    await e.ensure(["djdl.l10n"]);
    expect(e.state().running["djdl.l10n"]).toBeDefined();
    const r = await revocationFor(v1);
    order.length = 0;
    await e.recordRevocations([{ revocation: await verified(r), jws: r.jws }]);
    expect(order).toEqual(["state", "revocations"]);
    expect(JSON.parse(state.text!).revocationsStored).toBe(true);
    expect(Object.keys(JSON.parse(revs.text!).revoked)).toEqual([
      v1.recordSha256,
    ]);
    expect(e.state().running["djdl.l10n"]).toBeUndefined();
    await expect(e.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "pack-revoked",
    });
    expect(await e.rollback("djdl.l10n")).toBe(false);

    // A fresh process re-verifies the file and never mounts the revoked install.
    const again = engine({
      server: byteServer(v1),
      state,
      revocations: revs,
      stamp: stampFor(v1),
    });
    await again.load();
    expect(again.state().running["djdl.l10n"]).toBeUndefined();
    expect(again.isRevoked(v1.recordSha256)).toBe(true);
  });

  it("refuses a revoked embedded baseline, and a pack in relearn after a torn file", async () => {
    const { v1 } = await l10n();
    const storage = memoryPackStorage();
    storage.store.set("embedded/djdl.l10n", {
      layout: "tree",
      tree: new Map(Object.entries(v1.files)),
      index: null,
    });
    const baseline = {
      marker: markerFor(v1),
      payload: { kind: "tree" as const, treeDigest: v1.treeDigest },
      location: "embedded/djdl.l10n",
    };
    // Torn: quarantined, replaced by a fresh file whose relearn holds the stamp's pins.
    const revs = memoryPackStateStore("{torn");
    const state = memoryPackStateStore();
    const e = engine({
      server: byteServer(v1),
      storage,
      state,
      revocations: revs,
      stamp: stampFor(v1),
    });
    await e.load([baseline]);
    expect(revs.torn).toBe("{torn");
    expect(JSON.parse(revs.text!).relearn).toEqual(["djdl.l10n"]);
    expect(JSON.parse(state.text!).revocationsStored).toBe(true);
    expect(e.revocations().issue).toBe("torn");
    expect(e.state().running["djdl.l10n"]).toBeUndefined();
    // A fresh feed that re-teaches the pack clears relearn; the baseline mounts next boot.
    await e.recordRevocations([], { relearnCleared: ["djdl.l10n"] });
    expect(JSON.parse(revs.text!).relearn).toEqual([]);
    const next = engine({
      server: byteServer(v1),
      storage,
      state,
      revocations: revs,
      stamp: stampFor(v1),
    });
    await next.load([baseline]);
    expect(next.state().running["djdl.l10n"]?.embedded).toBe(true);

    // recoverState() clears relearn wholesale and releases the quarantine.
    const torn2 = memoryPackStateStore("{torn");
    const e2 = engine({
      server: byteServer(v1),
      storage,
      revocations: torn2,
      stamp: stampFor(v1),
    });
    await e2.load([baseline]);
    await e2.recoverState();
    expect(torn2.torn).toBeNull();
    expect(e2.revocations().relearn).toEqual([]);
  });

  it("an unreadable revocations.json refuses the stamp's baselines only when the flag is set", async () => {
    const { v1 } = await l10n();
    const storage = memoryPackStorage();
    storage.store.set("embedded/djdl.l10n", {
      layout: "tree",
      tree: new Map(Object.entries(v1.files)),
      index: null,
    });
    const baseline = {
      marker: markerFor(v1),
      payload: { kind: "tree" as const, treeDigest: v1.treeDigest },
      location: "embedded/djdl.l10n",
    };
    const unreadable = {
      ...memoryPackStateStore(),
      read: async (): Promise<string | null> => {
        throw new Error("EIO");
      },
    };
    const flagged = memoryPackStateStore(
      JSON.stringify({
        v: 1,
        active: {},
        previous: {},
        inflight: {},
        observed: {},
        confirmedBootSeq: 0,
        bootSeq: 0,
        revocationsStored: true,
      }),
    );
    const a = engine({
      server: byteServer(v1),
      storage,
      state: flagged,
      revocations: unreadable,
      stamp: stampFor(v1),
    });
    await a.load([baseline]);
    expect(a.revocations().issue).toBe("unreadable");
    expect(a.state().running["djdl.l10n"]).toBeUndefined();
    const b = engine({
      server: byteServer(v1),
      storage,
      revocations: unreadable,
      stamp: stampFor(v1),
    });
    await b.load([baseline]);
    expect(b.state().running["djdl.l10n"]?.embedded).toBe(true);
  });

  it("offline, a baseline refused for relearn raises pack-revoked with detail relearn", async () => {
    const { v1 } = await l10n();
    const storage = memoryPackStorage();
    storage.store.set("embedded/djdl.l10n", {
      layout: "tree",
      tree: new Map(Object.entries(v1.files)),
      index: null,
    });
    const e = engine({
      server: byteServer(), // offline: no record can be fetched
      storage,
      revocations: memoryPackStateStore("{torn"),
      stamp: stampFor(v1),
    });
    await e.load([
      {
        marker: markerFor(v1),
        payload: { kind: "tree", treeDigest: v1.treeDigest },
        location: "embedded/djdl.l10n",
      },
    ]);
    const err = await e.ensure(["djdl.l10n"]).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(PackError);
    expect((err as PackError).code).toBe("pack-revoked");
    expect((err as PackError).detail).toBe("relearn");
    expect((err as PackError).packId).toBe("djdl.l10n");
  });

  it("a failed flag write is never believed: no revocations.json without the flag on disk", async () => {
    const { v1, v2 } = await l10n();
    const v3 = await treePack({
      packId: "djdl.l10n",
      version: "1.2.0",
      seq: 3,
      files: { "fr.json": '{"a":"d"}' },
    });
    const state = memoryPackStateStore();
    const revs = memoryPackStateStore();
    const order: string[] = [];
    let stateFails = false;
    const failing = {
      ...state,
      replace: async (t: string) => {
        // The state write fails (the store refuses it), as a full disk would.
        if (stateFails) throw new Error("disk full");
        order.push("state");
        await state.replace(t);
      },
    };
    const watchedRevs = {
      ...revs,
      replace: async (t: string) => {
        order.push("revocations");
        await revs.replace(t);
      },
    };
    const e = engine({
      server: byteServer(v1),
      state: failing,
      revocations: watchedRevs,
      stamp: stampFor(v1),
    });
    await e.load();
    await e.ensure(["djdl.l10n"]);
    const flagInMemory = () =>
      (e as unknown as { doc: { revocationsStored?: boolean } }).doc
        .revocationsStored;
    stateFails = true;
    order.length = 0;
    for (const p of [v1, v2]) {
      const r = await revocationFor(p);
      await expect(
        e.recordRevocations([{ revocation: await verified(r), jws: r.jws }]),
      ).rejects.toThrow("disk full");
    }
    expect(order).toEqual([]);
    expect(revs.text).toBeNull();
    expect(JSON.parse(state.text!).revocationsStored).toBeUndefined();
    expect(flagInMemory()).toBeUndefined();
    // The revocations still apply for the process; the revoked release stopped running.
    expect(e.isRevoked(v1.recordSha256)).toBe(true);
    expect(e.isRevoked(v2.recordSha256)).toBe(true);
    expect(e.state().running["djdl.l10n"]).toBeUndefined();

    // Once the state is writable, the flag is written first, then the file.
    stateFails = false;
    const r3 = await revocationFor(v3);
    await e.recordRevocations([
      { revocation: await verified(r3), jws: r3.jws },
    ]);
    expect(order).toEqual(["state", "revocations"]);
    expect(JSON.parse(state.text!).revocationsStored).toBe(true);
    expect(flagInMemory()).toBe(true);
    expect(Object.keys(JSON.parse(revs.text!).revoked)).toHaveLength(3);
  });

  it("restores revocationsStored when state.json lost it but revocations.json has entries", async () => {
    const { v1 } = await l10n();
    const r = await revocationFor(v1);
    const doc = storeRevocation(
      emptyRevocations(),
      await verified(r),
      r.jws,
    ).doc;
    const state = memoryPackStateStore("{torn state");
    const e = engine({
      server: byteServer(v1),
      state,
      revocations: memoryPackStateStore(serializeRevocations(doc)),
      stamp: stampFor(v1),
    });
    await e.load();
    expect(e.state().stateIssue).toBe("torn");
    expect(JSON.parse(state.text!).revocationsStored).toBe(true);
    expect(e.isRevoked(v1.recordSha256)).toBe(true);
  });

  it("raises a typed PackError for a revoked pin", async () => {
    const { v1 } = await l10n();
    const e = engine({ server: byteServer(v1), stamp: stampFor(v1) });
    await e.load();
    const r = await revocationFor(v1);
    await e.recordRevocations([{ revocation: await verified(r), jws: r.jws }]);
    const err = await e.ensure(["djdl.l10n"]).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(PackError);
    expect((err as PackError).code).toBe("pack-revoked");
  });
});

describe("runUpdateCheck content steps 10–14 (plans/P4-13.md §2.5)", () => {
  const NOW = 1_759_400_100;
  async function setup(
    o: { replacement?: boolean; noPackSets?: boolean } = {},
  ) {
    const { v1, v2 } = await l10n();
    const appRecord = {
      schemaVersion: 1,
      aud: PRODUCT,
      deliverable: "app",
      kind: "app",
      version: "1.5.0",
      seq: 15,
      issuedAt: 1_759_000_000,
      builds: [
        {
          id: "macos-dmg",
          platform: "macos",
          arch: "universal",
          format: "dmg",
          artifacts: [
            { name: "a.dmg", role: "payload", sha256: sha("a"), size: 1 },
          ],
        },
      ],
    };
    const appJws = await signReleaseDoc(appRecord);
    const rev = await revocationFor(
      v1,
      o.replacement ? { replacement: v2 } : {},
    );
    const setId = sha(`djdl.l10n ${v1.recordSha256}\n`);
    const feed: ChannelFeedDoc = {
      schemaVersion: 1,
      iss: "key.plrs.im",
      aud: PRODUCT,
      channel: "stable",
      selector: {},
      seq: 7,
      issuedAt: NOW - 100,
      expiresAt: NOW + 800,
      app: {
        deliverable: "app",
        versionScheme: "semver",
        targets: [
          {
            platform: "macos",
            release: { sha256: sha(appJws), seq: 15, version: "1.5.0" },
            floor: null,
            critical: false,
            outlets: {
              direct: {
                kind: "direct",
                live: { version: "1.5.0", seq: 15 },
                halted: false,
              },
            },
          },
        ],
      },
      ...(o.noPackSets
        ? {}
        : {
            packSets: {
              releases: {
                [v1.recordSha256]: {
                  pack: "djdl.l10n",
                  version: "1.0.0",
                  seq: 1,
                },
              },
              sets: { [setId]: [v1.recordSha256] },
              rows: [
                {
                  contentApi: 1,
                  platform: "macos",
                  engine: "",
                  variant: {},
                  set: setId,
                },
              ],
            },
          }),
      revocations: [rev.entry],
    };
    const feedJws = await signFeedDoc(feed);
    const records = new Map<string, string>([
      [sha(appJws), appJws],
      [rev.record, rev.jws],
      [v1.recordSha256, v1.jws],
      [v2.recordSha256, v2.jws],
    ]);
    const fetched: string[] = [];
    const opts = {
      channel: "stable",
      expectedAud: PRODUCT,
      trust: PRODUCT_TRUST,
      releaseKeys: RELEASE_KEYS,
      now: NOW,
      installId: "dev_1",
      installed: {
        version: "1.5.0",
        buildNumber: null,
        platform: "macos",
        arch: "arm64",
        format: null,
        engine: null,
      },
      outlet: { id: "direct", kind: "direct" as const },
      subkind: null,
      methods: ["download" as const],
      cache: {},
      fetchFeed: async () => ({ ok: true as const, body: feedJws }),
      fetchRecord: async (h: string) => {
        fetched.push(h);
        const b = records.get(h);
        return b
          ? { ok: true as const, body: b }
          : { ok: false as const, code: "network-error" };
      },
      content: {
        stamp: {
          contentApi: 1,
          pins: [],
          expects: [
            { pack: "djdl.l10n", required: true, delivery: "essential" },
          ],
        },
        holds: [],
        active: {
          "djdl.l10n": { sha256: v1.recordSha256, seq: 1, version: "1.0.0" },
        },
        engine: null,
        axes: {},
        revoked: {},
        relearn: ["djdl.l10n"],
      },
    };
    return { v1, v2, rev, opts, fetched };
  }

  it("learns a relevant revocation and blocks revoked required content (boot required)", async () => {
    const { rev, opts } = await setup();
    const r = await runUpdateCheck(opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.revocations?.learned.map((l) => l.revocation.record)).toEqual([
      rev.record,
    ]);
    expect(r.revocations?.relearnCleared).toEqual(["djdl.l10n"]);
    expect(r.check.decision).toMatchObject({
      action: "blocked",
      reason: "revoked-content",
    });
    expect(r.boot).toBe("required");
  });

  it("clears relearn when the feed lists only the revocation of an older release the device does not hold", async () => {
    const { v2, rev, opts, fetched } = await setup({ noPackSets: true });
    const pin2 = { sha256: v2.recordSha256, seq: 2, version: "1.1.0" };
    const r = await runUpdateCheck({
      ...opts,
      content: {
        ...opts.content,
        stamp: {
          ...opts.content.stamp,
          pins: [{ pack: "djdl.l10n", release: pin2 }],
        },
        active: { "djdl.l10n": pin2 },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // v1 is outside H: its revocation is not fetched, and it keeps nothing in relearn.
    expect(fetched).not.toContain(rev.record);
    expect(r.revocations?.learned).toEqual([]);
    expect(r.revocations?.relearnCleared).toEqual(["djdl.l10n"]);
  });

  it("keeps relearn while a considered revocation cannot be fetched", async () => {
    const { rev, opts } = await setup();
    const r = await runUpdateCheck({
      ...opts,
      fetchRecord: async (h: string) =>
        h === rev.record
          ? { ok: false as const, code: "network-error" }
          : opts.fetchRecord(h),
    });
    expect(r.ok && r.revocations?.relearnCleared).toEqual([]);
  });

  it("installs a fetched, verified, usable replacement instead", async () => {
    const { v2, opts, fetched } = await setup({ replacement: true });
    const r = await runUpdateCheck(opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetched).toContain(v2.recordSha256);
    expect(r.check.decision).toMatchObject({
      action: "packs",
      install: [
        {
          pack: "djdl.l10n",
          release: { sha256: v2.recordSha256, seq: 2, version: "1.1.0" },
        },
      ],
    });
    expect(r.boot).toBe("none");
  });

  it("a replacement that cannot be fetched is not yet usable: the required pack stays blocked", async () => {
    const { v2, opts } = await setup({ replacement: true });
    const r = await runUpdateCheck({
      ...opts,
      fetchRecord: async (h: string) =>
        h === v2.recordSha256
          ? { ok: false as const, code: "network-error" }
          : opts.fetchRecord(h),
    });
    expect(r.ok && r.check.decision.action).toBe("blocked");
  });

  it("skips a stored revocation it already holds, and clears nothing from a committed feed", async () => {
    const { rev, opts, fetched } = await setup();
    const v = await verifyRevocation(rev.jws, {
      releaseKeys: RELEASE_KEYS,
      productTrust: PRODUCT_TRUST,
      expectedAud: PRODUCT,
      entry: rev.entry,
    });
    if (!v.ok) throw new Error("fixture");
    const first = await runUpdateCheck(opts);
    if (!first.ok) throw new Error("first");
    fetched.length = 0;
    const r = await runUpdateCheck({
      ...opts,
      cache: first.cache,
      fetchFeed: async () => ({ ok: false as const, code: "network-error" }),
      content: {
        ...opts.content,
        revoked: { [rev.entry.target]: v.revocation },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fetched).not.toContain(rev.record);
    expect(r.check.feed).toBe("committed");
    expect(r.revocations?.relearnCleared).toEqual([]);
  });
});
