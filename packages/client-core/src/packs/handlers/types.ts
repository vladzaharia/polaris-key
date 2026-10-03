// The v3 pack-type handlers client-core ships (CONTENT §4.2, §13; P4-16): `data.json`,
// `l10n.table` and `ml.model`, shared by @polaris-key/node and @polaris-key/react. Python, Swift
// and Godot port them against `test/fixtures/pack-type-cases.json`.
//
// Every handler is a tree handler (a delegated payload is always tree layout, plans/P4-19.md
// §8.5), activates hot, and checks a newly staged payload in `check` before it commits, raising
// `pack-type-check-failed` through the engine with a `detail` token and the file's `path`. The
// engine has already verified every hash, refused every unsafe path (`checkPaths`) and, for a
// delegated release, applied the data-only rule: a handler only judges the type.
//
// They PARSE untrusted bytes and never evaluate them (no `eval`, no `Function`, no object
// revivers, no engine resource loader). A file is judged by its bytes, never its name; files
// are looked up by exact index path only.

import { strictParse } from "../files.js";
import type { InstalledFile } from "../ports.js";
import { readAll } from "../ports.js";
import { compareBytes } from "../variant.js";
import type {
  PackCheckRefusal,
  PackHandler,
  PackPayloadAccess,
  StagedPack,
} from "../engine.js";
import type { PackInstall } from "../state.js";
import { parseL10nFile, sameLocale, type L10nTable } from "./l10n.js";

/** The largest data or table file a handler parses (16 MiB), unless the host sets another. */
export const DEFAULT_MAX_TYPE_FILE_BYTES = 16 * 1024 * 1024;
/** The largest `model.json` or `bank.json` descriptor. */
export const MAX_DESCRIPTOR_BYTES = 65536;
/** A descriptor token (`runtime`, `quantization`, `middleware`). */
export const TYPE_TOKEN_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const refuse = (
  detail: string,
  path?: string,
  message?: string,
): PackCheckRefusal => ({
  detail,
  ...(path !== undefined ? { path } : {}),
  ...(message !== undefined ? { message } : {}),
});

const formatsOf = (v: readonly number[] | undefined): Set<number> =>
  new Set(v ?? [1]);

/** An install's files in index (UTF-8 path byte) order. */
async function filesOf(p: PackPayloadAccess): Promise<InstalledFile[]> {
  return [...((await p.read())?.files ?? [])].sort((a, b) =>
    compareBytes(a.path, b.path),
  );
}

// ── data.json ──────────────────────────────────────────────────────────────────────────────

export interface DataJsonHandlerOptions {
  /** The `formatVersion`s (the payload's JSON Schema versions) this app reads; default `[1]`. */
  formatVersions?: readonly number[];
  /** Files above this many bytes are refused (`size`); default 16 MiB. */
  maxFileBytes?: number;
  /** A release became live: its documents by index path, in index order. */
  onActivate?: (
    packId: string,
    documents: ReadonlyMap<string, unknown>,
  ) => void | Promise<void>;
  /** A live release was replaced, rolled back or revoked. */
  onDeactivate?: (packId: string) => void | Promise<void>;
}

/**
 * `data.json` (CONTENT §4.2): JSON documents (balance tables, event definitions), hot. Every file
 * must be strict JSON (WIRE-CONTRACT-V4 §1.2: UTF-8 without a BOM, no duplicate member, no
 * trailing comma, comment, `NaN` or second value), whatever its name. Tiny, frequently tuned
 * values belong in managed config, not a pack.
 */
export class DataJsonHandler implements PackHandler {
  readonly type = "data.json";
  readonly layout = "tree" as const;
  readonly activation = "hot" as const;
  private readonly formats: Set<number>;
  private readonly maxFileBytes: number;
  private readonly live = new Map<string, ReadonlyMap<string, unknown>>();

  constructor(private readonly opts: DataJsonHandlerOptions = {}) {
    this.formats = formatsOf(opts.formatVersions);
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_TYPE_FILE_BYTES;
  }

  supports(formatVersion: number): boolean {
    return this.formats.has(formatVersion);
  }

  /** The live release's documents, or null. */
  documents(packId: string): ReadonlyMap<string, unknown> | null {
    return this.live.get(packId) ?? null;
  }

  async check(staged: StagedPack): Promise<PackCheckRefusal | null> {
    for (const f of staged.files) {
      if (f.size > this.maxFileBytes) return refuse("size", f.path);
      if (strictParse(await readAll(f.source)) === null)
        return refuse("json", f.path);
    }
    return null;
  }

  async activate(install: PackInstall, payload: PackPayloadAccess) {
    const docs = new Map<string, unknown>();
    for (const f of await filesOf(payload)) {
      const parsed = strictParse(await readAll(f.source));
      if (parsed === null)
        throw new Error(
          `${install.packId}: ${f.path} is no longer strict JSON.`,
        );
      docs.set(f.path, parsed.value);
    }
    this.live.set(install.packId, docs);
    await this.opts.onActivate?.(install.packId, docs);
  }

  async deactivate(install: PackInstall) {
    this.live.delete(install.packId);
    await this.opts.onDeactivate?.(install.packId);
  }
}

// ── l10n.table ─────────────────────────────────────────────────────────────────────────────

export interface L10nTableHandlerOptions {
  /** The `formatVersion`s (key-schema versions) this app reads; default `[1]` (PO, CSV, JSON). */
  formatVersions?: readonly number[];
  /** Files above this many bytes are refused (`size`); default 16 MiB. */
  maxFileBytes?: number;
  onActivate?: (
    packId: string,
    tables: readonly L10nTable[],
  ) => void | Promise<void>;
  /** The tables a replaced, rolled-back or revoked release had registered. */
  onDeactivate?: (
    packId: string,
    tables: readonly L10nTable[],
  ) => void | Promise<void>;
}

/** Every table of a payload, or the first refusal. `locale` is the variant's `locale` axis. */
export async function readL10nTables(
  files: readonly InstalledFile[],
  locale: string | undefined,
  maxFileBytes: number = DEFAULT_MAX_TYPE_FILE_BYTES,
): Promise<
  { ok: true; tables: L10nTable[] } | { ok: false; refusal: PackCheckRefusal }
> {
  const tables: L10nTable[] = [];
  for (const f of files) {
    if (f.size > maxFileBytes)
      return { ok: false, refusal: refuse("size", f.path) };
    const r = parseL10nFile(f.path, await readAll(f.source));
    if (!r.ok) return { ok: false, refusal: refuse(r.detail, f.path) };
    for (const t of r.tables)
      if (locale !== undefined && !sameLocale(t.locale, locale))
        return {
          ok: false,
          refusal: refuse(
            "locale",
            f.path,
            `${f.path} is a ${t.locale} table in the ${locale} variant.`,
          ),
        };
    tables.push(...r.tables);
  }
  return { ok: true, tables };
}

/**
 * `l10n.table` (CONTENT §4.2): PO, CSV or JSON tables, hot. Each file is parsed by a plain parser
 * (never evaluated); each table's locale must be a well-formed BCP-47 tag and, when the variant
 * has a `locale` axis, that locale. The host takes the tables in `onActivate` (or reads
 * `tables(packId)`) and feeds its own translation system.
 */
export class L10nTableHandler implements PackHandler {
  readonly type = "l10n.table";
  readonly layout = "tree" as const;
  readonly activation = "hot" as const;
  private readonly formats: Set<number>;
  private readonly maxFileBytes: number;
  private readonly live = new Map<string, readonly L10nTable[]>();

  constructor(private readonly opts: L10nTableHandlerOptions = {}) {
    this.formats = formatsOf(opts.formatVersions);
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_TYPE_FILE_BYTES;
  }

  supports(formatVersion: number): boolean {
    return this.formats.has(formatVersion);
  }

  /** The live release's tables, or null. */
  tables(packId: string): readonly L10nTable[] | null {
    return this.live.get(packId) ?? null;
  }

  async check(staged: StagedPack): Promise<PackCheckRefusal | null> {
    const r = await readL10nTables(
      staged.files,
      staged.variant.variant.locale,
      this.maxFileBytes,
    );
    return r.ok ? null : r.refusal;
  }

  async activate(install: PackInstall, payload: PackPayloadAccess) {
    const r = await readL10nTables(
      await filesOf(payload),
      undefined,
      this.maxFileBytes,
    );
    if (!r.ok)
      throw new Error(
        `${install.packId}: its tables no longer parse (${r.refusal.detail}).`,
      );
    this.live.set(install.packId, r.tables);
    await this.opts.onActivate?.(install.packId, r.tables);
  }

  async deactivate(install: PackInstall) {
    const was = this.live.get(install.packId) ?? [];
    this.live.delete(install.packId);
    await this.opts.onDeactivate?.(install.packId, was);
  }
}

// ── ml.model ───────────────────────────────────────────────────────────────────────────────

/** `model.json`, the descriptor at the root of an `ml.model` payload. */
export interface ModelDescriptor {
  runtime: string;
  /** The model file: exactly an index path of the payload. */
  file: string;
  /** RAM the model needs, in bytes. */
  memBytes: number;
  vramBytes?: number;
  quantization?: string;
}

export interface MlModel {
  packId: string;
  location: string;
  /** The model file's index path. */
  path: string;
  descriptor: ModelDescriptor;
}

export interface MlModelHandlerOptions {
  /** The runtimes this host can load (`onnx`, `gguf`, …). */
  runtimes: readonly string[];
  /** The RAM a model may need, in bytes. */
  ramBytes: number;
  /** The VRAM a model may need, in bytes; default 0. */
  vramBytes?: number;
  /** The quantisations accepted; absent accepts any (and none). */
  quantizations?: readonly string[];
  /** Loads the staged model as the app would, before the path swaps; false (or a throw)
   *  refuses it (`load-test`). */
  loadTest?: (model: {
    packId: string;
    location: string;
    file: InstalledFile;
    descriptor: ModelDescriptor;
  }) => boolean | Promise<boolean>;
  onActivate?: (model: MlModel) => void | Promise<void>;
  onDeactivate?: (packId: string) => void | Promise<void>;
  formatVersions?: readonly number[];
}

/** The model descriptor of a payload, or the refusal (`descriptor`, path `model.json`). */
export async function readModelDescriptor(
  files: readonly InstalledFile[],
): Promise<
  { ok: true; descriptor: ModelDescriptor; file: InstalledFile } | { ok: false }
> {
  const d = files.find((f) => f.path === "model.json");
  if (!d || d.size > MAX_DESCRIPTOR_BYTES) return { ok: false };
  const parsed = strictParse(await readAll(d.source));
  if (parsed === null) return { ok: false };
  const v = parsed.value;
  if (typeof v !== "object" || v === null || Array.isArray(v))
    return { ok: false };
  const o = v as Record<string, unknown>;
  const wire = (x: unknown, ptr: string) =>
    typeof x === "number" &&
    Number.isSafeInteger(x) &&
    x >= 0 &&
    !parsed.nonWire.has(ptr);
  if (typeof o.runtime !== "string" || !TYPE_TOKEN_PATTERN.test(o.runtime))
    return { ok: false };
  if (typeof o.file !== "string" || o.file === "model.json")
    return { ok: false };
  const file = files.find((f) => f.path === o.file);
  if (!file) return { ok: false };
  if (!wire(o.memBytes, "/memBytes")) return { ok: false };
  if (o.vramBytes !== undefined && !wire(o.vramBytes, "/vramBytes"))
    return { ok: false };
  if (
    o.quantization !== undefined &&
    (typeof o.quantization !== "string" ||
      !TYPE_TOKEN_PATTERN.test(o.quantization))
  )
    return { ok: false };
  return {
    ok: true,
    file,
    descriptor: {
      runtime: o.runtime,
      file: o.file,
      memBytes: o.memBytes as number,
      ...(o.vramBytes !== undefined
        ? { vramBytes: o.vramBytes as number }
        : {}),
      ...(o.quantization !== undefined
        ? { quantization: o.quantization as string }
        : {}),
    },
  };
}

/**
 * `ml.model` (CONTENT §4.2): GGUF, ONNX or safetensors with a `model.json` descriptor, hot. The
 * runtime, quantisation and RAM/VRAM needs are checked against what the host declares, then the
 * host's load test runs over the staged file; only then does `model(packId)` swap to it. Not
 * built in: the host registers one with its budget.
 */
export class MlModelHandler implements PackHandler {
  readonly type = "ml.model";
  readonly layout = "tree" as const;
  readonly activation = "hot" as const;
  private readonly formats: Set<number>;
  private readonly live = new Map<string, MlModel>();

  constructor(private readonly opts: MlModelHandlerOptions) {
    if (
      !Array.isArray(opts?.runtimes) ||
      opts.runtimes.length === 0 ||
      !Number.isSafeInteger(opts.ramBytes) ||
      opts.ramBytes < 0 ||
      (opts.vramBytes !== undefined &&
        (!Number.isSafeInteger(opts.vramBytes) || opts.vramBytes < 0))
    )
      throw new TypeError(
        "MlModelHandler needs {runtimes: a non-empty list, ramBytes: a non-negative integer, vramBytes?: a non-negative integer}.",
      );
    this.formats = formatsOf(opts.formatVersions);
  }

  supports(formatVersion: number): boolean {
    return this.formats.has(formatVersion);
  }

  /** The live release's model, or null. */
  model(packId: string): MlModel | null {
    return this.live.get(packId) ?? null;
  }

  async check(staged: StagedPack): Promise<PackCheckRefusal | null> {
    const d = await readModelDescriptor(staged.files);
    if (!d.ok) return refuse("descriptor", "model.json");
    const m = d.descriptor;
    if (!this.opts.runtimes.includes(m.runtime))
      return refuse(
        "runtime",
        "model.json",
        `this host runs ${this.opts.runtimes.join(", ")}, not ${m.runtime}.`,
      );
    const q = this.opts.quantizations;
    if (
      q !== undefined &&
      (m.quantization === undefined || !q.includes(m.quantization))
    )
      return refuse("quantization", "model.json");
    if (
      m.memBytes > this.opts.ramBytes ||
      (m.vramBytes ?? 0) > (this.opts.vramBytes ?? 0)
    )
      return refuse(
        "memory",
        "model.json",
        `the model needs ${m.memBytes} B of RAM and ${m.vramBytes ?? 0} B of VRAM; the budget is ${this.opts.ramBytes} B and ${this.opts.vramBytes ?? 0} B.`,
      );
    if (this.opts.loadTest) {
      let passed = false;
      try {
        passed =
          (await this.opts.loadTest({
            packId: staged.packId,
            location: staged.location,
            file: d.file,
            descriptor: m,
          })) === true;
      } catch {
        passed = false;
      }
      if (!passed) return refuse("load-test", m.file);
    }
    return null;
  }

  async activate(install: PackInstall, payload: PackPayloadAccess) {
    const d = await readModelDescriptor(await filesOf(payload));
    if (!d.ok)
      throw new Error(`${install.packId}: its model.json no longer reads.`);
    const model: MlModel = {
      packId: install.packId,
      location: install.location,
      path: d.descriptor.file,
      descriptor: d.descriptor,
    };
    this.live.set(install.packId, model);
    await this.opts.onActivate?.(model);
  }

  async deactivate(install: PackInstall) {
    this.live.delete(install.packId);
    await this.opts.onDeactivate?.(install.packId);
  }
}
