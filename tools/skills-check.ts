/**
 * `pnpm skills:check`: the format and hygiene rules for agent skills (AX-07.1).
 *
 * Checks every skill under `packages/agent-kit/skills/*` and `.claude/skills/*`, following
 * links and deduplicating by real path. Rules:
 *
 *   1 frontmatter       name, description ("Use when"), length limits
 *   2 skill-length      SKILL.md under 500 lines
 *   3 references        one level deep; a reference over 100 lines opens with contents
 *   4 repo-names        backticked repo paths and pnpm scripts exist (repo-names.ts)
 *   5 docs-lints        DOC-03a's programme-id, pkey-command and http-path rules
 *   6 docs-links        /docs links point at public, non-stub pages; no sentence copied
 *                       from a member or admin page
 *   7 secrets           `gh secret set`, `pkey release keys generate`, PEM private keys
 *                       only in a fence whose info string contains `handoff`
 *   8 kit               no plugin.json version, no .mcp.json in the kit, no
 *                       extraKnownMarketplaces in .claude/settings.json
 *
 * Removed SDK names stay with api-check rule 2.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { TIER_PREFIXES } from "../packages/docs/src/lib/doors.js";
import { ROOT, missingPaths, missingPnpmScripts } from "./repo-names.js";

export interface Problem {
  rule: number;
  file: string;
  message: string;
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_MAX_LINES = 500;
const REFERENCE_CONTENTS_AFTER = 100;
const REFERENCE_CONTENTS_WITHIN = 15;

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

const rel = (file: string): string => relative(ROOT, file);

interface Row {
  n: number;
  text: string;
  /** The info string of the fence this line is in (or opens), else null. */
  fence: string | null;
}

/** Lines tagged with the info string of the fence they sit in. */
function rows(text: string): Row[] {
  const out: Row[] = [];
  let open: { mark: string; info: string } | null = null;
  text.split("\n").forEach((raw, i) => {
    const m = /^\s*(```+|~~~+)\s*(.*)$/.exec(raw);
    if (open === null && m) {
      open = { mark: m[1] as string, info: (m[2] as string).trim() };
      out.push({ n: i + 1, text: raw, fence: open.info });
    } else if (open !== null) {
      out.push({ n: i + 1, text: raw, fence: open.info });
      if (m && raw.trim().startsWith(open.mark) && (m[2] ?? "") === "")
        open = null;
    } else {
      out.push({ n: i + 1, text: raw, fence: null });
    }
  });
  return out;
}

const mdFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => join(dir, f))
    : [];

/** The skill's own markdown: SKILL.md and the files directly in references/. */
const skillFiles = (dir: string): string[] => [
  join(dir, "SKILL.md"),
  ...mdFiles(join(dir, "references")),
];

/**
 * A skill also quotes paths in the reader's own repo (`product.yaml`, `.pkey/schema`), which this
 * repo cannot check. Only a path that starts at one of this repo's top-level directories, or
 * inside the skill's `references/`, is a claim about this tree.
 */
const TOP_LEVEL = new Set(
  readdirSync(ROOT, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        (!e.name.startsWith(".") ||
          e.name === ".claude" ||
          e.name === ".github"),
    )
    .map((e) => e.name)
    .filter((n) => n !== "node_modules"),
);
const namesRepoTree = (span: string): boolean =>
  TOP_LEVEL.has(span.split("/")[0] as string) || span.startsWith("references/");

// ── docs facts, read from source (no docs build) ──────────────────────────────────────────────

interface PageInfo {
  id: string;
  data: Record<string, unknown>;
  body: string;
  firstLine: number;
}

/**
 * The docs package's scripts are TypeScript and ESM written for its own tsconfig, so they are
 * loaded at run time rather than type-checked as part of `tools/`.
 */
interface DocsScripts {
  lintPage(
    page: PageInfo,
    facts: unknown,
  ): { rule: string; line: number; text: string }[];
  loadFacts(): unknown;
  allIds(): string[];
  fileFor(id: string): string | null;
  splitFrontmatter(text: string): {
    data: Record<string, unknown>;
    body: string;
  };
}

const loadDocsScripts = async (): Promise<DocsScripts> => {
  const at = (name: string) =>
    new URL(`../packages/docs/scripts/${name}`, import.meta.url).href;
  const lint = await import(/* @vite-ignore */ at("lint-docs.ts"));
  const map = await import(/* @vite-ignore */ at("site-map.mjs"));
  return {
    lintPage: lint.lintPage,
    loadFacts: lint.loadFacts,
    allIds: map.allIds,
    fileFor: map.fileFor,
    splitFrontmatter: map.splitFrontmatter,
  };
};

interface DocsFacts extends DocsScripts {
  lint: unknown;
  tierOf: (id: string) => "public" | "member" | "admin";
  gated: Set<string>;
}

const sentenceOf = (s: string): string =>
  s
    .replace(/^[\s>#*+-]+|^\d+\.\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

/** Sentences of 8 or more words in the prose of a text (no fences, no frontmatter). */
export function sentences(text: string): string[] {
  const body = rows(text)
    .filter((r) => r.fence === null)
    .map((r) => r.text)
    .join("\n");
  const out: string[] = [];
  for (const para of body.split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.)\s)/)) {
    for (const s of para.replace(/\n/g, " ").split(/(?<=[.!?])\s+/)) {
      const t = sentenceOf(s);
      if ((t.match(/\S+/g) ?? []).length >= 8) out.push(t);
    }
  }
  return out;
}

export async function loadDocsFacts(): Promise<DocsFacts> {
  const scripts = await loadDocsScripts();
  const { allIds, fileFor, splitFrontmatter } = scripts;
  const tierOf = (id: string): "public" | "member" | "admin" => {
    let best: { len: number; tier: "public" | "member" | "admin" } | null =
      null;
    for (const [prefix, , tier] of TIER_PREFIXES) {
      const hit = prefix.endsWith("/") ? id.startsWith(prefix) : id === prefix;
      if (hit && (best === null || prefix.length > best.len))
        best = { len: prefix.length, tier };
    }
    return best?.tier ?? "admin";
  };
  const gated = new Set<string>();
  for (const id of allIds()) {
    if (tierOf(id) === "public") continue;
    const file = fileFor(id) as string;
    const { body } = splitFrontmatter(readFileSync(file, "utf8"));
    for (const s of sentences(body)) gated.add(s);
  }
  return { ...scripts, lint: scripts.loadFacts(), tierOf, gated };
}

// ── rules 1-7, per skill directory ────────────────────────────────────────────────────────────

const SECRET_PATTERNS: readonly RegExp[] = [
  /gh secret set/,
  /pkey release keys generate/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const DOC_LINK =
  /(?:https?:\/\/)?key\.plrs\.im(\/docs(?:\/[^\s)\]`"'<>{}…]*)?)|(?<![\w./@-])(\/docs(?:\/[^\s)\]`"'<>{}…]*)?)/g;

/**
 * Platform skills stay in `.claude/skills` and never ship in the kit. This one works inside the
 * programme's own tree, so it names programme ids and paths relative to that tree by design;
 * rules 4 and 5 do not apply to it. Everything else does.
 */
const EXEMPT_RULES: Readonly<Record<string, readonly number[]>> = {
  "running-the-omniplatform-program": [4, 5],
};

export function checkSkillDir(dir: string, docs: DocsFacts): Problem[] {
  const { lintPage, fileFor, splitFrontmatter } = docs;
  const out: Problem[] = [];
  const exempt = EXEMPT_RULES[dir.split("/").pop() as string] ?? [];
  const add = (rule: number, file: string, message: string): void => {
    if (exempt.includes(rule)) return;
    out.push({ rule, file: rel(file), message });
  };
  const skillFile = join(dir, "SKILL.md");
  if (!existsSync(skillFile)) {
    add(1, dir, "no SKILL.md");
    return out;
  }
  const text = readFileSync(skillFile, "utf8");

  // 1. frontmatter
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  let data: Record<string, unknown> = {};
  if (!fm) add(1, skillFile, "no frontmatter");
  else {
    try {
      data = (parseYaml(fm[1] as string) as Record<string, unknown>) ?? {};
    } catch (e) {
      add(1, skillFile, `frontmatter is not YAML: ${(e as Error).message}`);
    }
  }
  const name = data.name;
  if (typeof name !== "string" || !NAME.test(name) || name.length > 64)
    add(
      1,
      skillFile,
      `name ${JSON.stringify(name)} must match ${NAME}, max 64`,
    );
  const description = data.description;
  const whenToUse =
    typeof data.when_to_use === "string" ? data.when_to_use : "";
  if (typeof description !== "string" || description.trim() === "")
    add(1, skillFile, "description is missing");
  else {
    if (description.length > 1024)
      add(
        1,
        skillFile,
        `description is ${description.length} characters (max 1024)`,
      );
    if (!description.includes("Use when"))
      add(1, skillFile, 'description does not contain "Use when"');
    if (description.length + whenToUse.length > 1536)
      add(1, skillFile, "description plus when_to_use is over 1536 characters");
  }

  // 2. length
  const lineCount = text.trimEnd().split("\n").length;
  if (lineCount >= SKILL_MAX_LINES)
    add(
      2,
      skillFile,
      `SKILL.md is ${lineCount} lines (limit ${SKILL_MAX_LINES - 1})`,
    );

  // 3. references
  const refs = join(dir, "references");
  if (existsSync(refs)) {
    for (const entry of readdirSync(refs)) {
      if (statSync(join(refs, entry)).isDirectory())
        add(3, join(refs, entry), "references/ nests deeper than one level");
    }
    for (const file of mdFiles(refs)) {
      const body = readFileSync(file, "utf8").trimEnd().split("\n");
      if (
        body.length > REFERENCE_CONTENTS_AFTER &&
        !body
          .slice(0, REFERENCE_CONTENTS_WITHIN)
          .some((l) => /\bcontents\b/i.test(l))
      )
        add(
          3,
          file,
          `${body.length} lines and no contents list in the first ${REFERENCE_CONTENTS_WITHIN}`,
        );
    }
  }

  const dirRel = rel(realpathSync(dir));
  for (const file of skillFiles(dir)) {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    const all = rows(src);

    // 4. repo names (inline code outside fences)
    const spans = all
      .filter((r) => r.fence === null)
      .flatMap((r) =>
        [...r.text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string),
      );
    const badPaths = missingPaths(spans.filter(namesRepoTree), {
      dir: dirRel,
      bases: ["."],
      absent: new Set(["key.plrs.im/docs"]),
    });
    for (const p of badPaths) add(4, file, `path does not exist: ${p}`);
    for (const s of missingPnpmScripts(spans, "."))
      add(4, file, `pnpm command does not exist: ${s}`);

    // 5. DOC-03a lints
    const { data: pageData, body } = splitFrontmatter(src);
    const firstLine = src.slice(0, src.length - body.length).split("\n").length;
    const hits = lintPage(
      {
        id: rel(file),
        data: { ...pageData, status: undefined },
        body,
        firstLine,
      },
      docs.lint,
    ).filter((h) =>
      ["programme-id", "pkey-command", "http-path"].includes(h.rule),
    );
    for (const h of hits) add(5, file, `${h.rule} line ${h.line}: ${h.text}`);

    // 6. docs links and copied sentences
    for (const r of all) {
      for (const m of r.text.matchAll(DOC_LINK)) {
        const route = (m[1] ?? m[2]) as string;
        const clean = route.replace(/[#?].*$/, "").replace(/[.,;:]+$/, "");
        const id =
          clean.replace(/^\/docs\/?/, "").replace(/\/+$/, "") || "index";
        const candidates = [id, `${id}/index`];
        const found = candidates.find((c) => fileFor(c) !== null);
        if (found === undefined) {
          add(6, file, `line ${r.n}: ${route} is not a docs page`);
          continue;
        }
        // site-map.json keeps listing a stub after its page is written; the frontmatter decides.
        const stub =
          splitFrontmatter(readFileSync(fileFor(found) as string, "utf8")).data
            .status === "stub";
        if (stub) add(6, file, `line ${r.n}: ${route} is a stub page`);
        else if (docs.tierOf(found) !== "public")
          add(6, file, `line ${r.n}: ${route} is a ${docs.tierOf(found)} page`);
      }
    }
    for (const s of sentences(src)) {
      if (docs.gated.has(s))
        add(
          6,
          file,
          `sentence copied from a gated page: "${s.slice(0, 60)}..."`,
        );
    }

    // 7. secrets outside a handoff fence
    for (const r of all) {
      if (r.fence !== null && r.fence.includes("handoff")) continue;
      for (const re of SECRET_PATTERNS)
        if (re.test(r.text))
          add(7, file, `line ${r.n}: ${re.source} outside a handoff fence`);
    }
  }
  return out;
}

// ── rule 8, per kit ───────────────────────────────────────────────────────────────────────────

export function checkKit(opts: {
  kitRoot: string;
  settings: string;
}): Problem[] {
  const out: Problem[] = [];
  const plugin = join(opts.kitRoot, ".claude-plugin", "plugin.json");
  if (existsSync(plugin)) {
    const json = JSON.parse(readFileSync(plugin, "utf8")) as Record<
      string,
      unknown
    >;
    if ("version" in json)
      out.push({
        rule: 8,
        file: rel(plugin),
        message: "plugin.json carries a version (the release stamps it)",
      });
  }
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules") continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === ".mcp.json")
        out.push({ rule: 8, file: rel(full), message: ".mcp.json in the kit" });
    }
  };
  walk(opts.kitRoot);
  if (existsSync(opts.settings)) {
    const json = JSON.parse(readFileSync(opts.settings, "utf8")) as Record<
      string,
      unknown
    >;
    if ("extraKnownMarketplaces" in json)
      out.push({
        rule: 8,
        file: rel(opts.settings),
        message: "extraKnownMarketplaces in settings",
      });
  }
  return out;
}

// ── discovery and main ────────────────────────────────────────────────────────────────────────

/** Skill directories under the given roots, deduplicated by real path. */
export function discoverSkills(roots: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root).sort()) {
      const dir = join(root, entry);
      if (!statSync(dir).isDirectory()) continue;
      const real = realpathSync(dir);
      if (!seen.has(real)) seen.set(real, dir);
    }
  }
  return [...seen.values()];
}

export async function checkRepo(): Promise<Problem[]> {
  const docs = await loadDocsFacts();
  const skills = discoverSkills([
    join(ROOT, "packages/agent-kit/skills"),
    join(ROOT, ".claude/skills"),
  ]);
  return [
    ...skills.flatMap((d) => checkSkillDir(d, docs)),
    ...checkKit({
      kitRoot: join(ROOT, "packages/agent-kit"),
      settings: join(ROOT, ".claude/settings.json"),
    }),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await checkRepo();
  for (const p of problems)
    console.error(`skills:check rule ${p.rule} ${p.file}: ${p.message}`);
  if (problems.length > 0) {
    console.error(`skills:check: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log("skills:check: ok");
}
