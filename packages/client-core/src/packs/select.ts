// Variant selection and target mapping (plans/P4-01.md §2.9; WIRE-CONTRACT-V4 §11.4).
// `plan-matrix.json#variantCases` pins `selectVariant` and `#targetCases` pins `planTarget`.
// Pure; never throws on a record that passed the claims.

import {
  FILES_FORMAT,
  MAX_FILES_INDEX_BYTES,
} from "@polaris-key/protocol/core";
import type { FilesIndexDoc, PackVariant } from "@polaris-key/protocol/packs";
import { has, isObject } from "./claims.js";
import { compareBytes } from "./variant.js";

/** An object ref is usable when its codec is `zstd` or `none` (§2.9). */
export function usableCodec(codec: unknown): boolean {
  return codec === "zstd" || codec === "none";
}

/** The index is readable when `files.format` is `pkey-files/1`, its ref is usable and
 *  `files.size` ≤ `MAX_FILES_INDEX_BYTES` (§2.9). */
export function indexReadable(files: unknown): boolean {
  return (
    isObject(files) &&
    files.format === FILES_FORMAT &&
    usableCodec(files.codec) &&
    typeof files.size === "number" &&
    files.size <= MAX_FILES_INDEX_BYTES
  );
}

/** A container's index and gaps together are rebuildable: a readable index and a usable gaps
 *  ref. A tree needs only the readable index. */
export function indexRebuildable(files: unknown): boolean {
  if (!indexReadable(files)) return false;
  const f = files as Record<string, unknown>;
  if (f.layout !== "container") return true;
  return isObject(f.gaps) && usableCodec(f.gaps.codec);
}

/** A variant is usable when its layout is `container`, or `tree` with a readable index. */
export function variantUsable(variant: unknown): boolean {
  if (!isObject(variant) || !isObject(variant.files)) return false;
  const layout = variant.files.layout;
  if (layout === "container") return true;
  return layout === "tree" && indexReadable(variant.files);
}

/** What the host prefers: its engine (`godot-<major>.<minor>`, null outside Godot) and, per
 *  axis, its values in preference order. */
export interface VariantPrefs {
  engine: string | null;
  axes: Readonly<Record<string, readonly string[]>>;
}

/**
 * `selectVariant(variants, {engine, axes})` (§2.9): a variant is eligible when it is usable, its
 * `requires.engine` is absent or equals the host's `engine`, and every axis it declares has a
 * host preference list containing its value (compared by bytes). The lowest tuple of preference
 * indexes over the axis names in byte order wins; ties keep the earlier variant.
 */
export function selectVariant(
  variants: readonly unknown[],
  prefs: VariantPrefs,
): { index: number } | { error: "pack-no-variant" } {
  let best: { index: number; key: number[] } | null = null;
  for (const [i, v] of variants.entries()) {
    if (!variantUsable(v)) continue;
    const variant = v as Record<string, unknown>;
    const req = variant.requires;
    if (isObject(req) && has(req, "engine") && req.engine !== prefs.engine)
      continue;
    const sel = isObject(variant.variant)
      ? (variant.variant as Record<string, unknown>)
      : {};
    const key: number[] = [];
    let eligible = true;
    for (const axis of Object.keys(sel).sort(compareBytes)) {
      const list = has(prefs.axes as Record<string, unknown>, axis)
        ? prefs.axes[axis]
        : undefined;
      const k = Array.isArray(list) ? list.indexOf(sel[axis] as string) : -1;
      if (k < 0) {
        eligible = false;
        break;
      }
      key.push(k);
    }
    if (!eligible) continue;
    if (best === null || lexLess(key, best.key)) best = { index: i, key };
  }
  return best === null ? { error: "pack-no-variant" } : { index: best.index };
}

function lexLess(x: readonly number[], y: readonly number[]): boolean {
  for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return x[j]! < y[j]!;
  return false;
}

/** A delta of the planner's input (A7 §4.1). */
export interface PlanDelta {
  id: string;
  method: string;
  from: string;
  memBytes: number;
  artifacts: { sha256: string; bytes: number }[];
}

/** The planner's target (A7 §4.1, with `full.requests`; plans/P4-01.md §2.9). */
export interface PlanTarget {
  release: string;
  payload: { size: number; sha256: string };
  full: { bytes: number; requests?: number } | null;
  platform: { transport: string } | null;
  /** Chunk candidates (P4-10, P4-11): the index bytes and inline records
   *  `[id, len, clen, bundle, offset]`. Null in v1. */
  chunks: {
    indexBytes: number;
    records: [string, number, number, number, number][];
  } | null;
  files: {
    indexBytes: number;
    gapsBytes: number;
    files: { sha256: string; blobBytes: number }[];
  } | null;
  deltas: PlanDelta[];
}

/**
 * `planTarget(variant, recordSha256, filesIndex | null)` (§2.9): a variant onto the planner's
 * input. An unusable variant maps to no candidate at all. `full` needs a usable ref whose size
 * is the payload's (a tree's costs its index too, in two requests); `files` needs the index, a
 * readable one (a container: rebuildable); a `payload` delta is kept on a container, a `files`
 * delta when `files` is kept and its `patch` ref is usable; anything else is dropped. The method
 * is passed through for the planner's `caps.patchMethods` to decide.
 */
export function planTarget(
  variant: PackVariant,
  recordSha256: string,
  filesIndex: FilesIndexDoc | null,
): PlanTarget {
  const payload = variant.payload;
  if (!variantUsable(variant))
    return {
      release: recordSha256,
      payload,
      full: null,
      platform: null,
      chunks: null,
      files: null,
      deltas: [],
    };
  const files = variant.files;
  const container = files.layout === "container";
  const full = variant.full;
  const fullT =
    isObject(full) && usableCodec(full.codec) && full.size === payload.size
      ? container
        ? { bytes: full.bytes, requests: 1 }
        : { bytes: full.bytes + files.bytes, requests: 2 }
      : null;
  const filesT =
    filesIndex !== null && indexRebuildable(files)
      ? {
          indexBytes: files.bytes,
          gapsBytes: container ? files.gaps!.bytes : 0,
          files: filesIndex.files.map((f) => ({
            sha256: f.sha256,
            blobBytes: f.blob.bytes,
          })),
        }
      : null;
  const deltas: PlanDelta[] = [];
  for (const d of variant.deltas ?? []) {
    if (d.scope === "payload" && container)
      deltas.push({
        id: d.artifact.sha256,
        method: d.method,
        from: d.from,
        memBytes: d.memBytes,
        artifacts: [{ sha256: d.artifact.sha256, bytes: d.artifact.bytes }],
      });
    else if (
      d.scope === "files" &&
      filesT !== null &&
      isObject(d.patch) &&
      usableCodec(d.patch.codec)
    )
      deltas.push({
        id: d.patch.sha256,
        method: d.method,
        from: d.from,
        memBytes: d.memBytes,
        artifacts: [
          { sha256: files.sha256, bytes: files.bytes },
          ...(container
            ? [{ sha256: files.gaps!.sha256, bytes: files.gaps!.bytes }]
            : []),
          { sha256: d.patch.sha256, bytes: d.patch.bytes },
          { sha256: d.data.sha256, bytes: d.data.bytes },
        ],
      });
  }
  return {
    release: recordSha256,
    payload,
    full: fullT,
    platform: null,
    chunks: null,
    files: filesT,
    deltas,
  };
}
