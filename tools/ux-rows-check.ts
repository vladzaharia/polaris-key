// The UX-row gate (P0-41): every `UX-*` package id the design specs name is mapped, and every row of
// the three spec tables says where its work went.
//
//   pnpm gen ux-rows            # read-only; one line per violation, exit 1 on any
//   pnpm gen ux-rows --check    # the same (accepted for symmetry with the other families)
//
// The map is `uxRows` in docs/research/2026-10-07-dx-consolidation/backlog-changes.json: one entry per
// `UX-*` id, whose value is exactly one of
//
//   <graph id>                         the work package that owns it (`ST-30`); must exist in workpackages.json
//   built <sha> [(<note>)]             built in that commit
//   built by <graph id> [and|, <id>]   built by those packages; each must exist
//   parked: <idea>; revive when|after|with <condition>
//   dropped: <reason>
//
// It fails when:
//
//   1. a `UX-*` id named anywhere in the six design specs (EXPERIENCE, SETUP, FLOWS, SIGN-IN, ADMIN,
//      PORTAL) is not a key of `uxRows`, or a `uxRows` key is named in none of the three tables;
//   2. a row of EXPERIENCE §13.3, SETUP §8.2 or FLOWS §4.2 has no Status cell, or its Status cell is
//      not exactly the `uxRows` value for that id;
//   3. a `uxRows` value is none of the five forms above, or names a graph id workpackages.json lacks.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UX_ROWS_PATH =
  "docs/research/2026-10-07-dx-consolidation/backlog-changes.json";
export const PROGRAM_PATH =
  "docs/research/2026-09-29-godot-omniplatform/program/workpackages.json";

/** The three specs whose tables carry the marks, each with the heading that opens and closes its table. */
export const TABLES: readonly { file: string; from: string; to: string }[] = [
  {
    file: "docs/design/EXPERIENCE.md",
    from: "### 13.3 Work packages",
    to: "### 13.4 ",
  },
  {
    file: "docs/design/SETUP.md",
    from: "### 8.2 Work packages",
    to: "### 8.3 ",
  },
  {
    file: "docs/design/FLOWS.md",
    from: "### 4.2 Work packages",
    to: "### 4.3 ",
  },
];

/** Every design spec a `UX-*` id may appear in. */
export const SPECS: readonly string[] = [
  ...TABLES.map((t) => t.file),
  "docs/design/SIGN-IN.md",
  "docs/design/ADMIN.md",
  "docs/design/PORTAL.md",
];

const GRAPH_ID = "[A-Z][A-Za-z0-9]{0,2}-\\d+[a-z]?";
const GRAPH_ID_RE = new RegExp(`^${GRAPH_ID}$`);
const BUILT_SHA_RE = /^built [0-9a-f]{7,40}(?: \(.+\))?$/;
const BUILT_BY_RE = new RegExp(
  `^built by ${GRAPH_ID}(?:(?:, | and | and, )${GRAPH_ID})*(?: \\(.+\\))?$`,
);
const PARKED_RE = /^parked: .+; revive (?:when|after|with) .+$/;
const DROPPED_RE = /^dropped: .+$/;

export type UxRowKind = "package" | "built" | "parked" | "dropped";

/** The shape of one `uxRows` value, and the graph ids it names; `null` when it is none of the forms. */
export function parseUxRow(
  value: string,
): { kind: UxRowKind; ids: string[] } | null {
  if (GRAPH_ID_RE.test(value)) return { kind: "package", ids: [value] };
  if (BUILT_SHA_RE.test(value)) return { kind: "built", ids: [] };
  if (BUILT_BY_RE.test(value))
    return {
      kind: "built",
      ids:
        value
          .slice("built by ".length)
          .replace(/ \(.+\)$/, "")
          .match(new RegExp(GRAPH_ID, "g")) ?? [],
    };
  if (PARKED_RE.test(value)) return { kind: "parked", ids: [] };
  if (DROPPED_RE.test(value)) return { kind: "dropped", ids: [] };
  return null;
}

/** Every `UX-*` id a text names. `UX-06a/06b` names two; a range names its two ends. */
export function uxIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bUX-(\d+[a-z]?)((?:\/\d+[a-z]?)*)/g)) {
    out.add(`UX-${m[1]}`);
    for (const more of (m[2] ?? "").split("/").filter(Boolean))
      out.add(`UX-${more}`);
  }
  return [...out];
}

/** Splits one table line into trimmed cells, honouring `\|` inside a cell. */
export function cellsOf(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c === "\\" && body[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

export interface TableRow {
  /** 1-based line in the file. */
  line: number;
  id: string;
  /** The Status cell, or `null` when the row's table has no Status column or the row is short. */
  status: string | null;
}

/**
 * The rows of every table between `from` and `to` headings whose first cell is a package id. Each
 * table has its own header; a header without a `Status` column gives every row `status: null`.
 */
export function tableRows(text: string, from: string, to: string): TableRow[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(from));
  if (start === -1) throw new Error(`no heading "${from}"`);
  let end = lines.findIndex((l, i) => i > start && l.startsWith(to));
  if (end === -1) end = lines.length;
  const rows: TableRow[] = [];
  let statusAt = -1;
  let inTable = false;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i] as string;
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    const cells = cellsOf(line);
    if (!inTable) {
      // The first line of a table is its header.
      inTable = true;
      statusAt = cells.findIndex((c) => c === "Status");
      continue;
    }
    if (/^[-:\s|]+$/.test(line)) continue;
    const id = cells[0]?.replace(/[*`]/g, "") ?? "";
    if (!new RegExp(`^${GRAPH_ID}$`).test(id)) continue;
    rows.push({
      line: i + 1,
      id,
      status: statusAt === -1 ? null : (cells[statusAt] ?? null),
    });
  }
  return rows;
}

export interface UxRowsResult {
  violations: string[];
  /** How many `uxRows` entries were checked. */
  rows: number;
}

export function checkUxRows(opts: { root: string }): UxRowsResult {
  const { root } = opts;
  const violations: string[] = [];
  const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

  // Both files are repository-controlled JSON; `JSON.parse` is `any`, so the named shapes are the
  // contract and a missing top-level key is reported, never guessed around.
  const rowsDoc: { uxRows?: Record<string, string> } = JSON.parse(
    read(UX_ROWS_PATH),
  );
  const programDoc: { workPackages?: { id: string }[] } = JSON.parse(
    read(PROGRAM_PATH),
  );
  if (!rowsDoc.uxRows) throw new Error(`${UX_ROWS_PATH} has no uxRows`);
  if (!programDoc.workPackages)
    throw new Error(`${PROGRAM_PATH} has no workPackages`);
  const uxRows = rowsDoc.uxRows;
  const graph = new Set(programDoc.workPackages.map((w) => w.id));

  // 3. Every value is one of the five forms, and the ids it names exist.
  for (const [id, value] of Object.entries(uxRows)) {
    const parsed = parseUxRow(value);
    if (!parsed) {
      violations.push(
        `${UX_ROWS_PATH}: uxRows ${id} is "${value}", which is not a graph id, "built <sha>", "built by <ids>", "parked: …; revive when …" or "dropped: …"`,
      );
      continue;
    }
    for (const g of parsed.ids)
      if (!graph.has(g))
        violations.push(
          `${UX_ROWS_PATH}: uxRows ${id} names ${g}, which ${PROGRAM_PATH} does not register`,
        );
  }

  // 1a. Every id the specs name is mapped.
  for (const file of SPECS) {
    if (!existsSync(join(root, file))) {
      violations.push(`${file}: missing`);
      continue;
    }
    for (const id of uxIds(read(file)))
      if (!(id in uxRows))
        violations.push(`${file}: ${id} is not mapped in uxRows`);
  }

  // 2. Every row of the three tables is marked from uxRows.
  const marked = new Set<string>();
  for (const { file, from, to } of TABLES) {
    for (const row of tableRows(read(file), from, to)) {
      if (!row.id.startsWith("UX-")) continue;
      const want = uxRows[row.id];
      if (want === undefined) {
        violations.push(
          `${file}:${row.line}: ${row.id} is not mapped in uxRows`,
        );
        continue;
      }
      marked.add(row.id);
      if (row.status === null)
        violations.push(
          `${file}:${row.line}: ${row.id} has no Status cell (its table needs a Status column)`,
        );
      else if (row.status !== want)
        violations.push(
          `${file}:${row.line}: ${row.id} says "${row.status}" but uxRows says "${want}"`,
        );
    }
  }

  // 1b. Every mapped id has a marked row.
  for (const id of Object.keys(uxRows))
    if (!marked.has(id))
      violations.push(
        `${UX_ROWS_PATH}: uxRows ${id} has no marked row in EXPERIENCE §13.3, SETUP §8.2 or FLOWS §4.2`,
      );

  return { violations, rows: Object.keys(uxRows).length };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────

function main(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // `--check` is accepted and ignored: the checker never writes anything.
  const { violations, rows } = checkUxRows({ root });
  if (violations.length) {
    for (const v of violations) console.error(v);
    console.error(`ux-rows: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log(`ux-rows: all ${rows} UX rows are mapped and marked`);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main();
}
