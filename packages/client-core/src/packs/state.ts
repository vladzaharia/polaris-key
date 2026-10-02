// The pack install-state machine (CONTENT §9 "Install state", §10; plans/P4-01.md §2.13, P4-06).
//
// One document per product, written by atomic replace (temp + rename, or the host's equivalent):
//
//   active            pack id → the install the next boot (and, for `hot` packs, this process)
//                     uses
//   previous          pack id → the install `active` replaced, kept for `rollback`
//   inflight          pack id → the journal of an install in progress (strategy, objects, how
//                     many bytes of each are staged), for resume
//   observed          what a platform transport reported (P5-08); carried, never interpreted here
//   confirmedBootSeq  the last boot `confirm` marked healthy; `bootSeq` counts loads
//
// The document is NEVER trusted from storage. Each install and journal carries its pack record's
// compact JWS verbatim, and `reloadPackState` re-verifies every one (hash, pinned release keys,
// claims, `kind: pack` and its pack id) through the caller's verifier before anything uses it;
// the host then re-checks the stored payload itself. What fails is dropped, never repaired. A
// staged object's completed bytes are re-hashed on resume (the engine), never taken on trust.
//
// Pure functions over the document: each returns a new document and changes nothing in place.

import { isObject, isPackId, SHA256_RE } from "./claims.js";

export const PACK_STATE_VERSION = 1;

/** One installed pack release. */
export interface PackInstall {
  packId: string;
  /** The pack record's compact JWS, verbatim: re-verified on every load. */
  record: string;
  recordSha256: string;
  version: string;
  seq: number;
  type: string;
  /** The selected variant's key (`variantKey`). */
  variant: string;
  layout: string;
  payloadSha256: string;
  payloadSize: number;
  /** `hot` (live at commit) or `restart` (live from the next boot). */
  activation: "hot" | "restart";
  /** Where the host keeps the payload (a store directory, an OPFS path, an embedded path). */
  location: string;
  /** True for an embedded baseline the host registered (it lives in the app's resources). */
  embedded?: boolean;
  /** Epoch seconds of the commit. */
  installedAt: number;
}

/** One object of an in-flight plan: its stored ref and how many bytes are staged. */
export interface JournalObject {
  sha256: string;
  bytes: number;
  done: number;
}

/** The journal of an install in progress (CONTENT §10 step 2). */
export interface PackJournal {
  planId: string;
  packId: string;
  record: string;
  recordSha256: string;
  variant: string;
  strategy: string;
  delta?: string;
  objects: JournalObject[];
  startedAt: number;
}

export interface PackStateDoc {
  v: typeof PACK_STATE_VERSION;
  active: Record<string, PackInstall>;
  previous: Record<string, PackInstall>;
  inflight: Record<string, PackJournal>;
  observed: Record<string, unknown>;
  confirmedBootSeq: number;
  bootSeq: number;
}

/**
 * Where the document lives: read it whole, replace it atomically.
 *
 * `read` answers null ONLY when there is no document (ENOENT, NotFoundError) and throws for
 * anything else: an unreadable document is never the empty state. The quarantine members (all
 * required; a store that lacks them at run time has a torn document treated as unreadable) keep a
 * torn document (one that exists but does not parse) aside, as `state.json.torn`, before the
 * first write replaces it; while one is held the engine collects no garbage, so payloads the lost
 * document named survive until an operator calls `recoverState()`.
 */
export interface PackStateStore {
  read(): Promise<string | null>;
  replace(text: string): Promise<void>;
  /** Keep the torn text aside (never overwriting an earlier one). */
  quarantine(text: string): Promise<void>;
  /** Whether a quarantined document is held. */
  quarantined(): Promise<boolean>;
  /** Drop the quarantined document (operator recovery). */
  clearQuarantine(): Promise<void>;
}

export function emptyPackState(): PackStateDoc {
  return {
    v: PACK_STATE_VERSION,
    active: {},
    previous: {},
    inflight: {},
    observed: {},
    confirmedBootSeq: 0,
    bootSeq: 0,
  };
}

const nat = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function asInstall(v: unknown, packId: string): PackInstall | null {
  if (!isObject(v)) return null;
  if (v.packId !== packId || !isPackId(packId)) return null;
  for (const k of [
    "record",
    "version",
    "type",
    "variant",
    "layout",
    "location",
  ])
    if (typeof v[k] !== "string") return null;
  if (typeof v.recordSha256 !== "string" || !SHA256_RE.test(v.recordSha256))
    return null;
  if (typeof v.payloadSha256 !== "string" || !SHA256_RE.test(v.payloadSha256))
    return null;
  if (!nat(v.seq) || !nat(v.payloadSize) || !nat(v.installedAt)) return null;
  if (v.embedded !== undefined && typeof v.embedded !== "boolean") return null;
  if (v.activation !== "hot" && v.activation !== "restart") return null;
  return v as unknown as PackInstall;
}

function asJournal(v: unknown, packId: string): PackJournal | null {
  if (!isObject(v) || v.packId !== packId || !isPackId(packId)) return null;
  for (const k of ["planId", "record", "variant", "strategy"])
    if (typeof v[k] !== "string") return null;
  if (typeof v.recordSha256 !== "string" || !SHA256_RE.test(v.recordSha256))
    return null;
  if (v.delta !== undefined && typeof v.delta !== "string") return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(v.planId as string)) return null;
  if (!nat(v.startedAt) || !Array.isArray(v.objects)) return null;
  for (const o of v.objects)
    if (
      !isObject(o) ||
      typeof o.sha256 !== "string" ||
      !SHA256_RE.test(o.sha256) ||
      !nat(o.bytes) ||
      !nat(o.done) ||
      o.done > o.bytes
    )
      return null;
  return v as unknown as PackJournal;
}

/**
 * Parse the stored document's shape. Anything malformed is dropped entry by entry (a document
 * that does not parse at all is the empty state). Shape only: `reloadPackState` decides what is
 * trusted.
 */
export function parsePackState(text: string | null): PackStateDoc {
  const out = emptyPackState();
  if (text === null) return out;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return out;
  }
  if (!isObject(doc) || doc.v !== PACK_STATE_VERSION) return out;
  for (const slot of ["active", "previous"] as const) {
    const m = doc[slot];
    if (!isObject(m)) continue;
    for (const [id, v] of Object.entries(m)) {
      const i = asInstall(v, id);
      if (i) out[slot][id] = i;
    }
  }
  if (isObject(doc.inflight))
    for (const [id, v] of Object.entries(doc.inflight)) {
      const j = asJournal(v, id);
      if (j) out.inflight[id] = j;
    }
  if (isObject(doc.observed)) out.observed = { ...doc.observed };
  if (nat(doc.confirmedBootSeq)) out.confirmedBootSeq = doc.confirmedBootSeq;
  if (nat(doc.bootSeq)) out.bootSeq = doc.bootSeq;
  if (out.confirmedBootSeq > out.bootSeq) out.confirmedBootSeq = out.bootSeq;
  return out;
}

export function serializePackState(state: PackStateDoc): string {
  return JSON.stringify(state);
}

/** What `reloadPackState` asks of the host for each entry. */
export interface PackStateVerifier {
  /** The record JWS re-verified (hash = `recordSha256`, pinned release keys, claims, `kind:
   *  pack`, `deliverable` = the pack id, and `version`/`seq` as stored); and for an install, the
   *  payload still present with its hash. False drops the entry. */
  install(install: PackInstall): Promise<boolean>;
  journal(journal: PackJournal): Promise<boolean>;
}

/**
 * The reload path: every install and journal goes through the verifier, and only what passes
 * survives. `bootSeq` counts this load. A `previous` equal to its `active` is dropped.
 */
export async function reloadPackState(
  state: PackStateDoc,
  verify: PackStateVerifier,
): Promise<PackStateDoc> {
  const out = emptyPackState();
  out.observed = state.observed;
  out.confirmedBootSeq = state.confirmedBootSeq;
  out.bootSeq = state.bootSeq + 1;
  for (const [id, i] of Object.entries(state.active))
    if (await verify.install(i).catch(() => false)) out.active[id] = i;
  for (const [id, i] of Object.entries(state.previous)) {
    if (out.active[id]?.recordSha256 === i.recordSha256) continue;
    if (await verify.install(i).catch(() => false)) out.previous[id] = i;
  }
  for (const [id, j] of Object.entries(state.inflight))
    if (await verify.journal(j).catch(() => false)) out.inflight[id] = j;
  return out;
}

/** Start (or restart) a plan: its journal becomes the pack's `inflight`. */
export function beginInstall(
  state: PackStateDoc,
  journal: PackJournal,
): PackStateDoc {
  return {
    ...state,
    inflight: { ...state.inflight, [journal.packId]: journal },
  };
}

/** Record how many bytes of one staged object are done. */
export function checkpoint(
  state: PackStateDoc,
  packId: string,
  sha256: string,
  done: number,
): PackStateDoc {
  const j = state.inflight[packId];
  if (!j) return state;
  return {
    ...state,
    inflight: {
      ...state.inflight,
      [packId]: {
        ...j,
        objects: j.objects.map((o) =>
          o.sha256 === sha256 ? { ...o, done: Math.min(done, o.bytes) } : o,
        ),
      },
    },
  };
}

/** Abandon a plan (its staging becomes garbage). */
export function abandonInstall(
  state: PackStateDoc,
  packId: string,
): PackStateDoc {
  if (!state.inflight[packId]) return state;
  const inflight = { ...state.inflight };
  delete inflight[packId];
  return { ...state, inflight };
}

/**
 * Commit a verified install: the pointer swap. `active` becomes the new install, the install it
 * replaces becomes `previous` (unless it is the same release), and the journal is closed. A crash
 * before the host persists this document leaves `active` untouched; the staged payload is then
 * garbage, which `gcRoots` does not protect.
 */
export function commitInstall(
  state: PackStateDoc,
  install: PackInstall,
): PackStateDoc {
  const old = state.active[install.packId];
  const previous = { ...state.previous };
  if (old && old.recordSha256 !== install.recordSha256)
    previous[install.packId] = old;
  const inflight = { ...state.inflight };
  delete inflight[install.packId];
  return {
    ...state,
    active: { ...state.active, [install.packId]: install },
    previous,
    inflight,
  };
}

/** Roll a pack back to `previous`. Unchanged (and false) when there is none. */
export function rollbackInstall(
  state: PackStateDoc,
  packId: string,
): { state: PackStateDoc; rolledBack: boolean } {
  const prev = state.previous[packId];
  if (!prev) return { state, rolledBack: false };
  const previous = { ...state.previous };
  delete previous[packId];
  return {
    state: { ...state, active: { ...state.active, [packId]: prev }, previous },
    rolledBack: true,
  };
}

/** Mark this boot healthy (CONTENT §10 step 7). */
export function confirmBoot(state: PackStateDoc): PackStateDoc {
  return { ...state, confirmedBootSeq: state.bootSeq };
}

/** What garbage collection must keep. */
export interface PackGcRoots {
  /** Locations of active, previous and embedded installs. */
  locations: Set<string>;
  /** Plan ids of in-flight installs (their staging). */
  plans: Set<string>;
}

/**
 * `roots()` (CONTENT §4.1): the locations of every active and previous install and of every
 * embedded baseline the host registered, and the plan ids of every in-flight journal. Anything
 * else in the store or staging is garbage.
 */
export function gcRoots(
  state: PackStateDoc,
  embedded: Iterable<{ location: string }> = [],
): PackGcRoots {
  const locations = new Set<string>();
  for (const i of Object.values(state.active)) locations.add(i.location);
  for (const i of Object.values(state.previous)) locations.add(i.location);
  for (const e of embedded) locations.add(e.location);
  const plans = new Set<string>();
  for (const j of Object.values(state.inflight)) plans.add(j.planId);
  return { locations, plans };
}
