import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { missingPaths, missingPnpmScripts } from "./repo-names.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");

interface Destination {
  readonly file: string;
  readonly section?: string;
}

interface MoveRow {
  readonly rule: string;
  readonly marker: string;
  readonly destinations: readonly Destination[];
  readonly staysInClaude?: boolean;
}

const MOVE_ROWS: readonly MoveRow[] = [
  {
    rule: "AGENTS.md import",
    marker: "@AGENTS.md",
    destinations: [{ file: "CLAUDE.md" }],
    staysInClaude: true,
  },
  {
    rule: "pinned Node commands",
    marker: "Prefix every JS/TS command",
    destinations: [{ file: "AGENTS.md", section: "Commands" }],
  },
  {
    rule: "background jobs over sleep loops",
    marker: 'Never sleep "just in case"',
    destinations: [{ file: "AGENTS.md", section: "Working" }],
  },
  {
    rule: "scoped tests while building",
    marker: "run scoped tests while building",
    destinations: [{ file: "AGENTS.md", section: "Testing" }],
  },
  {
    rule: "gate once at hand-off",
    marker: "run the gate once at hand-off",
    destinations: [{ file: "AGENTS.md", section: "Testing" }],
  },
  {
    rule: "rerun only the failed step",
    marker: "rerun only that step",
    destinations: [{ file: "AGENTS.md", section: "Testing" }],
  },
  {
    rule: "timing flakes",
    marker: "record the timing flake",
    destinations: [{ file: "AGENTS.md", section: "Testing" }],
  },
  {
    rule: "test timeout discipline",
    marker: "Never raise timeouts",
    destinations: [{ file: "AGENTS.md", section: "Testing" }],
  },
  {
    rule: "reviewers skip the gate",
    marker: "Reviewers never run the gate",
    destinations: [
      { file: "AGENTS.md", section: "Review" },
      { file: ".claude/agents/pkey-wp-reviewer.md" },
    ],
  },
  {
    rule: "review conflicts",
    marker: "conflicts with current `main`",
    destinations: [
      { file: "AGENTS.md", section: "Review" },
      { file: ".claude/agents/pkey-wp-reviewer.md" },
    ],
  },
  {
    rule: "one review fix round",
    marker: "at most one fix round",
    destinations: [
      { file: "AGENTS.md", section: "Review" },
      { file: ".claude/agents/pkey-wp-reviewer.md" },
    ],
  },
  {
    rule: "merge main once",
    marker: "at most once, right before hand-off",
    destinations: [
      { file: "AGENTS.md", section: "Hand-off" },
      { file: ".claude/agents/pkey-implementer.md" },
      { file: ".claude/agents/pkey-sdk-porter.md" },
      { file: ".claude/agents/pkey-godot-engineer.md" },
    ],
  },
  {
    rule: "migration placeholder",
    marker: "00XX_<name>.sql",
    destinations: [{ file: "AGENTS.md", section: "Hand-off" }],
  },
  {
    rule: "clean hand-off",
    marker: "Finish clean: stop every background job",
    destinations: [{ file: "AGENTS.md", section: "Hand-off" }],
  },
  {
    rule: "lead merge helper",
    marker: "$PKEY_LEAD/merge.sh",
    destinations: [
      {
        file: ".claude/skills/running-the-omniplatform-program/SKILL.md",
        section: "Integrating and closing agents",
      },
    ],
  },
  {
    rule: "one integration agent",
    marker: "one integration agent",
    destinations: [
      {
        file: ".claude/skills/running-the-omniplatform-program/SKILL.md",
        section: "Integrating and closing agents",
      },
    ],
  },
  {
    rule: "stall watcher",
    marker: "$PKEY_LEAD/stall-watch.sh",
    destinations: [
      {
        file: ".claude/skills/running-the-omniplatform-program/SKILL.md",
        section: "Integrating and closing agents",
      },
    ],
  },
  {
    rule: "lead closes agents",
    marker: "TaskStop",
    destinations: [
      {
        file: ".claude/skills/running-the-omniplatform-program/SKILL.md",
        section: "Integrating and closing agents",
      },
    ],
  },
  {
    rule: "scoped gate command",
    marker: "pnpm gate",
    destinations: [{ file: "AGENTS.md", section: "Testing" }],
  },
  {
    rule: "scoped lead gate",
    marker: "$PKEY_LEAD/gate.sh",
    destinations: [
      {
        file: ".claude/skills/running-the-omniplatform-program/SKILL.md",
        section: "Integrating and closing agents",
      },
    ],
  },
  {
    rule: "active-agent registry",
    marker: "$PKEY_LEAD/active",
    destinations: [
      {
        file: ".claude/skills/running-the-omniplatform-program/SKILL.md",
        section: "Integrating and closing agents",
      },
    ],
  },
  {
    rule: "completed-agent sweep",
    marker: "ListAgents",
    destinations: [
      {
        file: ".claude/skills/running-the-omniplatform-program/SKILL.md",
        section: "Integrating and closing agents",
      },
    ],
  },
  {
    rule: "plan mode",
    marker: "Enter plan mode before any wire-touching change",
    destinations: [{ file: "CLAUDE.md" }],
    staysInClaude: true,
  },
  {
    rule: "explicit subagent models",
    marker: "Set `model` on every subagent call",
    destinations: [{ file: "CLAUDE.md" }],
    staysInClaude: true,
  },
  {
    rule: "ordinary pull requests",
    marker: "ordinary PR with no brief",
    destinations: [{ file: ".claude/agents/pkey-wp-reviewer.md" }],
  },
  {
    rule: "mockup evidence location",
    marker: "directory next to `$PKEY_LEAD`",
    destinations: [{ file: ".claude/agents/pkey-ux-reviewer.md" }],
  },
];

const ROLE_MODELS = {
  ".claude/agents/pkey-implementer.md": "sonnet",
  ".claude/agents/pkey-sdk-porter.md": "sonnet",
  ".claude/agents/pkey-godot-engineer.md": "sonnet",
  ".claude/agents/pkey-spike-runner.md": "sonnet",
  ".claude/agents/pkey-wire-planner.md": "opus",
  ".claude/agents/pkey-wp-reviewer.md": "opus",
  ".claude/agents/pkey-ux-reviewer.md": "opus",
} as const;

const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  // The file list passed the 1 MiB default (1.05 MB at 16.5k files); lift it, not the repo.
  { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
)
  .toString()
  .split("\0")
  .filter(Boolean)
  .filter((file) => existsSync(join(ROOT, file)));

function normalizeForMarkerSearch(text: string): string {
  const collapsedWhitespace = text.replace(/\s+/g, " ");
  return collapsedWhitespace.trim();
}

function section(text: string, heading: string): string {
  const headingLine = `## ${heading}`;
  const lines = text.split(/\r?\n/);
  let found = false;
  let fenced = false;
  const body: string[] = [];

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      if (found) body.push(line);
      continue;
    }
    if (!fenced && line.startsWith("## ")) {
      if (found) break;
      if (line === headingLine) {
        found = true;
        continue;
      }
    }
    if (found) body.push(line);
  }

  if (!found) throw new Error(`Missing section ${headingLine}`);
  return body.join("\n");
}

function destinationText(destination: Destination): string {
  const text = read(destination.file);
  if (!destination.section) return text;
  return section(text, destination.section);
}

function frontmatter(file: string): Record<string, unknown> {
  const match = read(file).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match?.[1]) throw new Error(`${file} has no YAML frontmatter`);
  const parsed = parseYaml(match[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} has invalid YAML frontmatter`);
  }
  return parsed as Record<string, unknown>;
}

describe("the CLAUDE.md move table", () => {
  for (const row of MOVE_ROWS) {
    for (const destination of row.destinations) {
      const label = destination.section
        ? `${destination.file} → ${destination.section}`
        : destination.file;
      it(`${row.rule} reaches ${label}`, () => {
        expect(
          normalizeForMarkerSearch(destinationText(destination)),
          label,
        ).toContain(normalizeForMarkerSearch(row.marker));
      });
    }
    if (row.staysInClaude) {
      it(`${row.rule} stays in CLAUDE.md`, () => {
        expect(row.destinations).toEqual([{ file: "CLAUDE.md" }]);
      });
    }
  }

  it("leaves only Claude-specific sections", () => {
    const headings = read("CLAUDE.md").match(/^## .+$/gm) ?? [];
    expect(headings).toEqual(["## Plan mode", "## Subagent models"]);
    for (const removed of [
      "## Skills",
      "## Running commands",
      "## Generated files",
      "## Waiting on long jobs",
      "## Test budget",
      "## Integration and stalls",
    ]) {
      expect(read("CLAUDE.md")).not.toContain(removed);
    }
  });

  it("imports AGENTS.md on the first line and stays short", () => {
    const lines = read("CLAUDE.md").trimEnd().split(/\r?\n/);
    expect(lines[0]).toBe("@AGENTS.md");
    expect(lines.length).toBeLessThan(30);
  });
});

describe("instruction-file hygiene", () => {
  const instructionFiles = tracked.filter(
    (file) =>
      file === "AGENTS.md" ||
      file === "CLAUDE.md" ||
      /^\.claude\/agents\/[^/]+\.md$/.test(file) ||
      /^\.claude\/skills\/.+/.test(file),
  );

  it("does not put machine paths in tracked instructions", () => {
    for (const file of instructionFiles) {
      expect(read(file), file).not.toMatch(/\/Users\/|~\//);
    }
  });
});

describe("role agents", () => {
  const agentFiles = tracked
    .filter((file) => /^\.claude\/agents\/[^/]+\.md$/.test(file))
    .sort();
  const expectedFiles = Object.keys(ROLE_MODELS).sort();

  it("has the expected role-agent set", () => {
    expect(agentFiles).toEqual(expectedFiles);
  });

  for (const [file, model] of Object.entries(ROLE_MODELS)) {
    it(`${file} declares tools and its routed model`, () => {
      const text = read(file);
      const metadata = frontmatter(file);
      const tools = metadata.tools;
      const hasTools = Array.isArray(tools)
        ? tools.length > 0
        : typeof tools === "string" && tools.trim().length > 0;

      expect(text, `${file} needs tools frontmatter`).toMatch(/^tools:/m);
      expect(hasTools, `${file} needs at least one tool`).toBe(true);
      expect(metadata.model, `${file} must not inherit its model`).toBe(model);
      expect(metadata.model).not.toBe("inherit");
    });
  }

  it("does not hardcode a hard-rule count", () => {
    const countedRules = /\beleven\b|\b\d+\s+hard rules\b/i;
    for (const file of agentFiles) {
      expect(read(file), file).not.toMatch(countedRules);
    }
  });
});

const NESTED_DIRS = [
  "packages/worker",
  "packages/docs",
  "conformance",
  "sdks/godot",
] as const;

const INSTRUCTION_ROOTS = [".", ...NESTED_DIRS] as const;

describe("nested instruction files", () => {
  for (const dir of NESTED_DIRS) {
    it(`${dir}/AGENTS.md is short and links its README`, () => {
      const lines = read(dir, "AGENTS.md").trimEnd().split(/\r?\n/);
      expect(lines.length, `${dir}/AGENTS.md`).toBeLessThan(40);
      expect(read(dir, "AGENTS.md")).toMatch(/\]\(README\.md\)/);
      expect(existsSync(join(ROOT, dir, "README.md"))).toBe(true);
    });

    it(`${dir}/CLAUDE.md only imports AGENTS.md`, () => {
      expect(read(dir, "CLAUDE.md")).toBe("@AGENTS.md\n");
    });

    it(`${dir} instruction files carry no machine paths`, () => {
      for (const file of ["AGENTS.md", "CLAUDE.md"]) {
        expect(read(dir, file), `${dir}/${file}`).not.toMatch(/\/Users\/|~\//);
      }
    });
  }

  it("does not hardcode a hard-rule count", () => {
    const countedRules = /\beleven\b|\b\d+\s+hard rules\b/i;
    for (const dir of INSTRUCTION_ROOTS) {
      expect(read(dir, "AGENTS.md"), dir).not.toMatch(countedRules);
    }
  });
});

// The root cites some paths relative to the directory it is describing.
const PATH_BASES = [
  ".",
  "packages/worker",
  "packages/docs",
  "conformance",
  "conformance/corpus/v2",
  "conformance/corpus/v2/content",
  "conformance/corpus/v2/content/blobs",
  "packages/worker/src",
  "packages/worker/src/core",
  "packages/docs/scripts",
  "packages/docs/src/content/docs",
] as const;

// Names the root cites on purpose although they are not in the tree: moved or retired
// files, dead naming, unreleased paths and the deployed host.
const INTENTIONALLY_ABSENT = new Set([
  ".opencode",
  ".polaris",
  "key.plrs.im/docs",
]);

describe("names cited by AGENTS.md exist", () => {
  for (const dir of INSTRUCTION_ROOTS) {
    const file = join(dir, "AGENTS.md");
    const text = read(file);
    // The repo map quotes each README's own words, relative to that README; its links are built
    // from directories that exist.
    const cited = text.replace(
      /<!-- repo-map:start[\s\S]*?<!-- repo-map:end -->/,
      "",
    );
    const spans = [...cited.matchAll(/`([^`\n]+)`/g)].map(
      (m) => m[1] as string,
    );

    it(`${file}: every backticked repo path resolves`, () => {
      const missing = missingPaths(spans, {
        dir,
        bases: PATH_BASES,
        absent: INTENTIONALLY_ABSENT,
      });
      expect(missing, `${file} cites paths that do not exist`).toEqual([]);
    });

    it(`${file}: every pnpm script exists`, () => {
      const bad = missingPnpmScripts(spans, dir);
      expect(bad, `${file} cites pnpm commands that do not exist`).toEqual([]);
    });

    it(`${file}: every skill a table row names exists`, () => {
      const skills = new Set(
        execFileSync("ls", [join(ROOT, ".claude/skills")])
          .toString()
          .split("\n")
          .filter(Boolean),
      );
      const bad: string[] = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("|") || !/skill/i.test(line)) continue;
        for (const m of line.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)) {
          const name = m[1] as string;
          if (!skills.has(name) && !existsSync(join(ROOT, dir, name))) {
            bad.push(name);
          }
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

/** D-R6: the root stays under 24 KB, generated blocks included. */
export const AGENTS_MD_CAP = 24_576;

describe("the root AGENTS.md shape", () => {
  const text = read("AGENTS.md");

  it(`is at most ${AGENTS_MD_CAP} bytes`, () => {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(AGENTS_MD_CAP);
  });

  it("anchors the hard rules as rule-1 … rule-N, in order", () => {
    const ids = [...text.matchAll(/<a id="rule-(\d+)"><\/a>\*\*(\d+)\. /g)];
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((m, i) => {
      expect(m[1], m[0]).toBe(String(i + 1));
      expect(m[2], m[0]).toBe(String(i + 1));
    });
    // Every "rule N" link resolves to an anchor.
    for (const m of text.matchAll(/\]\(#rule-(\d+)\)/g))
      expect(Number(m[1])).toBeLessThanOrEqual(ids.length);
  });

  it("routes tasks: every row names a task, an existing skill or —, files and a check", () => {
    const rows = section(text, "Task router")
      .split(/\r?\n/)
      .filter((l) => l.startsWith("|"))
      .slice(2)
      .map((l) =>
        l
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim()),
      );
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const [task, skill, files, check] of rows) {
      expect(task, "task").toBeTruthy();
      expect(files, `${task}: files`).toBeTruthy();
      expect(check, `${task}: check`).toBeTruthy();
      if (skill === "—") continue;
      const name = /^`([a-z0-9-]+)`$/.exec(skill ?? "")?.[1];
      expect(name, `${task}: skill cell ${skill}`).toBeTruthy();
      expect(
        existsSync(join(ROOT, ".claude/skills", name as string, "SKILL.md")),
        `${task}: skill ${name}`,
      ).toBe(true);
    }
  });

  it("has no typed repo tree (the repo map is generated)", () => {
    expect(text).not.toMatch(/^```\r?\npackages\//m);
  });

  it("has no tool-specific copies: those tools read AGENTS.md", () => {
    const copies = tracked.filter((file) =>
      /^(\.cursor\/|\.cursorrules$|\.windsurfrules$|\.github\/copilot-instructions\.md$)/.test(
        file,
      ),
    );
    expect(copies).toEqual([]);
  });
});
