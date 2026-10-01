// The service-table generator (P0-09).
//
//   pnpm gen:services              # (re)write every generated service file
//   pnpm gen:services -- --check   # regenerate in memory; exit 1 if any file differs
//
// Input: tools/services.json — one row per opt-in service, in canonical order. Core is not a
// service and has no row.
//
// Output: the files below, each with a GENERATED banner. They are committed on purpose (the
// packages build without running this, and a diff is reviewable), and `--check` is the drift
// gate in the green gate, CI and the pre-commit hook, so a hand edit fails before it ships.
//
// WHY GENERATED FILES AND NOT ONE IMPORT. The Worker and the CLI already depend on
// `@polaris-key/manifest`, so they import the manifest package's generated file. The console and
// the SDKs do not, and must not grow a dependency on a manifest parser, so each gets its own
// file. `client-core` is deliberately not a target: touching it is plan mode, and nothing here
// needs it.
//
// WHAT IS NOT GENERATED. Coherence error CODES (`update_requires_distribution`) stay literal in both
// validators: the rule-9 parity test extracts codes from validator SOURCE, so a code built from
// table data would vanish from its sweep. Views, descriptors, docs pages and accent CSS are real
// code. For each of those an assertion test names what a new row is missing instead; see the
// "Adding a service" checklist at /docs/contribute/layout/#adding-a-service.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

// ── The table ──────────────────────────────────────────────────────────────────────────────

export interface ServiceRow {
  /** Wire and route slug: `/<product>/<slug>/…`, `services.<slug>` in discovery. */
  slug: string;
  /** Human label (console, docs sidebar). */
  label: string;
  /** One sentence: the console's Services card text. */
  summary: string;
  /** Whether a product that never declared its services runs this one. */
  defaultEnabled: boolean;
  /** Coherence edges: this service may only be on while each of these is on. */
  requires: string[];
  /** Legacy `.pkey/product` `modules:` names that enable this service. */
  legacyModules: string[];
  console: {
    /** The `data-service` accent token (License is `key`, Identity is `id`). */
    accent: string;
    /** A lucide-react icon name for the Services card. */
    icon: string;
  };
  /** The service's docs section, site-absolute with a trailing slash. */
  docs: string;
}

export interface ServiceTable {
  $comment?: string;
  services: ServiceRow[];
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TABLE_PATH = join(ROOT, "tools", "services.json");

const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MODULE_RE = /^[a-z][A-Za-z0-9]*$/;
const ICON_RE = /^[A-Z][A-Za-z0-9]*$/;
/** Names a slug may never take: Core's own namespace and the discovery blob's other key. */
const RESERVED = new Set(["core", "registration", "__proto__"]);

/** Every structural rule the generated code relies on. Empty = valid. */
export function validateTable(table: unknown): string[] {
  const errors: string[] = [];
  const t = table as ServiceTable;
  if (!t || typeof t !== "object" || !Array.isArray(t.services)) {
    return ["the table must be an object with a `services` array"];
  }
  if (t.services.length === 0) errors.push("the table has no services");
  const slugs = new Set<string>();
  const accents = new Set<string>();
  for (const [i, row] of t.services.entries()) {
    const at = `services[${i}]`;
    if (!row || typeof row !== "object") {
      errors.push(`${at}: not an object`);
      continue;
    }
    if (typeof row.slug !== "string" || !SLUG_RE.test(row.slug)) {
      errors.push(`${at}.slug: must match ${SLUG_RE}`);
      continue;
    }
    if (RESERVED.has(row.slug))
      errors.push(`${at}.slug: "${row.slug}" is reserved`);
    if (slugs.has(row.slug)) errors.push(`${at}.slug: duplicate "${row.slug}"`);
    slugs.add(row.slug);
    for (const key of ["label", "summary"] as const) {
      if (typeof row[key] !== "string" || row[key].trim() === "")
        errors.push(`${at}.${key}: must be a non-empty string`);
    }
    if (typeof row.defaultEnabled !== "boolean")
      errors.push(`${at}.defaultEnabled: must be a boolean`);
    if (!Array.isArray(row.requires))
      errors.push(`${at}.requires: must be an array`);
    if (!Array.isArray(row.legacyModules))
      errors.push(`${at}.legacyModules: must be an array`);
    const accent = row.console?.accent;
    if (typeof accent !== "string" || !SLUG_RE.test(accent)) {
      errors.push(`${at}.console.accent: must match ${SLUG_RE}`);
    } else {
      if (accent === "core")
        errors.push(`${at}.console.accent: "core" is the platform section's`);
      if (accents.has(accent))
        errors.push(`${at}.console.accent: duplicate "${accent}"`);
      accents.add(accent);
    }
    if (
      typeof row.console?.icon !== "string" ||
      !ICON_RE.test(row.console.icon)
    )
      errors.push(`${at}.console.icon: must be a lucide-react icon name`);
    if (row.docs !== `/docs/services/${row.slug}/`)
      errors.push(`${at}.docs: must be "/docs/services/${row.slug}/"`);
  }
  // Cross-row rules, once every slug is known.
  for (const [i, row] of t.services.entries()) {
    if (!row || typeof row !== "object" || typeof row.slug !== "string")
      continue;
    const at = `services[${i}]`;
    for (const req of Array.isArray(row.requires) ? row.requires : []) {
      if (!slugs.has(req)) errors.push(`${at}.requires: unknown slug "${req}"`);
      if (req === row.slug)
        errors.push(`${at}.requires: a service cannot require itself`);
    }
    for (const mod of Array.isArray(row.legacyModules)
      ? row.legacyModules
      : []) {
      if (typeof mod !== "string" || !MODULE_RE.test(mod)) {
        errors.push(
          `${at}.legacyModules: "${String(mod)}" is not a module name`,
        );
        continue;
      }
      if (slugs.has(mod))
        errors.push(
          `${at}.legacyModules: "${mod}" is a service slug, not a legacy name`,
        );
    }
  }
  return errors;
}

export function loadTable(path = TABLE_PATH): ServiceTable {
  const table = JSON.parse(readFileSync(path, "utf8")) as ServiceTable;
  const errors = validateTable(table);
  if (errors.length > 0) {
    throw new Error(
      `${relative(ROOT, path)} is invalid:\n  ${errors.join("\n  ")}`,
    );
  }
  return table;
}

// ── Derived views ──────────────────────────────────────────────────────────────────────────

/** Legacy module names in first-appearance order, each with the slugs it enables. */
export function legacyModuleMap(table: ServiceTable): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of table.services) {
    for (const mod of row.legacyModules) {
      const slugs = out.get(mod) ?? [];
      slugs.push(row.slug);
      out.set(mod, slugs);
    }
  }
  return out;
}

const q = (s: string): string => JSON.stringify(s);
const union = (xs: readonly string[]): string =>
  xs.length === 0 ? "never" : xs.map(q).join(" | ");
const list = (xs: readonly string[]): string => `[${xs.map(q).join(", ")}]`;

function banner(comment: string): string {
  return [
    `${comment} GENERATED FILE — do not edit by hand.`,
    comment,
    `${comment} Written by \`pnpm gen:services\` (tools/gen-services.ts) from tools/services.json, the`,
    `${comment} one declaration of the opt-in services. \`pnpm gen:services -- --check\` fails the green`,
    `${comment} gate on any difference. To change a service, edit the table and regenerate.`,
    "",
  ].join("\n");
}

// ── Renderers ──────────────────────────────────────────────────────────────────────────────

/** The part every TypeScript target shares: the slug type, its order, and the defaults. */
function tsCore(table: ServiceTable): string {
  const slugs = table.services.map((r) => r.slug);
  const defaults = table.services
    .filter((r) => r.defaultEnabled)
    .map((r) => r.slug);
  return `
/** The opt-in services. Core is not a service — it is always on. */
export type ServiceSlug = ${union(slugs)};

/** Canonical order. Iterate this rather than \`Object.keys\` so output is stable. */
export const SERVICE_SLUGS: readonly ServiceSlug[] = ${list(slugs)};

/**
 * What a product runs when it has never said otherwise, in canonical order. Every other service
 * is opt-in because it needs coordinates (a linked repo, an IdP) a default cannot invent.
 */
export const DEFAULT_ENABLED_SERVICES: readonly ServiceSlug[] = ${list(defaults)};
`;
}

function tsRequires(table: ServiceTable): string {
  const entries = table.services
    .map((r) => `  ${q(r.slug)}: ${list(r.requires)},`)
    .join("\n");
  return `
/**
 * Coherence edges: a service may only be enabled while every service it lists is. Each edge
 * \`<a> → <b>\` has a LITERAL \`<a>_requires_<b>\` error code in the validators (rule 9 reads
 * codes from source), which a test asserts.
 */
export const SERVICE_REQUIRES: Readonly<Record<ServiceSlug, readonly ServiceSlug[]>> = {
${entries}
};
`;
}

export function renderManifestTs(table: ServiceTable): string {
  const legacy = legacyModuleMap(table);
  const legacyNames = [...legacy.keys()];
  const moduleEntries = [
    ...[...legacy].map(([mod, slugs]) => `  ${mod}: ${list(slugs)},`),
    ...table.services.map((r) => `  ${q(r.slug)}: ${list([r.slug])},`),
  ].join("\n");
  return `${banner("//")}${tsCore(table)}${tsRequires(table)}
/** The legacy \`.pkey/product\` \`modules:\` vocabulary (design spec §2.1). */
export type LegacyModule = ${union(legacyNames)};

/** What a \`modules:\` block may name: a legacy module name or a service slug. */
export type ProductModule = LegacyModule | ServiceSlug;

/**
 * Every module name a \`modules:\` block may use, mapped to the service slug(s) it enables:
 * legacy names first (in table order), then each slug mapping to itself.
 */
export const MODULE_SERVICES: Readonly<Record<ProductModule, readonly ServiceSlug[]>> = {
${moduleEntries}
};
`;
}

export function renderAdminTs(table: ServiceTable): string {
  const accents = table.services.map((r) => r.console.accent);
  const icons = [...new Set(table.services.map((r) => r.console.icon))];
  const rows = table.services
    .map(
      (r) => `  {
    slug: ${q(r.slug)},
    label: ${q(r.label)},
    summary: ${q(r.summary)},
    accent: ${q(r.console.accent)},
    icon: ${q(r.console.icon)},
    docs: ${q(r.docs)},
    defaultEnabled: ${r.defaultEnabled},
    requires: ${list(r.requires)},
  },`,
    )
    .join("\n");
  return `${banner("//")}${tsCore(table)}${tsRequires(table)}
/** A service section's \`data-service\` accent token (D-17). The platform section's \`core\` is
 *  not a service and is added by the nav model, not here. */
export type ServiceAccentToken = ${union(accents)};

/** The lucide-react icon each service's row uses. \`ServicesCard\` maps every name to a
 *  component, so a new icon here is a type error until it is imported there. */
export type ServiceIconName = ${union(icons)};

export interface ServiceTableRow {
  slug: ServiceSlug;
  label: string;
  /** The Services card text. */
  summary: string;
  accent: ServiceAccentToken;
  icon: ServiceIconName;
  /** The service's docs section. */
  docs: string;
  defaultEnabled: boolean;
  requires: readonly ServiceSlug[];
}

/** The service table, in canonical order. */
export const SERVICE_TABLE: readonly ServiceTableRow[] = [
${rows}
];
`;
}

export function renderSdkTs(table: ServiceTable): string {
  return `${banner("//")}${tsCore(table)}`;
}

export function renderPython(table: ServiceTable): string {
  const slugs = table.services.map((r) => r.slug);
  const defaults = table.services
    .filter((r) => r.defaultEnabled)
    .map((r) => r.slug);
  const tuple = (xs: string[]): string =>
    xs.length === 1 ? `(${q(xs[0]!)},)` : `(${xs.map(q).join(", ")})`;
  return `${banner("#")}"""The opt-in Polaris Key services, generated from the service table."""

from __future__ import annotations

from typing import Tuple

#: The opt-in services, in canonical order. Core is not a service — it is always on.
SERVICE_SLUGS: Tuple[str, ...] = ${tuple(slugs)}

#: What a product runs when it has never said otherwise, in canonical order.
DEFAULT_ENABLED_SERVICES: Tuple[str, ...] = ${tuple(defaults)}
`;
}

/** GDScript (the Godot SDK): a `PKeyServices` class of two constant arrays. */
export function renderGdscript(table: ServiceTable): string {
  const slugs = table.services.map((r) => r.slug);
  const defaults = table.services
    .filter((r) => r.defaultEnabled)
    .map((r) => r.slug);
  const list = (xs: string[]): string => `[${xs.map(q).join(", ")}]`;
  return `${banner("#")}class_name PKeyServices
extends RefCounted
## The opt-in Polaris Key services, generated from the service table.

## The opt-in services, in canonical order. Core is not a service — it is always on.
const SLUGS := ${list(slugs)}

## What a product runs when it has never said otherwise, in canonical order.
const DEFAULT_ENABLED := ${list(defaults)}
`;
}

export const SWIFT_KEYWORDS = new Set([
  "associatedtype",
  "class",
  "deinit",
  "enum",
  "extension",
  "fileprivate",
  "func",
  "import",
  "init",
  "inout",
  "internal",
  "let",
  "open",
  "operator",
  "private",
  "protocol",
  "public",
  "rethrows",
  "static",
  "struct",
  "subscript",
  "typealias",
  "var",
  "break",
  "case",
  "continue",
  "default",
  "defer",
  "do",
  "else",
  "fallthrough",
  "for",
  "guard",
  "if",
  "in",
  "repeat",
  "return",
  "switch",
  "where",
  "while",
  "as",
  "catch",
  "false",
  "is",
  "nil",
  "self",
  "super",
  "throw",
  "throws",
  "true",
  "try",
]);

/** A slug as a Swift enum case name: camelCase, back-ticked if it is a keyword. */
export function swiftCase(slug: string): string {
  const name = slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name;
}

export function renderSwift(table: ServiceTable): string {
  const cases = table.services
    .map((r) => {
      const name = swiftCase(r.slug);
      const bare = name.replace(/`/g, "");
      return bare === r.slug
        ? `    case ${name}`
        : `    case ${name} = ${q(r.slug)}`;
    })
    .join("\n");
  const on = table.services.filter((r) => r.defaultEnabled);
  const off = table.services.filter((r) => !r.defaultEnabled);
  const arm = (rows: ServiceRow[], value: boolean): string[] =>
    rows.length === 0
      ? []
      : [
          `        case ${rows.map((r) => `.${swiftCase(r.slug)}`).join(", ")}: return ${value}`,
        ];
  return `${banner("//")}
/// The opt-in services, in canonical order. Core is not a service — it is always on.
public enum ServiceSlug: String, Sendable, Codable, Equatable, CaseIterable {
${cases}

    /// Whether a product runs this service when it has never said otherwise.
    public var isDefaultEnabled: Bool {
        switch self {
${[...arm(on, true), ...arm(off, false)].join("\n")}
        }
    }
}
`;
}

// ── Targets ────────────────────────────────────────────────────────────────────────────────

export interface Target {
  /** Repo-relative path. */
  path: string;
  render: (table: ServiceTable) => string;
  /** Prettier parser, for the targets `pnpm lint` checks. */
  parser?: "typescript";
}

export const TARGETS: readonly Target[] = [
  {
    path: "packages/shared-manifest/src/services.generated.ts",
    render: renderManifestTs,
    parser: "typescript",
  },
  {
    path: "packages/admin/src/services.generated.ts",
    render: renderAdminTs,
    parser: "typescript",
  },
  {
    path: "packages/sdk-node/src/services.generated.ts",
    render: renderSdkTs,
    parser: "typescript",
  },
  {
    path: "packages/sdk-react/src/core/services.generated.ts",
    render: renderSdkTs,
    parser: "typescript",
  },
  {
    path: "sdks/python/src/polaris_key/_services.py",
    render: renderPython,
  },
  {
    path: "sdks/swift/Sources/PolarisKeyCore/ServiceSlug.generated.swift",
    render: renderSwift,
  },
  {
    path: "sdks/godot/addons/polaris_key/core/services_generated.gd",
    render: renderGdscript,
  },
];

/** Every generated file's content, keyed by repo-relative path. */
export async function renderAll(
  table: ServiceTable,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const target of TARGETS) {
    let content = target.render(table);
    if (target.parser) {
      const options =
        (await prettier.resolveConfig(join(ROOT, target.path))) ?? {};
      content = await prettier.format(content, {
        ...options,
        parser: target.parser,
      });
    }
    out.set(target.path, content);
  }
  return out;
}

/** Write (or, with `check`, compare) every target. Returns the stale paths. */
export async function run(opts: {
  check: boolean;
  root?: string;
  table?: ServiceTable;
}): Promise<string[]> {
  const root = opts.root ?? ROOT;
  const table = opts.table ?? loadTable();
  const stale: string[] = [];
  for (const [path, content] of await renderAll(table)) {
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
  let stale: string[];
  try {
    stale = await run({ check });
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  if (check) {
    for (const path of stale)
      console.error(`stale: ${path} — run \`pnpm gen:services\``);
    if (stale.length > 0) process.exit(1);
    console.log(`up to date: ${TARGETS.length} generated service files`);
    return;
  }
  for (const path of stale) console.log(`wrote ${path}`);
  if (stale.length === 0) console.log("nothing to write");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
