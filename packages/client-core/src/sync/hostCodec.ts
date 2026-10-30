// The host codec boundary of Cloud Sync's end-to-end mode (WIRE-CONTRACT-V5 §13.10, §13.10.7).
// `CloudSyncMachine` speaks plaintext; this module is the one place a host turns the machine's
// requests into sealed ones (`sealPush`) and the Worker's answers into plaintext plus the typed
// open result the machine trusts (`openPull`). Node and React share it; Python ports it.
//
// What it guarantees (plans U-sync-clients-slices.md §9, S1 and S10):
//   - nothing leaves in the clear that the contract seals: a `value` becomes `ct`, an open
//     setting key and a merge member are blinded, a declared key stays as it is. A locked codec
//     refuses with `sync-locked` before anything is sealed, so nothing is sent.
//   - `OpenedBody` comes only from this module's own open. `sealed`, `invalid` and `seq` members
//     of the served body are removed, never read: a Worker cannot mark a plaintext row sealed.
//   - a blinded name is accepted only when the `k` inside the envelope re-blinds to it. An
//     envelope that does not open is `invalid`; its row falls through to the document.
//   - `seq` is the change's `version` (§13.10.7), set on plaintext rows only.
//
// Records (U-22.0; §13.10.4, "Record names"). A record's collection travels in the clear and its
// id, field and element names only blinded (`blind("record" | "field" | "element", c, name)`).
// Every sealed record value shares `K_coll(c)`, so the envelope's `k` places it:
//   value    `k = id`                              wire name `blind("record", c, id)`
//   field    `k = id U+0000 field`                 and `blind("field", c, field)`
//   element  `k = id U+0000 canonicalJson(e)`      and `blind("element", c, canonicalJson(e))`
// A pulled record opens only when the id is blinded and the `k` inside the envelope re-blinds to
// every wire name it came under, so a Worker cannot place a sealed value under another record,
// field or element. A conflict copy carries no names and opens under the mutation's own record.
// A record tombstone names its id blinded; it maps back only for a record the machine holds
// (`recordKeys`). The collection `$settings` and the namespace `$` are never a record collection.
//
// Scope: settings (the `$settings` collection) and records of every shape (value, field,
// element). The Swift, Kotlin and Godot ports seal a scalar record value only (D-2); on a
// shared input they behave alike, and they refuse what this module seals beyond a value.

import { base64UrlDecode, base64UrlEncodeBytes } from "@polaris-key/jws";
import type {
  Json,
  OpenedBody,
  OpenedRow,
  SettingRoute,
  WireMutation,
} from "../cloud-sync.js";
import { PolarisError } from "../errors.js";
import { hasOwn } from "../own.js";
import { isBlindedName, type BlindKind } from "./blind.js";
import { canonicalJson, type OpenedValue, type SyncJson } from "./envelope.js";

/** The collection every setting is sealed under. */
export const SETTINGS_COLLECTION = "$settings";

/**
 * What the host seals and opens with: `sdk-node`'s `SyncCodec` plus `openAny`, which opens an
 * envelope whose name is inside it (a blinded open key or member). The codec holds the root and
 * refuses with `sync-locked` once the ring is locked.
 */
export interface HostCodec {
  readonly locked: boolean;
  readonly seal: (
    collection: string,
    name: string,
    value: SyncJson,
  ) => Promise<Uint8Array>;
  /** Tries the current root, then any adopted root the envelope's `kid` names. */
  readonly open: (
    collection: string,
    name: string,
    envelope: Uint8Array,
    aliases?: readonly string[],
  ) => Promise<OpenedValue>;
  /** Opens with whatever name the envelope holds; the caller checks it (`openValueAnyName`). */
  readonly openAny: (
    collection: string,
    envelope: Uint8Array,
  ) => Promise<OpenedValue>;
  readonly blind: (
    kind: BlindKind,
    ctx: string,
    name: string,
  ) => Promise<string>;
}

/** What `openPull` may be told besides the body. Each member only narrows or completes. */
export interface OpenPullContext {
  /** The plaintext mutations of the request this answer belongs to. A conflict's server copy
   *  carries no name, so it is opened against the mutation's own setting; without this, a
   *  conflict copy reads as `invalid`. */
  mutations?: ReadonlyArray<WireMutation>;
  /** Renames the app declares (old name to current name). Never taken from the served body: the
   *  Worker could use them to move a value between keys. */
  aliases?: Readonly<Record<string, string>>;
  /** Open-setting keys the machine already holds: a tombstone names a key blinded, and only
   *  these can be mapped back. */
  openKeys?: Iterable<string>;
  /** The `[collection, id]` of the records the machine already holds: a record tombstone names
   *  its id blinded, and only these can be mapped back. */
  recordKeys?: Iterable<readonly [string, string]>;
}

const locked = (): PolarisError =>
  new PolarisError("sync-locked", "Cloud Sync is locked: there is no root");
const refuse = (why: string): PolarisError =>
  new PolarisError("invalid-options", `Cloud Sync host codec: ${why}`);

const isObj = (v: unknown): v is { [k: string]: Json } =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** The blind input has no length prefix (`kind\0ctx\0name`), so a name with a NUL could collide
 *  with another (setting, member) pair; no name may hold one. */
const hasNul = (s: string): boolean => s.includes("\0");

const toCt = (env: Uint8Array): string => base64UrlEncodeBytes(env);

/** The envelope of a served `ct`, or null for anything but canonical base64url. */
function fromCt(ct: unknown): Uint8Array | null {
  if (typeof ct !== "string" || ct === "" || !/^[A-Za-z0-9_-]+$/.test(ct))
    return null;
  try {
    const out = base64UrlDecode(ct);
    return base64UrlEncodeBytes(out) === ct ? out : null;
  } catch {
    return null;
  }
}

/** The envelope name of a merge member (D-2): the setting, U+0000, the member. */
export const memberEnvelopeName = (setting: string, member: string): string =>
  `${setting}\0${member}`;

/** The envelope name of a `merge` record's field (§13.10.4): the id, U+0000, the field. */
export const fieldEnvelopeName = (id: string, field: string): string =>
  `${id}\0${field}`;

/** The envelope name of a `union` record's element (§13.10.4): the id, U+0000, the element's
 *  canonical JSON. */
export const elementEnvelopeName = (id: string, canonical: string): string =>
  `${id}\0${canonical}`;

/**
 * `[collection, id]` when `v` is a pair of non-empty strings that can name a record: no U+0000
 * (the blind input has no length prefix) and not in the `$` namespace of the settings collection.
 */
export function recordRef(v: unknown): [string, string] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [c, id] = v as unknown[];
  if (typeof c !== "string" || typeof id !== "string") return null;
  if (c === "" || id === "" || hasNul(c) || hasNul(id) || c.startsWith("$"))
    return null;
  return [c, id];
}

// ── Push ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Seals a push body. `routes` is the catalog's setting list: a key it names is declared and stays
 * in the clear; any other key is an open setting and is blinded. The body is not changed; the
 * answer is a copy. Throws (and so sends nothing) when the codec is locked or a mutation cannot
 * be sealed.
 */
export async function sealPush(
  body: Json,
  codec: HostCodec,
  routes: ReadonlyArray<SettingRoute>,
): Promise<Json> {
  if (codec.locked) throw locked();
  if (!isObj(body) || !Array.isArray(body.mutations)) return body;
  const declared = new Set(routes.map((r) => r.key));
  const mutations: Json[] = [];
  for (const m of body.mutations) {
    if (!isObj(m)) throw refuse("mutation is not an object");
    mutations.push(await sealMutation(m, codec, declared));
  }
  return { ...body, mutations };
}

async function sealMutation(
  m: { [k: string]: Json },
  codec: HostCodec,
  declared: ReadonlySet<string>,
): Promise<Json> {
  const target = m.target;
  if (isObj(target) && "record" in target)
    return sealRecordMutation(m, target, codec);
  if (!isObj(target) || typeof target.setting !== "string")
    throw refuse("only a setting or a record mutation can be sealed");
  if ("ct" in m || "field" in m || "element" in m)
    throw refuse("mutation carries a member this codec does not seal");
  const setting = target.setting;
  if (hasNul(setting) || (typeof m.member === "string" && hasNul(m.member)))
    throw refuse("a name holds U+0000");
  const open = !declared.has(setting);
  const out: { [k: string]: Json } = { ...m };
  if (open)
    out.target = {
      ...target,
      setting: await codec.blind("setting", SETTINGS_COLLECTION, setting),
    };
  switch (m.op) {
    case "set":
      if (m.value === undefined || "member" in m)
        throw refuse("set needs a value and no member");
      delete out.value;
      out.ct = toCt(
        await codec.seal(SETTINGS_COLLECTION, setting, m.value as SyncJson),
      );
      return out;
    case "setMember":
      if (open || typeof m.member !== "string" || m.value === undefined)
        throw refuse(
          "setMember needs a declared setting, a member and a value",
        );
      delete out.value;
      out.member = await codec.blind("member", setting, m.member);
      out.ct = toCt(
        await codec.seal(
          SETTINGS_COLLECTION,
          memberEnvelopeName(setting, m.member),
          m.value as SyncJson,
        ),
      );
      return out;
    case "removeMember":
      if (open || typeof m.member !== "string" || "value" in m)
        throw refuse("removeMember needs a declared setting and a member");
      out.member = await codec.blind("member", setting, m.member);
      return out;
    case "clear":
      if ("value" in m || "member" in m) throw refuse("clear carries no value");
      return out;
    default:
      throw refuse("unsupported operation");
  }
}

/** The canonical JSON of an element, or a refusal: a number or text that cannot be spelled
 *  identically everywhere is never sent. */
function canonical(e: Json): string {
  try {
    return canonicalJson(e as SyncJson);
  } catch {
    throw refuse("an element cannot be spelled canonically");
  }
}

/**
 * A record mutation (§13.10.4). `set` seals the value under `k = id`; `setField` under
 * `id U+0000 field`; `add` seals the element under `id U+0000 canonicalJson(e)`. `delete`,
 * `removeField` and `remove` carry no value. Every name goes blinded, the collection in the clear.
 */
async function sealRecordMutation(
  m: { [k: string]: Json },
  target: { [k: string]: Json },
  codec: HostCodec,
): Promise<Json> {
  const ref = recordRef(target.record);
  if (ref === null) throw refuse("a record reference is malformed");
  const [c, id] = ref;
  if ("ct" in m)
    throw refuse("mutation carries a member this codec does not seal");
  const absent = (...names: string[]): void => {
    for (const n of names)
      if (n in m)
        throw refuse("mutation carries a member its operation does not take");
  };
  const out: { [k: string]: Json } = { ...m };
  const field = (): string => {
    if (typeof m.field !== "string" || m.field === "" || hasNul(m.field))
      throw refuse("a field name is empty or holds U+0000");
    return m.field;
  };
  const element = (): Json => {
    if (m.element === undefined) throw refuse("an element is missing");
    return m.element;
  };
  switch (m.op) {
    case "set":
      absent("field", "element", "member");
      if (m.value === undefined) throw refuse("set needs a value");
      delete out.value;
      out.ct = toCt(await codec.seal(c, id, m.value as SyncJson));
      break;
    case "delete":
      absent("value", "field", "element", "member");
      break;
    case "setField": {
      absent("element", "member");
      const f = field();
      if (m.value === undefined) throw refuse("setField needs a value");
      delete out.value;
      out.field = await codec.blind("field", c, f);
      out.ct = toCt(
        await codec.seal(c, fieldEnvelopeName(id, f), m.value as SyncJson),
      );
      break;
    }
    case "removeField":
      absent("value", "element", "member");
      out.field = await codec.blind("field", c, field());
      break;
    case "add": {
      absent("value", "field", "member");
      const e = element();
      const name = canonical(e);
      out.element = await codec.blind("element", c, name);
      out.ct = toCt(
        await codec.seal(c, elementEnvelopeName(id, name), e as SyncJson),
      );
      break;
    }
    case "remove":
      absent("value", "field", "member");
      out.element = await codec.blind("element", c, canonical(element()));
      break;
    default:
      throw refuse("unsupported operation");
  }
  out.target = { ...target, record: [c, await codec.blind("record", c, id)] };
  return out;
}

// ── Pull ─────────────────────────────────────────────────────────────────────────────────────

type Entry = { [k: string]: Json };

/** An opened row: the value the machine reads, what to put in the body, and the host's verdict. */
interface Opened {
  entry: Entry;
  row: OpenedRow;
}

const STRIP = ["sealed", "invalid", "seq", "ct"] as const;

function stripped(e: Entry): Entry {
  const out: Entry = { ...e };
  for (const k of STRIP) delete out[k];
  return out;
}

/**
 * Opens a pull or push answer. The result's `body` has plaintext `value`s and plaintext setting
 * names where they could be proven; `opened` is the typed result for `CloudSyncMachine.receive`.
 * Throws (and so delivers nothing to the machine) when the codec is locked.
 */
export async function openPull(
  body: Json,
  codec: HostCodec,
  ctx: OpenPullContext = {},
): Promise<{ body: Json; opened: OpenedBody }> {
  if (codec.locked) throw locked();
  if (!isObj(body)) return { body, opened: {} };
  const out: Entry = { ...body };
  const opened: {
    changes?: Array<OpenedRow | undefined>;
    conflicts?: Record<number, OpenedRow | undefined>;
  } = {};

  if (Array.isArray(body.changes)) {
    const changes: Json[] = [];
    opened.changes = [];
    for (const c of body.changes) {
      if (!isObj(c)) {
        changes.push(c);
        opened.changes.push(undefined);
        continue;
      }
      const r = await openChange(c, codec, ctx);
      changes.push(r.entry);
      opened.changes.push(r.row);
    }
    out.changes = changes;
  }

  if (Array.isArray(body.tombstones)) {
    const names = await openKeyNames(codec, ctx.openKeys);
    const records = await recordNames(codec, ctx.recordKeys);
    out.tombstones = body.tombstones.map((t) => {
      if (!isObj(t)) return t;
      if (typeof t.setting === "string" && names.has(t.setting))
        return { ...t, setting: names.get(t.setting)! };
      const served = servedRecord(t.record);
      const id = served === null ? undefined : records.get(served.key);
      return served !== null && id !== undefined
        ? { ...t, record: [served.collection, id] }
        : t;
    });
  }

  // Renames come from the app only; a served map or `renamedTo` could swap values between keys.
  if ("aliases" in body) out.aliases = { ...(ctx.aliases ?? {}) };

  if (Array.isArray(body.results)) {
    const results: Json[] = [];
    const seen = new Set<Json>();
    for (const r of body.results) {
      if (!isObj(r)) {
        results.push(r);
        continue;
      }
      // One verdict per mutation. A second result for an id would overwrite the first verdict in
      // `opened.conflicts` while the machine reads the first body entry: fail closed.
      const dup = seen.has(r.mutationId as Json);
      seen.add(r.mutationId as Json);
      if (dup)
        throw new PolarisError(
          "sync-failed",
          "Cloud Sync answer repeats a mutationId",
        );
      const clean: Entry = stripped(r);
      if ("renamedTo" in clean) {
        const from = conflictSetting(ctx.mutations, r.mutationId);
        if (from === null || ctx.aliases?.[from] !== clean.renamedTo)
          delete clean.renamedTo;
      }
      if (r.status === "conflict" && isObj(r.server)) {
        const id = r.mutationId;
        const target = conflictTarget(ctx.mutations, id);
        // A record mutation's copy opens under that mutation's own record; anything else is a
        // setting (a mutation the host cannot place opens as invalid).
        const o =
          target !== null && "record" in target
            ? await openRecordCopy(r.server, recordRef(target.record), codec)
            : await openCopy(
                r.server,
                target !== null && "setting" in target ? target.setting : null,
                codec,
                ctx,
              );
        clean.server = o.entry;
        if (typeof id === "number") (opened.conflicts ??= {})[id] = o.row;
      }
      results.push(clean);
    }
    out.results = results;
  }

  for (const k of STRIP) delete out[k];
  return { body: out, opened };
}

/** The target of mutation `id`, or null when the host did not say. */
function conflictTarget(
  ms: ReadonlyArray<WireMutation> | undefined,
  id: Json | undefined,
): WireMutation["target"] | null {
  return ms?.find((x) => x.mutationId === id)?.target ?? null;
}

/** The plaintext setting name of mutation `id`, or null when the host did not say. */
function conflictSetting(
  ms: ReadonlyArray<WireMutation> | undefined,
  id: Json | undefined,
): string | null {
  const t = conflictTarget(ms, id);
  return t !== null && "setting" in t ? t.setting : null;
}

async function openKeyNames(
  codec: HostCodec,
  keys: Iterable<string> | undefined,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const k of keys ?? [])
    map.set(await codec.blind("setting", SETTINGS_COLLECTION, k), k);
  return map;
}

/** The lookup key of a collection and a (blinded) id: a NUL no collection name holds. */
const recordKey = (c: string, id: string): string => `${c}\0${id}`;

/** A served `[collection, id]` as a lookup key: any pair of strings, not only a usable record. */
function servedRecord(v: unknown): { collection: string; key: string } | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [c, id] = v as unknown[];
  if (typeof c !== "string" || typeof id !== "string") return null;
  return { collection: c, key: recordKey(c, id) };
}

/** Blinded record id (with its collection) to plaintext id, for the records the machine holds. */
async function recordNames(
  codec: HostCodec,
  keys: Iterable<readonly [string, string]> | undefined,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const k of keys ?? []) {
    const ref = recordRef(k);
    if (ref !== null)
      map.set(
        recordKey(ref[0], await codec.blind("record", ref[0], ref[1])),
        ref[1],
      );
  }
  return map;
}

function aliasesOf(
  name: string,
  aliases: Readonly<Record<string, string>> | undefined,
): string[] {
  return Object.entries(aliases ?? {})
    .filter(([, to]) => to === name)
    .map(([from]) => from);
}

const invalidRow = (e: Entry): Opened => {
  const out = stripped(e);
  delete out.value;
  delete out.members;
  delete out.fields;
  delete out.elements;
  return { entry: out, row: { invalid: true } };
};

async function openChange(
  c: Entry,
  codec: HostCodec,
  ctx: OpenPullContext,
): Promise<Opened> {
  if (typeof c.setting === "string") return openSettingChange(c, codec, ctx);
  if ("record" in c) return openRecordChange(c, codec, ctx);
  // Neither a setting nor a record: a sealed one cannot be placed.
  if ("ct" in c) return invalidRow(c);
  return plainRow(c);
}

function plainRow(c: Entry): Opened {
  // Sealed cells with no `ct` are not a plaintext row: only the host's open can read them.
  if (Array.isArray(c.fields) || Array.isArray(c.elements))
    return invalidRow(c);
  const entry = stripped(c);
  return {
    entry,
    row: typeof c.version === "number" ? { seq: c.version } : {},
  };
}

/** The sealed shape of a record row: one `ct`, sealed `fields`, or sealed `elements`. */
function recordShape(e: Entry): "ct" | "fields" | "elements" | "plain" | null {
  const shapes = [
    "ct" in e ? "ct" : null,
    Array.isArray(e.fields) ? "fields" : null,
    Array.isArray(e.elements) ? "elements" : null,
  ].filter((x) => x !== null);
  if (shapes.length === 0) return "plain";
  return shapes.length === 1
    ? (shapes[0] as "ct" | "fields" | "elements")
    : null;
}

/** A sealed record row's entry: the placed `[collection, id]` and the value it opened to. */
function sealedRecord(
  e: Entry,
  record: [string, string] | Json,
  value: Json,
): Opened {
  const entry = stripped(e);
  delete entry.fields;
  delete entry.elements;
  entry.record = record as Json;
  entry.value = value;
  return { entry, row: { sealed: true } };
}

/**
 * A record change. A plaintext row is legacy (the machine judges its `seq`, §13.10.7). A sealed
 * one needs a blinded id and opens only when every envelope's `k` re-blinds to the names the row
 * came under; the row then carries the plaintext id and the opened value (a `merge` record's
 * object, a `union` record's array in the served order).
 */
async function openRecordChange(
  c: Entry,
  codec: HostCodec,
  ctx: OpenPullContext,
): Promise<Opened> {
  const shape = recordShape(c);
  if (shape === "plain") return plainRow(c);
  const ref = recordRef(c.record);
  if (shape === null || ref === null || !isBlindedName(ref[1]))
    return invalidRow(c);
  const [collection, served] = ref;
  if (shape === "ct") {
    const env = fromCt(c.ct);
    if (env === null) return invalidRow(c);
    const r = await codec.openAny(collection, env);
    if (!r.ok || r.name === "" || hasNul(r.name)) return invalidRow(c);
    if ((await codec.blind("record", collection, r.name)) !== served)
      return invalidRow(c);
    return sealedRecord(c, [collection, r.name], r.value as Json);
  }
  const cells = await openCells(c, shape, collection, null, codec);
  if (cells === null) return invalidRow(c);
  let id = cells.id;
  if (id === null) {
    // No cell names the record, so the id comes from a record the machine holds, if any.
    const held = await recordNames(codec, ctx.recordKeys);
    id = held.get(recordKey(collection, served)) ?? null;
  } else if ((await codec.blind("record", collection, id)) !== served)
    return invalidRow(c);
  return sealedRecord(c, [collection, id ?? served], cells.value);
}

/** A conflict's server copy of the record `rec` of the mutation: opened under that id. */
async function openRecordCopy(
  e: Entry,
  rec: [string, string] | null,
  codec: HostCodec,
): Promise<Opened> {
  const shape = recordShape(e);
  if (shape === "plain") return plainRow(e);
  if (shape === null || rec === null) return invalidRow(e);
  const [collection, id] = rec;
  if (shape === "ct") {
    const env = fromCt(e.ct);
    if (env === null) return invalidRow(e);
    const r = await codec.open(collection, id, env, []);
    if (!r.ok) return invalidRow(e);
    const entry = stripped(e);
    entry.value = r.value as Json;
    return { entry, row: { sealed: true } };
  }
  const cells = await openCells(e, shape, collection, id, codec);
  if (cells === null) return invalidRow(e);
  const entry = stripped(e);
  delete entry.fields;
  delete entry.elements;
  entry.value = cells.value;
  return { entry, row: { sealed: true } };
}

/**
 * Opens the sealed cells of a `merge` record (`fields`) or a `union` record (`elements`). Each
 * envelope's `k` splits at its first U+0000 into the id and the cell name; the cell's blinded
 * name must be what the row carries (and, for an element, the opened value must spell the name),
 * and every cell must name the same id (`expectId`, when the caller knows it). `id` is null for
 * a record with no cells.
 */
async function openCells(
  e: Entry,
  shape: "fields" | "elements",
  collection: string,
  expectId: string | null,
  codec: HostCodec,
): Promise<{ id: string | null; value: Json } | null> {
  const kind = shape === "fields" ? "field" : "element";
  const cells = e[shape] as Json[];
  let id: string | null = expectId;
  const names = new Set<string>();
  const fields: { [k: string]: Json } = {};
  const elements: Json[] = [];
  for (const cell of cells) {
    if (!isObj(cell)) return null;
    const wire = cell[kind];
    if (typeof wire !== "string" || !isBlindedName(wire)) return null;
    const env = fromCt(cell.ct);
    if (env === null) return null;
    const r = await codec.openAny(collection, env);
    if (!r.ok) return null;
    const cut = r.name.indexOf("\0");
    if (cut <= 0) return null;
    const cellId = r.name.slice(0, cut);
    const name = r.name.slice(cut + 1);
    if (name === "" || hasNul(name)) return null;
    if (id !== null && cellId !== id) return null;
    id = cellId;
    if ((await codec.blind(kind, collection, name)) !== wire) return null;
    if (names.has(name)) return null;
    names.add(name);
    if (kind === "field") {
      Object.defineProperty(fields, name, {
        value: r.value as Json,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      let spelled: string;
      try {
        spelled = canonicalJson(r.value);
      } catch {
        return null;
      }
      if (spelled !== name) return null;
      elements.push(r.value as Json);
    }
  }
  return { id, value: kind === "field" ? fields : elements };
}

async function openSettingChange(
  c: Entry,
  codec: HostCodec,
  ctx: OpenPullContext,
): Promise<Opened> {
  const served = c.setting as string;
  if (hasNul(served)) return invalidRow(c);
  if (!("ct" in c) && !Array.isArray(c.members)) return plainRow(c);
  if (isBlindedName(served)) {
    // An open key: the name is inside the envelope and must re-blind to the served name.
    if (!("ct" in c)) return invalidRow(c);
    const env = fromCt(c.ct);
    if (env === null) return invalidRow(c);
    const r = await codec.openAny(SETTINGS_COLLECTION, env);
    if (!r.ok || hasNul(r.name)) return invalidRow(c);
    if ((await codec.blind("setting", SETTINGS_COLLECTION, r.name)) !== served)
      return invalidRow(c);
    const entry = stripped(c);
    entry.setting = r.name;
    entry.value = r.value as Json;
    return { entry, row: { sealed: true } };
  }
  return openCopy(c, served, codec, ctx);
}

/**
 * Opens a row (or a conflict's server copy) whose setting name is `name`: one `ct`, or a merge
 * setting's sealed `members`. `name` null (a conflict the host cannot place) reads as invalid.
 */
async function openCopy(
  e: Entry,
  name: string | null,
  codec: HostCodec,
  ctx: OpenPullContext,
): Promise<Opened> {
  const hasCt = "ct" in e;
  const members = e.members;
  if (!hasCt && !Array.isArray(members)) {
    // Plaintext: legacy only if the machine finds its `seq` below `encryptionSince`.
    return plainRow(e);
  }
  if (name === null || hasNul(name)) return invalidRow(e);
  if (hasCt) {
    const env = fromCt(e.ct);
    if (env === null) return invalidRow(e);
    const r = await codec.open(
      SETTINGS_COLLECTION,
      name,
      env,
      aliasesOf(name, ctx.aliases),
    );
    if (!r.ok) return invalidRow(e);
    const entry = stripped(e);
    delete entry.members;
    entry.value = r.value as Json;
    return { entry, row: { sealed: true } };
  }
  const value: { [k: string]: Json } = {};
  for (const m of members as Json[]) {
    if (!isObj(m) || typeof m.member !== "string") return invalidRow(e);
    const env = fromCt(m.ct);
    if (env === null || !isBlindedName(m.member)) return invalidRow(e);
    const r = await codec.openAny(SETTINGS_COLLECTION, env);
    if (!r.ok) return invalidRow(e);
    const prefix = `${name}\0`;
    if (!r.name.startsWith(prefix)) return invalidRow(e);
    const member = r.name.slice(prefix.length);
    if (hasNul(member)) return invalidRow(e);
    if ((await codec.blind("member", name, member)) !== m.member)
      return invalidRow(e);
    if (hasOwn(value, member)) return invalidRow(e);
    Object.defineProperty(value, member, {
      value: r.value as Json,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const entry = stripped(e);
  delete entry.members;
  entry.value = value;
  return { entry, row: { sealed: true } };
}
