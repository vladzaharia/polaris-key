// Unit proofs for the pack install-state machine and the pipeline (plans/P4-01.md §2.13, P4-06;
// CONTENT §9–§10). The appliers, planner and selection are pinned by the content corpus and
// `plan-matrix.json` in the conformance runners; these pin what no corpus row can: commit and
// the pointer swap, resume, rollback, garbage-collection roots, embedded baselines and the
// state reload that trusts nothing it reads back.
//
// @pkey-feature packs.state packs.handlers

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decode as wasmDecode,
  decodeWithPrefix as wasmDecodeWithPrefix,
} from "@polaris-key/zstd-wasm";
import {
  PackEngine,
  PackError,
  applyDelta,
  commitInstall,
  emptyPackState,
  gcRoots,
  memoryPackStateStore,
  memoryPackStorage,
  memorySource,
  packSetId,
  parsePackState,
  reloadPackState,
  rollbackInstall,
  serializePackState,
  type PackEngineOptions,
  type PackHandler,
  type PackInstall,
  type Sha256Port,
  type ZstdPort,
} from "../src/index.js";
import {
  PRODUCT,
  PRODUCT_TRUST,
  PROBE_BASE,
  PROBE_TARGET,
  RELEASE_KEYS,
  byteServer,
  markerFor,
  sha,
  stampFor,
  treePack,
  type TreePack,
} from "./packFixtures.js";

const zstd: ZstdPort = {
  pointerBits: 30,
  decode: wasmDecode,
  decodeWithPrefix: wasmDecodeWithPrefix,
};

/** A streaming SHA-256 that counts the bytes it is fed. */
function countingSha256(): { port: Sha256Port; fed: () => number } {
  let fed = 0;
  return {
    fed: () => fed,
    port: () => {
      const h = createHash("sha256");
      return {
        update(b) {
          fed += b.byteLength;
          h.update(b);
        },
        digest: () => h.digest("hex"),
      };
    },
  };
}

let plans = 0;
function engine(
  o: Partial<PackEngineOptions> & {
    server: ReturnType<typeof byteServer>;
  },
): PackEngine {
  const { server, ...rest } = o;
  return new PackEngine({
    product: PRODUCT,
    releaseKeys: RELEASE_KEYS,
    productTrust: () => PRODUCT_TRUST,
    stamp: null,
    prefs: { engine: null, axes: {} },
    zstd,
    sha256: countingSha256().port,
    patchMethods: ["zstd-patch-from"],
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

const v1Files = {
  "fr/strings.json": '{"hello":"bonjour"}',
  "fr/menu.json": '{"play":"jouer"}',
  "probe.txt": PROBE_BASE,
  "big.bin": "x".repeat(50000),
};

async function releases(): Promise<{
  v1: TreePack;
  v2: TreePack;
  v3: TreePack;
}> {
  const v1 = await treePack({
    packId: "djdl.l10n",
    version: "1.0.0",
    seq: 1,
    files: v1Files,
  });
  const v2 = await treePack({
    packId: "djdl.l10n",
    version: "1.1.0",
    seq: 2,
    files: { ...v1Files, "fr/strings.json": '{"hello":"salut"}' },
  });
  const v3 = await treePack({
    packId: "djdl.l10n",
    version: "1.2.0",
    seq: 3,
    files: {
      ...v1Files,
      "fr/strings.json": '{"hello":"salut"}',
      "probe.txt": PROBE_TARGET,
      "fr/new.json": "{}",
    },
    from: v2,
  });
  return { v1, v2, v3 };
}

function treeOf(
  storage: ReturnType<typeof memoryPackStorage>,
  location: string,
): Record<string, string> {
  const t = storage.store.get(location)?.tree;
  return Object.fromEntries([...(t ?? [])].map(([p, b]) => [p, sha(b)]));
}
const hashes = (files: Record<string, Uint8Array>) =>
  Object.fromEntries(Object.entries(files).map(([p, b]) => [p, sha(b)]));

describe("the probe vector fixture", () => {
  it("is the zstd 1.5.7 --patch-from target", () => {
    expect(sha(PROBE_TARGET)).toBe(
      "cb0e436ee45ab5d453e18dd20612ce36c56e371dbf940bc5cabd20fd0ef27c27",
    );
  });
});

describe("the install-state machine (pure)", () => {
  const install = (packId: string, n: number): PackInstall => ({
    packId,
    record: `r${n}`,
    recordSha256: sha(`r${n}`),
    version: `1.${n}.0`,
    seq: n,
    type: "files.tree",
    variant: "",
    layout: "tree",
    payloadSha256: sha(`p${n}`),
    payloadSize: n,
    activation: "hot",
    location: `${packId}/${n}`,
    installedAt: n,
  });

  it("commit swaps the pointer and keeps the replaced install as previous; rollback restores it", () => {
    let s = commitInstall(emptyPackState(), install("a", 1));
    s = commitInstall(s, install("a", 2));
    expect(s.active.a!.seq).toBe(2);
    expect(s.previous.a!.seq).toBe(1);
    const r = rollbackInstall(s, "a");
    expect(r.rolledBack).toBe(true);
    expect(r.state.active.a!.seq).toBe(1);
    expect(r.state.previous.a).toBeUndefined();
    expect(rollbackInstall(r.state, "a").rolledBack).toBe(false);
  });

  it("GC keeps active, previous, in-flight and embedded roots", () => {
    let s = commitInstall(emptyPackState(), install("a", 1));
    s = commitInstall(s, install("a", 2));
    s = {
      ...s,
      inflight: {
        b: {
          planId: "p9",
          packId: "b",
          record: "x",
          recordSha256: sha("x"),
          variant: "",
          strategy: "full",
          objects: [],
          startedAt: 0,
        },
      },
    };
    const roots = gcRoots(s, [{ location: "emb/c" }]);
    expect([...roots.locations].sort()).toEqual(["a/1", "a/2", "emb/c"]);
    expect([...roots.plans]).toEqual(["p9"]);
  });

  it("parses nothing it cannot read and reload keeps only what the verifier accepts", async () => {
    expect(parsePackState("not json")).toEqual(emptyPackState());
    expect(parsePackState(JSON.stringify({ v: 2 }))).toEqual(emptyPackState());
    const s = commitInstall(
      commitInstall(emptyPackState(), install("a", 1)),
      install("b", 2),
    );
    const text = serializePackState(s).replace(
      '"payloadSize":2',
      '"payloadSize":-2',
    );
    const parsed = parsePackState(text);
    expect(Object.keys(parsed.active)).toEqual(["a"]);
    const reloaded = await reloadPackState(s, {
      install: async (i) => i.packId === "b",
      journal: async () => true,
    });
    expect(Object.keys(reloaded.active)).toEqual(["b"]);
    expect(reloaded.bootSeq).toBe(s.bootSeq + 1);
  });
});

describe("PackEngine: a files.tree pack through the pipeline", () => {
  it("installs a first release by full, reports its packSetId, and keeps the index", async () => {
    const { v1 } = await releases();
    const server = byteServer(v1);
    const storage = memoryPackStorage();
    const e = engine({ server, storage, stamp: stampFor(v1) });
    await e.load();
    const progress: number[] = [];
    e.on((p) => progress.push(p.done));
    const [i] = await e.ensure(["djdl.l10n"]);
    expect(i!.recordSha256).toBe(v1.recordSha256);
    expect(i!.payloadSha256).toBe(v1.treeDigest);
    expect(treeOf(storage, i!.location)).toEqual(hashes(v1.files));
    expect(storage.store.get(i!.location)!.index?.files.length).toBe(4);
    expect(e.state().running["djdl.l10n"]!.recordSha256).toBe(v1.recordSha256);
    expect(await e.packSetId()).toBe(
      await packSetId([
        { packId: "djdl.l10n", releaseSha256: v1.recordSha256 },
      ]),
    );
    expect(server.calls.map((c) => c.sha256)).toEqual([
      v1.indexSha256,
      v1.fullSha256,
    ]);
    expect(progress.at(-1)).toBeGreaterThan(0);
    // Ensuring the same pin again is a no-op that fetches nothing.
    await e.ensure(["djdl.l10n"]);
    expect(server.calls.length).toBe(2);
  });

  it("updates by the file strategy (only the changed file's blob) and by a files delta set", async () => {
    const { v1, v2, v3 } = await releases();
    const server = byteServer(v1, v2, v3);
    const storage = memoryPackStorage();
    const state = memoryPackStateStore();
    let e = engine({ server, storage, state, stamp: stampFor(v1) });
    await e.load();
    await e.ensure(["djdl.l10n"]);

    server.calls.length = 0;
    e = engine({ server, storage, state, stamp: stampFor(v2) });
    await e.load();
    const [i2] = await e.ensure(["djdl.l10n"]);
    expect(treeOf(storage, i2!.location)).toEqual(hashes(v2.files));
    expect(server.calls.map((c) => c.sha256)).toEqual([
      v2.indexSha256,
      sha('{"hello":"salut"}'),
    ]);

    server.calls.length = 0;
    // Request weight makes a two-file change cheaper by `file` than by a three-object set, so
    // this host lists only `delta` and `full`.
    e = engine({
      server,
      storage,
      state,
      stamp: stampFor(v3),
      strategies: ["delta", "full"],
    });
    await e.load();
    const [i3] = await e.ensure(["djdl.l10n"]);
    expect(treeOf(storage, i3!.location)).toEqual(hashes(v3.files));
    // The delta set: index, descriptor, data (the probe frame for probe.txt, a blob for the new file).
    expect(
      server.calls
        .map((c) => c.sha256)
        .slice(1)
        .sort(),
    ).toEqual(
      [...v3.objects.keys()]
        .filter(
          (h) =>
            !v2.objects.has(h) &&
            h !== v3.indexSha256 &&
            h !== v3.fullSha256 &&
            h !== sha(PROBE_TARGET) &&
            h !== sha("{}"),
        )
        .sort(),
    );
    expect(e.state().previous["djdl.l10n"]!.recordSha256).toBe(v2.recordSha256);
    // GC: only active (v3) and previous (v2) stay.
    expect([...storage.store.keys()].sort()).toEqual(
      [i2!.location, i3!.location].sort(),
    );
    expect(storage.staging.size).toBe(0);
  });

  it("a crash after staging (before the state's pointer swap) leaves active untouched", async () => {
    const { v1, v2 } = await releases();
    const server = byteServer(v1, v2);
    const storage = memoryPackStorage();
    const state = memoryPackStateStore();
    let e = engine({ server, storage, state, stamp: stampFor(v1) });
    await e.load();
    const [i1] = await e.ensure(["djdl.l10n"]);
    const before = state.text;

    // The process dies as it writes the committed state: the payload is in the store, the
    // document on disk still has the journal and the old pointer.
    const dying = {
      read: state.read,
      replace: async (text: string) => {
        const doc = JSON.parse(text) as {
          active: Record<string, { seq: number }>;
        };
        if (doc.active["djdl.l10n"]?.seq === 2) throw new Error("killed");
        await state.replace(text);
      },
    };
    e = engine({ server, storage, state: dying, stamp: stampFor(v2) });
    await e.load();
    await expect(e.ensure(["djdl.l10n"])).rejects.toThrow("killed");
    expect(JSON.parse(state.text!).active["djdl.l10n"].seq).toBe(1);
    expect(state.text).not.toBe(before); // the journal was written

    // Relaunch: active is still v1, the orphaned v2 payload is collected, the journal resumes.
    e = engine({ server, storage, state, stamp: stampFor(v1) });
    await e.load();
    expect(e.state().active["djdl.l10n"]!.recordSha256).toBe(v1.recordSha256);
    expect([...storage.store.keys()]).toEqual([i1!.location]);
  });

  it("resumes an interrupted download with Range and If-Range, re-hashing what is staged", async () => {
    const { v1 } = await releases();
    const server = byteServer(v1);
    const storage = memoryPackStorage();
    const state = memoryPackStateStore();
    const hash = countingSha256();
    let e = engine({
      server,
      storage,
      state,
      stamp: stampFor(v1),
      sha256: hash.port,
      checkpointBytes: 1,
    });
    await e.load();
    server.cut = null;
    // Interrupt the full object (the second object) after 1,000 bytes.
    const orig = server.fetchObject;
    let n = 0;
    server.fetchObject = async (req) => {
      if (++n === 2) server.cut = 1000;
      return orig(req);
    };
    await expect(e.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "network-error",
    });
    const journal = JSON.parse(state.text!).inflight["djdl.l10n"];
    expect(
      journal.objects.find(
        (o: { sha256: string }) => o.sha256 === v1.fullSha256,
      ).done,
    ).toBe(1000);

    server.fetchObject = orig;
    server.calls.length = 0;
    const relaunch = countingSha256();
    e = engine({
      server,
      storage,
      state,
      stamp: stampFor(v1),
      sha256: relaunch.port,
    });
    await e.load();
    expect(e.state().inflight["djdl.l10n"]).toBeDefined();
    const [i] = await e.ensure(["djdl.l10n"]);
    expect(treeOf(storage, i!.location)).toEqual(hashes(v1.files));
    const resumed = server.calls.find((c) => c.sha256 === v1.fullSha256)!;
    expect(resumed).toEqual({
      sha256: v1.fullSha256,
      offset: 1000,
      ifRange: `"${v1.fullSha256}"`,
    });
    // The 1,000 staged bytes were hashed again on resume.
    expect(relaunch.fed()).toBeGreaterThanOrEqual(1000 + v1.size);
  });

  it("refetches from the start when the staged prefix no longer hashes", async () => {
    const { v1 } = await releases();
    const server = byteServer(v1);
    const storage = memoryPackStorage();
    const state = memoryPackStateStore();
    let e = engine({ server, storage, state, stamp: stampFor(v1) });
    await e.load();
    const orig = server.fetchObject;
    let n = 0;
    server.fetchObject = async (req) => {
      if (++n === 2) server.cut = 1000;
      return orig(req);
    };
    await expect(e.ensure(["djdl.l10n"])).rejects.toBeInstanceOf(PackError);
    server.fetchObject = orig;
    // Corrupt the staged prefix: it must not be trusted.
    for (const objs of storage.staging.values()) {
      const b = objs.get(v1.fullSha256);
      if (b) b[0] = b[0]! ^ 1;
    }
    server.calls.length = 0;
    e = engine({ server, storage, state, stamp: stampFor(v1) });
    await e.load();
    const [i] = await e.ensure(["djdl.l10n"]);
    expect(treeOf(storage, i!.location)).toEqual(hashes(v1.files));
    expect(
      server.calls
        .filter((c) => c.sha256 === v1.fullSha256)
        .map((c) => c.offset),
    ).toEqual([1000, 0]);
  });

  it("rolls back to previous, and a hot handler is deactivated and activated", async () => {
    const { v1, v2 } = await releases();
    const server = byteServer(v1, v2);
    const storage = memoryPackStorage();
    const state = memoryPackStateStore();
    const events: string[] = [];
    const handler: PackHandler = {
      type: "files.tree",
      layout: "tree",
      activation: "hot",
      supports: (fv) => fv === 1,
      activate: (i) => void events.push(`on ${i.version}`),
      deactivate: (i) => void events.push(`off ${i.version}`),
    };
    let e = engine({
      server,
      storage,
      state,
      stamp: stampFor(v1),
      handlers: [handler],
    });
    await e.load();
    await e.ensure(["djdl.l10n"]);
    e = engine({
      server,
      storage,
      state,
      stamp: stampFor(v2),
      handlers: [handler],
    });
    await e.load();
    await e.ensure(["djdl.l10n"]);
    expect(await e.rollback("djdl.l10n")).toBe(true);
    expect(e.state().active["djdl.l10n"]!.version).toBe("1.0.0");
    expect(e.state().running["djdl.l10n"]!.version).toBe("1.0.0");
    expect(events).toEqual([
      "on 1.0.0",
      "on 1.0.0",
      "off 1.0.0",
      "on 1.1.0",
      "off 1.1.0",
      "on 1.0.0",
    ]);
    expect(await e.rollback("djdl.l10n")).toBe(false);
    await e.confirm();
    expect(JSON.parse(state.text!).confirmedBootSeq).toBe(e.state().bootSeq);
  });

  it("uses a verified embedded baseline as installed state and keeps it as a GC root", async () => {
    const { v1 } = await releases();
    const other = await treePack({
      packId: "djdl.extra",
      version: "1.0.0",
      seq: 1,
      files: { "a.txt": "a" },
    });
    const server = byteServer(v1, other);
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
    const e = engine({ server, storage, stamp: stampFor(v1, other) });
    expect((await e.load([baseline])).refused).toEqual([]);
    const [i] = await e.ensure(["djdl.l10n"]);
    expect(i!.embedded).toBe(true);
    expect(server.calls.length).toBe(0);
    // Installing another pack runs garbage collection; the embedded payload is a root.
    await e.ensure(["djdl.extra"]);
    expect(storage.store.has("embedded/djdl.l10n")).toBe(true);
    expect(await e.packSetId()).toBe(
      await packSetId([
        { packId: "djdl.l10n", releaseSha256: v1.recordSha256 },
        { packId: "djdl.extra", releaseSha256: other.recordSha256 },
      ]),
    );

    // A marker whose bytes do not match, or whose release the stamp does not pin, is refused.
    const v2 = await treePack({
      packId: "djdl.l10n",
      version: "1.1.0",
      seq: 2,
      files: { a: "b" },
    });
    const bad = await engine({ server, storage, stamp: stampFor(v1) }).load([
      { ...baseline, payload: { kind: "tree", treeDigest: v2.treeDigest } },
    ]);
    expect(bad.refused).toEqual([
      { location: "embedded/djdl.l10n", step: "payload" },
    ]);
    const unpinned = await engine({
      server,
      storage,
      stamp: stampFor(v2),
    }).load([baseline]);
    expect(unpinned.refused).toEqual([
      { location: "embedded/djdl.l10n", step: "pin" },
    ]);
    const forged = await engine({ server, storage, stamp: stampFor(v1) }).load([
      { ...baseline, marker: markerFor(v1).replace('"1.0.0"', '"1.0.1"') },
    ]);
    expect(forged.refused).toEqual([
      { location: "embedded/djdl.l10n", step: "cross-check" },
    ]);
  });

  it("re-verifies the stored state on load and drops what fails", async () => {
    const { v1 } = await releases();
    const server = byteServer(v1);
    const storage = memoryPackStorage();
    const state = memoryPackStateStore();
    const e = engine({ server, storage, state, stamp: stampFor(v1) });
    await e.load();
    const [i] = await e.ensure(["djdl.l10n"]);
    // A forged record JWS in the stored state.
    state.text = state.text!.replace(v1.jws, v1.jws.slice(0, -4) + "AAAA");
    const e2 = engine({ server, storage, state, stamp: stampFor(v1) });
    await e2.load();
    expect(e2.state().active["djdl.l10n"]).toBeUndefined();
    expect(storage.store.has(i!.location)).toBe(false);
    // A payload that changed on disk is dropped too.
    const state3 = memoryPackStateStore();
    const e3 = engine({ server, storage, state: state3, stamp: stampFor(v1) });
    await e3.load();
    const [j] = await e3.ensure(["djdl.l10n"]);
    storage.store
      .get(j!.location)!
      .tree!.set("fr/menu.json", new TextEncoder().encode("{}"));
    const e4 = engine({ server, storage, state: state3, stamp: stampFor(v1) });
    await e4.load();
    expect(e4.state().active["djdl.l10n"]).toBeUndefined();
  });

  it("refuses with typed codes: no stamp, unpinned, unknown type, entitlement, forged record", async () => {
    const { v1 } = await releases();
    const server = byteServer(v1);
    const noStamp = engine({ server });
    await noStamp.load();
    await expect(noStamp.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "not-configured",
    });
    const e = engine({ server, stamp: stampFor(v1) });
    await e.load();
    await expect(e.ensure(["djdl.other"])).rejects.toMatchObject({
      code: "pack-not-pinned",
    });

    const table = await treePack({
      packId: "djdl.table",
      version: "1.0.0",
      seq: 1,
      files: { a: "1" },
      type: "l10n.table",
    });
    const t = engine({ server: byteServer(table), stamp: stampFor(table) });
    await t.load();
    await expect(t.ensure(["djdl.table"])).rejects.toMatchObject({
      code: "pack-type-unsupported",
    });

    const paid = await treePack({
      packId: "djdl.hd",
      version: "1.0.0",
      seq: 1,
      files: { a: "1" },
      entitlement: "hd",
    });
    const p = engine({
      server: byteServer(paid),
      stamp: stampFor(paid),
      entitlements: () => new Set(["other"]),
    });
    await p.load();
    await expect(p.ensure(["djdl.hd"])).rejects.toMatchObject({
      code: "pack-not-entitled",
    });
    const p2 = engine({
      server: byteServer(paid),
      stamp: stampFor(paid),
      entitlements: () => new Set(["hd"]),
    });
    await p2.load();
    await expect(p2.ensure(["djdl.hd"])).resolves.toHaveLength(1);

    const forged = byteServer(v1);
    forged.fetchRecord = async () => ({ ok: true, body: v1.jws + "x" });
    const f = engine({ server: forged, stamp: stampFor(v1) });
    await f.load();
    await expect(f.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "record-rejected",
      detail: "hash",
    });
  });

  it("registerHandler validates its handler", () => {
    const e = engine({ server: byteServer() });
    expect(() =>
      e.registerHandler({ type: "x" } as unknown as PackHandler),
    ).toThrow(PackError);
  });
});

describe("applyDelta and rule 5 (a base that starts with the dictionary magic)", () => {
  it("is refused before any decoder sees it", async () => {
    let called = false;
    const spy: ZstdPort = {
      pointerBits: 31,
      decode: () => new Uint8Array(),
      decodeWithPrefix: () => {
        called = true;
        return new Uint8Array();
      },
    };
    const base = new Uint8Array([0x37, 0xa4, 0x30, 0xec, 1, 2, 3]);
    const frame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x05, 0, 0]);
    const variant = {
      variant: {},
      payload: { size: 5, sha256: sha("hello") },
      full: { sha256: sha("f"), bytes: 1, size: 5, codec: "zstd" },
      files: {
        format: "pkey-files/1",
        layout: "container",
        sha256: sha("i"),
        bytes: 1,
        size: 1,
        codec: "zstd",
      },
      deltas: [
        {
          method: "zstd-patch-from",
          scope: "payload" as const,
          from: sha(base),
          memBytes: 64,
          artifact: { sha256: sha(frame), bytes: frame.byteLength },
        },
      ],
    };
    const r = await applyDelta(variant, 0, memorySource(base), {
      objects: async () => memorySource(frame),
      zstd: spy,
    });
    expect(r.verdict).toEqual({ ok: false, error: "delta-apply-failed" });
    expect(called).toBe(false);
  });
});
