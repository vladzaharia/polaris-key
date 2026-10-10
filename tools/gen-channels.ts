// The distribution-channel catalogue generator (A-19).
//
//   pnpm gen channels            # (re)write the generated channel table
//   pnpm gen channels --check    # regenerate in memory; exit 1 if it differs
//
// Input: tools/channels.json, the one catalogue of the places builds reach customers (ids, aliases,
// labels, family, plane, platforms, formats, deliverable kinds, customer action, verbs, auto and
// human steps, and an optional storefront facet). Output: packages/shared-manifest/src/
// channels.generated.ts. The Worker, the CLI and the console already depend on
// `@polaris-key/manifest`, so they read the table through it; no package grows its own copy.
//
// WHAT IS NOT GENERATED. Behaviour. A storefront adapter binds to its entry by id, and
// the two-way conformance test (tools/gen-channels.test.ts) fails
// when an adapter has no entry or an entry names an adapter that does not exist. Outlet kinds stay the
// wire's: `outlet.kind` must be one of OUTLET_KINDS and `platforms` a subset of OUTLET_PLATFORMS
// (asserted by the test, which may read the protocol package; the generator stays free of it).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

export const FAMILIES = [
  "first-party",
  "apple",
  "google",
  "microsoft",
  "pc-store",
  "linux",
  "package-manager",
  "sideload",
  "web",
] as const;
/** Where the work runs: the Worker calls the store's API, CI runs its tool, a PR goes to its repo, or a feed serves it. */
export const PLANES = ["worker", "ci", "pr", "feed"] as const;
/** What the customer does to get the build. */
export const CUSTOMER_ACTIONS = [
  "install",
  "open-listing",
  "add-source",
  "download",
  "run-command",
  "open-in-browser",
] as const;
export const DELIVERABLE_KINDS = ["app", "pack", "package"] as const;
export const PLATFORMS = [
  "macos",
  "ios",
  "android",
  "windows",
  "linux",
  "web",
] as const;
/** The storefront operations (mirrors STOREFRONT_OPS in the Worker; a test keeps them equal). */
export const VERBS = [
  "connect",
  "listApps",
  "identifiers",
  "createApp",
  "readListing",
  "writeListingText",
  "writeListingAssets",
  "category",
  "contentRating",
  "privacyDeclarations",
  "pricing",
  "iap",
  "testers",
  "uploadBuild",
  "notificationsUrl",
  "submit",
  "release",
  "rollout",
  "status",
] as const;

export interface ChannelStorefront {
  /** The storefront adapter id this channel binds to. */
  adapter: string;
  /** The team credential slot that connects it (a PLATFORM_CREDENTIALS id), or null when keyless. */
  credential: string | null;
  /** The credential slot that verifies purchases, when commerce differs from `credential`. */
  verification?: string;
  /** The store's server-to-server notification kind. */
  notification?: string;
  /** The kind of SKU the store sells. */
  sku?: string;
}

export interface ChannelRow {
  id: string;
  aliases: string[];
  label: string;
  family: (typeof FAMILIES)[number];
  plane: (typeof PLANES)[number];
  outlet: { kind: string; subkind?: string };
  platforms: string[];
  formats: string[];
  deliverableKinds: string[];
  customerAction: (typeof CUSTOMER_ACTIONS)[number];
  verbs: string[];
  auto: string[];
  human: string[];
  storefront: ChannelStorefront | null;
}

export interface ChannelTable {
  $comment?: string;
  channels: ChannelRow[];
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TABLE_PATH = join(ROOT, "tools", "channels.json");
export const OUTPUT_PATH = "packages/shared-manifest/src/channels.generated.ts";
export const DOC_PATH = "packages/docs/src/content/docs/reference/channels.mdx";

const ID_RE = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;
const WORD_RE = /^[a-z0-9][a-z0-9.-]*$/;

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Every structural rule the generated code relies on. Empty = valid. */
export function validateTable(table: unknown): string[] {
  const errors: string[] = [];
  const t = table as ChannelTable;
  if (!t || typeof t !== "object" || !Array.isArray(t.channels))
    return ["the table must be an object with a `channels` array"];
  if (t.channels.length === 0) return ["the table has no channels"];
  const names = new Map<string, string>();
  const claim = (name: string, at: string): void => {
    const prev = names.get(name);
    if (prev) errors.push(`${at}: "${name}" is already ${prev}`);
    else names.set(name, at);
  };
  for (const [i, row] of t.channels.entries()) {
    const at = `channels[${i}]`;
    if (!row || typeof row !== "object") {
      errors.push(`${at}: not an object`);
      continue;
    }
    if (typeof row.id !== "string" || !ID_RE.test(row.id)) {
      errors.push(`${at}.id: must match ${ID_RE}`);
      continue;
    }
    claim(row.id, `${at}.id`);
    if (!strings(row.aliases)) errors.push(`${at}.aliases: must be strings`);
    else
      for (const a of row.aliases) {
        if (!ID_RE.test(a)) errors.push(`${at}.aliases: "${a}" is not an id`);
        claim(a, `${at}.aliases`);
      }
    if (typeof row.label !== "string" || row.label.trim() === "")
      errors.push(`${at}.label: must be a non-empty string`);
    const oneOf = (
      key: string,
      value: unknown,
      allowed: readonly string[],
    ): void => {
      if (typeof value !== "string" || !allowed.includes(value))
        errors.push(`${at}.${key}: must be one of ${allowed.join(", ")}`);
    };
    oneOf("family", row.family, FAMILIES);
    oneOf("plane", row.plane, PLANES);
    oneOf("customerAction", row.customerAction, CUSTOMER_ACTIONS);
    if (typeof row.outlet?.kind !== "string" || !ID_RE.test(row.outlet.kind))
      errors.push(`${at}.outlet.kind: must be an outlet kind`);
    const lists: [string, unknown, readonly string[] | null][] = [
      ["platforms", row.platforms, PLATFORMS],
      ["deliverableKinds", row.deliverableKinds, DELIVERABLE_KINDS],
      ["verbs", row.verbs, VERBS],
      ["formats", row.formats, null],
      ["auto", row.auto, null],
      ["human", row.human, null],
    ];
    for (const [key, value, allowed] of lists) {
      if (!strings(value)) {
        errors.push(`${at}.${key}: must be an array of strings`);
        continue;
      }
      if (new Set(value).size !== value.length)
        errors.push(`${at}.${key}: has a duplicate`);
      for (const v of value) {
        if (allowed ? !allowed.includes(v) : !WORD_RE.test(v))
          errors.push(`${at}.${key}: "${v}" is not allowed`);
      }
    }
    if (strings(row.platforms) && row.platforms.length === 0)
      errors.push(`${at}.platforms: must not be empty`);
    if (strings(row.deliverableKinds) && row.deliverableKinds.length === 0)
      errors.push(`${at}.deliverableKinds: must not be empty`);
    const sf = row.storefront;
    if (sf !== null) {
      if (!sf || typeof sf !== "object" || typeof sf.adapter !== "string") {
        errors.push(`${at}.storefront: must be null or carry an adapter id`);
      } else {
        if (sf.credential !== null && typeof sf.credential !== "string")
          errors.push(`${at}.storefront.credential: string or null`);
        for (const k of ["verification", "notification", "sku"] as const)
          if (sf[k] !== undefined && typeof sf[k] !== "string")
            errors.push(`${at}.storefront.${k}: must be a string`);
        if (row.plane === "feed")
          errors.push(`${at}: a feed channel has no storefront adapter`);
      }
    }
  }
  return errors;
}

export function loadTable(path = TABLE_PATH): ChannelTable {
  const table = JSON.parse(readFileSync(path, "utf8")) as ChannelTable;
  const errors = validateTable(table);
  if (errors.length > 0)
    throw new Error(
      `${relative(ROOT, path)} is invalid:\n  ${errors.join("\n  ")}`,
    );
  return table;
}

const q = (s: string): string => JSON.stringify(s);
const union = (xs: readonly string[]): string => xs.map(q).join(" | ");
const list = (xs: readonly string[]): string => `[${xs.map(q).join(", ")}]`;

export function renderManifestTs(table: ChannelTable): string {
  const ids = table.channels.map((c) => c.id);
  const aliases = table.channels.flatMap((c) =>
    c.aliases.map((a) => [a, c.id] as const),
  );
  const rows = table.channels
    .map((c) => {
      const sf = c.storefront
        ? `{ ${[
            `adapter: ${q(c.storefront.adapter)}`,
            `credential: ${c.storefront.credential === null ? "null" : q(c.storefront.credential)}`,
            ...(["verification", "notification", "sku"] as const).flatMap(
              (k) =>
                c.storefront?.[k] === undefined
                  ? []
                  : [`${k}: ${q(c.storefront[k] as string)}`],
            ),
          ].join(", ")} }`
        : "null";
      return `  {
    id: ${q(c.id)},
    aliases: ${list(c.aliases)},
    label: ${q(c.label)},
    family: ${q(c.family)},
    plane: ${q(c.plane)},
    outlet: { kind: ${q(c.outlet.kind)}${c.outlet.subkind ? `, subkind: ${q(c.outlet.subkind)}` : ""} },
    platforms: ${list(c.platforms)},
    formats: ${list(c.formats)},
    deliverableKinds: ${list(c.deliverableKinds)},
    customerAction: ${q(c.customerAction)},
    verbs: ${list(c.verbs)},
    auto: ${list(c.auto)},
    human: ${list(c.human)},
    storefront: ${sf},
  },`;
    })
    .join("\n");
  const aliasRows = aliases.map(([a, id]) => `  ${q(a)}: ${q(id)},`).join("\n");
  return `// GENERATED FILE — do not edit by hand.
//
// Written by \`pnpm gen channels\` (tools/gen-channels.ts) from tools/channels.json, the one
// catalogue of distribution channels. \`pnpm gen channels --check\` fails the green gate on any
// difference. To change a channel, edit the catalogue and regenerate.

/** Every distribution channel id, in catalogue order. */
export type ChannelId = ${union(ids)};

export type ChannelFamily = ${union([...new Set(table.channels.map((c) => c.family))])};
export type ChannelPlane = ${union([...new Set(table.channels.map((c) => c.plane))])};
export type ChannelCustomerAction = ${union([...new Set(table.channels.map((c) => c.customerAction))])};

export interface ChannelStorefrontFacet {
  /** The storefront adapter id the channel binds to. */
  adapter: string;
  /** The team credential slot that connects it; null when keyless. */
  credential: string | null;
  verification?: string;
  notification?: string;
  sku?: string;
}

export interface ChannelEntry {
  id: ChannelId;
  aliases: readonly string[];
  label: string;
  family: ChannelFamily;
  plane: ChannelPlane;
  /** The wire outlet kind (and, for a package manager, the \`direct\` subkind). Never a new kind. */
  outlet: { kind: string; subkind?: string };
  platforms: readonly string[];
  formats: readonly string[];
  deliverableKinds: readonly string[];
  customerAction: ChannelCustomerAction;
  verbs: readonly string[];
  auto: readonly string[];
  human: readonly string[];
  storefront: ChannelStorefrontFacet | null;
}

/** The catalogue, in canonical order. */
export const CHANNELS: readonly ChannelEntry[] = [
${rows}
];

/** Every channel id, in catalogue order. */
export const CHANNEL_IDS: readonly ChannelId[] = ${list(ids)};

/** Alternate spellings and wire kinds that name a channel, mapped to its id. */
export const CHANNEL_ALIASES: Readonly<Record<string, ChannelId>> = {
${aliasRows}
};

/** A channel by id or alias, or null. */
export function findChannel(idOrAlias: string): ChannelEntry | null {
  const id = Object.hasOwn(CHANNEL_ALIASES, idOrAlias)
    ? CHANNEL_ALIASES[idOrAlias]
    : idOrAlias;
  return CHANNELS.find((c) => c.id === id) ?? null;
}

/** The label for a channel id or alias; an unknown value comes back unchanged. */
export function channelLabel(idOrAlias: string): string {
  return findChannel(idOrAlias)?.label ?? idOrAlias;
}

/** The channel serving an outlet kind (and subkind, for the \`direct\` package managers), or null. */
export function channelForOutlet(
  kind: string,
  subkind?: string | null,
): ChannelEntry | null {
  return (
    CHANNELS.find(
      (c) => c.outlet.kind === kind && (c.outlet.subkind ?? null) === (subkind ?? null),
    ) ?? null
  );
}
`;
}

/** The reference page: one row per channel, straight from the catalogue. */
export function renderDoc(table: ChannelTable): string {
  const cell = (xs: readonly string[]): string =>
    xs.length === 0 ? "none" : xs.map((x) => `\`${x}\``).join(", ");
  const rows = table.channels.map(
    (c) =>
      `| ${c.label} | \`${c.id}\` | ${cell(c.aliases)} | ${c.family} | ${c.plane} | ${cell(c.platforms)} | ${cell(c.formats)} | ${cell(c.deliverableKinds)} | ${c.customerAction} |`,
  );
  return `---
title: "Channels"
description: "Every distribution channel Polaris Key knows: its id, plane, platforms, formats and what the customer does."
---

{/* GENERATED PAGE — do not edit. Regenerate with \`pnpm gen channels\`.
    Source of truth: tools/channels.json; emitter: tools/gen-channels.ts. */}

A channel is a place builds reach customers. The catalogue holds ids, aliases, platforms, formats and deliverable kinds once; the Worker, the CLI and the console read it. An alias is another spelling that names the same channel, such as a wire outlet kind.

| Channel | Id | Aliases | Family | Plane | Platforms | Formats | Deliverables | Customer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

The plane is where the work runs: \`worker\` calls the store's API, \`ci\` runs the store's tool, \`pr\` opens a pull request, \`feed\` serves a signed feed.
`;
}

export async function renderAll(
  table: ChannelTable,
): Promise<Map<string, string>> {
  const options = (await prettier.resolveConfig(join(ROOT, OUTPUT_PATH))) ?? {};
  const content = await prettier.format(renderManifestTs(table), {
    ...options,
    parser: "typescript",
  });
  const doc = renderDoc(table);
  return new Map([
    [OUTPUT_PATH, content],
    [DOC_PATH, doc],
  ]);
}

/** Write (or, with `check`, compare) the output. Returns the stale paths. */
export async function run(opts: {
  check: boolean;
  root?: string;
  table?: ChannelTable;
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
      console.error(`stale: ${path} — run \`pnpm gen channels\``);
    if (stale.length > 0) process.exit(1);
    console.log("up to date: the generated channel table");
    return;
  }
  for (const path of stale) console.log(`wrote ${path}`);
  if (stale.length === 0) console.log("nothing to write");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
