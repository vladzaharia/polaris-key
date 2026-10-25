import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  checkKit,
  checkRepo,
  checkSkillDir,
  discoverSkills,
  loadDocsFacts,
  type Problem,
} from "./skills-check.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/skills",
);
const fixture = (name: string) => join(FIXTURES, name);

let docs: Awaited<ReturnType<typeof loadDocsFacts>>;
beforeAll(async () => {
  docs = await loadDocsFacts();
});

const rulesOf = (problems: Problem[]) => [
  ...new Set(problems.map((p) => p.rule)),
];

/** A scratch skill with the given SKILL.md body (frontmatter added unless given). */
function scratch(skill: string, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-check-"));
  writeFileSync(join(dir, "SKILL.md"), skill);
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const FM =
  "---\nname: scratch\ndescription: A scratch skill. Use when testing.\n---\n\n";

describe("skills:check", () => {
  it("passes the good fixture", () => {
    expect(checkSkillDir(fixture("good"), docs)).toEqual([]);
  });

  it("rule 1 refuses a bad name", () => {
    expect(rulesOf(checkSkillDir(fixture("r1-name"), docs))).toEqual([1]);
  });

  it("rule 1 refuses a missing, long or unprompted description", () => {
    const bad = [
      "---\nname: a\n---\n",
      `---\nname: a\ndescription: Use when ${"x".repeat(1100)}\n---\n`,
      "---\nname: a\ndescription: Does a thing.\n---\n",
      `---\nname: a\ndescription: Use when ${"x".repeat(900)}\nwhen_to_use: ${"y".repeat(700)}\n---\n`,
    ];
    for (const text of bad)
      expect(
        rulesOf(checkSkillDir(scratch(text), docs)),
        text.slice(0, 40),
      ).toEqual([1]);
  });

  it("rule 2 refuses a SKILL.md of 500 lines", () => {
    const ok = scratch(FM + "line\n".repeat(400));
    const long = scratch(FM + "line\n".repeat(500));
    expect(checkSkillDir(ok, docs)).toEqual([]);
    expect(rulesOf(checkSkillDir(long, docs))).toEqual([2]);
  });

  it("rule 3 refuses a nested references directory", () => {
    expect(rulesOf(checkSkillDir(fixture("r3-deep"), docs))).toEqual([3]);
  });

  it("rule 3 refuses a long reference with no contents list", () => {
    const body = "# Ref\n\n" + "text\n".repeat(120);
    const bad = scratch(FM, { "references/long.md": body });
    const ok = scratch(FM, {
      "references/long.md":
        "# Ref\n\nContents: a, b\n\n" + "text\n".repeat(120),
    });
    expect(rulesOf(checkSkillDir(bad, docs))).toEqual([3]);
    expect(checkSkillDir(ok, docs)).toEqual([]);
  });

  it("rule 4 refuses a repo path and a pnpm script that do not exist", () => {
    const problems = checkSkillDir(fixture("r4-names"), docs);
    expect(rulesOf(problems)).toEqual([4]);
    expect(problems.map((p) => p.message).join("\n")).toMatch(
      /nowhere.*\n.*no-such-script/,
    );
  });

  it("rule 5 refuses a programme id", () => {
    const problems = checkSkillDir(fixture("r5-programme-id"), docs);
    expect(rulesOf(problems)).toEqual([5]);
    expect(problems[0]?.message).toContain("P0-12");
  });

  it("rule 5 refuses an unknown pkey command and an unknown HTTP path", () => {
    const cmd = scratch(FM + "Run `pkey nonesuch --flag`.\n");
    const http = scratch(FM + "Call `GET /nonesuch/route`.\n");
    expect(rulesOf(checkSkillDir(cmd, docs))).toEqual([5]);
    expect(rulesOf(checkSkillDir(http, docs))).toEqual([5]);
  });

  it("rule 6 refuses a link to an admin page, a missing page and a stub", () => {
    expect(rulesOf(checkSkillDir(fixture("r6-gated-link"), docs))).toEqual([6]);
    const missing = scratch(
      FM + "See https://key.plrs.im/docs/start/no-such-page/.\n",
    );
    expect(rulesOf(checkSkillDir(missing, docs))).toEqual([6]);
  });

  it("rule 6 refuses a sentence copied from a gated page", () => {
    const sentence = [...docs.gated][0] as string;
    const copied = scratch(`${FM}${sentence}\n`);
    expect(rulesOf(checkSkillDir(copied, docs))).toEqual([6]);
  });

  it("rule 7 refuses a secret command outside a handoff fence", () => {
    expect(rulesOf(checkSkillDir(fixture("r7-secret"), docs))).toEqual([7]);
    const keys = scratch(`${FM}Run pkey release keys generate.\n`);
    const pem = scratch(
      `${FM}${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\n`,
    );
    expect(rulesOf(checkSkillDir(keys, docs))).toEqual([7]);
    expect(rulesOf(checkSkillDir(pem, docs))).toEqual([7]);
  });

  it("rule 8 refuses a plugin version, an .mcp.json and extraKnownMarketplaces", () => {
    const kit = fixture("r8-kit");
    const problems = checkKit({
      kitRoot: kit,
      settings: join(kit, "settings.json"),
    });
    expect(problems.map((p) => p.message).sort()).toEqual([
      ".mcp.json in the kit",
      "extraKnownMarketplaces in settings",
      "plugin.json carries a version (the release stamps it)",
    ]);
  });

  it("discovers a linked skill once", () => {
    expect(discoverSkills([fixture("good"), fixture("good")])).toHaveLength(1);
  });

  it("passes today's skills", async () => {
    expect(await checkRepo()).toEqual([]);
  });
});
