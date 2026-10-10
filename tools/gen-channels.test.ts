import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OUTLET_KINDS,
  OUTLET_PLATFORMS,
} from "../packages/shared-protocol/src/distribution.js";
import { DEFAULT_OUTLET_TRACKS } from "../packages/shared-manifest/src/distribution.js";
import { OUTLET_SUBKINDS } from "../packages/shared-protocol/src/distribution.js";
import {
  VERBS,
  loadTable,
  renderAll,
  renderManifestTs,
  run,
  validateTable,
  type ChannelRow,
  type ChannelTable,
} from "./gen-channels.js";

// The Worker is read through a variable specifier so tools' typecheck does not compile the Worker
// tree (it needs the Worker's own type environment); the shapes below are what this test reads.
interface AdapterShape {
  id: string;
  label: string;
  outletKinds: readonly string[];
  credential: string | null;
  gate: unknown;
  ci: unknown;
  pr: unknown;
}
const WORKER = fileURLToPath(
  new URL("../packages/worker/src/core/", import.meta.url),
);
const adapterModule = (await import(
  /* @vite-ignore */ WORKER + "storefront/adapter.ts"
)) as {
  STOREFRONT_ADAPTERS: readonly AdapterShape[];
  STOREFRONT_OPS: readonly string[];
};
const { STOREFRONT_ADAPTERS, STOREFRONT_OPS } = adapterModule;
const { PLATFORM_CREDENTIALS } = (await import(
  /* @vite-ignore */ WORKER + "platformCredentials.ts"
)) as { PLATFORM_CREDENTIALS: Record<string, unknown> };

const TABLE = loadTable();
const row = (id: string): ChannelRow =>
  TABLE.channels.find((c) => c.id === id) as ChannelRow;

function withRow(extra: Partial<ChannelRow> = {}): ChannelTable {
  return {
    channels: [
      ...TABLE.channels,
      {
        ...row("itch"),
        id: "newstore",
        aliases: [],
        outlet: { kind: "itch" },
        storefront: null,
        ...extra,
      },
    ],
  };
}

describe("tools/channels.json", () => {
  it("is valid", () => {
    expect(validateTable(TABLE)).toEqual([]);
  });

  it("reconciles the two spellings: the adapter id is the id, the wire kind an alias", () => {
    expect(row("google-play").aliases).toContain("play");
    expect(row("google-play").outlet.kind).toBe("play");
    expect(row("microsoft-store").aliases).toContain("ms-store");
    expect(row("microsoft-store").outlet.kind).toBe("ms-store");
    expect(TABLE.channels.map((c) => c.id)).not.toContain("play");
    expect(TABLE.channels.map((c) => c.id)).not.toContain("ms-store");
  });
});

describe("conformance with the wire (no new outlet kinds)", () => {
  it("every outlet kind is served by exactly one channel, and every channel's kind is real", () => {
    const plain = TABLE.channels.filter((c) => !c.outlet.subkind);
    expect(plain.map((c) => c.outlet.kind).sort()).toEqual(
      [...OUTLET_KINDS].sort(),
    );
    for (const c of TABLE.channels)
      expect(OUTLET_KINDS as readonly string[]).toContain(c.outlet.kind);
  });

  it("subkinds are real direct subkinds", () => {
    for (const c of TABLE.channels.filter((c) => c.outlet.subkind)) {
      expect(c.outlet.kind).toBe("direct");
      expect(OUTLET_SUBKINDS as readonly string[]).toContain(c.outlet.subkind);
    }
  });

  it("platforms are a subset of OUTLET_PLATFORMS for the channel's kind", () => {
    for (const c of TABLE.channels)
      for (const p of c.platforms)
        expect(
          OUTLET_PLATFORMS[c.outlet.kind as keyof typeof OUTLET_PLATFORMS],
          `${c.id} ${p}`,
        ).toContain(p);
  });

  it("the verb vocabulary is the storefront operations", () => {
    expect([...VERBS]).toEqual([...STOREFRONT_OPS]);
  });

  it("every kind with default tracks has a channel that names that kind", () => {
    for (const kind of Object.keys(DEFAULT_OUTLET_TRACKS))
      expect(TABLE.channels.some((c) => c.outlet.kind === kind)).toBe(true);
  });
});

describe("two-way adapter binding", () => {
  const adapterIds = STOREFRONT_ADAPTERS.map((a) => a.id);

  it("every storefront adapter is bound by at least one channel", () => {
    const bound = new Set(
      TABLE.channels.flatMap((c) =>
        c.storefront ? [c.storefront.adapter] : [],
      ),
    );
    for (const id of adapterIds) expect(bound, id).toContain(id);
  });

  it("every channel's storefront names a real adapter, serving the channel's kind and credential", () => {
    for (const c of TABLE.channels) {
      if (!c.storefront) continue;
      const adapter = STOREFRONT_ADAPTERS.find(
        (a) => a.id === c.storefront?.adapter,
      );
      expect(adapter, `${c.id} -> ${c.storefront.adapter}`).toBeDefined();
      expect(adapter?.outletKinds as readonly string[]).toContain(
        c.outlet.kind,
      );
      if (adapter?.id === c.id) {
        expect(adapter.label.length).toBeGreaterThan(0);
        expect(adapter.credential).toBe(c.storefront.credential);
      }
    }
  });

  it("every adapter id is also a channel id that binds back to it", () => {
    for (const a of STOREFRONT_ADAPTERS) {
      const c = row(a.id);
      expect(c, a.id).toBeDefined();
      expect(c.storefront?.adapter).toBe(a.id);
    }
  });

  it("credential slots are real team credentials", () => {
    for (const c of TABLE.channels) {
      for (const slot of [c.storefront?.credential, c.storefront?.verification])
        if (slot) expect(Object.keys(PLATFORM_CREDENTIALS)).toContain(slot);
    }
  });

  it("the plane agrees with the adapter's declared planes", () => {
    for (const a of STOREFRONT_ADAPTERS) {
      const c = row(a.id);
      const planes = [
        a.gate ? "worker" : null,
        a.ci ? "ci" : null,
        a.pr ? "pr" : null,
      ].filter(Boolean);
      if (planes.length > 0) expect(planes, a.id).toContain(c.plane);
    }
  });

  it("negative control: dropping a channel leaves its adapter unbound", () => {
    const rest = TABLE.channels.filter((c) => c.id !== "steam");
    const bound = new Set(
      rest.flatMap((c) => (c.storefront ? [c.storefront.adapter] : [])),
    );
    expect(adapterIds.filter((id) => !bound.has(id))).toEqual(["steam"]);
  });

  it("negative control: a channel naming an adapter that does not exist is not bound", () => {
    const table = withRow({
      storefront: { adapter: "ghost", credential: null },
    });
    const bad = table.channels.filter(
      (c) =>
        c.storefront && !adapterIds.includes(c.storefront.adapter as never),
    );
    expect(bad.map((c) => c.id)).toEqual(["newstore"]);
  });
});

describe("one label table", () => {
  it("renders every channel label and resolves aliases", async () => {
    const out = renderManifestTs(TABLE);
    for (const c of TABLE.channels)
      expect(out).toContain(JSON.stringify(c.label));
    expect(out).toContain('"play": "google-play"');
    expect(out).toContain('"ms-store": "microsoft-store"');
  });
});

describe("validateTable", () => {
  it("accepts an extra row", () => {
    expect(validateTable(withRow())).toEqual([]);
  });

  it.each([
    [{ id: "itch" }, "already"],
    [{ id: "Bad_Id" }, ".id: must match"],
    [{ aliases: ["play"] }, '"play" is already'],
    [{ aliases: ["Bad Alias"] }, "is not an id"],
    [{ label: "" }, ".label: must be a non-empty string"],
    [{ family: "nope" as never }, ".family: must be one of"],
    [{ plane: "nope" as never }, ".plane: must be one of"],
    [{ customerAction: "nope" as never }, ".customerAction"],
    [{ platforms: [] }, "platforms: must not be empty"],
    [{ platforms: ["beos"] }, '"beos" is not allowed'],
    [{ verbs: ["teleport"] }, '"teleport" is not allowed'],
    [{ deliverableKinds: ["app", "app"] }, "has a duplicate"],
    [{ formats: ["Bad Format"] }, '"Bad Format" is not allowed'],
    [
      { plane: "feed", storefront: { adapter: "x", credential: null } },
      "feed channel has no storefront",
    ],
    [{ storefront: { adapter: 3 as never, credential: null } }, "storefront"],
  ] as [Partial<ChannelRow>, string][])("rejects %j", (extra, message) => {
    expect(validateTable(withRow(extra)).join("\n")).toContain(message);
  });

  it("rejects a table that is not a table", () => {
    expect(validateTable(null)).not.toEqual([]);
    expect(validateTable({ channels: [] })).toEqual([
      "the table has no channels",
    ]);
  });
});

describe("reference page", () => {
  it("lists every channel and carries the generated banner", async () => {
    const doc = (await renderAll(TABLE)).get(
      "packages/docs/src/content/docs/reference/channels.mdx",
    ) as string;
    expect(doc).toContain("GENERATED PAGE — do not edit");
    for (const c of TABLE.channels) expect(doc).toContain("`" + c.id + "`");
  });
});

describe("gen channels --check", () => {
  it("the committed file is up to date", async () => {
    expect(await run({ check: true })).toEqual([]);
  });

  it("reports a hand edit and does not write under --check; write repairs it", async () => {
    const root = mkdtempSync(join(tmpdir(), "gen-channels-"));
    const rendered = await renderAll(TABLE);
    for (const [path, content] of rendered) {
      const abs = join(root, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content + "// hand edit\n");
    }
    const [path] = [...rendered.keys()];
    expect(await run({ check: true, root })).toEqual([...rendered.keys()]);
    expect(readFileSync(join(root, path as string), "utf8")).toContain(
      "hand edit",
    );
    expect(await run({ check: false, root })).toEqual([...rendered.keys()]);
    expect(await run({ check: true, root })).toEqual([]);
  });
});
