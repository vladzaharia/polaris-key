// The pack pipeline (CONTENT §10; plans/P4-01.md §2.6, §2.9; P4-06): preflight, journal, fetch,
// verify, commit, activate, confirm and resume, over injected ports. `client.update.packs` in
// @polaris-key/node and `update.packs` in @polaris-key/react are this engine with their own
// transport, storage, zstd and SHA-256, so the two JavaScript SDKs cannot drift; Python, Swift
// and Godot port it.
//
// For each pack id `ensure` asks for:
//
//  1. the content stamp's pin (a host without a stamp has no packs, §2.8);
//  2. the pinned pack record, fetched by hash and verified against the pinned release keys with
//     `pin: {kind: "pack", deliverable, version, seq}` (V4 §3.5 steps 12–15);
//  3. its type (a registered handler for `type` and `formatVersion`), its entitlement (a licence
//     without the flag leaves the pack out), `selectVariant`;
//  4. the target files index when the layout is `tree` or a release of the pack is installed;
//     `planTarget` and `plan`, with the host's free disk and memory budget;
//  5. a journal, then each object fetched with `Range`/`If-Range` into staging, resumed from what
//     is staged (re-hashed, never trusted), checkpointed;
//  6. the applier; on a refusal, the next fallback (`full` always last);
//  7. commit (the payload moves into the store, then the state's pointer swap), activation
//     (`hot` now; `restart` at the next boot), and garbage collection of what no root holds.

import type { TrustSet } from "@polaris-key/jws";
import type {
  AppContent,
  FilesIndexDoc,
  PackRecordDoc,
  PackVariant,
} from "@polaris-key/protocol/packs";
import type { PackTarget } from "@polaris-key/protocol/update";
import { PolarisError } from "../errors.js";
import {
  delegationHashOf,
  newerRevocation,
  recordHash,
  recordRevoked,
  verifyReleaseRecord,
  type VerifiedRevocation,
} from "../record.js";
import {
  dataOnlyFileRefusal,
  dataOnlyPathRefusal,
  dataOnlyTreeSink,
  type DataOnlyRefusalSeen,
} from "./dataonly.js";
import {
  clearRelearn,
  emptyRevocations,
  isEmptyRevocations,
  parseRevocations,
  reloadRevocations,
  serializeRevocations,
  storeRevocation,
  type RevocationsDoc,
  type StoredRevocation,
} from "./revocations.js";
import { applyDelta, applyFile, applyFull, type ApplyResult } from "./apply.js";
import { parseFilesIndex } from "./files.js";
import { matchEmbedded, verifyMarker, type EmbeddedPayload } from "./marker.js";
import {
  plan,
  type PlanCaps,
  type PlanInstalled,
  type PlanResult,
} from "./plan.js";
import {
  READ_CHUNK,
  readAll,
  type ByteSink,
  type ByteSource,
  type InstalledFile,
  type Sha256Port,
  type TreeSink,
  type ZstdPort,
} from "./ports.js";
import {
  indexReadable,
  planTarget,
  selectVariant,
  type VariantPrefs,
} from "./select.js";
import {
  MAX_DELEGATIONS_PER_CHECK,
  MAX_FILES_INDEX_BYTES,
} from "@polaris-key/protocol/core";
import { packSetId } from "./set.js";
import {
  providesFacts,
  verifiedPayloadOf,
  type PackProvider,
  type ProvidesFacts,
} from "./provides.js";
import {
  abandonInstall,
  beginInstall,
  checkpoint,
  commitInstall,
  confirmBoot,
  gcRoots,
  parsePackState,
  reloadPackState,
  rollbackInstall,
  serializePackState,
  type PackInstall,
  type PackJournal,
  type PackStateDoc,
  type PackStateStore,
} from "./state.js";
import { variantKey } from "./variant.js";

// ── Ports ────────────────────────────────────────────────────────────────────────────────────

/** A pack type's handler (CONTENT §4.1). `files.tree` is built in; P4-16 and games add more
 *  through `registerHandler`. Bytes are the engine's: a handler decides which formats it holds,
 *  the layout it expects and what activation does. */
export interface PackHandler {
  readonly type: string;
  /** The layout of the payloads it installs. */
  readonly layout: "tree" | "container";
  /** The activation when the record names none. */
  readonly activation: "hot" | "restart";
  /** Whether it can install and activate this `formatVersion`. */
  supports(formatVersion: number): boolean;
  /** A committed install becomes live: at commit for `hot`, at load for a boot's `restart`. */
  activate?(install: PackInstall): void | Promise<void>;
  /** A live `hot` install is replaced or rolled back. */
  deactivate?(install: PackInstall): void | Promise<void>;
}

/** `files.tree` (CONTENT §4.2): a directory tree, hot (versioned directory plus pointer swap),
 *  format version 1. */
export const FILES_TREE_HANDLER: PackHandler = {
  type: "files.tree",
  layout: "tree",
  activation: "hot",
  supports: (formatVersion) => formatVersion === 1,
};

/** An object download as the engine reads it (the host adapts its HTTP client). */
export interface ObjectResponse {
  status: number;
  /** `Content-Range`, or null. */
  contentRange: string | null;
  chunks: AsyncIterable<Uint8Array>;
}

/** `GET` of one stored object by its SHA-256, from `offset`; `ifRange` is the strong ETag
 *  (`"<sha256>"`) whenever `offset > 0`, so a resume never splices two versions. */
export type ObjectFetch = (req: {
  sha256: string;
  offset: number;
  ifRange: string | null;
}) => Promise<ObjectResponse>;

/** `GET` of one release record by hash (the body, or the failure's code). */
export type RecordFetch = (
  sha256: string,
) => Promise<{ ok: true; body: string } | { ok: false; code: string }>;

/** One object being staged for a plan. */
export interface StagedObject {
  size(): Promise<number>;
  source(): Promise<ByteSource>;
  append(bytes: Uint8Array): Promise<void>;
  reset(): Promise<void>;
}

/** An install's bytes, for reuse as a delta base or a file seed. */
export interface InstalledPayload {
  /** A container's whole payload. */
  payload: ByteSource | null;
  /** Its files, from the index kept at install (or, for an embedded tree, its listing). */
  files: InstalledFile[] | null;
}

/** Where a host keeps staging and the store (Node: the platform data directory; the web: OPFS
 *  or memory). Locations and plan ids are opaque to the engine. */
export interface PackStorage {
  stagedObject(planId: string, sha256: string): Promise<StagedObject>;
  /** The plan's output area: a byte sink for a container, a tree sink for a tree. */
  output(
    planId: string,
    layout: string,
  ): Promise<{ sink?: ByteSink; tree?: TreeSink }>;
  /** Move the plan's verified output into the store, keeping the decoded files index beside it
   *  (never inside the payload's own paths), and return its location. */
  commit(
    planId: string,
    packId: string,
    payloadSha256: string,
    layout: string,
    index: FilesIndexDoc | null,
  ): Promise<string>;
  /** The install's bytes, or null when its payload is gone. */
  installed(install: PackInstall): Promise<InstalledPayload | null>;
  /** Re-check an install's payload on load (a tree: its `treeDigest`; a file: its SHA-256). */
  verify(install: PackInstall): Promise<boolean>;
  remove(location: string): Promise<void>;
  removeStaging(planId: string): Promise<void>;
  list(): Promise<{ locations: string[]; plans: string[] }>;
  freeDisk(): Promise<number>;
}

/** An embedded baseline the host ships: its marker's text and its measured bytes. */
export interface EmbeddedBaseline {
  marker: string | Uint8Array;
  payload: EmbeddedPayload;
  /** Where its payload is (the host reads it back through `PackStorage.installed`). */
  location: string;
}

export interface PackProgress {
  packId: string;
  /** `state-issue` is emitted once at `load` when the state document cannot be trusted (then
   *  `packId` is empty, the counts are 0 and `issue` says why). */
  phase: "download" | "apply" | "done" | "state-issue";
  done: number;
  total: number;
  issue?: "torn" | "unreadable";
}

export interface PackEngineOptions {
  /** The product: every record's `aud`. */
  product: string;
  /** The PINNED release keys, the only keys a pack record verifies against. */
  releaseKeys: TrustSet;
  /** The effective product trust set (a release key also in it is refused). */
  productTrust: () => TrustSet;
  /** The running build's content stamp (`parseContentStamp`), or null: no packs. */
  stamp: AppContent | null;
  /** Variant preferences: the host's engine and per-axis value lists. */
  prefs: VariantPrefs;
  zstd: ZstdPort;
  sha256: Sha256Port;
  /** `zstd-patch-from` when the decoder passed its start-up probe; empty otherwise. */
  patchMethods: readonly string[];
  /** The memory budget for one delta frame (`memBytes`); at most 2^30 on wasm32. */
  memBudget: number;
  /** The strategies to cost. Default `["delta", "file", "full"]` (v1 lists no `chunk`). */
  strategies?: readonly string[];
  /** Default `["pkey-cdn"]`. */
  transports?: readonly string[];
  storage: PackStorage;
  state: PackStateStore;
  /**
   * The sibling `revocations.json` (plans/P4-13.md §2.5): the same store seam with a second key,
   * its own atomic replace and quarantine. Omit it and revocations live in memory for the life
   * of the process only. Never created empty: a product with no revocations has no such file.
   */
  revocations?: PackStateStore;
  fetchRecord: RecordFetch;
  fetchObject: ObjectFetch;
  /** The licence's granted flags, or null when the product runs no License service (the server
   *  then gates the bytes alone). */
  entitlements?: () => ReadonlySet<string> | null;
  /** Epoch seconds. */
  now: () => number;
  /** Fresh plan ids (`[A-Za-z0-9_-]{1,64}`). */
  newPlanId: () => string;
  handlers?: readonly PackHandler[];
  /** Write the journal every this many staged bytes (default 8 MiB). */
  checkpointBytes?: number;
  /**
   * The most one buffered decode may hold: the stored `full` frame plus its decoded payload.
   * When set and the zstd port cannot stream, a `full` candidate above it is dropped before
   * planning, so a payload too large for this device refuses cleanly (`plan-no-strategy`)
   * instead of failing an allocation. React sets it to its memory budget; Node streams.
   */
  oneShotBudget?: number;
}

/** The error the pipeline raises when it cannot proceed. `code` is a registered client code
 *  (`conformance/parity/errors.json`); `detail` names a step, `path` a file. */
export class PackError extends PolarisError {
  readonly detail: string | null;
  readonly path: string | null;
  readonly packId: string | null;
  constructor(
    code: string,
    message: string,
    opts: {
      detail?: string | null;
      path?: string | null;
      packId?: string | null;
    } = {},
  ) {
    super(code, message);
    this.name = "PackError";
    this.detail = opts.detail ?? null;
    this.path = opts.path ?? null;
    this.packId = opts.packId ?? null;
  }
}

/** What `state()` reports. */
export interface PacksSnapshot {
  active: Record<string, PackInstall>;
  previous: Record<string, PackInstall>;
  inflight: Record<
    string,
    { planId: string; strategy: string; done: number; total: number }
  >;
  /** The pack releases activated in this process: restart packs mounted at this boot, hot packs
   *  active, embedded baselines included. `packSetId` hashes this set. */
  running: Record<string, PackInstall>;
  confirmedBootSeq: number;
  bootSeq: number;
  /** Why this load could not trust the state document: `torn` (it did not parse and is held
   *  aside; garbage collection waits for `recoverState()`), `unreadable` (it could not be read;
   *  nothing is written or installed this process), or null. */
  stateIssue: "torn" | "unreadable" | null;
}

/** What `revocations()` reports (plans/P4-13.md §2.5). */
export interface RevocationsSnapshot {
  /** Revoked target hash → the stored winner (persisted, or this process's only). */
  revoked: Record<string, StoredRevocation>;
  /** The verified revocation of every revoked target, replacement included. */
  verified: Record<string, VerifiedRevocation>;
  /** Packs whose embedded baselines are refused until a fresh feed re-teaches them. */
  relearn: string[];
  /** `torn` (quarantined and replaced), `unreadable` (nothing is written this process), or
   *  null. */
  issue: "torn" | "unreadable" | null;
}

/** `preflight`'s answer. */
type Preflight =
  | { kind: "current"; install: PackInstall }
  | {
      kind: "plan";
      body: string;
      recordSha256: string;
      record: PackRecordDoc;
      variant: PackVariant;
      installs: PackInstall[];
      seeds: Map<string, InstalledPayload>;
      planId: string;
      index: FilesIndexDoc | null;
      plan: Exclude<PlanResult, { error: unknown }>;
      /** The delegation's compact JWS when a content key signed the record (plans/P4-19.md
       *  §2.3), else null. */
      delegation: string | null;
    };

/** What `estimate` reports for a set of packs (the consent dialog's size disclosure). */
export interface PackEstimate {
  /** The bytes the chosen strategies would download, summed over the packs not yet current. */
  bytes: number;
  /** The packs that would download. */
  packs: string[];
  /** Packs that cannot be planned, with the code `ensure` would raise. */
  refused: { packId: string; code: string }[];
}

// ── The engine ───────────────────────────────────────────────────────────────────────────────

export class PackEngine {
  private readonly opts: PackEngineOptions;
  private readonly handlers = new Map<string, PackHandler>();
  private readonly listeners = new Set<(e: PackProgress) => void>();
  private readonly embedded = new Map<string, PackInstall>();
  private readonly running = new Map<string, PackInstall>();
  /** Locations whose payload could not be read at load: kept out of use and out of GC. */
  private readonly unverifiable = new Set<string>();
  /** Stored installs whose payload check threw: kept in the written document, out of use. */
  private deferred: {
    active: Record<string, PackInstall>;
    previous: Record<string, PackInstall>;
  } = { active: {}, previous: {} };
  private stateIssue: "torn" | "unreadable" | null = null;
  /** No garbage collection while a torn document is held or the state is unreadable. */
  private gcHold = false;
  /** While a torn document is held: what existed when the hold started, never collected. */
  private holdSnapshot: { locations: Set<string>; plans: Set<string> } | null =
    null;
  /** Packs whose `previous` was carried over from an entry whose check could not run:
   *  re-verified before a rollback uses it. */
  private readonly unverifiedPrevious = new Set<string>();
  private doc: PackStateDoc | null = null;
  /** The revocations (plans/P4-13.md §2.5): the sibling document as loaded and updated. */
  private revDoc: RevocationsDoc = emptyRevocations();
  /** Every revocation verified in this process (loaded or learned), by target. */
  private readonly revVerified = new Map<string, VerifiedRevocation>();
  /** The JWS of each revocation learned in this process, by target. */
  private readonly revJws = new Map<string, string>();
  private revIssue: "torn" | "unreadable" | null = null;
  /** Whether `revocations.json` exists (it is never created empty). */
  private revFile = false;
  /** Plan ids `estimate` staged an index under, reused by the next `ensure`. */
  private readonly preflightPlans = new Map<
    string,
    { planId: string; recordSha256: string }
  >();
  /** Delegation records fetched in this process, by hash (plans/P4-19.md §2.3). Each is bound
   *  to its hash and re-verified at every use against the current trust inputs, so a rotation of
   *  the pinned release keys or the product trust set takes effect at once. */
  private readonly delegationBodies = new Map<string, string>();
  /** Distinct delegations this call may still fetch (`MAX_DELEGATIONS_PER_CHECK`). */
  private delegationBudget = MAX_DELEGATIONS_PER_CHECK;
  /** Delegated releases verified in this process: record hash → pack and delegation hash. */
  private readonly delegatedKnown = new Map<
    string,
    { pack: string; delegation: string }
  >();
  /** P4-20: `providesFacts` of verified records, by record hash. */
  private readonly providesMemo = new Map<string, ProvidesFacts>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: PackEngineOptions) {
    this.opts = opts;
    this.handlers.set(FILES_TREE_HANDLER.type, FILES_TREE_HANDLER);
    for (const h of opts.handlers ?? []) this.handlers.set(h.type, h);
  }

  /** Add or replace a handler for a pack type (CONTENT §4.1 custom types). */
  registerHandler(handler: PackHandler): void {
    if (
      typeof handler !== "object" ||
      handler === null ||
      typeof handler.type !== "string" ||
      typeof handler.supports !== "function" ||
      (handler.layout !== "tree" && handler.layout !== "container") ||
      (handler.activation !== "hot" && handler.activation !== "restart")
    )
      throw new PackError(
        "invalid-options",
        "registerHandler needs {type, layout, activation, supports}.",
      );
    this.handlers.set(handler.type, handler);
  }

  /** Progress events; returns the unsubscribe function. */
  on(listener: (e: PackProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Load the state (re-verifying every entry), register the host's embedded baselines (each
   * marker verified once, its bytes matched, its pin checked against the stamp), activate what
   * this boot runs, persist the document and collect garbage. Run once, before `ensure`.
   * Returns the embedded baselines that were refused, by marker step.
   */
  load(
    embedded: readonly EmbeddedBaseline[] = [],
  ): Promise<{ refused: { location: string; step: string }[] }> {
    return this.serialised(async () => {
      const refused: { location: string; step: string }[] = [];
      for (const e of embedded) {
        const r = await this.verifyEmbedded(e);
        if (!r.ok) refused.push({ location: e.location, step: r.step });
        else this.embedded.set(r.install.packId, r.install);
      }
      // The state. `read` is null only for "no document"; anything else it throws means the
      // document is unknown, so nothing may be written over it or collected this process.
      let text: string | null = null;
      let unreadable = false;
      try {
        text = await this.opts.state.read();
      } catch {
        unreadable = true;
      }
      // A document that exists but does not parse (a torn write) is not the empty state: it is
      // held aside before anything replaces it, and nothing is collected while it is held.
      const torn =
        !unreadable &&
        text !== null &&
        text.trim() !== "" &&
        !looksLikeState(text);
      const st = this.opts.state;
      const canQuarantine =
        typeof st.quarantine === "function" &&
        typeof st.quarantined === "function" &&
        typeof st.clearQuarantine === "function";
      if (torn) {
        // A store that cannot keep the torn text aside (a host's store from before the
        // interface required it) is treated as unreadable: nothing is written over the text.
        if (!canQuarantine) unreadable = true;
        else
          try {
            await st.quarantine(text!);
          } catch {
            unreadable = true;
          }
      }
      const held =
        !unreadable &&
        (torn || (canQuarantine && (await st.quarantined().catch(() => true))));
      this.stateIssue = unreadable ? "unreadable" : held ? "torn" : null;
      this.gcHold = unreadable;
      if (held) {
        // Bound the hold: what exists now may belong to the lost document and is kept; what
        // this process creates and drops later is collected as usual.
        // The first hold's snapshot is kept beside the quarantine and reused by later loads, so
        // the store stays bounded across restarts; one that cannot be read holds GC entirely.
        const listed = await this.holdList(st);
        if (listed === null) this.gcHold = true;
        else
          this.holdSnapshot = {
            locations: new Set(listed.locations),
            plans: new Set(listed.plans),
          };
      }
      if (this.stateIssue !== null)
        this.emit({
          packId: "",
          phase: "state-issue",
          done: 0,
          total: 0,
          issue: this.stateIssue,
        });
      const parsed = parsePackState(torn ? null : text);
      const deferred = new Set<PackInstall>();
      const doc = await reloadPackState(parsed, {
        install: async (i) => {
          if (
            !(await this.verifyStoredRecord(
              i.record,
              i.recordSha256,
              i.packId,
              i,
              i.delegation,
            ))
          )
            return false;
          try {
            return await this.opts.storage.verify(i);
          } catch {
            // The payload could not be read (an I/O error, not a mismatch): kept in the
            // document and out of GC, but out of the running set and the planner this load.
            this.unverifiable.add(i.location);
            deferred.add(i);
            return false;
          }
        },
        journal: (j) =>
          this.verifyStoredRecord(
            j.record,
            j.recordSha256,
            j.packId,
            undefined,
            j.delegation,
          ),
      });
      for (const [id, i] of Object.entries(parsed.active))
        if (deferred.has(i)) this.deferred.active[id] = i;
      for (const [id, i] of Object.entries(parsed.previous))
        if (deferred.has(i)) this.deferred.previous[id] = i;
      this.doc = doc;
      // plans/P4-13.md §2.5: the sibling revocations, before anything mounts.
      await this.loadRevocations(unreadable);
      // This boot's set: every active install (restart packs mount now), else the embedded
      // baseline. A revoked release never activates or mounts (`pack-revoked`).
      for (const i of Object.values(doc.active))
        if (!this.installRevoked(i)) await this.activate(i);
      for (const [id, e] of this.embedded)
        if (!this.running.has(id) && !this.embeddedRefused(e))
          this.running.set(id, e);
      if (!unreadable) await this.persist();
      await this.collect();
      return { refused };
    });
  }

  /** The install state and this process's running set. */
  state(): PacksSnapshot {
    const doc = this.requireLoaded();
    const inflight: PacksSnapshot["inflight"] = {};
    for (const [id, j] of Object.entries(doc.inflight))
      inflight[id] = {
        planId: j.planId,
        strategy: j.strategy,
        done: j.objects.reduce((a, o) => a + o.done, 0),
        total: j.objects.reduce((a, o) => a + o.bytes, 0),
      };
    return {
      active: { ...doc.active },
      previous: { ...doc.previous },
      inflight,
      running: Object.fromEntries(this.running),
      confirmedBootSeq: doc.confirmedBootSeq,
      bootSeq: doc.bootSeq,
      stateIssue: this.stateIssue,
    };
  }

  /** The bytes of a pack's running install (its files, its payload), or null. */
  async open(packId: string): Promise<InstalledPayload | null> {
    const i = this.running.get(packId);
    return i ? this.opts.storage.installed(i) : null;
  }

  /** `packSetId` of the running set (plans/P4-01.md §2.9), for `devices/report`'s `content`. */
  packSetId(): Promise<string | null> {
    return packSetId(
      [...this.running.values()].map((i) => ({
        packId: i.packId,
        releaseSha256: i.recordSha256,
      })),
    );
  }

  /**
   * Save compatibility (P4-20, CONTENT §6.7 item 8): whether a pack release in the ACTIVE set
   * provides `contentId` (its record's `provides`, `provides.ts`). The active set is `running`:
   * restart packs mounted at this boot, hot packs active, embedded baselines included; a revoked
   * release is never in it. A pack whose `entitlement` the licence lacks never answers.
   */
  isAvailable(contentId: string): boolean {
    this.requireLoaded();
    const granted = this.opts.entitlements?.() ?? null;
    for (const i of this.running.values()) {
      const f = this.factsOf(i.recordSha256, i.record);
      if (f.provides.has(contentId) && entitled(f, granted)) return true;
    }
    return false;
  }

  /**
   * The pack whose TARGET release provides `contentId`, so a game can `estimate` and `ensure` it
   * ("Continue (downloading 12 MB…)"). The target set is `targets` (a `packs` decision's install
   * list) or, by default, the content stamp's pins; each target's record is the verified record
   * of an install or embedded baseline with its hash, else fetched by hash and verified as
   * `ensure` verifies it. The first target, in list order, that provides the id answers. A target
   * that cannot be fetched or verified, a revoked one and an unentitled one (CONTENT §6.7 item 9)
   * never answer. Null when no target provides it.
   */
  packFor(
    contentId: string,
    targets?: readonly PackTarget[],
  ): Promise<PackProvider | null> {
    return this.serialised(async () => {
      this.requireLoaded();
      this.delegationBudget = MAX_DELEGATIONS_PER_CHECK;
      const list: readonly PackTarget[] =
        targets ??
        (this.opts.stamp?.pins ?? []).map((p) => ({
          pack: p.pack,
          release: p.release,
        }));
      const granted = this.opts.entitlements?.() ?? null;
      for (const t of list) {
        if (this.isRevoked(t.release.sha256)) continue;
        const f = await this.targetFacts(t);
        if (f && f.provides.has(contentId) && entitled(f, granted))
          return {
            packId: t.pack,
            release: {
              sha256: t.release.sha256,
              seq: t.release.seq,
              version: t.release.version,
            },
          };
      }
      return null;
    });
  }

  /** Mark this boot healthy (CONTENT §10 step 7). */
  confirm(): Promise<void> {
    return this.serialised(async () => {
      this.refuseUnreadable();
      this.doc = confirmBoot(this.requireLoaded());
      await this.persist();
    });
  }

  /** Re-point a pack at `previous`. A hot pack switches now; a restart pack at the next boot. */
  rollback(packId: string): Promise<boolean> {
    return this.serialised(async () => {
      this.refuseUnreadable();
      const doc = this.requireLoaded();
      const before = doc.active[packId];
      const prev = doc.previous[packId];
      // plans/P4-13.md §2.5: never back to a revoked release.
      if (prev && this.installRevoked(prev)) return false;
      if (prev && this.unverifiedPrevious.has(packId)) {
        // Carried over from an entry whose check could not run: verify it now.
        let ok = false;
        try {
          ok =
            (await this.verifyStoredRecord(
              prev.record,
              prev.recordSha256,
              packId,
              prev,
              prev.delegation,
            )) && (await this.opts.storage.verify(prev));
        } catch {
          ok = false;
        }
        if (!ok) return false;
        this.unverifiedPrevious.delete(packId);
      }
      const r = rollbackInstall(doc, packId);
      if (!r.rolledBack) return false;
      this.doc = r.state;
      await this.persist();
      const now = r.state.active[packId]!;
      const h = this.handlers.get(now.type);
      if (this.activation(now) === "hot") {
        if (before && h?.deactivate) await h.deactivate(before);
        await this.activate(now);
      }
      return true;
    });
  }

  /**
   * Install the pinned release of each pack, in order. Resolves to the installs (already-current
   * packs included); raises a `PackError` for the first pack that cannot be installed.
   */
  ensure(packIds: readonly string[]): Promise<PackInstall[]> {
    return this.serialised(async () => {
      this.refuseUnreadable();
      this.delegationBudget = MAX_DELEGATIONS_PER_CHECK;
      const out: PackInstall[] = [];
      for (const id of packIds) out.push(await this.ensureOne(id));
      return out;
    });
  }

  /**
   * Install exact releases (a `packs` decision's `install`, plans/P4-13.md §2.6): each pack's
   * named release, verified against the pinned release keys with that pin, instead of the stamp's
   * pin. Raises `pack-revoked` for a release a verified revocation names.
   */
  ensureReleases(
    targets: readonly {
      pack: string;
      release: { sha256: string; seq: number; version: string };
    }[],
  ): Promise<PackInstall[]> {
    return this.serialised(async () => {
      this.refuseUnreadable();
      this.delegationBudget = MAX_DELEGATIONS_PER_CHECK;
      const out: PackInstall[] = [];
      for (const t of targets)
        out.push(await this.ensureOne(t.pack, t.release));
      return out;
    });
  }

  /**
   * Preflight each pack (CONTENT §10 step 1: record, type, entitlement, variant, index, plan)
   * without downloading the payload, and sum the chosen strategies' bytes: the size a consent
   * dialog discloses (Apple 4.2.3(ii)). The index each tree stages is reused by `ensure`.
   */
  estimate(packIds: readonly string[]): Promise<PackEstimate> {
    return this.estimateAll(packIds.map((id) => ({ pack: id })));
  }

  /** `estimate` for exact releases (a `packs` decision's `install`, plans/P4-13.md §2.6). */
  estimateReleases(
    targets: readonly {
      pack: string;
      release: { sha256: string; seq: number; version: string };
    }[],
  ): Promise<PackEstimate> {
    return this.estimateAll(targets);
  }

  private estimateAll(
    items: readonly {
      pack: string;
      release?: { sha256: string; seq: number; version: string };
    }[],
  ): Promise<PackEstimate> {
    return this.serialised(async () => {
      this.refuseUnreadable();
      this.delegationBudget = MAX_DELEGATIONS_PER_CHECK;
      const out: PackEstimate = { bytes: 0, packs: [], refused: [] };
      for (const { pack: id, release } of items) {
        try {
          const pre = await this.preflight(id, release);
          if (pre.kind === "current") continue;
          if (pre.plan.strategy === "noop") continue;
          out.packs.push(id);
          if ("bytes" in pre.plan) out.bytes += pre.plan.bytes;
        } catch (e) {
          out.refused.push({
            packId: id,
            code: e instanceof PolarisError ? String(e.code) : "network-error",
          });
        }
      }
      return out;
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────

  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private requireLoaded(): PackStateDoc {
    if (!this.doc)
      throw new PackError("not-configured", "Call load() before using packs.");
    return this.doc;
  }

  private emit(e: PackProgress): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // A listener never fails an install.
      }
    }
  }

  /** The torn hold's snapshot: the saved one, else `storage.list()` now (saved when the store
   *  can keep it). Null when it cannot be known (an unreadable snapshot or listing). */
  private async holdList(
    st: PackStateStore,
  ): Promise<{ locations: string[]; plans: string[] } | null> {
    if (typeof st.readHoldList === "function") {
      let saved: string | null;
      try {
        saved = await st.readHoldList();
      } catch {
        return null;
      }
      if (saved !== null) {
        try {
          const d = JSON.parse(saved) as {
            locations?: unknown;
            plans?: unknown;
          };
          if (
            Array.isArray(d.locations) &&
            Array.isArray(d.plans) &&
            [...d.locations, ...d.plans].every((x) => typeof x === "string")
          )
            return {
              locations: d.locations as string[],
              plans: d.plans as string[],
            };
        } catch {
          // Torn too: fall through to the full hold.
        }
        return null;
      }
    }
    let listed: { locations: string[]; plans: string[] };
    try {
      listed = await this.opts.storage.list();
    } catch {
      return null;
    }
    if (typeof st.writeHoldList === "function")
      try {
        await st.writeHoldList(JSON.stringify(listed));
      } catch {
        return null;
      }
    return listed;
  }

  private refuseUnreadable(): void {
    this.requireLoaded();
    if (this.stateIssue === "unreadable")
      throw new PackError(
        "pack-state-unreadable",
        "The pack state could not be read, so nothing is fetched, written or installed this process.",
      );
  }

  private async persist(): Promise<void> {
    if (this.stateIssue === "unreadable")
      throw new PackError(
        "pack-state-unreadable",
        "The pack state could not be read, so nothing is written or installed this process.",
      );
    const doc = this.requireLoaded();
    // Entries whose payload check threw stay in the document for the next load.
    const out: PackStateDoc = {
      ...doc,
      active: { ...this.deferred.active, ...doc.active },
      previous: { ...this.deferred.previous, ...doc.previous },
    };
    for (const id of Object.keys(doc.active))
      if (out.previous[id]?.recordSha256 === out.active[id]?.recordSha256)
        delete out.previous[id];
    await this.opts.state.replace(serializePackState(out));
  }

  /**
   * Operator recovery after a torn state document: drop the copy held aside and resume garbage
   * collection, which then removes the payloads no install names. The installs the torn
   * document held are not recovered (their records went with it); `ensure` reinstalls them.
   */
  recoverState(): Promise<void> {
    return this.serialised(async () => {
      this.requireLoaded();
      if (this.stateIssue === "unreadable")
        throw new PackError(
          "pack-state-unreadable",
          "The pack state could not be read; restart once the store is readable.",
        );
      await this.opts.state.clearQuarantine?.();
      this.stateIssue = null;
      this.gcHold = false;
      this.holdSnapshot = null;
      // plans/P4-13.md §2.5: `relearn` is cleared wholesale and a quarantined
      // `revocations.json` released; revocations are re-learned from the next feed.
      const rs = this.opts.revocations;
      if (rs && this.revIssue !== "unreadable") {
        await rs.clearQuarantine?.();
        if (this.revDoc.relearn.length > 0) {
          this.revDoc = { ...this.revDoc, relearn: [] };
          if (this.revFile) await rs.replace(serializeRevocations(this.revDoc));
        }
        if (this.revIssue === "torn") this.revIssue = null;
      }
      await this.collect();
    });
  }

  // ── Revocations (plans/P4-13.md §2.5) ───────────────────────────────────────────────────

  /** The stored and this process's verified revocations. */
  revocations(): RevocationsSnapshot {
    const revoked: Record<string, StoredRevocation> = {
      ...this.revDoc.revoked,
    };
    for (const [t, r] of this.revVerified)
      if (!Object.prototype.hasOwnProperty.call(revoked, t))
        revoked[t] = {
          jws: this.revJws.get(t) ?? "",
          pack: r.pack,
          version: r.version,
          seq: r.seq,
          record: r.record,
          issuedAt: r.issuedAt,
        };
    return {
      revoked,
      verified: Object.fromEntries(this.revVerified),
      relearn: [...this.revDoc.relearn],
      issue: this.revIssue,
    };
  }

  /**
   * Keep revocations a fresh check verified (plans/P4-13.md §2.5 step 11): each is stored when its
   * target is new, or when `newerRevocation` ranks it above the stored one. `relearnCleared` names
   * the packs a fresh, network-verified feed with a usable `revocations` member re-taught. A
   * revoked install stops running at once (a `hot` handler is deactivated; a `restart` pack is
   * not mounted at the next boot). Writes `state.json`'s `revocationsStored` before the sibling
   * file the first time; writes nothing while either document is unreadable (the revocations
   * still apply for the life of the process).
   */
  recordRevocations(
    learned: readonly { revocation: VerifiedRevocation; jws: string }[],
    opts: { relearnCleared?: readonly string[] } = {},
  ): Promise<void> {
    return this.serialised(async () => {
      this.requireLoaded();
      let next = this.revDoc;
      let changed = false;
      for (const { revocation, jws } of learned) {
        const t = revocation.target;
        const prev = this.revVerified.get(t);
        if (!prev || newerRevocation(revocation, prev) === revocation) {
          this.revVerified.set(t, revocation);
          this.revJws.set(t, jws);
        }
        const r = storeRevocation(next, revocation, jws, (target) =>
          target === t ? prev : undefined,
        );
        next = r.doc;
        changed ||= r.changed;
      }
      const c = clearRelearn(next, opts.relearnCleared ?? []);
      next = c.doc;
      changed ||= c.changed;
      // The cap may have dropped a target: it is forgotten here too.
      for (const t of [...this.revVerified.keys()])
        if (
          !Object.prototype.hasOwnProperty.call(next.revoked, t) &&
          Object.prototype.hasOwnProperty.call(this.revDoc.revoked, t)
        )
          this.revVerified.delete(t);
      this.revDoc = next;
      if (changed) await this.persistRevocations();
      await this.unmountRevoked();
    });
  }

  /** Whether a release is revoked (stored, or verified in this process). */
  isRevoked(recordSha256: string): boolean {
    return (
      Object.prototype.hasOwnProperty.call(this.revDoc.revoked, recordSha256) ||
      this.revVerified.has(recordSha256)
    );
  }

  /** Why a release is revoked (plans/P4-19.md §2.3 `recordRevoked`): `record` when its own hash
   *  is a target, `delegation` when the delegation it was signed under is, else null. */
  revokedBy(
    recordSha256: string,
    delegationSha256: string | null,
  ): "record" | "delegation" | null {
    // `recordRevoked` over this engine's targets (stored, or verified in this process).
    const targets = new Set<string>([
      ...Object.keys(this.revDoc.revoked),
      ...this.revVerified.keys(),
    ]);
    return recordRevoked(recordSha256, delegationSha256, targets);
  }

  /** Whether an install is revoked: its record, or the delegation it was signed under. */
  private installRevoked(i: PackInstall): boolean {
    return this.revokedBy(i.recordSha256, installDelegation(i)) !== null;
  }

  /**
   * The delegated releases this engine knows (plans/P4-19.md §2.7): every stored or running
   * install signed by a content key, and every delegated feed target verified in this process,
   * as record hash → its pack and delegation hash. The update check adds a decision revocation
   * for each one whose delegation is revoked, and treats a delegation entry naming one of these
   * delegations as relevant (step 11).
   */
  delegatedReleases(): Record<string, { pack: string; delegation: string }> {
    const out: Record<string, { pack: string; delegation: string }> =
      Object.fromEntries(this.delegatedKnown);
    const doc = this.doc;
    const installs = [
      ...Object.values(doc?.active ?? {}),
      ...Object.values(doc?.previous ?? {}),
      ...this.running.values(),
    ];
    for (const i of installs) {
      const h = installDelegation(i);
      if (h !== null) out[i.recordSha256] = { pack: i.packId, delegation: h };
    }
    return out;
  }

  /** The embedded-baseline refusals (plans/P4-13.md §2.5): a revoked release; a pack in
   *  `relearn`; with an unreadable `revocations.json` and `revocationsStored` set, every pack
   *  the stamp pins or the host embeds. These apply at every boot and every mount, online or
   *  offline (not only offline), until a fresh feed clears `relearn` (or `recoverState()`); online, the pack is
   *  fetched instead. A product with no revocations refuses nothing. */
  private embeddedRefused(e: PackInstall): boolean {
    if (this.isRevoked(e.recordSha256)) return true;
    if (this.revDoc.relearn.includes(e.packId)) return true;
    if (
      this.revIssue === "unreadable" &&
      this.doc?.revocationsStored === true &&
      (this.stampPacks().has(e.packId) || this.embedded.has(e.packId))
    )
      return true;
    return false;
  }

  private stampPacks(): Set<string> {
    return new Set((this.opts.stamp?.pins ?? []).map((p) => p.pack));
  }

  /** Load `revocations.json` (§2.5): absent is empty; unreadable writes nothing this process;
   *  torn is quarantined and replaced by a fresh document whose `relearn` holds the stamp's
   *  pinned and embedded packs; each entry is re-verified against the pinned release keys. */
  private async loadRevocations(stateUnreadable: boolean): Promise<void> {
    const rs = this.opts.revocations;
    if (!rs) return;
    let text: string | null;
    try {
      text = await rs.read();
    } catch {
      this.revIssue = "unreadable";
      return;
    }
    if (text === null) return;
    this.revFile = true;
    const parsed = text.trim() === "" ? null : parseRevocations(text);
    if (parsed === null) {
      // Torn: held aside, then a fresh document that re-learns the stamp's packs.
      try {
        if (typeof rs.quarantine !== "function")
          throw new Error("no quarantine");
        await rs.quarantine(text);
      } catch {
        this.revIssue = "unreadable";
        return;
      }
      this.revIssue = "torn";
      const relearn = [
        ...new Set([...this.stampPacks(), ...this.embedded.keys()]),
      ].sort();
      this.revDoc = { ...emptyRevocations(), relearn };
      if (!stateUnreadable) await this.writeRevocations();
      return;
    }
    const r = await reloadRevocations(parsed, {
      releaseKeys: this.opts.releaseKeys,
      productTrust: this.opts.productTrust(),
      expectedAud: this.opts.product,
    });
    this.revDoc = r.doc;
    for (const [t, v] of r.verified) this.revVerified.set(t, v);
    if (r.changed && !stateUnreadable) await this.writeRevocations();
    else if (
      !stateUnreadable &&
      !isEmptyRevocations(this.revDoc) &&
      this.doc?.revocationsStored !== true
    ) {
      // A torn (or replaced) `state.json` lost the flag while the sibling file kept its
      // entries: set it again, so an unreadable `revocations.json` later still refuses.
      this.doc = { ...this.requireLoaded(), revocationsStored: true };
      await this.persist();
    }
  }

  /** Persist the revocations: `revocationsStored` in `state.json` first, then the sibling file.
   *  Never creates an empty file; never writes while a document is unreadable. */
  private async persistRevocations(): Promise<void> {
    if (!this.opts.revocations) return;
    if (this.revIssue === "unreadable" || this.stateIssue === "unreadable")
      return;
    if (!this.revFile && isEmptyRevocations(this.revDoc)) return;
    await this.writeRevocations();
  }

  private async writeRevocations(): Promise<void> {
    const rs = this.opts.revocations!;
    const doc = this.requireLoaded();
    if (!doc.revocationsStored) {
      this.doc = { ...doc, revocationsStored: true };
      await this.persist();
    }
    await rs.replace(serializeRevocations(this.revDoc));
    this.revFile = true;
  }

  /** Stop running every revoked release (a hot handler is deactivated). */
  private async unmountRevoked(): Promise<void> {
    for (const [id, i] of [...this.running]) {
      if (!this.installRevoked(i)) continue;
      const h = this.handlers.get(i.type);
      if (this.activation(i) === "hot" && h?.deactivate)
        try {
          await h.deactivate(i);
        } catch {
          // A handler failure never keeps a revoked release running.
        }
      this.running.delete(id);
    }
  }

  private activation(i: PackInstall): "hot" | "restart" {
    return i.activation;
  }

  private async activate(i: PackInstall): Promise<void> {
    const h = this.handlers.get(i.type);
    if (h?.activate) await h.activate(i);
    this.running.set(i.packId, i);
  }

  /** Steps 12–16 again over a stored record, with its own pack id as the pin; a delegated
   *  record through its stored delegation (plans/P4-19.md §2.4: an installed release stays valid
   *  after its window). */
  private async verifyStoredRecord(
    jws: string,
    sha256: string,
    packId: string,
    install?: PackInstall,
    delegation?: string,
  ): Promise<boolean> {
    const r = await verifyReleaseRecord(jws, {
      releaseKeys: this.opts.releaseKeys,
      productTrust: this.opts.productTrust(),
      expectedAud: this.opts.product,
      expectedHash: sha256,
      ...(typeof delegation === "string" ? { delegation } : {}),
    });
    if (!r.ok) return false;
    const rec = r.record as unknown as PackRecordDoc;
    if (rec.kind !== "pack" || rec.deliverable !== packId) return false;
    if (install) {
      if (rec.version !== install.version || rec.seq !== install.seq)
        return false;
      const v = rec.variants.find(
        (x) => variantKey(x.variant) === install.variant,
      );
      if (!v || v.payload.sha256 !== install.payloadSha256) return false;
      if (v.payload.size !== install.payloadSize || rec.type !== install.type)
        return false;
    }
    return true;
  }

  private async verifyEmbedded(
    e: EmbeddedBaseline,
  ): Promise<{ ok: true; install: PackInstall } | { ok: false; step: string }> {
    const m = await verifyMarker(e.marker, {
      releaseKeys: this.opts.releaseKeys,
      productTrust: this.opts.productTrust(),
      expectedAud: this.opts.product,
    });
    if (!m.ok) return { ok: false, step: m.step };
    const match = matchEmbedded(m, e.payload, this.opts.stamp);
    if (!match.ok) return { ok: false, step: match.step };
    const v = m.record.variants[match.variant]!;
    const release =
      typeof e.marker === "string"
        ? e.marker
        : new TextDecoder().decode(e.marker);
    return {
      ok: true,
      install: {
        packId: m.packId,
        record: (JSON.parse(release) as { release: string }).release,
        recordSha256: m.recordSha256,
        version: m.version,
        seq: m.record.seq,
        type: m.record.type,
        variant: variantKey(v.variant),
        layout: v.files.layout,
        payloadSha256: v.payload.sha256,
        payloadSize: v.payload.size,
        activation: activationOf(m.record, this.handlers.get(m.record.type)),
        location: e.location,
        embedded: true,
        installedAt: m.record.issuedAt,
      },
    };
  }

  /** The installs of a pack the planner can reuse: active, previous and the embedded copy. */
  private installsOf(packId: string): PackInstall[] {
    const doc = this.requireLoaded();
    const out: PackInstall[] = [];
    const seen = new Set<string>();
    for (const i of [
      doc.active[packId],
      this.embedded.get(packId),
      doc.previous[packId],
    ])
      if (i && !seen.has(i.location)) {
        seen.add(i.location);
        out.push(i);
      }
    return out;
  }

  /** Steps 1–4 for one pack: what is already current, or the verified record, the variant, the
   *  seeds, the index and the plan. */
  private async preflight(
    packId: string,
    want?: { sha256: string; seq: number; version: string },
  ): Promise<Preflight> {
    const doc = this.requireLoaded();
    const stamp = this.opts.stamp;
    if (!stamp)
      throw new PackError(
        "not-configured",
        "This build ships no content stamp, so it has no packs.",
        { packId },
      );
    const stampPin = stamp.pins.find((p) => p.pack === packId);
    const pin = want ? { pack: packId, release: want } : stampPin;
    if (!pin)
      throw new PackError(
        "pack-not-pinned",
        `The content stamp pins no release of ${packId}.`,
        { packId },
      );
    // plans/P4-13.md §2.5: a revoked release is never installed, activated or mounted.
    if (this.isRevoked(pin.release.sha256))
      throw new PackError(
        "pack-revoked",
        `${packId}@${pin.release.version} was revoked by its developer.`,
        { packId },
      );

    // Already current: the active install, or the embedded copy, is the pinned release.
    const current = doc.active[packId];
    if (current && current.recordSha256 === pin.release.sha256) {
      // plans/P4-19.md §2.6: a release under a revoked delegation is refused like a revoked one.
      if (this.installRevoked(current))
        throw new PackError(
          "pack-revoked",
          `${packId}@${pin.release.version} was signed under a delegation its developer revoked.`,
          { packId, detail: "delegation" },
        );
      return { kind: "current", install: current };
    }
    const emb = this.embedded.get(packId);
    if (
      emb &&
      emb.recordSha256 === pin.release.sha256 &&
      !current &&
      !this.embeddedRefused(emb)
    )
      return { kind: "current", install: emb };

    // 2. The pinned record, by hash, against the pinned release keys.
    const { body, record, delegated } = await this.fetchVerified(packId, pin);

    // 3. Type, entitlement, variant.
    const handler = this.handlers.get(record.type);
    if (
      !handler ||
      !handler.supports(record.formatVersion) ||
      !this.knownActivation(record)
    )
      throw new PackError(
        "pack-type-unsupported",
        `${packId} is a ${record.type} v${record.formatVersion} pack, which this SDK cannot hold.`,
        { packId },
      );
    const granted = this.opts.entitlements?.() ?? null;
    if (
      record.entitlement !== undefined &&
      granted !== null &&
      !granted.has(record.entitlement)
    )
      throw new PackError(
        "pack-not-entitled",
        `${packId} needs the ${record.entitlement} entitlement.`,
        { packId },
      );
    const sel = selectVariant(record.variants, this.opts.prefs);
    if ("error" in sel)
      throw new PackError(
        "pack-no-variant",
        `No variant of ${packId} is eligible here.`,
        { packId },
      );
    const variant = record.variants[sel.index]!;
    if (variant.files.layout !== handler.layout)
      throw new PackError(
        "pack-type-unsupported",
        `${packId}'s variant is a ${variant.files.layout}, not a ${handler.layout}.`,
        { packId },
      );

    // 4. The index (a tree, or any installed release), the target, the plan.
    // Only installs whose bytes can be opened count as installed: the planner must not choose
    // a delta from a base the appliers cannot read.
    const seeds = new Map<string, InstalledPayload>();
    const readable: PackInstall[] = [];
    for (const i of this.installsOf(packId)) {
      const p = await this.opts.storage.installed(i).catch(() => null);
      if (p) {
        seeds.set(i.location, p);
        readable.push(i);
      }
    }
    const installs = readable;
    const prior = doc.inflight[packId];
    const early = this.preflightPlans.get(packId);
    const planId =
      prior &&
      prior.recordSha256 === pin.release.sha256 &&
      prior.variant === variantKey(variant.variant)
        ? prior.planId
        : early && early.recordSha256 === pin.release.sha256
          ? early.planId
          : this.opts.newPlanId();
    this.preflightPlans.set(packId, {
      planId,
      recordSha256: pin.release.sha256,
    });
    let index: FilesIndexDoc | null = null;
    const needIndex =
      variant.files.layout === "tree" ||
      [...seeds.values()].some((s) => s.files !== null);
    // Bound the index before a byte of it is staged (plans/P4-01.md §2.7 step 1).
    const indexOk =
      indexReadable(variant.files) &&
      variant.files.bytes <= MAX_FILES_INDEX_BYTES;
    if (needIndex && !indexOk && variant.files.layout === "tree")
      throw new PackError(
        "files-index-invalid",
        `${packId}'s files index is unreadable here or over the size limit.`,
        { packId },
      );
    if (needIndex && indexOk) {
      const ok = await this.download(
        planId,
        packId,
        { sha256: variant.files.sha256, bytes: variant.files.bytes },
        null,
      );
      if (ok) {
        const staged = await this.opts.storage.stagedObject(
          planId,
          variant.files.sha256,
        );
        const r = await parseFilesIndex(
          await readAll(await staged.source()),
          variant.files,
          variant,
          {
            decode: (f, s) => this.opts.zstd.decode(f, s),
          },
        );
        if (r.ok) index = r.index;
        else if (variant.files.layout === "tree")
          throw new PackError(r.error, `${packId}'s files index was refused.`, {
            packId,
            path: r.path ?? null,
          });
      } else if (variant.files.layout === "tree")
        throw new PackError(
          "network-error",
          `Fetching ${packId}'s files index failed.`,
          { packId },
        );
    }
    // plans/P4-19.md §2.5: a delegated release's extension rule over the files index, before
    // any payload object is fetched.
    if (delegated !== null) {
      if (index === null)
        throw new PackError(
          "files-index-invalid",
          `${packId}'s files index is required for a delegated release.`,
          { packId },
        );
      for (const f of index.files)
        if (dataOnlyPathRefusal(f.path) !== null)
          throw new PackError(
            "pack-not-data-only",
            `${packId} holds ${f.path}, which a delegated content key may not ship.`,
            { packId, path: f.path, detail: "extension" },
          );
    }
    const target = planTarget(variant, pin.release.sha256, index);
    const budget = this.opts.oneShotBudget;
    if (
      budget !== undefined &&
      target.full !== null &&
      !(variant.full.codec === "zstd" && this.opts.zstd.decodeStream) &&
      variant.full.bytes + variant.full.size > budget
    )
      target.full = null;
    const plannerInstalled: PlanInstalled[] = installs.map((i) => ({
      release: i.recordSha256,
      payloadSha256: i.payloadSha256,
      files: seeds.get(i.location)?.files?.map((f) => f.sha256) ?? null,
    }));
    const caps: PlanCaps = {
      strategies: this.opts.strategies ?? ["delta", "file", "full"],
      patchMethods: this.opts.patchMethods,
      transports: this.opts.transports ?? ["pkey-cdn"],
      memBudget: this.opts.memBudget,
      freeDisk: await this.opts.storage.freeDisk().catch(() => 0),
    };
    const p: PlanResult = plan({ target, installed: plannerInstalled, caps });
    if ("error" in p)
      throw new PackError(p.error, `No way to install ${packId}: ${p.error}.`, {
        packId,
      });
    return {
      kind: "plan",
      body,
      recordSha256: pin.release.sha256,
      record,
      variant,
      installs,
      seeds,
      planId,
      index,
      plan: p,
      delegation: delegated,
    };
  }

  /** `providesFacts` of a verified record, by its hash (bounded memo). */
  private factsOf(sha256: string, jws: string): ProvidesFacts {
    const hit = this.providesMemo.get(sha256);
    if (hit) return hit;
    const f = providesFacts(verifiedPayloadOf(jws));
    if (this.providesMemo.size >= MAX_PROVIDES_MEMO) this.providesMemo.clear();
    this.providesMemo.set(sha256, f);
    return f;
  }

  /** A target's facts: from an install or embedded baseline of that release, else its record
   *  fetched and verified (`fetchVerified`); null when that fails. */
  private async targetFacts(t: PackTarget): Promise<ProvidesFacts | null> {
    const sha = t.release.sha256;
    const hit = this.providesMemo.get(sha);
    if (hit) return hit;
    const doc = this.requireLoaded();
    for (const i of [
      doc.active[t.pack],
      doc.previous[t.pack],
      this.running.get(t.pack),
      this.embedded.get(t.pack),
    ])
      if (i && i.recordSha256 === sha && i.packId === t.pack)
        return this.factsOf(sha, i.record);
    try {
      const { body } = await this.fetchVerified(t.pack, t);
      return this.factsOf(sha, body);
    } catch {
      return null;
    }
  }

  /** Step 2 for one pin: the record fetched by hash and verified against the pinned release keys
   *  (a delegated one through its delegation, plans/P4-19.md §2.3). Raises a `PackError`. */
  private async fetchVerified(
    packId: string,
    pin: { release: { sha256: string; seq: number; version: string } },
  ): Promise<{ body: string; record: PackRecordDoc; delegated: string | null }> {
    const got = await this.opts.fetchRecord(pin.release.sha256);
    if (!got.ok)
      throw new PackError(
        got.code,
        `Fetching ${packId}'s record failed (${got.code}).`,
        { packId },
      );
    // plans/P4-19.md §2.3, §2.4: a `pkd1-` kid names its delegation, fetched by hash, only on
    // the delegated surface (a feed target that is neither the stamp's pin or hold for this pack
    // nor a stored revocation's replacement). Elsewhere step 13 refuses it at `jws`.
    const delegationHash = delegationHashOf(got.body);
    const delegation =
      delegationHash !== null &&
      this.delegatedAllowed(packId, pin.release.sha256)
        ? await this.fetchDelegation(packId, delegationHash)
        : null;
    const v = await verifyReleaseRecord(got.body, {
      releaseKeys: this.opts.releaseKeys,
      productTrust: this.opts.productTrust(),
      expectedAud: this.opts.product,
      expectedHash: pin.release.sha256,
      pin: {
        kind: "pack",
        deliverable: packId,
        version: pin.release.version,
        seq: pin.release.seq,
      },
      ...(delegation !== null ? { delegation } : {}),
    });
    if (!v.ok)
      throw v.step === "cross-check"
        ? new PackError(
            "record-mismatch",
            `${packId}'s record is not the pinned release.`,
            { packId },
          )
        : new PackError(
            "record-rejected",
            `${packId}'s record was refused at ${v.step}.`,
            { packId, detail: v.step },
          );
    const record = v.record as unknown as PackRecordDoc;
    if (v.delegation !== null) {
      this.delegatedKnown.set(pin.release.sha256, {
        pack: packId,
        delegation: v.delegation.sha256,
      });
      if (this.revokedBy(pin.release.sha256, v.delegation.sha256) !== null)
        throw new PackError(
          "pack-revoked",
          `${packId}@${pin.release.version} was signed under a delegation its developer revoked.`,
          { packId, detail: "delegation" },
        );
    }
    return {
      body: got.body,
      record,
      delegated: v.delegation !== null ? delegation : null,
    };
  }

  /** §2.4's delegated surface: never the stamp's pin or hold for the pack, never a stored
   *  revocation's replacement (release-key surfaces vouch for exact bytes). */
  private delegatedAllowed(packId: string, sha256: string): boolean {
    const stamp = this.opts.stamp;
    if (
      stamp?.pins.some((p) => p.pack === packId && p.release.sha256 === sha256)
    )
      return false;
    const holds = (stamp as { holds?: unknown } | null)?.holds;
    if (
      Array.isArray(holds) &&
      holds.some(
        (h) =>
          typeof h === "object" &&
          h !== null &&
          (h as { pack?: unknown }).pack === packId &&
          (h as { release?: { sha256?: unknown } }).release?.sha256 === sha256,
      )
    )
      return false;
    for (const r of this.revVerified.values())
      if (r.replacement?.sha256 === sha256) return false;
    return true;
  }

  /** A delegation record by hash: this process's copy, else fetched (at most
   *  `MAX_DELEGATIONS_PER_CHECK` distinct ones per call; a target beyond that waits). */
  private async fetchDelegation(packId: string, hash: string): Promise<string> {
    const have = this.delegationBodies.get(hash);
    if (have !== undefined) return have;
    if (this.delegationBudget <= 0)
      throw new PackError(
        "network-error",
        `${packId}'s delegation was not fetched: this call reached its delegation bound; the next one retries.`,
        { packId, detail: "delegation" },
      );
    this.delegationBudget--;
    const got = await this.opts.fetchRecord(hash);
    if (!got.ok)
      throw new PackError(
        got.code,
        `Fetching ${packId}'s delegation failed (${got.code}).`,
        { packId, detail: "delegation" },
      );
    // Kept only when it is the record the hash names; `verifyReleaseRecord` checks it again.
    if ((await recordHash(got.body)) === hash)
      this.delegationBodies.set(hash, got.body);
    return got.body;
  }

  private async ensureOne(
    packId: string,
    target?: { sha256: string; seq: number; version: string },
  ): Promise<PackInstall> {
    try {
      return await this.ensureOneInner(packId, target);
    } catch (e) {
      // plans/P4-13.md §2.5: when the only copy is an embedded baseline refused for `relearn`
      // (or for `revocationsStored` with an unreadable `revocations.json`) and the fetch cannot
      // proceed, the typed refusal is `pack-revoked` with detail `relearn`.
      const want =
        target?.sha256 ??
        this.opts.stamp?.pins.find((p) => p.pack === packId)?.release.sha256;
      const emb = this.embedded.get(packId);
      if (
        e instanceof PackError &&
        e.code !== "pack-revoked" &&
        emb !== undefined &&
        emb.recordSha256 === want &&
        !this.isRevoked(emb.recordSha256) &&
        this.embeddedRefused(emb)
      )
        throw new PackError(
          "pack-revoked",
          `${packId}'s embedded copy is refused until a fresh feed re-teaches its revocations, and it cannot be fetched (${e.code}).`,
          { packId, detail: "relearn" },
        );
      throw e;
    }
  }

  private async ensureOneInner(
    packId: string,
    target?: { sha256: string; seq: number; version: string },
  ): Promise<PackInstall> {
    const pre = await this.preflight(packId, target);
    if (pre.kind === "current") {
      const current = pre.install;
      if (
        !current.embedded &&
        !this.running.has(packId) &&
        this.activation(current) === "hot"
      )
        await this.activate(current);
      return current;
    }
    const { record, variant, installs, seeds, planId, index, delegation } = pre;
    const p = pre.plan;
    const got = { body: pre.body };
    const pin = { release: { sha256: pre.recordSha256 } };
    this.preflightPlans.delete(packId);
    if (p.strategy === "noop") {
      const same = installs.find(
        (i) => i.payloadSha256 === variant.payload.sha256,
      )!;
      // plans/P4-19.md Amendment A1: a delegated release that reuses an install holding the same
      // payload re-sniffs that install's files, so the data-only rule holds whatever admitted
      // the bytes first (a release-signed install, or an older rule).
      if (delegation !== null) {
        const files = seeds.get(same.location)?.files ?? null;
        if (files === null)
          throw new PackError(
            "pack-not-data-only",
            `${packId}'s reused install cannot be re-checked by the data-only rule.`,
            { packId, detail: "content" },
          );
        for (const f of files) {
          const rule = dataOnlyFileRefusal(f.path, await readAll(f.source));
          if (rule !== null)
            throw new PackError(
              "pack-not-data-only",
              `${packId} holds ${f.path}, which a delegated content key may not ship (${rule}).`,
              { packId, path: f.path, detail: rule },
            );
        }
      }
      return this.commit(
        packId,
        got.body,
        pin.release.sha256,
        record,
        variant,
        same.location,
        null,
        planId,
        true,
        delegation,
      );
    }
    if (p.strategy === "platform")
      throw new PackError(
        "plan-transport-unsupported",
        `${packId} is platform-bound.`,
        { packId },
      );

    // 5–6. Each candidate in turn: journal, fetch, apply.
    let firstFailure: PackError | null = null;
    for (const cand of [p, ...p.fallbacks]) {
      const objects = this.objectsFor(
        cand.strategy,
        cand.delta ?? null,
        variant,
        index,
        seeds,
      );
      if (objects === null) continue;
      const journal: PackJournal = {
        planId,
        packId,
        record: got.body,
        recordSha256: pin.release.sha256,
        variant: variantKey(variant.variant),
        strategy: cand.strategy,
        ...(cand.delta !== undefined ? { delta: cand.delta } : {}),
        objects: objects.map((o) => ({
          sha256: o.sha256,
          bytes: o.bytes,
          done: 0,
        })),
        startedAt: this.opts.now(),
        ...(delegation !== null ? { delegation } : {}),
      };
      this.doc = beginInstall(this.requireLoaded(), journal);
      await this.persist();
      const total = objects.reduce((a, o) => a + o.bytes, 0);
      const progress = { done: 0, total };
      this.emit({ packId, phase: "download", done: 0, total });
      for (const o of objects)
        if (!(await this.download(planId, packId, o, progress)))
          // The journal and what is staged stay for the next `ensure`, which resumes them.
          throw new PackError(
            "network-error",
            `Fetching ${packId}'s objects failed; the next ensure resumes.`,
            { packId },
          );
      this.emit({ packId, phase: "apply", done: total, total });
      // plans/P4-19.md §2.5: every file a delegated install writes passes the data-only rule.
      const seen: { refusal: DataOnlyRefusalSeen | null } = { refusal: null };
      const result = await this.apply(
        planId,
        packId,
        cand.strategy,
        cand.delta ?? null,
        variant,
        seeds,
        delegation !== null ? seen : null,
      );
      if (seen.refusal !== null) {
        // A refusal aborts the plan: no fallback, staging discarded.
        const r: DataOnlyRefusalSeen = seen.refusal;
        this.doc = abandonInstall(this.requireLoaded(), packId);
        await this.persist();
        await this.opts.storage.removeStaging(planId).catch(() => undefined);
        throw new PackError(
          "pack-not-data-only",
          `${packId} holds ${r.path}, which a delegated content key may not ship (${r.rule}).`,
          { packId, path: r.path, detail: r.rule },
        );
      }
      if (result.verdict.ok) {
        const location = await this.opts.storage.commit(
          planId,
          packId,
          variant.payload.sha256,
          variant.files.layout,
          result.index ?? index,
        );
        const install = await this.commit(
          packId,
          got.body,
          pin.release.sha256,
          record,
          variant,
          location,
          planId,
          planId,
          false,
          delegation,
        );
        this.emit({ packId, phase: "done", done: total, total });
        return install;
      }
      const f = result.verdict;
      firstFailure ??= new PackError(
        f.error,
        `Installing ${packId} by ${cand.strategy} failed: ${f.error}.`,
        { packId, path: f.path ?? null, detail: cand.strategy },
      );
      await this.opts.storage.removeStaging(planId).catch(() => undefined);
    }
    this.doc = abandonInstall(this.requireLoaded(), packId);
    await this.persist();
    await this.opts.storage.removeStaging(planId).catch(() => undefined);
    throw (
      firstFailure ??
      new PackError("plan-no-strategy", `No way to install ${packId}.`, {
        packId,
      })
    );
  }

  private knownActivation(record: PackRecordDoc): boolean {
    const a = record.handler?.activation;
    return a === undefined || a === "hot" || a === "restart";
  }

  /** The objects a strategy fetches, in order; null when the strategy cannot run here. */
  private objectsFor(
    strategy: string,
    delta: string | null,
    variant: PackVariant,
    index: FilesIndexDoc | null,
    seeds: Map<string, InstalledPayload>,
  ): { sha256: string; bytes: number }[] | null {
    const files = variant.files;
    const idx = { sha256: files.sha256, bytes: files.bytes };
    const gaps =
      files.layout === "container" && files.gaps
        ? [{ sha256: files.gaps.sha256, bytes: files.gaps.bytes }]
        : [];
    if (strategy === "full")
      return files.layout === "tree"
        ? [idx, { sha256: variant.full.sha256, bytes: variant.full.bytes }]
        : [{ sha256: variant.full.sha256, bytes: variant.full.bytes }];
    if (strategy === "delta") {
      const d = (variant.deltas ?? []).find((x) =>
        x.scope === "payload"
          ? x.artifact.sha256 === delta
          : x.scope === "files" && x.patch.sha256 === delta,
      );
      if (!d) return null;
      if (d.scope === "payload")
        return [{ sha256: d.artifact.sha256, bytes: d.artifact.bytes }];
      return [
        idx,
        ...gaps,
        { sha256: d.patch.sha256, bytes: d.patch.bytes },
        { sha256: d.data.sha256, bytes: d.data.bytes },
      ];
    }
    if (strategy === "file") {
      if (index === null) return null;
      const held = new Set<string>();
      for (const s of seeds.values())
        for (const f of s.files ?? []) held.add(f.sha256);
      const blobs = new Map<string, number>();
      for (const f of index.files)
        if (!held.has(f.sha256) && !blobs.has(f.blob.sha256))
          blobs.set(f.blob.sha256, f.blob.bytes);
      return [
        idx,
        ...gaps,
        ...[...blobs].map(([sha256, bytes]) => ({ sha256, bytes })),
      ];
    }
    return null;
  }

  private async apply(
    planId: string,
    packId: string,
    strategy: string,
    delta: string | null,
    variant: PackVariant,
    seeds: Map<string, InstalledPayload>,
    dataOnly: { refusal: DataOnlyRefusalSeen | null } | null = null,
  ): Promise<ApplyResult> {
    const storage = this.opts.storage;
    const objects = async (sha256: string): Promise<ByteSource | null> => {
      const o = await storage.stagedObject(planId, sha256);
      return (await o.size()) > 0 || sha256 === EMPTY_SHA256
        ? o.source()
        : null;
    };
    const out = await storage.output(planId, variant.files.layout);
    if (dataOnly !== null && out.tree)
      out.tree = dataOnlyTreeSink(out.tree, dataOnly);
    const ports = {
      objects,
      zstd: this.opts.zstd,
      sha256: this.opts.sha256,
      ...out,
    };
    if (strategy === "full") return applyFull(variant, ports);
    const installed: InstalledFile[] = [];
    for (const s of seeds.values()) installed.push(...(s.files ?? []));
    if (strategy === "file") return applyFile(variant, null, installed, ports);
    const k = (variant.deltas ?? []).findIndex((x) =>
      x.scope === "payload"
        ? x.artifact.sha256 === delta
        : x.scope === "files" && x.patch.sha256 === delta,
    );
    const d = (variant.deltas ?? [])[k]!;
    if (d.scope === "files") return applyFile(variant, k, installed, ports);
    // A payload delta's base: the installed payload whose hash is `from`.
    let base: ByteSource | null = null;
    for (const i of this.installsOf(packId)) {
      const s = seeds.get(i.location);
      if (base === null && i.payloadSha256 === d.from && s?.payload)
        base = s.payload;
    }
    if (base === null)
      return { verdict: { ok: false, error: "delta-base-mismatch" } };
    return applyDelta(variant, k, base, ports);
  }

  /** Commit: the pointer swap, activation, garbage collection. */
  private async commit(
    packId: string,
    recordJws: string,
    recordSha256: string,
    record: PackRecordDoc,
    variant: PackVariant,
    location: string,
    _planId: string | null,
    stagingPlan: string,
    reused: boolean,
    delegation: string | null = null,
  ): Promise<PackInstall> {
    const install: PackInstall = {
      packId,
      record: recordJws,
      recordSha256,
      version: record.version,
      seq: record.seq,
      type: record.type,
      variant: variantKey(variant.variant),
      layout: variant.files.layout,
      payloadSha256: variant.payload.sha256,
      payloadSize: variant.payload.size,
      activation: activationOf(record, this.handlers.get(record.type)),
      location,
      ...(this.embedded.get(packId)?.location === location
        ? { embedded: true }
        : {}),
      installedAt: this.opts.now(),
      ...(delegation !== null ? { delegation } : {}),
    };
    // A fresh commit supersedes this pack's entries whose check could not run; an active one
    // becomes `previous`, re-verified before a rollback uses it.
    const carried = this.deferred.active[packId];
    delete this.deferred.active[packId];
    delete this.deferred.previous[packId];
    const before = this.running.get(packId);
    this.doc = commitInstall(this.requireLoaded(), install);
    if (carried && carried.recordSha256 !== install.recordSha256) {
      this.doc = {
        ...this.doc,
        previous: { ...this.doc.previous, [packId]: carried },
      };
      this.unverifiedPrevious.add(packId);
    } else this.unverifiedPrevious.delete(packId);
    await this.persist();
    if (!reused)
      await this.opts.storage.removeStaging(stagingPlan).catch(() => undefined);
    const h = this.handlers.get(record.type);
    if (install.activation === "hot") {
      if (before && before.location !== location && h?.deactivate)
        await h.deactivate(before);
      await this.activate(install);
    }
    await this.collect();
    return install;
  }

  /** Remove every stored location and staging area no root holds. */
  private async collect(): Promise<void> {
    if (this.gcHold) return;
    const roots = gcRoots(this.requireLoaded(), [
      ...this.embedded.values(),
      ...this.running.values(),
    ]);
    for (const loc of this.unverifiable) roots.locations.add(loc);
    const listed = await this.opts.storage
      .list()
      .catch(() => ({ locations: [], plans: [] }));
    const held = this.holdSnapshot;
    for (const loc of listed.locations)
      if (!roots.locations.has(loc) && !held?.locations.has(loc))
        await this.opts.storage.remove(loc).catch(() => undefined);
    for (const plan of listed.plans)
      if (!roots.plans.has(plan) && !held?.plans.has(plan))
        await this.opts.storage.removeStaging(plan).catch(() => undefined);
  }

  /**
   * Stage one object: resume from what is staged (its bytes re-hashed, never trusted), fetch the
   * rest with `Range` and `If-Range`, checkpoint the journal. True when the staged object then
   * has the ref's length and SHA-256; a mismatch resets it and refetches once from the start.
   */
  private async download(
    planId: string,
    packId: string,
    ref: { sha256: string; bytes: number },
    progress: { done: number; total: number } | null,
  ): Promise<boolean> {
    const staged = await this.opts.storage.stagedObject(planId, ref.sha256);
    for (let attempt = 0; attempt < 2; attempt++) {
      let have = await staged.size();
      if (have > ref.bytes) {
        await staged.reset();
        have = 0;
      }
      // Resume: what is staged is hashed again, never taken on trust.
      const hasher = this.opts.sha256();
      if (have > 0) {
        const src = await staged.source();
        for (let at = 0; at < have; ) {
          const chunk = await src.read(at, Math.min(READ_CHUNK, have - at));
          if (chunk.byteLength === 0) break;
          hasher.update(chunk);
          at += chunk.byteLength;
        }
      }
      const counted = progress ? have : 0;
      if (progress) {
        progress.done += counted;
        this.emit({ packId, phase: "download", ...progress });
      }
      let outcome: "ok" | "interrupted" | "mismatch";
      if (have < ref.bytes) {
        let res: ObjectResponse;
        try {
          res = await this.opts.fetchObject({
            sha256: ref.sha256,
            offset: have,
            ifRange: have > 0 ? `"${ref.sha256}"` : null,
          });
        } catch {
          return false;
        }
        if (res.status === 200 && have > 0) {
          // The validator moved, so the server sent the whole object: start over.
          if (progress) progress.done -= counted;
          await staged.reset();
          outcome = await this.fetchInto(
            staged,
            res,
            ref,
            this.opts.sha256(),
            0,
            planId,
            packId,
            progress,
          );
        } else if (
          res.status === 206 &&
          have > 0 &&
          rangeStartsAt(res.contentRange, have)
        ) {
          outcome = await this.fetchInto(
            staged,
            res,
            ref,
            hasher,
            have,
            planId,
            packId,
            progress,
          );
        } else if (res.status === 200) {
          outcome = await this.fetchInto(
            staged,
            res,
            ref,
            hasher,
            0,
            planId,
            packId,
            progress,
          );
        } else return false;
      } else {
        outcome = (await hasher.digest()) === ref.sha256 ? "ok" : "mismatch";
      }
      if (outcome === "ok") return true;
      // An interrupted transfer keeps what is staged for the next resume.
      if (outcome === "interrupted") return false;
      if (progress) progress.done -= Math.min(await staged.size(), ref.bytes);
      await staged.reset();
    }
    return false;
  }

  private async fetchInto(
    staged: StagedObject,
    res: ObjectResponse,
    ref: { sha256: string; bytes: number },
    hasher: { update(b: Uint8Array): void; digest(): string | Promise<string> },
    from: number,
    planId: string,
    packId: string,
    progress: { done: number; total: number } | null,
  ): Promise<"ok" | "interrupted" | "mismatch"> {
    let have = from;
    let sinceCheckpoint = 0;
    const every = this.opts.checkpointBytes ?? 8 << 20;
    const save = async (): Promise<void> => {
      if (this.doc?.inflight[packId]?.planId !== planId) return;
      this.doc = checkpoint(this.doc, packId, ref.sha256, have);
      await this.persist();
    };
    try {
      for await (const chunk of res.chunks) {
        if (have + chunk.byteLength > ref.bytes) return "mismatch";
        hasher.update(chunk);
        await staged.append(chunk);
        have += chunk.byteLength;
        sinceCheckpoint += chunk.byteLength;
        if (progress) {
          progress.done += chunk.byteLength;
          this.emit({ packId, phase: "download", ...progress });
        }
        if (sinceCheckpoint >= every) {
          sinceCheckpoint = 0;
          await save();
        }
      }
    } catch {
      await save().catch(() => undefined);
      return "interrupted";
    }
    await save();
    return have === ref.bytes && (await hasher.digest()) === ref.sha256
      ? "ok"
      : "mismatch";
  }
}

/** SHA-256 of the empty string: an empty object is legitimately zero bytes long. */
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function rangeStartsAt(contentRange: string | null, offset: number): boolean {
  if (contentRange === null) return false;
  const m = /^bytes (\d+)-\d+\/\d+$/.exec(contentRange.trim());
  return m !== null && Number(m[1]) === offset;
}

/** Whether stored text is at least a version-1 state document's shape. */
function looksLikeState(text: string): boolean {
  try {
    const d = JSON.parse(text) as { v?: unknown };
    return typeof d === "object" && d !== null && d.v === 1;
  } catch {
    return false;
  }
}

/** A record's activation, else its handler's default. */
function activationOf(
  record: PackRecordDoc,
  handler: PackHandler | undefined,
): "hot" | "restart" {
  const a = record.handler?.activation;
  if (a === "hot" || a === "restart") return a;
  return handler?.activation ?? "restart";
}

/** The most record facts `providesMemo` keeps before it starts over. */
const MAX_PROVIDES_MEMO = 1024;

/** Whether the licence lets a pack answer: ungated, no License service, or the flag granted. */
function entitled(
  f: ProvidesFacts,
  granted: ReadonlySet<string> | null,
): boolean {
  return f.entitlement === null || granted === null || granted.has(f.entitlement);
}

/** The delegation hash of a delegated install (its stored delegation and the record's kid), or
 *  null for a release-signed one. */
function installDelegation(i: PackInstall): string | null {
  return typeof i.delegation === "string" ? delegationHashOf(i.record) : null;
}
