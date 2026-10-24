import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NODE_OUT,
  GODOT_OUT,
  KOTLIN_OUT,
  PYTHON_OUT,
  REACT_OUT,
  SWIFT_OUT,
  loadApi,
  renderAll,
  run,
  type Api,
} from "./gen-api-surface.js";

describe("gen-api-surface", () => {
  it("the committed surface tests are current", async () => {
    expect(await run({ check: true })).toEqual([]);
  });

  it("a stale or missing file fails --check and writes nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "api-surface-"));
    const api = loadApi();
    expect((await run({ check: true, root, api })).sort()).toEqual(
      [
        NODE_OUT,
        PYTHON_OUT,
        REACT_OUT,
        SWIFT_OUT,
        KOTLIN_OUT,
        GODOT_OUT,
      ].sort(),
    );
    expect(await run({ check: false, root, api })).toHaveLength(6);
    expect(await run({ check: true, root, api })).toEqual([]);
    const abs = join(root, NODE_OUT);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "// edited\n");
    expect(await run({ check: true, root, api })).toEqual([NODE_OUT]);
  });

  it("skips a symbol absent today and a reserved concept; asserts the current spelling", async () => {
    const files = await renderAll(loadApi());
    const node = files.get(NODE_OUT)!;
    expect(node).toContain('"clearAll" in ConfigClient.prototype');
    expect(node).toContain("visibility");
    expect(node).not.toContain("fromConfig");
    expect(node).toContain('"get" in ConfigClient.prototype');
    expect(files.get(PYTHON_OUT)).toContain('"get_config"');
  });

  it("a removed row becomes an absence assertion", async () => {
    const api: Api = {
      ...loadApi(),
      removed: [
        { sdk: "node", from: "config.getConfig" },
        { sdk: "python", from: "config.get_config" },
      ],
    };
    const files = await renderAll(api);
    expect(files.get(NODE_OUT)).toContain(
      '"getConfig" in ConfigClient.prototype).toBe(false)',
    );
    expect(files.get(PYTHON_OUT)).toContain("test_removed");
  });

  it("Swift, Kotlin and Godot assert today's spellings", async () => {
    const files = await renderAll(loadApi());
    expect(files.get(SWIFT_OUT)).toContain("ConfigClient.config(_:default:)");
    expect(files.get(KOTLIN_OUT)).toContain("ConfigClient::configSource");
    expect(files.get(GODOT_OUT)).toContain('"get_value"');
  });
});
