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
    expect(r.out).toContain("Created .pkey/distribution.yaml with itch.");
    expect(r.out).toContain(text.trimEnd());
    expect(r.out).toContain(
      "Fields not set: gameId (itch.io game id). Set one with --field name=value.",
    );
    expect(r.out.trimEnd().endsWith("Next: pkey channel sync --dry-run")).toBe(
      true,
    );
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
    expect(r.out).toContain("Added itch to .pkey/distribution.yaml.");
    // only the new entry is shown, not the file
    expect(r.out).toContain("itch:");
    expect(r.out).not.toContain("# Our site.");
    expect(r.out).not.toContain("Fields not set");
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
    expect(r.err).toBe(
      ".pkey/distribution.yaml already declares itch. Name this one with --outlet-id, like --outlet-id itch-beta.\n",
    );
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("refuses an invalid identity and creates no file", async () => {
    const cwd = await product();
    const r = await pkey(cwd, "add", "itch", "--field", "target=not a target");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /^Nothing written\. --field target must be a butler user\/game target\.\n$/,
    );
    expect(await files(cwd)).not.toContain("distribution.yaml");
  });

  it("answers usage errors with exit 2", async () => {
    const cwd = await product();
    expect((await pkey(cwd, "add")).code).toBe(2);
    const unknown = await pkey(cwd, "add", "nope");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toBe(
      'Unknown channel "nope". Run pkey help channel for the list.\n',
    );
    expect((await pkey(cwd, "add", "itchio")).err).toBe(
      'Unknown channel "itchio". Did you mean itch?\n',
    );
    const field = await pkey(cwd, "add", "itch", "--field", "bogus=1");
    expect(field.code).toBe(2);
    expect(field.err).toBe(
      "Unknown field bogus for itch. Its fields: target, gameId.\n",
    );
    expect((await pkey(cwd, "add", "itch", "--field", "x")).code).toBe(2);
    const flag = await pkey(cwd, "add", "itch", "--feild", "x");
    expect(flag.code).toBe(2);
    expect(flag.err).toBe("✗  Unknown option --feild. Did you mean --field?\n");
    // extra words name only add's usage
    const extra = await pkey(cwd, "add", "itch", "extra");
    expect(extra.code).toBe(2);
    expect(extra.err).not.toContain("channel sync");
    expect(extra.err).toContain("pkey channel add <id>");
    const badId = await pkey(cwd, "add", "itch", "--outlet-id", "Itch Beta");
    expect(badId.code).toBe(2);
    expect(badId.err).toBe(
      '--outlet-id "Itch Beta": use lowercase letters, digits and hyphens, starting with a letter, like itch-beta.\n',
    );
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

  it("--json: one envelope line, refusals carry validate's error objects", async () => {
    const cwd = await product();
    const bad = await pkey(
      cwd,
      "add",
      "itch",
      "--field",
      "target=not a target",
      "--json",
    );
    expect(bad.code).toBe(1);
    expect(bad.out.trimEnd().split("\n")).toHaveLength(1);
    const j = JSON.parse(bad.out);
    expect(j).toMatchObject({ ok: false, exit: 1, channel: "itch" });
    expect(j.errors[0]).toEqual({
      code: expect.any(String),
      message: expect.any(String),
      at: expect.stringContaining("distribution"),
      file: ".pkey/distribution.yaml",
    });
    // a usage error stays plain stderr
    const usage = await pkey(cwd, "add", "nope", "--json");
    expect(usage.code).toBe(2);
    expect(usage.out).toBe("");
  });

  it("with no manifest, --json prints validate's no-manifest shape", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pkey-channel-"));
    dirs.push(cwd);
    const r = await pkey(cwd, "add", "itch", "--json");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      exit: 1,
      error: "no-manifest",
      message: expect.stringContaining("No .pkey/product manifest"),
    });
  });

  it("direct channels read only their own fields and need their marker", async () => {
    const cwd = await product();
    const wrong = await pkey(
      cwd,
      "add",
      "homebrew",
      "--field",
      "scoopBucket=a/b",
    );
    expect(wrong.code).toBe(2);
    expect(wrong.err).toBe(
      "Unknown field scoopBucket for homebrew. Its fields: homebrewTap, homebrewCask, homebrewFormula.\n",
    );
    const bare = await pkey(cwd, "add", "homebrew");
    expect(bare.code).toBe(1);
    expect(bare.err).toBe(
      "Nothing written. homebrew needs --field homebrewTap=owner/homebrew-name and --field homebrewCask=token (or homebrewFormula=name).\n",
    );
    expect(await files(cwd)).not.toContain("distribution.yaml");
  });

  it("a .pkey/ that is already invalid is named, not blamed on the new entry", async () => {
    const cwd = await product();
    await writeFile(
      path.join(cwd, ".pkey/distribution.yaml"),
      "outlets:\n  site:\n    kind: nope\n",
    );
    const r = await pkey(cwd, "add", "itch", "--field", "target=me/game");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /^Nothing written: \.pkey\/ already has 1 error\. Fix it first \(pkey validate\):\n✗  error distribution\/outlets\/site/,
    );
  });

  it("repo text is printed cleaned", async () => {
    const cwd = await product();
    const r = await pkey(
      cwd,
      "add",
      "itch",
      "--field",
      "target=me/game",
      "--field",
      "gameId=1",
    );
    expect(r.out).not.toMatch(/\u001b/);
  });

  it("help lists the channels and words --channel as the release track", async () => {
    const cwd = await product();
    let out = "";
    await runPkey(["help", "channel"], {
      cwd,
      env: { NO_COLOR: "1" },
      stdout: { write: (c: string) => ((out += c), true) },
      stderr: { write: () => true },
    });
    const text = out.replace(/\s+/g, " ");
    expect(text).toMatch(/Channels: .*\bitch\b.*\bsnap\b/);
    expect(text).toContain("--channel is the release track (default stable)");
    expect(text).toContain("--product slug");
  });
});
