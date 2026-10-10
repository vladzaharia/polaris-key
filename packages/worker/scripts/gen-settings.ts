/**
 * The settings reference generator and drift gate (ST-06, notes/S-18 §4.13 item 3).
 *
 *   pnpm gen settings              # rewrite both outputs
 *   pnpm gen settings --check   # exit 1 when either output is stale, write nothing
 *
 * The source is the settings registry as the composition root assembles it (`mount.ts`
 * `SETTINGS`: the platform slice, Core's slice and every service's slice) plus the
 * `NOT_A_SETTING` rows of `scripts/settings-coverage.ts`. It writes:
 *
 *   1. `packages/docs/src/content/docs/reference/settings.mdx`: the generated reference page
 *      (GENERATED banner, AGENTS.md rule 3), one table per scope and service;
 *   2. `packages/admin/src/console/settings.generated.ts`: the console's settings search index
 *      (⌘K, ST-10), one record per entry plus the fixed-on-purpose rows search explains.
 *
 * The worker suite's `test/settings-generated.test.ts` byte-compares both outputs, so `pnpm test`
 * fails on a stale page as well.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { SETTINGS } from "../src/mount.js";
import { NOT_A_SETTING } from "./settings-coverage.js";
import type { NotASetting } from "./settings-coverage.js";
import type {
  SettingConfirm,
  SettingDef,
  ValueSpec,
} from "../src/core/settings/types.js";

export const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
export const DOCS_PATH =
  "packages/docs/src/content/docs/reference/settings.mdx";
export const INDEX_PATH = "packages/admin/src/console/settings.generated.ts";

/** Product-scope sections, in the order the console's services appear. */
const OWNER_TITLES: Readonly<Record<string, string>> = {
  core: "Core",
  license: "License",
  config: "Config",
  release: "Release",
  update: "Update",
  distribution: "Distribution",
  identity: "Identity",
};

// ── formatting helpers ─────────────────────────────────────────────────────────

/** A table cell: no pipes, no newlines, and nothing MDX would read as JSX or an expression. */
function cell(s: string): string {
  return s
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .replace(/([{}<])/g, "\\$1");
}

/** Inline code for a cell (braces are literal inside a code span; pipes still need escaping). */
function code(s: string): string {
  return `\`${s.replace(/\|/g, "\\|")}\``;
}

function table(headers: readonly string[], rows: readonly string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

const UNIT_WORDS: Readonly<Record<string, string>> = {
  bytes: "bytes",
  days: "days",
  hours: "hours",
  months: "months",
  count: "",
  perDay: "per day",
  perHour: "per hour",
};

export function describeValue(v: ValueSpec): string {
  switch (v.kind) {
    case "switch":
      return "on or off";
    case "boolean":
      return "true or false";
    case "integer": {
      const unit = UNIT_WORDS[v.unit] ?? v.unit;
      return `integer ${v.min}–${v.max}${unit ? ` ${unit}` : ""}`;
    }
    case "enum":
      return `one of ${v.values.map((x) => `\`${x}\``).join(", ")}`;
    case "string":
      return `text, at most ${v.maxLength} characters`;
    case "list":
      return `list of up to ${v.max}: ${describeValue(v.of)}`;
    case "json":
      return `structured (${v.schema})`;
  }
}

function describeDefault(e: SettingDef): string {
  if (e.sensitivity === "secret") return "—";
  if (e.defaultValue === null) return e.allowUnset ? "unset" : "—";
  const json = JSON.stringify(e.defaultValue);
  const value = json.length > 60 ? "structured" : code(json);
  if (!e.legacyDefault) return value;
  // LX-06: a derived default (plans/LX-01.md §8 Q2), shown with its cut-over date.
  const before = new Date(e.legacyDefault.createdBefore * 1000)
    .toISOString()
    .slice(0, 10);
  return `${value} (${code(JSON.stringify(e.legacyDefault.value))} for products registered before ${before})`;
}

export function describeConfirm(c: SettingConfirm): string {
  if ("change" in c) return `${c.change} on change`;
  if ("on" in c) return c.on === c.off ? c.on : `${c.on} on, ${c.off} off`;
  return c.up === c.down ? c.up : `${c.up} up, ${c.down} down`;
}

function describeMerge(e: SettingDef): string {
  const parts: string[] = [e.merge];
  if (e.policyBound) parts.push(`bound: ${e.policyBound}`);
  if (e.inherits) parts.push("inherits platform");
  if (e.precedence) parts.push(`deploy: ${e.precedence}`);
  return parts.join(", ");
}

function notes(e: SettingDef): string {
  const n: string[] = [];
  if (e.pending) n.push(`registered ahead of ${e.pending.wp}`);
  if (e.critical) n.push("reason required");
  if (e.securityWidening) n.push("security-widening");
  if (e.systemLock)
    n.push(
      `locked to ${code(JSON.stringify(e.systemLock.value))} for the system product`,
    );
  if (e.sensitivity === "secret") n.push("secret: presence only");
  if (e.wire?.length) n.push(`devices see it (${e.wire.join(", ")})`);
  if (e.aliases?.length)
    n.push(`also ${e.aliases.map((a) => code(a)).join(", ")}`);
  if (e.deprecated) n.push(`deprecated: use ${code(e.deprecated.replacedBy)}`);
  return n.join("; ") || "—";
}

/** The setting's name, linked to the page that explains it, then its description. */
function nameCell(e: SettingDef): string {
  return `[${cell(e.label)}](${e.docs}): ${cell(e.description)}`;
}

// ── the docs page ──────────────────────────────────────────────────────────────

function platformTable(entries: readonly SettingDef[]): string {
  return table(
    [
      "Key",
      "Setting",
      "Value",
      "Default",
      "Merge",
      "Deploy var",
      "Confirm",
      "Notes",
    ],
    entries.map((e) => [
      code(e.key),
      nameCell(e),
      cell(describeValue(e.value)),
      describeDefault(e),
      cell(describeMerge(e)),
      e.varName ? code(e.varName) : "—",
      describeConfirm(e.confirm),
      notes(e),
    ]),
  );
}

function productTable(entries: readonly SettingDef[]): string {
  return table(
    [
      "Key",
      "Setting",
      "Value",
      "Default",
      "Merge",
      "Ownership",
      "Manifest",
      "Confirm",
      "Notes",
    ],
    entries.map((e) => [
      code(e.key),
      nameCell(e),
      cell(describeValue(e.value)),
      describeDefault(e),
      cell(describeMerge(e)),
      e.ownership,
      e.manifest
        ? [e.manifest.path, ...(e.manifest.alsoPaths ?? [])]
            .map((p) => code(p))
            .join(", ")
        : "—",
      describeConfirm(e.confirm),
      notes(e),
    ]),
  );
}

export function renderDocsPage(
  entries: readonly SettingDef[],
  notASetting: readonly NotASetting[],
): string {
  const platform = entries.filter((e) => e.scope === "platform");
  const product = entries.filter((e) => e.scope === "product");
  const entity = entries.filter((e) => e.scope === "entity");
  const owners = [...new Set(product.map((e) => e.service))];
  const pending = entries.filter((e) => e.pending).length;

  const sections: string[] = [
    "## Platform",
    "",
    "One value per deployment, edited under **Platform → Settings**. A deploy var, where one is named, is the value before any console edit; `deploy: ceiling` means a deploy-time `off` is a hard off the console cannot turn on.",
    "",
    platformTable(platform),
    "",
    "## Product",
    "",
    "One value per product. A service's settings are product settings whose key starts with the service's namespace; they are shown while the service is on.",
  ];
  for (const owner of owners) {
    const title = OWNER_TITLES[owner] ?? owner;
    sections.push(
      "",
      `### ${title}`,
      "",
      productTable(product.filter((e) => e.service === owner)),
    );
  }
  sections.push(
    "",
    "## Entity",
    "",
    entity.length
      ? productTable(entity)
      : "No entity-scope settings (a tier, licence, channel, feed, outlet or pack) are registered yet; their values are edited on the entity's own page.",
    "",
    "## Fixed on purpose",
    "",
    "Things that look configurable but are not settings, and why. The coverage test (`settings-coverage.test.ts`) accepts nothing else without a registry entry.",
    "",
    table(
      ["Thing", "Why it is not a setting", "Where it shows"],
      notASetting.map((n) => [cell(n.thing), cell(n.reason), cell(n.shows)]),
    ),
  );

  return `---
title: "Settings reference"
description: "Every platform, product and service setting in the settings registry: its key, value, default, merge rule, ownership, manifest field and confirmation level."
---

{/* GENERATED PAGE — do not edit. Regenerate with \`pnpm gen settings\`.
    Source of truth: the settings registry (packages/worker/src/core/settings/ and each service's
    settings.ts), emitted by packages/worker/scripts/gen-settings.ts. */}

The settings registry describes every setting Polaris Key has: ${entries.length} entries (${platform.length} platform, ${product.length} product, ${entity.length} entity)${pending ? `, ${pending} of them registered ahead of the work package that wires them` : ""}. This page is generated from the registry and checked against it in CI, so it cannot drift from it. An entry registered ahead of its work package is not offered in the console yet.

How to read the columns:

- **Merge**: \`cascade\`, the nearest scope wins; \`policy\`, a higher scope bounds the value (\`bound: max\` caps it, \`min\` floors it, \`lock\` fixes it).
- **Ownership**: \`operator\`, set in the console or the API; \`manifest\`, set only in \`.pkey/\` (the console shows it read-only); \`claimable\`, seeded by the manifest, and a console edit claims it until **Revert**; \`narrow-only\`, the console may only narrow the manifest's value; \`read-only\`, a code constant, deploy value or derived value.
- **Manifest**: the \`.pkey/\` field as \`<document>:<path>\`.
- **Confirm**: the confirmation a change needs, by the console's destructive levels: L0 none (an undo toast), L1 a confirmation listing the consequences, L2 a danger confirmation, L3 a typed confirmation. \`reason required\` adds a reason to every write.

${sections.join("\n")}
`;
}

// ── the console search index ───────────────────────────────────────────────────

export interface SettingsIndexEntry {
  key: string;
  aliases: string[];
  scope: SettingDef["scope"];
  entity: SettingDef["entity"] | null;
  service: string;
  area: string;
  label: string;
  description: string;
  keywords: string[];
  docs: string;
  ownership: SettingDef["ownership"];
  critical: boolean;
  secret: boolean;
  pending: string | null;
  deprecated: string | null;
}

export function indexEntries(
  entries: readonly SettingDef[],
): SettingsIndexEntry[] {
  return entries.map((e) => ({
    key: e.key,
    aliases: [...(e.aliases ?? [])],
    scope: e.scope,
    entity: e.entity ?? null,
    service: e.service,
    area: e.area,
    label: e.label,
    description: e.description,
    keywords: [...(e.keywords ?? [])],
    docs: e.docs,
    ownership: e.ownership,
    critical: e.critical === true,
    secret: e.sensitivity === "secret",
    pending: e.pending?.wp ?? null,
    deprecated: e.deprecated?.replacedBy ?? null,
  }));
}

export async function renderIndex(
  entries: readonly SettingDef[],
  notASetting: readonly NotASetting[],
): Promise<string> {
  const fixed = notASetting.map((n) => ({
    thing: n.thing,
    reason: n.reason,
    shows: n.shows,
  }));
  const source = [
    "// GENERATED by packages/worker/scripts/gen-settings.ts from the settings registry",
    "// (packages/worker/src/core/settings/ and each service's settings.ts). DO NOT EDIT.",
    "// Regenerate: pnpm gen settings",
    "// Freshness: pnpm gen settings --check (and the worker suite's settings-generated test)",
    "",
    "/** One registry entry, as the console's settings search (⌘K) indexes it. */",
    "export interface SettingsIndexEntry {",
    "  /** `<namespace>.<group>.<name>`; the same key may appear at platform and product scope. */",
    "  key: string;",
    "  /** Older spellings that resolve to this entry (A-13's SCREAMING_CASE names). */",
    "  aliases: readonly string[];",
    '  scope: "platform" | "product" | "entity";',
    "  entity: string | null;",
    "  /** The owner: a service slug, `core`, or `platform`. */",
    "  service: string;",
    "  /** The settings-hub section the row lives in. */",
    "  area: string;",
    "  label: string;",
    "  description: string;",
    "  keywords: readonly string[];",
    "  /** The docs page that explains it. */",
    "  docs: string;",
    '  ownership: "operator" | "manifest" | "claimable" | "narrow-only" | "read-only";',
    "  critical: boolean;",
    "  secret: boolean;",
    "  /** Registered ahead of this work package: no row offers it yet. */",
    "  pending: string | null;",
    "  /** The key that replaces it, when deprecated. */",
    "  deprecated: string | null;",
    "}",
    "",
    "/** A thing that looks configurable but is fixed on purpose; search explains it. */",
    "export interface NotASettingEntry {",
    "  thing: string;",
    "  reason: string;",
    "  shows: string;",
    "}",
    "",
    `export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = ${JSON.stringify(indexEntries(entries), null, 2)};`,
    "",
    `export const NOT_A_SETTING_INDEX: readonly NotASettingEntry[] = ${JSON.stringify(fixed, null, 2)};`,
    "",
  ].join("\n");
  const options = (await prettier.resolveConfig(join(ROOT, INDEX_PATH))) ?? {};
  return prettier.format(source, { ...options, parser: "typescript" });
}

/** Both outputs, rendered from the live registry: `{ path: content }`. */
export async function renderAll(): Promise<Record<string, string>> {
  return {
    [DOCS_PATH]: renderDocsPage(SETTINGS.entries, NOT_A_SETTING),
    [INDEX_PATH]: await renderIndex(SETTINGS.entries, NOT_A_SETTING),
  };
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [path, content] of Object.entries(await renderAll())) {
    const target = join(ROOT, path);
    let current: string | undefined;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) {
      console.log(`up to date: ${path}`);
      continue;
    }
    if (check) {
      console.error(`stale: ${path} — run \`pnpm gen settings\``);
      stale += 1;
      continue;
    }
    writeFileSync(target, content);
    console.log(`wrote ${path}`);
  }
  if (stale) process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
