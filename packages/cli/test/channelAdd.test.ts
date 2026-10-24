import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initManifest, runPkey } from "../src/index.js";

const dirs: string[] = [];

async function product(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pkey-channel-"));
  dirs.push(cwd);
  await initManifest({ cwd, slug: "acme", name: "Acme", modules: ["license"] });
  return cwd;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function pkey(cwd: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await runPkey(["channel", ...argv], {
    cwd,
    env: { NO_COLOR: "1" },
    stdout: { write: (c: string) => ((out += c), true) },
    stderr: { write: (c: string) => ((err += c), true) },
  });
  return { code, out, err };
}

const files = async (cwd: string) =>
  (await readdir(path.join(cwd, ".pkey"))).sort();

describe("pkey channel add", () => {
  it("creates distribution.yaml with a commented outlet", async () => {
    const cwd = await product();
    const r = await pkey(cwd, "add", "itch", "--field", "target=me/game");
    expect(r).toMatchObject({ code: 0, err: "" });
    const text = await readFile(
      path.join(cwd, ".pkey/distribution.yaml"),
      "utf8",
    );
    expect(text).toContain("# butler target, user/game.");
    expect(text).toContain("target: me/game");
    expect(r.out).toContain("Created outlet itch in .pkey/distribution.yaml");
    expect(r.out).toContain(text);
    expect(r.out.trimEnd().endsWith("Next: pkey validate")).toBe(true);
  });

  it("appends to an existing file and keeps its comments", async () => {
    const cwd = await product();
    const file = path.join(cwd, ".pkey/distribution.yaml");
    await writeFile(
      file,
      "# Where we ship.\napiVersion: pkey.dev/v1\noutlets:\n  # Our site.\n  site:\n    kind: web\n",
    );
    const r = await pkey(
      cwd,
      "add",
      "itch",
      "--field",
      "target=me/game",
      "--field",
      "gameId=42",
    );
    expect(r.code).toBe(0);
    const text = await readFile(file, "utf8");
    expect(text).toContain("# Where we ship.");
    expect(text).toContain("# Our site.\n  site:");
    expect(text).toContain("# itch.io game id (digits).");
    expect(text.indexOf("site:")).toBeLessThan(text.indexOf("itch:"));
    expect(r.out).toContain("Added outlet itch");
  });

  it("rewrites a JSON file with two-space indent", async () => {
    const cwd = await product();
    const file = path.join(cwd, ".pkey/distribution.json");
    await writeFile(file, '{"apiVersion":"pkey.dev/v1"}');
    const r = await pkey(
      cwd,
      "add",
      "itch",
      "--field",
      "target=me/game",
      "--outlet-id",
      "itch-main",
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      apiVersion: "pkey.dev/v1",
      outlets: { "itch-main": { kind: "itch", target: "me/game" } },
    });
    expect((await readFile(file, "utf8")).endsWith("}\n")).toBe(true);
    expect(await files(cwd)).not.toContain("distribution.yaml");
  });

  it("refuses a duplicate id and writes nothing", async () => {
    const cwd = await product();
    await pkey(cwd, "add", "itch", "--field", "target=me/game");
    const file = path.join(cwd, ".pkey/distribution.yaml");
    const before = await readFile(file, "utf8");
    const r = await pkey(cwd, "add", "itch", "--field", "target=me/other");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Nothing written\. .*already declares outlet itch/);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("refuses an invalid identity and creates no file", async () => {
    const cwd = await product();
    const r = await pkey(cwd, "add", "itch", "--field", "target=not a target");
    expect(r.code).toBe(1);
    expect(r.err).toContain("Nothing written.");
    expect(await files(cwd)).not.toContain("distribution.yaml");
  });

  it("answers usage errors with exit 2", async () => {
    const cwd = await product();
    expect((await pkey(cwd, "add")).code).toBe(2);
    const unknown = await pkey(cwd, "add", "nope");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown channel "nope"');
    const field = await pkey(cwd, "add", "itch", "--field", "bogus=1");
    expect(field.code).toBe(2);
    expect(field.err).toContain("unknown field bogus");
    expect((await pkey(cwd, "add", "itch", "--field", "x")).code).toBe(2);
    expect((await pkey(cwd, "add", "itch", "--nope")).code).toBe(2);
    expect((await pkey(cwd, "frob")).code).toBe(2);
    expect(await files(cwd)).not.toContain("distribution.yaml");
  });

  it("--json prints one result line, on success and on refusal", async () => {
    const cwd = await product();
    const ok = await pkey(
      cwd,
      "add",
      "itch",
      "--field",
      "target=me/game",
      "--json",
    );
    expect(JSON.parse(ok.out)).toEqual({
      v: 1,
      command: "channel add",
      event: "result",
      ok: true,
      exit: 0,
      channel: "itch",
      outlet: "itch",
      file: ".pkey/distribution.yaml",
      created: true,
    });
    const dup = await pkey(
      cwd,
      "add",
      "itch",
      "--field",
      "target=me/game",
      "--json",
    );
    expect(dup.code).toBe(1);
    expect(dup.err).toBe("");
    expect(JSON.parse(dup.out)).toMatchObject({ ok: false, exit: 1 });
  });
});
