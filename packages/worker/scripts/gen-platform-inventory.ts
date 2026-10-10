/**
 * The platform inventory generator and drift gate (ST-02, notes/S-18 §4.13 item 1).
 *
 *   pnpm gen platform-inventory              # rewrite src/platformInventory.generated.ts
 *   pnpm gen platform-inventory --check   # exit 1 on any drift, write nothing
 *
 * The source is `packages/worker/src/platform/env.ts`: every `Env` member carries one
 * `@inventory <kind> <area>` JSDoc tag and, when a console value can override it, one
 * `@editable <platform setting row key>`. The checks, in both modes:
 *
 *   1. every `Env` member has exactly one valid `@inventory` tag (a known kind and area), and an
 *      `@editable` names the row key of a registry platform entry whose `varName` is that member;
 *   2. the generated file is current (`--check` only; otherwise it is rewritten);
 *   3. `wrangler.toml` and `wrangler.deltas.toml`: every `[vars]` key (commented-out ones too)
 *      is an inventory `var`, every binding name is an inventory `binding`; every inventory
 *      binding is bound in `wrangler.toml`; every inventory `var` and `secret` is named somewhere
 *      in `wrangler.toml`; every `secret` is named in its trailing required-secrets comment;
 *   4. every name `src/` reads off the env (`env.NAME`, `env["NAME"]`, `secret(env, "NAME")`,
 *      `str(env, "NAME")`) is an `Env` member, so the index signature cannot hide a new setting.
 *
 * The worker suite's `test/platformInventory.test.ts` runs the same checks, so `pnpm test` fails
 * on drift as well.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import ts from "typescript";
import { aliasedPlatformEntries } from "../src/core/settings/platformRead.js";
import {
  INVENTORY_AREAS,
  INVENTORY_KINDS,
  type InventoryArea,
  type InventoryKind,
  type PlatformInventoryEntry,
} from "../src/platformInventory.js";

export const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
export const ENV_PATH = "packages/worker/src/platform/env.ts";
export const GENERATED_PATH =
  "packages/worker/src/platformInventory.generated.ts";
export const WRANGLER_PATH = "packages/worker/wrangler.toml";
export const WRANGLER_DELTAS_PATH = "packages/worker/wrangler.deltas.toml";
export const SRC_DIR = "packages/worker/src";

/** The line that opens `wrangler.toml`'s trailing secrets comment block. */
export const SECRETS_BLOCK_MARKER = "# Trusted publishing";

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function tagText(tag: ts.JSDocTag): string {
  const c = tag.comment;
  if (c === undefined) return "";
  return (typeof c === "string" ? c : c.map((p) => p.text).join(""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse `Env` out of `env.ts`'s source. Errors are human-readable, one per problem. */
export function parseEnvInventory(source: string): {
  entries: PlatformInventoryEntry[];
  errors: string[];
} {
  const sf = ts.createSourceFile(
    "env.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const errors: string[] = [];
  const entries: PlatformInventoryEntry[] = [];
  const iface = sf.statements.find(
    (s): s is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(s) && s.name.text === "Env",
  );
  if (!iface) return { entries, errors: ["env.ts declares no `Env`"] };
  const editableKeys = new Map(
    aliasedPlatformEntries().map((d) => [
      d.storage.kind === "scalar" ? d.storage.storedAs! : d.key,
      d.varName!,
    ]),
  );
  for (const m of iface.members) {
    if (ts.isIndexSignatureDeclaration(m)) continue;
    if (!ts.isPropertySignature(m) || !ts.isIdentifier(m.name)) {
      errors.push(`Env has a member the inventory cannot read: ${m.getText()}`);
      continue;
    }
    const name = m.name.text;
    if (!NAME_RE.test(name)) {
      errors.push(`${name}: an Env member name must be UPPER_SNAKE_CASE`);
      continue;
    }
    const tags = ts.getJSDocTags(m);
    const inv = tags.filter((t) => t.tagName.text === "inventory");
    const edit = tags.filter((t) => t.tagName.text === "editable");
    if (inv.length !== 1) {
      errors.push(
        inv.length === 0
          ? `${name}: no @inventory tag (add \`@inventory <${INVENTORY_KINDS.join("|")}> <area>\` to its JSDoc in env.ts)`
          : `${name}: more than one @inventory tag`,
      );
      continue;
    }
    const [kind, area, ...rest] = tagText(inv[0]!).split(" ");
    if (!INVENTORY_KINDS.includes(kind as InventoryKind)) {
      errors.push(
        `${name}: @inventory kind "${kind ?? ""}" is not one of ${INVENTORY_KINDS.join(", ")}`,
      );
      continue;
    }
    if (!INVENTORY_AREAS.includes(area as InventoryArea) || rest.length > 0) {
      errors.push(
        `${name}: @inventory area "${[area, ...rest].join(" ")}" is not one of ${INVENTORY_AREAS.join(", ")}`,
      );
      continue;
    }
    let editable: string | null = null;
    if (edit.length > 1) errors.push(`${name}: more than one @editable tag`);
    if (edit.length === 1) {
      editable = tagText(edit[0]!);
      if (kind !== "var") errors.push(`${name}: only a var can be @editable`);
      else if (editableKeys.get(editable) !== name)
        errors.push(
          `${name}: @editable ${editable} is not a registry platform setting row key whose varName is ${name}`,
        );
    }
    entries.push({
      name,
      kind: kind as InventoryKind,
      area: area as InventoryArea,
      optional: m.questionToken !== undefined,
      editable,
    });
  }
  // Every registry key must point back at its var, so the console's editable set and the
  // inventory cannot disagree.
  for (const [rowKey, varName] of editableKeys)
    if (!entries.some((e) => e.editable === rowKey))
      errors.push(
        `registry platform setting ${rowKey}: its var ${varName} carries no matching @editable tag in env.ts`,
      );
  return { entries, errors };
}

interface WranglerNames {
  vars: Set<string>;
  bindings: Set<string>;
  /** Every UPPER_SNAKE token anywhere in the file (comments included). */
  mentioned: Set<string>;
  /** UPPER_SNAKE tokens in the trailing secrets comment block. */
  secretsBlock: Set<string>;
}

/** Read the names a wrangler TOML file declares. A deliberately small reader: the shapes it
 *  matches are the ones this repo's two configs use, and the test pins them. */
export function wranglerNames(toml: string): WranglerNames {
  const vars = new Set<string>();
  const bindings = new Set<string>();
  const mentioned = new Set<string>();
  const secretsBlock = new Set<string>();
  let inVars = false;
  let inBlock = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    for (const tok of line.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [])
      mentioned.add(tok);
    if (line.startsWith(SECRETS_BLOCK_MARKER)) inBlock = true;
    if (inBlock) {
      if (line !== "" && !line.startsWith("#")) inBlock = false;
      else
        for (const tok of line.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [])
          secretsBlock.add(tok);
    }
    const section = /^\[{1,2}([^\]]+)\]{1,2}$/.exec(line);
    if (section) {
      inVars = /(^|\.)vars$/.test(section[1]!);
      continue;
    }
    const kv = /^(#\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, commented, key, value] = kv;
    if (inVars && NAME_RE.test(key!)) {
      vars.add(key!);
      continue;
    }
    if (commented) continue;
    if (key === "binding" || key === "name") {
      const v = /^"([^"]+)"/.exec(value!);
      if (v && NAME_RE.test(v[1]!)) bindings.add(v[1]!);
    }
  }
  return { vars, bindings, mentioned, secretsBlock };
}

/** Env ↔ wrangler drift. `main` is `wrangler.toml`, `deltas` is `wrangler.deltas.toml`. */
export function checkWrangler(
  entries: readonly PlatformInventoryEntry[],
  main: string,
  deltas: string,
): string[] {
  const errors: string[] = [];
  const byName = new Map(entries.map((e) => [e.name, e]));
  const m = wranglerNames(main);
  const d = wranglerNames(deltas);
  if (m.secretsBlock.size === 0)
    errors.push(
      `${WRANGLER_PATH}: no secrets comment block (a comment starting "${SECRETS_BLOCK_MARKER}")`,
    );
  for (const [file, w] of [
    [WRANGLER_PATH, m],
    [WRANGLER_DELTAS_PATH, d],
  ] as const) {
    for (const v of w.vars) {
      const e = byName.get(v);
      if (!e) errors.push(`${file}: [vars] ${v} is not an Env member`);
      else if (e.kind !== "var")
        errors.push(`${file}: [vars] ${v} is an Env ${e.kind}, not a var`);
    }
    for (const b of w.bindings) {
      const e = byName.get(b);
      if (!e) errors.push(`${file}: binding ${b} is not an Env member`);
      else if (e.kind !== "binding")
        errors.push(`${file}: binding ${b} is an Env ${e.kind}, not a binding`);
    }
  }
  // The other direction: every name the secrets comment block tells operators to set must still
  // be an Env var or secret. Prose tokens (ONE, KEK, OCI) carry no underscore; a trailing
  // underscore (`PLATFORM_OIDC_*`) is a prefix that must still match some Env var or secret.
  const settable = entries.filter(
    (e) => e.kind === "var" || e.kind === "secret",
  );
  for (const tok of [...m.secretsBlock].sort()) {
    if (!NAME_RE.test(tok) || !tok.includes("_")) continue;
    const ok = tok.endsWith("_")
      ? settable.some((e) => e.name.startsWith(tok))
      : settable.some((e) => e.name === tok);
    if (!ok)
      errors.push(
        `${WRANGLER_PATH}: secrets comment block names ${tok}, which is not an Env var or secret`,
      );
  }
  for (const e of entries) {
    if (e.kind === "binding") {
      if (!m.bindings.has(e.name))
        errors.push(`${e.name}: an Env binding ${WRANGLER_PATH} never binds`);
      continue;
    }
    if (!m.mentioned.has(e.name))
      errors.push(
        `${e.name}: an Env ${e.kind} named nowhere in ${WRANGLER_PATH} (add it to a [vars] block or the secrets comment)`,
      );
    else if (e.kind === "secret" && !m.secretsBlock.has(e.name))
      errors.push(
        `${e.name}: an Env secret missing from ${WRANGLER_PATH}'s secrets comment block`,
      );
  }
  return errors;
}

const READ_RES = [
  /\benv\.([A-Z][A-Z0-9_]+)\b/g,
  /\benv\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/g,
  /\b(?:secret|str)\(\s*[A-Za-z_.]*env[A-Za-z_]*\s*,\s*"([A-Z][A-Z0-9_]+)"/g,
];

/** Names `src/` reads off the env that `Env` does not declare. */
export function checkSourceReads(
  entries: readonly PlatformInventoryEntry[],
  files: readonly { path: string; text: string }[],
): string[] {
  const known = new Set(entries.map((e) => e.name));
  const errors: string[] = [];
  for (const f of files) {
    if (f.path.endsWith(".generated.ts")) continue;
    const seen = new Set<string>();
    for (const re of READ_RES)
      for (const match of f.text.matchAll(re)) seen.add(match[1]!);
    for (const n of [...seen].sort())
      if (!known.has(n))
        errors.push(`${f.path}: reads env ${n}, which Env does not declare`);
  }
  return errors;
}

export function sourceFiles(root = ROOT): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
        out.push({
          path: relative(root, p).split("\\").join("/"),
          text: readFileSync(p, "utf8"),
        });
    }
  };
  walk(join(root, SRC_DIR));
  return out;
}

export async function renderInventory(
  entries: readonly PlatformInventoryEntry[],
): Promise<string> {
  const source = [
    "// GENERATED by packages/worker/scripts/gen-platform-inventory.ts from the @inventory and",
    "// @editable tags in packages/worker/src/platform/env.ts. DO NOT EDIT.",
    "// Regenerate: pnpm gen platform-inventory",
    "// Freshness: pnpm gen platform-inventory --check (and the worker suite's platformInventory test)",
    "",
    'import type { PlatformInventoryEntry } from "./platformInventory.js";',
    "",
    `export const PLATFORM_INVENTORY: readonly PlatformInventoryEntry[] = ${JSON.stringify(entries, null, 2)};`,
    "",
  ].join("\n");
  const options =
    (await prettier.resolveConfig(join(ROOT, GENERATED_PATH))) ?? {};
  return prettier.format(source, { ...options, parser: "typescript" });
}

export interface InventoryInputs {
  env: string;
  wrangler: string;
  wranglerDeltas: string;
  files: { path: string; text: string }[];
}

export function readInputs(root = ROOT): InventoryInputs {
  return {
    env: readFileSync(join(root, ENV_PATH), "utf8"),
    wrangler: readFileSync(join(root, WRANGLER_PATH), "utf8"),
    wranglerDeltas: readFileSync(join(root, WRANGLER_DELTAS_PATH), "utf8"),
    files: sourceFiles(root),
  };
}

/** Every drift check except freshness. Empty = consistent. */
export function inventoryErrors(inputs: InventoryInputs): {
  entries: PlatformInventoryEntry[];
  errors: string[];
} {
  const { entries, errors } = parseEnvInventory(inputs.env);
  return {
    entries,
    errors: [
      ...errors,
      ...checkWrangler(entries, inputs.wrangler, inputs.wranglerDeltas),
      ...checkSourceReads(entries, inputs.files),
    ],
  };
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const { entries, errors } = inventoryErrors(readInputs());
  if (errors.length > 0) {
    for (const e of errors) console.error(`platform inventory: ${e}`);
    process.exit(1);
  }
  const target = join(ROOT, GENERATED_PATH);
  const content = await renderInventory(entries);
  let current: string | undefined;
  try {
    current = readFileSync(target, "utf8");
  } catch {
    current = undefined;
  }
  if (current === content) {
    console.log(`up to date: ${GENERATED_PATH} (${entries.length} names)`);
    return;
  }
  if (check) {
    console.error(
      `stale: ${GENERATED_PATH} — run \`pnpm gen platform-inventory\``,
    );
    process.exit(1);
  }
  writeFileSync(target, content);
  console.log(`wrote ${GENERATED_PATH} (${entries.length} names)`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
