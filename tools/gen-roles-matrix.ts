// The roles matrix generator (ST-31.10).
//
//   pnpm gen roles-matrix            # (re)write both outputs
//   pnpm gen roles-matrix --check    # regenerate in memory; exit 1 if either differs
//
// Input: packages/worker/src/core/rbac/matrix.ts, the role x area rows. Outputs, from that one
// source so they cannot drift apart:
//   - packages/docs/src/content/docs/reference/roles.mdx, the public reference page;
//   - packages/admin/src/console/access/rolesMatrix.generated.ts, the data the console's Roles tab
//     renders (the admin package never imports the Worker).
// Whether the matrix agrees with `can()` is the Worker test `rolesMatrix.test.ts`; this
// generator only renders.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import {
  FOOTNOTES,
  MATRIX_ROLES,
  PLATFORM_ROWS,
  PRODUCT_ROWS,
  ROLE_NAMES,
  footnoteOf,
  type Cell,
  type MatrixRow,
} from "../packages/worker/src/core/rbac/matrix.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DOC_PATH = "packages/docs/src/content/docs/reference/roles.mdx";
export const ADMIN_PATH =
  "packages/admin/src/console/access/rolesMatrix.generated.ts";

const cellText = (c: Cell): string =>
  c.kind === "tick" ? "Manage" : c.kind === "none" ? "—" : c.word;

const rowLabel = (r: MatrixRow): string =>
  r.detail ? `${r.name}: ${r.detail}` : r.name;

function table(first: string, rows: readonly MatrixRow[]): string {
  const head = `| ${first} | ${MATRIX_ROLES.map((r) => ROLE_NAMES[r]).join(" | ")} |`;
  const rule = `| --- | ${MATRIX_ROLES.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (r) => `| ${rowLabel(r)} | ${r.cells.map(cellText).join(" | ")} |`,
  );
  return [head, rule, ...body].join("\n");
}

/**
 * Notes that explain no one cell, so no footnote carries them (the matrix test requires each
 * footnote to be pointed at by a cell). They hold for the whole table.
 */
const GENERAL_NOTES: readonly string[] = [
  "- Personal admin tokens: a token holds what its owner's roles allow, never a write that needs a step-up.",
  "- SSO rules: a rule can give Product admin or Console access to people who sign in through an operator connection. It never gives Superadmin or Platform admin, and only a Superadmin writes rules.",
];

export function renderDoc(): string {
  const notes = FOOTNOTES.map((f) => {
    const who = f.role ? ` (${ROLE_NAMES[f.role]})` : "";
    return `- **${f.word}**${who}: ${f.text}`;
  }).concat(GENERAL_NOTES);
  return `---
title: "Roles"
description: "What each console role can do, area by area: Superadmin, Platform admin, Product admin and Console access."
---

{/* GENERATED PAGE — do not edit. Regenerate with \`pnpm gen roles-matrix\`.
    Source of truth: packages/worker/src/core/rbac/matrix.ts; emitter: tools/gen-roles-matrix.ts.
    The Worker test rolesMatrix.test.ts derives every cell from the console's can() check. */}

A person's roles add up. Console access lets someone sign in and read the docs, and every other role includes it. A Product admin holds one product or all of them, and can be narrowed to some of its areas.

This table is generated from the console's route table. **Manage** means the role can view and change the area. Words stand for an exception, explained under the tables. A dash means no access.

## In a product

${table("Area", PRODUCT_ROWS)}

## On the platform

${table("Area", PLATFORM_ROWS)}

## Exceptions

${notes.join("\n")}
`;
}

export function renderAdmin(): string {
  const data = {
    roles: MATRIX_ROLES.map((id) => ({ id, name: ROLE_NAMES[id] })),
    productRows: PRODUCT_ROWS.map(rowData),
    platformRows: PLATFORM_ROWS.map(rowData),
    footnotes: FOOTNOTES.map((f) => ({ ...f })),
  };
  return `// GENERATED FILE — do not edit. Regenerate with \`pnpm gen roles-matrix\`.
// Source of truth: packages/worker/src/core/rbac/matrix.ts; emitter: tools/gen-roles-matrix.ts.

export type RolesMatrixCell =
  | { kind: "tick" }
  | { kind: "none" }
  | { kind: "word"; word: "Create" | "Invite" | "Name only" | "Most"; note: string };

export interface RolesMatrixRow {
  id: string;
  name: string;
  detail?: string;
  /** One cell per entry of ROLES_MATRIX.roles, in that order. */
  cells: readonly RolesMatrixCell[];
}

export interface RolesMatrixFootnote {
  id: string;
  word: "Create" | "Invite" | "Name only" | "Most";
  role?: string;
  text: string;
}

export const ROLES_MATRIX: {
  roles: readonly { id: string; name: string }[];
  productRows: readonly RolesMatrixRow[];
  platformRows: readonly RolesMatrixRow[];
  footnotes: readonly RolesMatrixFootnote[];
} = ${JSON.stringify(data, null, 2)};
`;
}

function rowData(r: MatrixRow): object {
  return {
    id: r.id,
    name: r.name,
    ...(r.detail ? { detail: r.detail } : {}),
    cells: r.cells.map((c) =>
      c.kind === "word"
        ? { kind: "word", word: c.word, note: footnoteOf(c.note).id }
        : { kind: c.kind },
    ),
  };
}

export async function renderAll(): Promise<Map<string, string>> {
  const options = (await prettier.resolveConfig(join(ROOT, ADMIN_PATH))) ?? {};
  const admin = await prettier.format(renderAdmin(), {
    ...options,
    parser: "typescript",
  });
  return new Map([
    [DOC_PATH, renderDoc()],
    [ADMIN_PATH, admin],
  ]);
}

/** Write (or, with `check`, compare) the outputs. Returns the stale paths. */
export async function run(opts: {
  check: boolean;
  root?: string;
}): Promise<string[]> {
  const root = opts.root ?? ROOT;
  const stale: string[] = [];
  for (const [path, content] of await renderAll()) {
    const abs = join(root, path);
    let current: string | undefined;
    try {
      current = readFileSync(abs, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) continue;
    stale.push(path);
    if (opts.check) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return stale;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const stale = await run({ check });
  if (check) {
    for (const path of stale)
      console.error(`stale: ${path} — run \`pnpm gen roles-matrix\``);
    if (stale.length > 0) process.exit(1);
    console.log("up to date: the roles matrix");
    return;
  }
  for (const path of stale) console.log(`wrote ${path}`);
  if (stale.length === 0) console.log("nothing to write");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
