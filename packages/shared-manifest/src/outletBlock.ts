/**
 * `renderOutletBlock` (A-25.1, UX-56): the one `outlets` entry a channel adds to
 * `.pkey/distribution`, rendered by ONE pure function. `pkey channel add` (A-25.2) and the
 * console call it; neither keeps its own snippet.
 *
 * Driven by two declarations and nothing else: the channel catalogue (`CHANNELS`: the outlet
 * kind and the label) and `OUTLET_IDENTITY_FIELDS` (the identity fields the kind reads, in the
 * order they are written). Every field carries a one-line comment in the YAML form. The block is
 * a whole, parseable `outlets:` document with one entry; callers that edit an existing file lift
 * the entry out with {@link outletBlockEntry}.
 */

import YAML from "yaml";
import {
  CHANNELS,
  findChannel,
  type ChannelEntry,
} from "./channels.generated.js";
import {
  OUTLET_IDENTITY_FIELDS,
  OUTLET_ID_PATTERN,
  isOutletKind,
  type OutletIdentityField,
} from "./distribution.js";
import type { OutletKind } from "@polaris-key/protocol/distribution";

/** The one-line comment each identity field carries in the YAML block. */
export const OUTLET_FIELD_LABELS: Readonly<
  Record<OutletIdentityField, string>
> = {
  platforms: "Platforms the direct download offers.",
  homebrewCask: "Homebrew cask token.",
  homebrewFormula: "Homebrew formula name.",
  homebrewTap: "Your own tap, <owner>/homebrew-<name>.",
  scoop: "Scoop manifest details (bin, shortcuts).",
  scoopBucket: "Your own Scoop bucket, <owner>/<repo> on GitHub.",
  appleId: "App Store Connect app id (digits).",
  bundleId: "Bundle id.",
  publicLink: "Join code of the public TestFlight link.",
  artifact: "Artifact id from .pkey/release.",
  marketplaceId: "AltStore PAL marketplace id.",
  packageName: "Android package name.",
  tracks: "Release track to Play track.",
  productId: "Microsoft Store product id.",
  flights: "Release track to package flight.",
  packageFamilyName: "MSIX package family name, <Name>_<PublisherId>.",
  publisher: "MSIX Publisher, the signing certificate's subject (CN=...).",
  updateSettings: "App Installer update behavior.",
  appId: "App id.",
  branches: "Release track to Steam branch.",
  depots: "Pack id to Steam depot id (digits).",
  target: "butler target, user/game.",
  gameId: "itch.io game id (digits).",
  name: "Snap name.",
  channels: "Release track to the Snap channel it releases to.",
  packageIdentifier: "winget package identifier.",
};

/** Labels that differ per outlet kind; the rest read the same everywhere. */
const KIND_FIELD_LABELS: Readonly<
  Partial<Record<OutletKind, Partial<Record<OutletIdentityField, string>>>>
> = {
  steam: { appId: "Steam app id." },
  flathub: { appId: "Flatpak application id, like com.example.App." },
};

/** The one-line comment for a field of a kind. */
export function outletFieldLabel(
  kind: OutletKind,
  field: OutletIdentityField,
): string {
  return KIND_FIELD_LABELS[kind]?.[field] ?? OUTLET_FIELD_LABELS[field];
}

/** `direct` serves two package managers; each reads only its own fields. */
const DIRECT_FIELDS: Readonly<Record<string, readonly OutletIdentityField[]>> =
  {
    homebrew: ["homebrewTap", "homebrewCask", "homebrewFormula"],
    scoop: ["scoopBucket", "scoop"],
  };

/** The identity fields `channel add` takes for a channel, in write order. */
export function channelIdentityFields(
  channelId: string,
): readonly OutletIdentityField[] {
  const channel = channelFor(channelId);
  const kind = channel.outlet.kind;
  if (!isOutletKind(kind)) return [];
  return (
    (kind === "direct" ? DIRECT_FIELDS[channel.id] : undefined) ??
    OUTLET_IDENTITY_FIELDS[kind]
  );
}

export interface RenderOutletBlockOptions {
  format: "yaml" | "json";
  /** The outlet id. Default: the channel id. */
  outletId?: string;
}

/** The entry {@link renderOutletBlock} writes, structured. */
export interface OutletBlockEntry {
  /** The key under `outlets`. */
  id: string;
  /** The entry's members in write order: `kind`, then the identity fields. */
  entry: Record<string, unknown>;
  /** The channel's catalogue label. */
  label: string;
  /** Member name to its one-line comment (no `#`); `kind` is not listed. */
  comments: Readonly<Record<string, string>>;
}

function channelFor(channelId: string): ChannelEntry {
  const channel = findChannel(channelId);
  if (!channel) {
    throw new Error(
      `unknown channel "${channelId}"; known channels: ${CHANNELS.map((c) => c.id).join(", ")}.`,
    );
  }
  return channel;
}

/** The outlet entry for one channel, structured (what the CLI merges into an existing file). */
export function outletBlockEntry(
  channelId: string,
  identity: Readonly<Record<string, unknown>> = {},
  opts: { outletId?: string } = {},
): OutletBlockEntry {
  const channel = channelFor(channelId);
  const kind = channel.outlet.kind;
  if (!isOutletKind(kind)) {
    throw new Error(`channel ${channel.id} has no outlet kind.`);
  }
  const id = opts.outletId ?? channel.id;
  if (!OUTLET_ID_PATTERN.test(id)) {
    throw new Error(
      `outlet id "${id}" must match ${OUTLET_ID_PATTERN.source}.`,
    );
  }
  const fields = channelIdentityFields(channelId);
  const unknown = Object.keys(identity).filter(
    (k) => !(fields as readonly string[]).includes(k),
  );
  if (unknown.length > 0) {
    throw new Error(
      `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} for channel ${channel.id}; known fields: ${fields.length > 0 ? fields.join(", ") : "none"}.`,
    );
  }
  const entry: Record<string, unknown> = { kind };
  const comments: Record<string, string> = {};
  for (const field of fields) {
    if (identity[field] === undefined) continue;
    entry[field] = identity[field];
    comments[field] = outletFieldLabel(kind, field);
  }
  return { id, entry, label: channel.label, comments };
}

/**
 * One `outlets` entry as a document. YAML carries the channel label above the entry and a comment
 * above every field; JSON is `{ "outlets": { "<id>": { ... } } }` with two-space indent and a
 * trailing newline. Unknown channel or field: throws, naming the known ones.
 */
export function renderOutletBlock(
  channelId: string,
  identity: Readonly<Record<string, unknown>>,
  opts: RenderOutletBlockOptions,
): string {
  const { id, entry, label, comments } = outletBlockEntry(
    channelId,
    identity,
    opts,
  );
  if (opts.format === "json") {
    // Arrays of scalars stay on one line, as Prettier would write them.
    const json = JSON.stringify({ outlets: { [id]: entry } }, null, 2).replace(
      /\[\n\s+([^[\]{}]*?)\n\s*\]/g,
      (_m, items: string) => `[${items.replace(/,\n\s+/g, ", ")}]`,
    );
    return `${json}\n`;
  }
  const doc = new YAML.Document({ outlets: { [id]: entry } });
  const outlets = doc.get("outlets", true) as YAML.YAMLMap;
  const pair = outlets.items[0] as YAML.Pair<YAML.Scalar, YAML.YAMLMap>;
  pair.key.commentBefore = ` ${label}`;
  for (const p of (pair.value as YAML.YAMLMap)
    .items as YAML.Pair<YAML.Scalar>[]) {
    const comment = comments[String(p.key.value)];
    if (comment) p.key.commentBefore = ` ${comment}`;
  }
  return doc.toString({ lineWidth: 0 });
}

/** {@link insertOutletBlock} cannot put the entry in this file: the message names why. */
export class OutletInsertError extends Error {
  override name = "OutletInsertError";
}

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `text` (the `.pkey/distribution` file, possibly empty) with `block` added under `outlets`. YAML
 * goes through the `yaml` Document API so the file's comments and layout survive and the entry
 * carries the same comments {@link renderOutletBlock} writes; JSON is rewritten with two-space
 * indent and a trailing newline. Throws {@link OutletInsertError} for a file that is not a
 * mapping, an `outlets` that is not a mapping, or an outlet id already declared. The caller
 * validates the whole manifest afterwards.
 */
export function insertOutletBlock(
  text: string,
  format: "yaml" | "json",
  block: OutletBlockEntry,
): string {
  if (format === "json") {
    let doc: unknown = {};
    if (text.trim() !== "") {
      try {
        doc = JSON.parse(text) as unknown;
      } catch (e) {
        throw new OutletInsertError(
          `distribution is not valid JSON: ${(e as Error).message}`,
        );
      }
    }
    if (doc === null) doc = {};
    if (!isMap(doc))
      throw new OutletInsertError("distribution must be a mapping.");
    const outlets = doc.outlets;
    if (outlets != null && !isMap(outlets))
      throw new OutletInsertError("outlets in distribution must be a mapping.");
    if (isMap(outlets) && block.id in outlets)
      throw new OutletInsertError(`distribution already declares ${block.id}.`);
    return `${JSON.stringify({ ...doc, outlets: { ...(outlets ?? {}), [block.id]: block.entry } }, null, 2)}\n`;
  }
  const doc = YAML.parseDocument(text) as unknown as YAML.Document;
  if (doc.errors.length > 0)
    throw new OutletInsertError(
      `distribution is not valid YAML: ${doc.errors[0]!.message}`,
    );
  if (doc.contents === null) doc.contents = doc.createNode({}) as YAML.YAMLMap;
  if (!YAML.isMap(doc.contents))
    throw new OutletInsertError("distribution must be a mapping.");
  let outlets: unknown = doc.contents.get("outlets", true);
  if (outlets === undefined || outlets === null) {
    outlets = doc.createNode({}) as YAML.YAMLMap;
    doc.contents.set("outlets", outlets);
  }
  if (!YAML.isMap(outlets))
    throw new OutletInsertError("outlets in distribution must be a mapping.");
  if (outlets.has(block.id))
    throw new OutletInsertError(`distribution already declares ${block.id}.`);
  const node = doc.createNode(block.entry) as YAML.YAMLMap;
  for (const p of node.items as YAML.Pair<YAML.Scalar>[]) {
    const comment = block.comments[String(p.key.value)];
    if (comment) p.key.commentBefore = ` ${comment}`;
  }
  const key = new YAML.Scalar(block.id);
  key.commentBefore = ` ${block.label}`;
  outlets.items.push(new YAML.Pair(key, node));
  return doc.toString({ lineWidth: 0 });
}
