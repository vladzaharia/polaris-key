import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildKit,
  claudeCommand,
  PINNED_CLAUDE_CODE,
  PINNED_CLAUDE_COMMAND,
} from "./agent-kit-release.js";
import { ZipReader } from "../packages/cli/src/zip.js";

const kit = join(__dirname, "fixtures", "agent-kit");
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ak-release-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("agent-kit release builder", () => {
  it("is byte-reproducible and the marketplace sha256 matches the zip", () => {
    const a = buildKit({ kit, version: "1.2.3", out: tmp() });
    const b = buildKit({ kit, version: "1.2.3", out: tmp() });
    const bytes = readFileSync(a.zipPath);
    expect(bytes.equals(readFileSync(b.zipPath))).toBe(true);
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(a.zipSha256).toBe(sha);
    const m = JSON.parse(readFileSync(a.marketplacePath, "utf8"));
    expect(m.name).toBe("polaris-key");
    expect(m.plugins[0].source).toEqual({
      source: "archive",
      url: "https://key.plrs.im/docs/agents/polaris-key-1.2.3.zip",
      sha256: sha,
    });
  });

  it("packs exactly the plugin files, sorted, with the version stamped", async () => {
    const r = buildKit({ kit, version: "1.2.3", out: tmp() });
    const z = await ZipReader.open(r.zipPath);
    const names = z.entries.map((e) => e.name);
    const plugin = JSON.parse((await z.read(z.entries[0]!)).toString("utf8"));
    await z.close();
    expect(names).toEqual([
      ".claude-plugin/plugin.json",
      "LICENSE",
      "README.md",
      "skills/demo-skill/SKILL.md",
    ]);
    expect(plugin.version).toBe("1.2.3");
    expect(
      JSON.parse(readFileSync(join(kit, ".claude-plugin/plugin.json"), "utf8"))
        .version,
    ).toBeUndefined();
  });

  it("ships README.dist.md as the zip's README.md", async () => {
    const r = buildKit({ kit, version: "1.2.3", out: tmp() });
    const z = await ZipReader.open(r.zipPath);
    const entry = z.entries.find((e) => e.name === "README.md")!;
    const readme = (await z.read(entry)).toString("utf8");
    await z.close();
    expect(readme).toBe(readFileSync(join(kit, "README.dist.md"), "utf8"));
  });

  it("the real kit's shipped README is the integrator one, long enough for the validator", async () => {
    const real = join(__dirname, "..", "packages", "agent-kit");
    const r = buildKit({ kit: real, version: "1.2.3", out: tmp() });
    const z = await ZipReader.open(r.zipPath);
    const entry = z.entries.find((e) => e.name === "README.md")!;
    const readme = (await z.read(entry)).toString("utf8");
    await z.close();
    expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(
      40,
    );
    expect(readme).toContain("/plugin marketplace add <source>");
    expect(readme).toContain("/plugin install polaris-key@polaris-key");
    expect(readme).not.toContain("AGENTS.md");
  });

  it("honours --base-url", () => {
    const r = buildKit({
      kit,
      version: "1.0.0",
      out: tmp(),
      baseUrl: "https://example.test/x/",
    });
    const m = JSON.parse(readFileSync(r.marketplacePath, "utf8"));
    expect(m.plugins[0].source.url).toBe(
      "https://example.test/x/polaris-key-1.0.0.zip",
    );
  });

  it("--local writes a directory marketplace with a relative source", () => {
    const out = tmp();
    const r = buildKit({ kit, version: "1.2.3", out, local: true });
    const m = JSON.parse(
      readFileSync(
        join(r.localMarketplaceDir!, ".claude-plugin", "marketplace.json"),
        "utf8",
      ),
    );
    expect(m.plugins[0].source).toBe("./polaris-key");
    expect(
      existsSync(join(out, "local/polaris-key/skills/demo-skill/SKILL.md")),
    ).toBe(true);
    expect(existsSync(join(out, "local/polaris-key/package.json"))).toBe(false);
    expect(existsSync(join(out, "local/polaris-key/scripts"))).toBe(false);
  });

  it("refuses a bad version", () => {
    expect(() => buildKit({ kit, version: "v1", out: tmp() })).toThrow(
      /semver/,
    );
  });
});

describe("claudeCommand", () => {
  it("prefers PKEY_CLAUDE_BIN, then PATH, then the pinned npx only in CI", () => {
    expect(
      claudeCommand({ PKEY_CLAUDE_BIN: "npx -y x@1" }, () => true),
    ).toEqual(["npx", "-y", "x@1"]);
    expect(claudeCommand({}, () => true)).toEqual(["claude"]);
    expect(claudeCommand({}, () => false)).toBeNull();
    expect(claudeCommand({ CI: "true" }, () => false)?.join(" ")).toContain(
      `@anthropic-ai/claude-code@${PINNED_CLAUDE_CODE}`,
    );
  });
});

describe("the workflows' Claude Code command", () => {
  it("is PINNED_CLAUDE_COMMAND exactly (npx runs the package's one bin; a trailing word becomes its first argument)", () => {
    for (const file of ["ci.yml", "deploy.yml"]) {
      const text = readFileSync(
        join(import.meta.dirname, "..", ".github", "workflows", file),
        "utf8",
      );
      const values = [...text.matchAll(/PKEY_CLAUDE_BIN:\s*(.+)$/gm)].map((m) =>
        m[1]!.trim(),
      );
      expect(values.length, file).toBeGreaterThan(0);
      for (const v of values) expect(v, file).toBe(PINNED_CLAUDE_COMMAND);
    }
  });
});
