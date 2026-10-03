// Unit proofs for save compatibility on the device (P4-20, CONTENT §6.7 item 8): `providesOf`,
// the reader of a pack record's reserved record-level `provides`, and the engine's `isAvailable`
// (the active set) and `packFor` (the target set). Python, Swift and Godot pin the same cases.
//
// @pkey-feature packs.provides

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decode as wasmDecode,
  decodeWithPrefix as wasmDecodeWithPrefix,
} from "@polaris-key/zstd-wasm";
import {
  CONTENT_ID_PATTERN,
  MAX_PROVIDES,
  PackEngine,
  memoryPackStateStore,
  memoryPackStorage,
  providesOf,
  type PackEngineOptions,
  type ZstdPort,
} from "../src/index.js";
import {
  PRODUCT,
  PRODUCT_TRUST,
  RELEASE_KEYS,
  byteServer,
  markerFor,
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
      const h = createHash("sha256");
      return { update: (b) => void h.update(b), digest: () => h.digest("hex") };
    },
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

function pack(
  packId: string,
  provides: unknown,
  extra: Partial<Parameters<typeof treePack>[0]> = {},
): Promise<TreePack> {
  return treePack({
    packId,
    version: "1.0.0",
    seq: 1,
    files: { [`${packId}.txt`]: packId },
    ...(provides === undefined ? {} : { recordExtra: { provides } }),
    ...extra,
  });
}

const target = (p: TreePack) => ({
  pack: p.packId,
  release: { sha256: p.recordSha256, seq: p.seq, version: p.version },
});

const provider = (p: TreePack) => ({
  packId: p.packId,
  release: target(p).release,
});

describe("providesOf", () => {
  it("reads a well-formed list", () => {
    expect([...providesOf({ provides: ["foe.goblin", "item.sword"] })]).toEqual(
      ["foe.goblin", "item.sword"],
    );
    expect(providesOf({ provides: [] }).size).toBe(0);
  });

  it("reads absent as nothing provided", () => {
    expect(providesOf({}).size).toBe(0);
    expect(providesOf(null).size).toBe(0);
    expect(providesOf([]).size).toBe(0);
  });

  it("reads an unusable list as nothing provided", () => {
    for (const provides of [
      "foe.goblin",
      { "foe.goblin": true },
      ["foe.goblin", "foe.goblin"],
      ["foe goblin"],
      [""],
      ["x".repeat(129)],
      ["é"],
      [7],
      Array.from({ length: MAX_PROVIDES + 1 }, (_, i) => `id.${i}`),
    ])
      expect(providesOf({ provides }).size).toBe(0);
    expect(
      providesOf({
        provides: Array.from({ length: MAX_PROVIDES }, (_, i) => `id.${i}`),
      }).size,
    ).toBe(MAX_PROVIDES);
    expect(CONTENT_ID_PATTERN.test("x".repeat(128))).toBe(true);
    expect(CONTENT_ID_PATTERN.test("~!res://a/b#c")).toBe(true);
  });
});

describe("isAvailable and packFor", () => {
  it("answers from an installed and active pack", async () => {
    const foes = await pack("djdl.foes", ["foe.goblin", "foe.orc"]);
    const server = byteServer(foes);
    const e = engine({ server, stamp: stampFor(foes) });
    await e.load();
    expect(e.isAvailable("foe.goblin")).toBe(false);
    await e.ensure(["djdl.foes"]);
    expect(e.isAvailable("foe.goblin")).toBe(true);
    expect(e.isAvailable("foe.dragon")).toBe(false);
    expect(await e.packFor("foe.orc")).toEqual(provider(foes));
  });

  it("names a pack only the target set provides, without installing it", async () => {
    const l10n = await pack("djdl.l10n", ["l10n.en"]);
    const foes = await pack("djdl.foes", ["foe.goblin"]);
    const server = byteServer(l10n, foes);
    const e = engine({ server, stamp: stampFor(l10n, foes) });
    await e.load();
    await e.ensure(["djdl.l10n"]);
    const before = server.calls.length;
    expect(e.isAvailable("foe.goblin")).toBe(false);
    expect(await e.packFor("foe.goblin")).toEqual(provider(foes));
    // Only the record was read: no object was fetched and nothing was installed.
    expect(server.calls.length).toBe(before);
    expect(e.state().active["djdl.foes"]).toBeUndefined();
    expect(e.isAvailable("foe.goblin")).toBe(false);
  });

  it("takes a packs decision's targets instead of the stamp's pins", async () => {
    const v1 = await pack("djdl.events", ["event.halloween"]);
    const v2 = await treePack({
      packId: "djdl.events",
      version: "1.1.0",
      seq: 2,
      files: { "e.txt": "e2" },
      recordExtra: { provides: ["event.halloween", "event.winter"] },
    });
    const server = byteServer(v1, v2);
    const e = engine({ server, stamp: stampFor(v1) });
    await e.load();
    expect(await e.packFor("event.winter")).toBeNull();
    expect(await e.packFor("event.winter", [target(v2)])).toEqual(provider(v2));
    expect(await e.packFor("event.winter", [])).toBeNull();
  });

  it("counts an embedded baseline's record", async () => {
    const core = await pack("djdl.core", ["dice.d6"]);
    const storage = memoryPackStorage();
    storage.store.set("embedded/djdl.core", {
      layout: "tree",
      tree: new Map(Object.entries(core.files)),
      index: null,
    });
    // The server holds nothing: the embedded marker's record answers both questions.
    const server = byteServer();
    const e = engine({ server, storage, stamp: stampFor(core) });
    const { refused } = await e.load([
      {
        marker: markerFor(core),
        payload: { kind: "tree", treeDigest: core.treeDigest },
        location: "embedded/djdl.core",
      },
    ]);
    expect(refused).toEqual([]);
    expect(e.isAvailable("dice.d6")).toBe(true);
    expect(await e.packFor("dice.d6")).toEqual(provider(core));
  });

  it("answers nothing for an id no pack provides", async () => {
    const plain = await pack("djdl.plain", undefined);
    const broken = await pack("djdl.broken", ["ok.id", "ok.id"]);
    const server = byteServer(plain, broken);
    const e = engine({ server, stamp: stampFor(plain, broken) });
    await e.load();
    await e.ensure(["djdl.plain", "djdl.broken"]);
    expect(e.isAvailable("ok.id")).toBe(false);
    expect(await e.packFor("ok.id")).toBeNull();
    expect(await e.packFor("anything")).toBeNull();
  });

  it("skips a target that names another pack's record, even once that record is known", async () => {
    const foes = await pack("djdl.foes", ["foe.goblin"]);
    const server = byteServer(foes);
    const e = engine({ server, stamp: stampFor(foes) });
    await e.load();
    expect(await e.packFor("foe.goblin")).toEqual(provider(foes));
    const forged = { ...target(foes), pack: "djdl.other" };
    expect(await e.packFor("foe.goblin", [forged])).toBeNull();
  });

  it("skips a target whose record cannot be fetched", async () => {
    const gone = await pack("djdl.gone", ["foe.ghost"]);
    const e = engine({ server: byteServer(), stamp: stampFor(gone) });
    await e.load();
    expect(await e.packFor("foe.ghost")).toBeNull();
  });

  it("hides a pack the licence is not entitled to", async () => {
    const skins = await pack("djdl.skins", ["skin.gold"], {
      entitlement: "extras.skins",
    });
    const server = byteServer(skins);
    let granted = new Set<string>();
    const e = engine({
      server,
      stamp: stampFor(skins),
      entitlements: () => granted,
    });
    await e.load();
    expect(await e.packFor("skin.gold")).toBeNull();
    granted = new Set(["extras.skins"]);
    expect(await e.packFor("skin.gold")).toEqual(provider(skins));
  });
});
