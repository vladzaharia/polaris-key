/**
 * The doc-snippet extractor: every fenced code block in the docs pages, the SDK READMEs and the
 * agent skills, by language, with the opt-out marker.
 *
 * Conventions for authors (also in AGENTS.md, "Conventions when writing docs pages"):
 *
 * - A `ts`, `tsx`, `js`, `python` or `py` fence is compiled in its SDK lane (see `lanes.ts`). The
 *   lane is the one the block's imports name; a block that imports nothing from an SDK is a Node
 *   block. `sh`, `ini`, `json` and the rest are never compiled.
 * - A block that cannot compile on purpose says so in its info string: ```` ```ts no-compile ````.
 *   Pages in `COVERED_PAGES` may not use it.
 * - `./polaris.config` (and `polaris_config`) resolve to the real `pkey sdk` output, the generated
 *   samples the drift gate keeps current. `PLACEHOLDERS` (ambient.d.ts, prelude.py) are the few
 *   app-side names a block may use without declaring them.
 * - A name written in prose as `Name` is checked against the SDK's exports (`symbols.ts`) unless its
 *   line says "planned" or "coming in".
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
export const DOCS_ROOT = join(REPO, "packages/docs/src/content/docs");

export type SnippetLang = "ts" | "tsx" | "js" | "python";

export interface Snippet {
  /** Repo-relative path of the source file. */
  file: string;
  /** 1-based line of the first code line. */
  line: number;
  lang: SnippetLang;
  /** The rest of the info string after the language. */
  meta: string;
  optOut: boolean;
  code: string;
}

const LANGS: Record<string, SnippetLang> = {
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  js: "js",
  javascript: "js",
  mjs: "js",
  python: "python",
  py: "python",
};

/** Fenced blocks of one markdown or MDX source. Fences nested in a list are dedented. */
export function extractFences(file: string, source: string): Snippet[] {
  const out: Snippet[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)\s*(.*)$/.exec(lines[i] ?? "");
    if (!open) continue;
    const indent = open[1] ?? "";
    const fence = open[2] ?? "```";
    const tag = (open[3] ?? "").toLowerCase();
    const meta = open[4] ?? "";
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const l = lines[j] ?? "";
      if (
        l.trim().startsWith(fence) &&
        l.trim().replaceAll(fence[0] ?? "`", "") === ""
      )
        break;
      body.push(l.startsWith(indent) ? l.slice(indent.length) : l);
    }
    const lang = LANGS[tag];
    if (lang)
      out.push({
        file,
        line: i + 2,
        lang,
        meta,
        optOut: /(^|\s)no-compile(\s|$)/.test(meta),
        code: body.join("\n"),
      });
    i = j;
  }
  return out;
}

function* walk(dir: string, exts: string[]): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".venv")
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full, exts);
    else if (exts.some((e) => name.endsWith(e))) yield full;
  }
}

/** Every source whose fences the extractor reads: docs pages, SDK READMEs, agent skills. */
export function sourceFiles(): string[] {
  const files = [...walk(DOCS_ROOT, [".md", ".mdx"])];
  for (const readme of [
    "packages/sdk-node/README.md",
    "packages/sdk-react/README.md",
    "packages/client-core/README.md",
    "sdks/python/README.md",
  ])
    if (existsSync(join(REPO, readme))) files.push(join(REPO, readme));
  // AX-07 and the skill packages: SDK-tagged fences under the agent kit.
  files.push(...walk(join(REPO, "packages/agent-kit/skills"), [".md", ".mdx"]));
  return files.map((f) => relative(REPO, f)).sort();
}

export function allSnippets(): Snippet[] {
  return sourceFiles().flatMap((f) =>
    extractFences(f, readFileSync(join(REPO, f), "utf8")),
  );
}

/** Prose of a page: the source without fenced blocks and frontmatter. */
export function proseOf(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let inFence: string | null = null;
  let inFront = false;
  source.split("\n").forEach((text, i) => {
    if (i === 0 && text.trim() === "---") {
      inFront = true;
      return;
    }
    if (inFront) {
      if (text.trim() === "---") inFront = false;
      return;
    }
    const m = /^\s*(`{3,}|~{3,})/.exec(text);
    if (m) {
      const f = m[1] ?? "```";
      if (inFence === null) inFence = f;
      else if (text.trim().startsWith(inFence)) inFence = null;
      return;
    }
    if (inFence === null) out.push({ line: i + 1, text });
  });
  return out;
}
