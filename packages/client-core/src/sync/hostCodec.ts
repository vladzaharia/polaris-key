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
// Scope: settings (the `$settings` collection). A record change or mutation is outside this
// slice: a record mutation is refused with `invalid-options`, and a record change carrying a
// `ct` reads as `invalid`.

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
import type { OpenedValue, SyncJson } from "./envelope.js";

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
  if (!isObj(target) || typeof target.setting !== "string")
    throw refuse("only a setting mutation can be sealed");
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
    out.tombstones = body.tombstones.map((t) =>
      isObj(t) && typeof t.setting === "string" && names.has(t.setting)
        ? { ...t, setting: names.get(t.setting)! }
        : t,
    );
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
        const expect = conflictSetting(ctx.mutations, id);
        const o = await openCopy(r.server, expect, codec, ctx);
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

/** The plaintext setting name of mutation `id`, or null when the host did not say. */
function conflictSetting(
  ms: ReadonlyArray<WireMutation> | undefined,
  id: Json | undefined,
): string | null {
  const m = ms?.find((x) => x.mutationId === id);
  return m && "setting" in m.target ? m.target.setting : null;
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
  return { entry: out, row: { invalid: true } };
};

async function openChange(
  c: Entry,
  codec: HostCodec,
  ctx: OpenPullContext,
): Promise<Opened> {
  if (typeof c.setting === "string") return openSettingChange(c, codec, ctx);
  // A record change: this slice seals no records, so a sealed one cannot be read.
  if ("ct" in c) return invalidRow(c);
  return plainRow(c);
}

function plainRow(c: Entry): Opened {
  const entry = stripped(c);
  return {
    entry,
    row: typeof c.version === "number" ? { seq: c.version } : {},
  };
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
