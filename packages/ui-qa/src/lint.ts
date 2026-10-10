// `pnpm ui:lint`: the modernity lint over the mockup boards (and any kit CSS or page it is
// given), the string lint across boards, and the per-kit source lints. Exit 1 on any finding.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { lintKits, type KitFinding } from "./kits.ts";
import {
  BOARDS,
  BOARDS_DIR,
  PROFILES,
  REPO_ROOT,
  STRINGS_ALLOW,
  type Board,
} from "./config.ts";
import { CHROME } from "./boards.ts";
import { cssPageUrl, lintTargets, serveDir, type PageTarget } from "./run.ts";
import {
  lintStrings,
  loadAllow,
  loadCatalog,
  normalise,
  stateOf,
  type StringFinding,
} from "./strings.ts";
import type { Violation } from "./types.ts";

/** `1920x1080` or `320x256@4` (a width, a height, an optional device pixel ratio). */
export function parseSize(size: string): {
  width: number;
  height: number;
  ratio: number;
} {
  const m = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(size);
  if (!m) throw new Error(`bad --size "${size}": use WIDTHxHEIGHT[@ratio]`);
  return { width: +m[1]!, height: +m[2]!, ratio: m[3] ? +m[3] : 1 };
}

export const STRING_DEBT = "packages/ui-qa/rules/strings.debt.json";

export interface LintRun {
  violations: Array<Violation & { board: string; theme: string }>;
  strings: StringFinding[];
  staleDebt: Array<{ board: string; state: string; text: string }>;
  kits: KitFinding[];
  consoleErrors: string[];
}

export interface LintArgs {
  boards?: string[];
  themes?: Array<"dark" | "light">;
  css?: string[];
  html?: string[];
  /** Window sizes for `html` pages, `WIDTHxHEIGHT[@ratio]`: `1920x1080`, `320x256@4` (400 % zoom). */
  sizes?: string[];
  strings?: boolean;
  kits?: boolean;
  recordStringDebt?: boolean;
  root?: string;
  /** Boards are read from this directory (tests point it at a seeded copy). */
  boardsDir?: string;
}

interface DebtFile {
  $comment: string;
  debt: Array<{ board: string; state: string; text: string }>;
}

function boardTarget(
  base: string,
  dir: string,
  b: Board,
  theme: string,
): PageTarget {
  const c = CHROME[b.name] ?? {};
  return {
    name: b.name,
    url: `${base}/${dir}/${b.name}.html?theme=${theme}`,
    theme: theme as "dark" | "light",
    options: {
      chrome: c.chrome ?? [],
      touch: c.touch ?? [],
      allow: c.allow ?? {},
      allowWeight700: b.allowWeight700 ?? [],
    },
  };
}

export async function runLint(
  args: LintArgs,
  browser?: Browser,
): Promise<LintRun> {
  const root = args.root ?? REPO_ROOT;
  const dir = args.boardsDir ?? BOARDS_DIR;
  const boards = BOARDS.filter(
    (b) => !args.boards || args.boards.includes(b.name),
  );
  const themes = args.themes ?? ["dark", "light"];
  const own = !browser;
  const br = browser ?? (await chromium.launch());
  const srv = await serveDir(root);
  const run: LintRun = {
    violations: [],
    strings: [],
    staleDebt: [],
    kits: [],
    consoleErrors: [],
  };
  try {
    const targets: PageTarget[] = [];
    for (const b of boards)
      for (const t of themes) targets.push(boardTarget(srv.base, dir, b, t));
    for (const file of args.css ?? [])
      targets.push({
        name: file,
        url: cssPageUrl(resolve(root, file)),
        options: { allRules: true },
      });
    for (const page of args.html ?? [])
      for (const size of args.sizes?.length ? args.sizes : [undefined]) {
        const s = size ? parseSize(size) : undefined;
        targets.push({
          name: s ? `${page} @ ${size}` : page,
          url: /^https?:/.test(page)
            ? page
            : `${srv.base}/${page.replace(/^\/+/, "")}`,
          ...(s && {
            viewport: { width: s.width, height: s.height },
            deviceScaleFactor: s.ratio,
          }),
        });
      }
    const results = await lintTargets(br, targets);
    for (const r of results) {
      const board = boards.find((b) => b.name === r.target.name);
      const skip: readonly string[] = board ? PROFILES[board.profile].skip : [];
      for (const v of r.violations)
        if (!skip.includes(v.rule))
          run.violations.push({
            ...v,
            board: r.target.name,
            theme: r.target.theme ?? "",
          });
      for (const e of r.consoleErrors)
        run.consoleErrors.push(
          `${r.target.name} ${r.target.theme ?? ""}: ${e}`,
        );
    }
    // One theme's strings are enough: the copy does not change with the theme.
    if (args.strings !== false && boards.length) {
      const first = themes[0];
      const perBoard = results
        .filter(
          (r) =>
            r.target.theme === first &&
            boards.some((b) => b.name === r.target.name),
        )
        .map((r) => ({
          board: r.target.name,
          platform: boards.find((b) => b.name === r.target.name)!.platform,
          strings: r.strings,
        }));
      const { findings } = lintStrings(
        loadCatalog(root),
        loadAllow(resolve(root, STRINGS_ALLOW)),
        perBoard,
      );
      const debtFile = resolve(root, STRING_DEBT);
      const key = (x: { board: string; state: string; text: string }) =>
        `${x.board}\u0000${x.state}\u0000${normalise(x.text)}`;
      if (args.recordStringDebt) {
        const seen = new Set<string>();
        const debt = findings
          .map((f) => ({
            board: f.board,
            state: f.state,
            text: normalise(f.text),
          }))
          .filter((d) => (seen.has(key(d)) ? false : (seen.add(key(d)), true)))
          .sort((a, b) => key(a).localeCompare(key(b)));
        const out: DebtFile = {
          $comment: DEBT_COMMENT,
          debt,
        };
        writeFileSync(debtFile, JSON.stringify(out, null, 2) + "\n");
      } else {
        const debt: DebtFile = existsSync(debtFile)
          ? (JSON.parse(readFileSync(debtFile, "utf8")) as DebtFile)
          : { $comment: "", debt: [] };
        const known = new Set(debt.debt.map(key));
        run.strings = findings.filter((f) => !known.has(key(f)));
        const present = new Set(findings.map(key));
        const linted = new Set(perBoard.map((p) => p.board));
        run.staleDebt = debt.debt.filter(
          (d) => linted.has(d.board) && !present.has(key(d)),
        );
      }
    }
    if (args.kits !== false) run.kits = lintKits(root).findings;
  } finally {
    await srv.close();
    if (own) await br.close();
  }
  return run;
}

export const DEBT_COMMENT =
  "Copy debt on the mockup boards (UI-KITS.md §4.7, §7.3): visible strings that are neither a catalog message, a documented platform variant nor an allowed fixture string (strings.allow.json), recorded when the string lint landed (UK-15). The lint fails on any NEW string not listed here, and on an entry that no longer appears (so the list only shrinks). Clear an entry by fixing the board's copy to the catalog, or by adding the key to packages/brand/kit-copy/en.json (pnpm gen brand). Re-record only to remove entries: pnpm ui:lint -- --record-string-debt.";

export function format(run: LintRun): string {
  const lines: string[] = [];
  const byRule = new Map<string, LintRun["violations"]>();
  for (const v of run.violations) {
    const list = byRule.get(v.rule) ?? [];
    list.push(v);
    byRule.set(v.rule, list);
  }
  for (const [rule, list] of [...byRule].sort()) {
    lines.push(`✗ ${rule} (${list.length})`);
    const seen = new Set<string>();
    for (const v of list) {
      const k = `${v.board}|${v.scope}|${v.target}|${v.detail}`;
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(
        `    ${v.board}${v.theme ? ` ${v.theme}` : ""} · ${v.scope} · ${v.target}\n      ${v.detail}`,
      );
    }
  }
  if (run.strings.length) {
    lines.push(`✗ catalog-string (${run.strings.length})`);
    for (const s of run.strings)
      lines.push(
        `    ${s.board} · ${s.state} · "${s.text}"\n      ${s.detail}`,
      );
  }
  if (run.staleDebt.length) {
    lines.push(
      `✗ catalog-string: stale debt (${run.staleDebt.length}); remove with --record-string-debt`,
    );
    for (const s of run.staleDebt)
      lines.push(`    ${s.board} · ${s.state} · "${s.text}"`);
  }
  if (run.kits.length) {
    lines.push(`✗ kit-source (${run.kits.length})`);
    for (const k of run.kits)
      lines.push(
        `    ${k.kit} · ${k.file}:${k.line} · ${k.rule}\n      ${k.detail}`,
      );
  }
  if (run.consoleErrors.length) {
    lines.push(`✗ console errors (${run.consoleErrors.length})`);
    for (const e of run.consoleErrors) lines.push(`    ${e}`);
  }
  return lines.join("\n");
}

export function failed(run: LintRun): boolean {
  return (
    run.violations.length +
      run.strings.length +
      run.staleDebt.length +
      run.kits.length +
      run.consoleErrors.length >
    0
  );
}

export { stateOf };
