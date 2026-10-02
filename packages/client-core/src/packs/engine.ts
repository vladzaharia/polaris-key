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
import { PolarisError } from "../errors.js";
import { verifyReleaseRecord } from "../record.js";
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
import { planTarget, selectVariant, type VariantPrefs } from "./select.js";
import { packSetId } from "./set.js";
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
  phase: "download" | "apply" | "done";
  done: number;
  total: number;
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
  private doc: PackStateDoc | null = null;
  /** Plan ids `estimate` staged an index under, reused by the next `ensure`. */
  private readonly preflightPlans = new Map<
    string,
    { planId: string; recordSha256: string }
  >();
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
      const text = await this.opts.state.read().catch(() => null);
      const parsed = parsePackState(text);
      // A document that exists but does not parse (a torn write) is not the empty state: nothing
      // it named is collected this load, so a crash cannot wipe the store.
      const torn = text !== null && text.trim() !== "" && !looksLikeState(text);
      const doc = await reloadPackState(parsed, {
        install: async (i) => {
          if (
            !(await this.verifyStoredRecord(
              i.record,
              i.recordSha256,
              i.packId,
              i,
            ))
          )
            return false;
          try {
            return await this.opts.storage.verify(i);
          } catch {
            // The payload could not be read (an I/O error, not a mismatch): not used this
            // load, but not collected either.
            this.unverifiable.add(i.location);
            return false;
          }
        },
        journal: (j) =>
          this.verifyStoredRecord(j.record, j.recordSha256, j.packId),
      });
      this.doc = doc;
      // This boot's set: every active install (restart packs mount now), else the embedded
      // baseline.
      for (const i of Object.values(doc.active)) await this.activate(i);
      for (const [id, e] of this.embedded)
        if (!this.running.has(id)) this.running.set(id, e);
      await this.persist();
      if (!torn) await this.collect();
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

  /** Mark this boot healthy (CONTENT §10 step 7). */
  confirm(): Promise<void> {
    return this.serialised(async () => {
      this.doc = confirmBoot(this.requireLoaded());
      await this.persist();
    });
  }

  /** Re-point a pack at `previous`. A hot pack switches now; a restart pack at the next boot. */
  rollback(packId: string): Promise<boolean> {
    return this.serialised(async () => {
      const doc = this.requireLoaded();
      const before = doc.active[packId];
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
      const out: PackInstall[] = [];
      for (const id of packIds) out.push(await this.ensureOne(id));
      return out;
    });
  }

  /**
   * Preflight each pack (CONTENT §10 step 1: record, type, entitlement, variant, index, plan)
   * without downloading the payload, and sum the chosen strategies' bytes: the size a consent
   * dialog discloses (Apple 4.2.3(ii)). The index each tree stages is reused by `ensure`.
   */
  estimate(packIds: readonly string[]): Promise<PackEstimate> {
    return this.serialised(async () => {
      const out: PackEstimate = { bytes: 0, packs: [], refused: [] };
      for (const id of packIds) {
        try {
          const pre = await this.preflight(id);
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

  private async persist(): Promise<void> {
    await this.opts.state.replace(serializePackState(this.requireLoaded()));
  }

  private activation(i: PackInstall): "hot" | "restart" {
    return i.activation;
  }

  private async activate(i: PackInstall): Promise<void> {
    const h = this.handlers.get(i.type);
    if (h?.activate) await h.activate(i);
    this.running.set(i.packId, i);
  }

  /** Steps 12–15 again over a stored record, with its own pack id as the pin. */
  private async verifyStoredRecord(
    jws: string,
    sha256: string,
    packId: string,
    install?: PackInstall,
  ): Promise<boolean> {
    const r = await verifyReleaseRecord(jws, {
      releaseKeys: this.opts.releaseKeys,
      productTrust: this.opts.productTrust(),
      expectedAud: this.opts.product,
      expectedHash: sha256,
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
  private async preflight(packId: string): Promise<Preflight> {
    const doc = this.requireLoaded();
    const stamp = this.opts.stamp;
    if (!stamp)
      throw new PackError(
        "not-configured",
        "This build ships no content stamp, so it has no packs.",
        { packId },
      );
    const pin = stamp.pins.find((p) => p.pack === packId);
    if (!pin)
      throw new PackError(
        "pack-not-pinned",
        `The content stamp pins no release of ${packId}.`,
        { packId },
      );

    // Already current: the active install, or the embedded copy, is the pinned release.
    const current = doc.active[packId];
    if (current && current.recordSha256 === pin.release.sha256) {
      return { kind: "current", install: current };
    }
    const emb = this.embedded.get(packId);
    if (emb && emb.recordSha256 === pin.release.sha256 && !current)
      return { kind: "current", install: emb };

    // 2. The pinned record, by hash, against the pinned release keys.
    const got = await this.opts.fetchRecord(pin.release.sha256);
    if (!got.ok)
      throw new PackError(
        got.code,
        `Fetching ${packId}'s record failed (${got.code}).`,
        { packId },
      );
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
    if (needIndex) {
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
    const target = planTarget(variant, pin.release.sha256, index);
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
      body: got.body,
      recordSha256: pin.release.sha256,
      record,
      variant,
      installs,
      seeds,
      planId,
      index,
      plan: p,
    };
  }

  private async ensureOne(packId: string): Promise<PackInstall> {
    const pre = await this.preflight(packId);
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
    const { record, variant, installs, seeds, planId, index } = pre;
    const p = pre.plan;
    const got = { body: pre.body };
    const pin = { release: { sha256: pre.recordSha256 } };
    this.preflightPlans.delete(packId);
    if (p.strategy === "noop") {
      const same = installs.find(
        (i) => i.payloadSha256 === variant.payload.sha256,
      )!;
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
      const result = await this.apply(
        planId,
        packId,
        cand.strategy,
        cand.delta ?? null,
        variant,
        seeds,
      );
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
  ): Promise<ApplyResult> {
    const storage = this.opts.storage;
    const objects = async (sha256: string): Promise<ByteSource | null> => {
      const o = await storage.stagedObject(planId, sha256);
      return (await o.size()) > 0 || sha256 === EMPTY_SHA256
        ? o.source()
        : null;
    };
    const out = await storage.output(planId, variant.files.layout);
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
      installedAt: this.opts.now(),
    };
    const before = this.running.get(packId);
    this.doc = commitInstall(this.requireLoaded(), install);
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
    const roots = gcRoots(this.requireLoaded(), [
      ...this.embedded.values(),
      ...this.running.values(),
    ]);
    for (const loc of this.unverifiable) roots.locations.add(loc);
    const listed = await this.opts.storage
      .list()
      .catch(() => ({ locations: [], plans: [] }));
    for (const loc of listed.locations)
      if (!roots.locations.has(loc))
        await this.opts.storage.remove(loc).catch(() => undefined);
    for (const plan of listed.plans)
      if (!roots.plans.has(plan))
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
