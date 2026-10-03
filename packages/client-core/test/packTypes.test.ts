// P4-16: the v3 pack-type handlers (CONTENT §4.2): the shared cases every SDK runs
// (`fixtures/pack-type-cases.json`), and each handler through the engine: stage, verify,
// activate, rollback, uninstall (garbage collection), one rejection each, and a game's
// `custom.dialogue` handler end to end.
//
// @pkey-feature packs.handlers packs.type.l10n.table packs.type.data.json packs.type.ml.model

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decode as wasmDecode,
  decodeWithPrefix as wasmDecodeWithPrefix,
} from "@polaris-key/zstd-wasm";
import {
  DataJsonHandler,
  L10nTableHandler,
  MlModelHandler,
  PackEngine,
  bcp47Canonical,
  memoryPackStateStore,
  memoryPackStorage,
  memorySource,
  type InstalledFile,
  type L10nTable,
  type PackEngineOptions,
  type PackHandler,
  type PackInstall,
  type StagedPack,
  type ZstdPort,
} from "../src/index.js";
import {
  PRODUCT,
  PRODUCT_TRUST,
  RELEASE_KEYS,
  byteServer,
  stampFor,
  treePack,
  type TreePack,
} from "./packFixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const CASES_PATH = join(here, "fixtures", "pack-type-cases.json");
const casesText = readFileSync(CASES_PATH, "utf8");
const cases = JSON.parse(casesText) as {
  bcp47: { tag: string; ok: boolean; canonical?: string }[];
  dataJson: Case[];
  l10nTable: Case[];
  mlModel: Case[];
};
interface Case {
  name: string;
  variant?: Record<string, string>;
  options?: Record<string, unknown>;
  files: { path: string; text?: string; base64?: string }[];
  loadTest?: boolean | null;
  expect: Record<string, unknown> & { ok: boolean };
}

const bytesOf = (f: Case["files"][number]): Uint8Array =>
  f.base64 !== undefined
    ? new Uint8Array(Buffer.from(f.base64, "base64"))
    : new TextEncoder().encode(f.text ?? "");

function staged(c: Case): StagedPack {
  const files: InstalledFile[] = c.files.map((f) => {
    const b = bytesOf(f);
    return {
      path: f.path,
      size: b.byteLength,
      sha256: createHash("sha256").update(b).digest("hex"),
      source: memorySource(b),
    };
  });
  return {
    packId: "djdl.case",
    record: {} as StagedPack["record"],
    variant: { variant: c.variant ?? {} } as StagedPack["variant"],
    location: "mem://case",
    files,
    payload: null,
  };
}

const access = (s: StagedPack) => ({
  read: async () => ({ payload: null, files: s.files }),
});
const install = (packId = "djdl.case"): PackInstall =>
  ({ packId, location: "mem://case" }) as PackInstall;

describe("the shared pack-type cases", () => {
  it("the Godot SDK keeps a byte-identical copy", () => {
    const godot = join(
      here,
      "..",
      "..",
      "..",
      "sdks",
      "godot",
      "tests",
      "fixtures",
      "pack_type_cases.json",
    );
    expect(readFileSync(godot, "utf8")).toBe(casesText);
  });

  it("BCP-47", () => {
    for (const c of cases.bcp47) {
      const got = bcp47Canonical(c.tag);
      expect(got !== null, c.tag).toBe(c.ok);
      if (c.ok) expect(got).toBe(c.canonical ?? c.tag);
    }
  });

  it.each(cases.dataJson.map((c) => [c.name, c] as const))(
    "data.json %s",
    async (_name, c) => {
      const h = new DataJsonHandler(c.options as { maxFileBytes?: number });
      const s = staged(c);
      const r = await h.check(s);
      if (!c.expect.ok) {
        expect(r).toMatchObject({
          detail: c.expect.detail,
          path: c.expect.path,
        });
        return;
      }
      expect(r).toBeNull();
      await h.activate(install(), access(s));
      expect(Object.fromEntries(h.documents("djdl.case")!)).toEqual(
        c.expect.documents,
      );
    },
  );

  it.each(cases.l10nTable.map((c) => [c.name, c] as const))(
    "l10n.table %s",
    async (_name, c) => {
      const h = new L10nTableHandler(c.options as { maxFileBytes?: number });
      const s = staged(c);
      const r = await h.check(s);
      if (!c.expect.ok) {
        expect(r).toMatchObject({
          detail: c.expect.detail,
          path: c.expect.path,
        });
        return;
      }
      expect(r).toBeNull();
      await h.activate(install(), access(s));
      expect(h.tables("djdl.case")).toEqual(c.expect.tables);
    },
  );

  it.each(cases.mlModel.map((c) => [c.name, c] as const))(
    "ml.model %s",
    async (_name, c) => {
      const tested: string[] = [];
      const o = c.options as {
        runtimes: string[];
        ramBytes: number;
        vramBytes?: number;
        quantizations?: string[];
      };
      const h = new MlModelHandler({
        ...o,
        ...(c.loadTest === null || c.loadTest === undefined
          ? {}
          : {
              loadTest: ({ file }) => {
                tested.push(file.path);
                return c.loadTest as boolean;
              },
            }),
      });
      const s = staged(c);
      const r = await h.check(s);
      if (!c.expect.ok) {
        expect(r).toMatchObject({
          detail: c.expect.detail,
          path: c.expect.path,
        });
        return;
      }
      expect(r).toBeNull();
      if (c.loadTest !== null) expect(tested).toEqual([c.expect.file]);
      await h.activate(install(), access(s));
      expect(h.model("djdl.case")?.path).toBe(c.expect.file);
    },
  );

  it("a throwing load test refuses the model", async () => {
    const c = cases.mlModel.find((x) => x.name === "fits")!;
    const h = new MlModelHandler({
      runtimes: ["onnx"],
      ramBytes: 1000,
      loadTest: () => {
        throw new Error("boom");
      },
    });
    expect(await h.check(staged(c))).toMatchObject({
      detail: "load-test",
      path: "net.onnx",
    });
  });

  it("an ml.model handler needs a budget", () => {
    expect(
      () => new MlModelHandler({ runtimes: [], ramBytes: 1 }),
    ).toThrowError(TypeError);
    expect(
      () => new MlModelHandler({ runtimes: ["onnx"], ramBytes: -1 }),
    ).toThrowError(TypeError);
  });
});

// ── Through the engine ───────────────────────────────────────────────────────────────────

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
    prefs: { engine: null, axes: { locale: ["fr", "de"] } },
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

/** Install each release in turn over shared storage and state, as successive boots. */
async function installEach(
  packs: TreePack[],
  handlers: PackHandler[],
): Promise<{
  e: PackEngine;
  storage: ReturnType<typeof memoryPackStorage>;
  state: ReturnType<typeof memoryPackStateStore>;
}> {
  const server = byteServer(...packs);
  const storage = memoryPackStorage();
  const state = memoryPackStateStore();
  let e!: PackEngine;
  for (const p of packs) {
    e = engine({ server, storage, state, stamp: stampFor(p), handlers });
    await e.load();
    await e.ensure([p.packId]);
  }
  return { e, storage, state };
}

describe("data.json through the engine", () => {
  const rel = (seq: number, files: Record<string, string>, formatVersion = 1) =>
    treePack({
      packId: "djdl.events",
      version: `1.${seq}.0`,
      seq,
      files,
      type: "data.json",
      formatVersion,
    });

  it("is built in: stages, verifies and activates with no host registration", async () => {
    const v1 = await rel(1, { "winter.json": '{"snow":true}' });
    const { e } = await installEach([v1], []);
    expect(e.state().running["djdl.events"]?.type).toBe("data.json");
    expect(e.state().running["djdl.events"]?.activation).toBe("hot");
  });

  it("activates, swaps, rolls back and collects the oldest release", async () => {
    const v1 = await rel(1, { "a.json": '{"v":1}' });
    const v2 = await rel(2, { "a.json": '{"v":2}' });
    const events: string[] = [];
    const h = new DataJsonHandler({
      onActivate: (id, docs) =>
        void events.push(`on ${JSON.stringify(docs.get("a.json"))}`),
      onDeactivate: () => void events.push("off"),
    });
    const { e } = await installEach([v1, v2], [h]);
    expect(h.documents("djdl.events")?.get("a.json")).toEqual({ v: 2 });
    expect(await e.rollback("djdl.events")).toBe(true);
    expect(h.documents("djdl.events")?.get("a.json")).toEqual({ v: 1 });
    expect(events).toEqual([
      'on {"v":1}',
      'on {"v":1}',
      "off",
      'on {"v":2}',
      "off",
      'on {"v":1}',
    ]);
  });

  it("uninstalls what no root holds: a third release collects the first", async () => {
    const v1 = await rel(1, { "a.json": '{"v":1}' });
    const v2 = await rel(2, { "a.json": '{"v":2}' });
    const v3 = await rel(3, { "a.json": '{"v":3}', "b.json": "{}" });
    const off: string[] = [];
    const h = new DataJsonHandler({ onDeactivate: (id) => void off.push(id) });
    const { e, storage } = await installEach([v1, v2, v3], [h]);
    expect(h.documents("djdl.events")?.get("a.json")).toEqual({ v: 3 });
    expect(off).toEqual(["djdl.events", "djdl.events"]);
    expect(e.state().previous["djdl.events"]?.version).toBe("1.2.0");
    expect([...storage.store.keys()].sort()).toEqual(
      [`djdl.events/${v2.treeDigest}`, `djdl.events/${v3.treeDigest}`].sort(),
    );
  });

  it("refuses a formatVersion it does not list, and a file that is not strict JSON", async () => {
    const tooNew = await rel(1, { "a.json": "{}" }, 2);
    const s1 = engine({ server: byteServer(tooNew), stamp: stampFor(tooNew) });
    await s1.load();
    await expect(s1.ensure(["djdl.events"])).rejects.toMatchObject({
      code: "pack-type-unsupported",
    });
    const h2 = new DataJsonHandler({ formatVersions: [1, 2] });
    const s2 = engine({
      server: byteServer(tooNew),
      stamp: stampFor(tooNew),
      handlers: [h2],
    });
    await s2.load();
    await expect(s2.ensure(["djdl.events"])).resolves.toHaveLength(1);

    const good = await rel(1, { "a.json": '{"v":1}' });
    const bad = await rel(2, { "a.json": '{"v":1}', "b.json": '{"v":1,}' });
    const activated: string[] = [];
    const h = new DataJsonHandler({
      onActivate: (id) => void activated.push(id),
    });
    const storage = memoryPackStorage();
    const state = memoryPackStateStore();
    const server = byteServer(good, bad);
    const e1 = engine({
      server,
      storage,
      state,
      stamp: stampFor(good),
      handlers: [h],
    });
    await e1.load();
    await e1.ensure(["djdl.events"]);
    const e2 = engine({
      server,
      storage,
      state,
      stamp: stampFor(bad),
      handlers: [h],
    });
    await e2.load();
    await expect(e2.ensure(["djdl.events"])).rejects.toMatchObject({
      code: "pack-type-check-failed",
      detail: "json",
      path: "b.json",
      packId: "djdl.events",
    });
    // Nothing activated, the good release still active, staging and the refused payload gone.
    expect(activated).toEqual(["djdl.events", "djdl.events"]);
    expect(e2.state().active["djdl.events"]?.version).toBe("1.1.0");
    expect(e2.state().inflight).toEqual({});
    expect(storage.staging.size).toBe(0);
    expect([...storage.store.keys()]).toEqual([
      `djdl.events/${good.treeDigest}`,
    ]);
  });
});

describe("l10n.table through the engine", () => {
  const po = (lang: string, msg: string) =>
    `msgid ""\nmsgstr "Language: ${lang}\\n"\n\nmsgid "hello"\nmsgstr "${msg}"\n`;
  const rel = (seq: number, lang: string, msg: string, variant = "fr") =>
    treePack({
      packId: "djdl.l10n",
      version: `1.${seq}.0`,
      seq,
      files: { "strings.po": po(lang, msg) },
      type: "l10n.table",
      variant: { locale: variant },
    });

  it("activates the tables, swaps them on update, re-activates on rollback", async () => {
    const v1 = await rel(1, "fr", "Bonjour");
    const v2 = await rel(2, "fr", "Salut");
    const seen: string[] = [];
    const h = new L10nTableHandler({
      onActivate: (_id, t: readonly L10nTable[]) =>
        void seen.push(`+${t[0]!.messages[0]!.strings[0]}`),
      onDeactivate: (_id, t) =>
        void seen.push(`-${t[0]!.messages[0]!.strings[0]}`),
    });
    const { e } = await installEach([v1, v2], [h]);
    expect(h.tables("djdl.l10n")?.[0]?.locale).toBe("fr");
    expect(await e.rollback("djdl.l10n")).toBe(true);
    expect(h.tables("djdl.l10n")?.[0]?.messages[0]?.strings).toEqual([
      "Bonjour",
    ]);
    expect(seen).toEqual([
      "+Bonjour",
      "+Bonjour",
      "-Bonjour",
      "+Salut",
      "-Salut",
      "+Bonjour",
    ]);
  });

  it("refuses a table whose locale is not the variant's", async () => {
    const wrong = await rel(1, "de", "Hallo", "fr");
    const e = engine({ server: byteServer(wrong), stamp: stampFor(wrong) });
    await e.load();
    await expect(e.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "pack-type-check-failed",
      detail: "locale",
      path: "strings.po",
    });
    expect(e.state().running["djdl.l10n"]).toBeUndefined();
  });
});

describe("ml.model through the engine", () => {
  const rel = (seq: number, memBytes: number) =>
    treePack({
      packId: "djdl.model",
      version: `1.${seq}.0`,
      seq,
      files: {
        "model.json": JSON.stringify({
          runtime: "onnx",
          file: "net.onnx",
          memBytes,
        }),
        "net.onnx": `ONNX ${seq}`,
      },
      type: "ml.model",
    });

  it("is not built in: without a host handler the type is unsupported", async () => {
    const v1 = await rel(1, 10);
    const e = engine({ server: byteServer(v1), stamp: stampFor(v1) });
    await e.load();
    await expect(e.ensure(["djdl.model"])).rejects.toMatchObject({
      code: "pack-type-unsupported",
    });
  });

  it("load-tests the staged model, then swaps the path; rollback swaps back", async () => {
    const v1 = await rel(1, 10);
    const v2 = await rel(2, 20);
    const tested: string[] = [];
    const h = new MlModelHandler({
      runtimes: ["onnx"],
      ramBytes: 100,
      loadTest: async ({ file }) => {
        tested.push(
          new TextDecoder().decode(await file.source.read(0, file.size)),
        );
        return true;
      },
    });
    const { e } = await installEach([v1, v2], [h]);
    expect(tested).toEqual(["ONNX 1", "ONNX 2"]);
    expect(h.model("djdl.model")?.descriptor.memBytes).toBe(20);
    expect(await e.rollback("djdl.model")).toBe(true);
    expect(h.model("djdl.model")?.descriptor.memBytes).toBe(10);
  });

  it("refuses a model above the memory budget before the load test runs", async () => {
    const big = await rel(1, 101);
    let tested = false;
    const h = new MlModelHandler({
      runtimes: ["onnx"],
      ramBytes: 100,
      loadTest: () => (tested = true),
    });
    const e = engine({
      server: byteServer(big),
      stamp: stampFor(big),
      handlers: [h],
    });
    await e.load();
    await expect(e.ensure(["djdl.model"])).rejects.toMatchObject({
      code: "pack-type-check-failed",
      detail: "memory",
      path: "model.json",
    });
    expect(tested).toBe(false);
    expect(h.model("djdl.model")).toBeNull();
  });
});

describe("custom.<name> through the engine", () => {
  it("a game-registered custom.dialogue handler installs end to end", async () => {
    const v1 = await treePack({
      packId: "djdl.dialogue",
      version: "1.0.0",
      seq: 1,
      files: { "intro.txt": "Hello, traveller.", "lines/a.txt": "Bye." },
      type: "custom.dialogue",
    });
    const checked: string[][] = [];
    const live: Record<string, string> = {};
    const dialogue: PackHandler = {
      type: "custom.dialogue",
      layout: "tree",
      activation: "hot",
      supports: (fv) => fv === 1,
      check: (s) => {
        checked.push(s.files.map((f) => f.path));
        return null;
      },
      activate: async (i, payload) => {
        for (const f of (await payload.read())?.files ?? [])
          live[f.path] = new TextDecoder().decode(
            await f.source.read(0, f.size),
          );
      },
    };
    const e = engine({ server: byteServer(v1), stamp: stampFor(v1) });
    e.registerHandler(dialogue);
    await e.load();
    await e.ensure(["djdl.dialogue"]);
    expect(checked).toEqual([["intro.txt", "lines/a.txt"]]);
    expect(live).toEqual({
      "intro.txt": "Hello, traveller.",
      "lines/a.txt": "Bye.",
    });
    expect(e.state().running["djdl.dialogue"]?.type).toBe("custom.dialogue");
  });

  it("a custom payload passes the same path rules as files.tree", async () => {
    const bad = await treePack({
      packId: "djdl.dialogue",
      version: "1.0.0",
      seq: 1,
      files: { "a/../b.txt": "x" },
      type: "custom.dialogue",
    });
    let checked = false;
    const e = engine({ server: byteServer(bad), stamp: stampFor(bad) });
    e.registerHandler({
      type: "custom.dialogue",
      layout: "tree",
      activation: "hot",
      supports: () => true,
      check: () => ((checked = true), null),
    });
    await e.load();
    await expect(e.ensure(["djdl.dialogue"])).rejects.toMatchObject({
      code: "files-unsafe-path",
    });
    expect(checked).toBe(false);
  });

  it("a game check's refusal and a throwing check both abandon the install", async () => {
    const v1 = await treePack({
      packId: "djdl.dialogue",
      version: "1.0.0",
      seq: 1,
      files: { "intro.txt": "x" },
      type: "custom.dialogue",
    });
    for (const [check, detail] of [
      [() => ({ detail: "voice-missing", path: "intro.txt" }), "voice-missing"],
      [() => ({ detail: "Not A Token" }), "check"],
      [
        () => {
          throw new Error("bug");
        },
        "check",
      ],
    ] as const) {
      const e = engine({ server: byteServer(v1), stamp: stampFor(v1) });
      e.registerHandler({
        type: "custom.dialogue",
        layout: "tree",
        activation: "hot",
        supports: () => true,
        check,
      });
      await e.load();
      await expect(e.ensure(["djdl.dialogue"])).rejects.toMatchObject({
        code: "pack-type-check-failed",
        detail,
      });
      expect(e.state().running["djdl.dialogue"]).toBeUndefined();
    }
  });
});
