/**
 * The feed's delta menu, Release's half (P4-29, plans/P4-29.md §2.2, §6.1, §6.3): which ready
 * `release_lazy_deltas` rows may be offered, as menu entries. Shared by the `lazyDeltas` hook
 * (the composer's read) and `packPayload` (P4-18's payload URL answers `dcz` from them too).
 *
 * A row is offered only when its stored descriptor passes the member's rules (so a menu built from
 * it can never read as unusable) and its frame's window is decodable by every applier: a
 * `windowLog` above `max(10, min(30, ⌈log2(memBytes)⌉))` would refuse on a wasm32 or 32-bit
 * decoder (WIRE-CONTRACT-V4 §2.6), so it is never listed.
 */

import type { FeedDelta } from "@polaris-key/protocol/update";
import type { Db } from "../../../../core/platform.js";
import { LAZY_DELTA_METHOD } from "./policy.js";
import type { LazyDeltaRow } from "./store.js";

const SHA256_RE = /^[0-9a-f]{64}$/;
const VOCAB_TOKEN_RE = /^[a-z][a-z0-9-]{0,31}$/;

const posInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/** The largest frame window log an applier accepts for `memBytes` (V4 §2.6, capped at 30). */
export function maxMenuWindowLog(memBytes: number): number {
  return Math.max(10, Math.min(30, Math.ceil(Math.log2(memBytes))));
}

/** A ready row as a menu entry, or null when it must not be offered. */
export function menuEntryOf(row: LazyDeltaRow): FeedDelta | null {
  const d = row.descriptor as unknown as Record<string, unknown> | null;
  if (row.state !== "ready" || !d || typeof d !== "object") return null;
  if (d.from !== row.from || d.to !== row.to) return null;
  if (typeof d.from !== "string" || !SHA256_RE.test(d.from)) return null;
  if (d.from === row.to || !SHA256_RE.test(row.to)) return null;
  if (typeof d.method !== "string" || !VOCAB_TOKEN_RE.test(d.method))
    return null;
  if (d.scope !== "payload") return null;
  if (!posInt(d.memBytes)) return null;
  const a = d.artifact as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return null;
  if (typeof a.sha256 !== "string" || !SHA256_RE.test(a.sha256)) return null;
  if (!posInt(a.bytes)) return null;
  if (!posInt(d.windowLog) || d.windowLog > maxMenuWindowLog(d.memBytes))
    return null;
  return {
    from: d.from,
    method: d.method,
    scope: "payload",
    memBytes: d.memBytes,
    artifact: { sha256: a.sha256, bytes: a.bytes },
  };
}

interface ReadyRaw {
  deliverable_id: string;
  build_id: string;
  from_sha256: string;
  to_sha256: string;
  descriptor_json: string | null;
  created_at: number;
}

/** Every ready lazy delta of `product`, oldest first: one read on `idx_release_lazy_deltas_state`. */
export async function readyLazyDeltas(
  db: Db,
  product: string,
): Promise<LazyDeltaRow[]> {
  const rows = await db.all<ReadyRaw>(
    `SELECT deliverable_id, build_id, from_sha256, to_sha256, descriptor_json, created_at
       FROM release_lazy_deltas
      WHERE product = ? AND state = 'ready' AND method = ?
      ORDER BY created_at, from_sha256, to_sha256`,
    product,
    LAZY_DELTA_METHOD,
  );
  return rows.map((r) => {
    let descriptor: LazyDeltaRow["descriptor"] = null;
    try {
      descriptor = r.descriptor_json
        ? (JSON.parse(r.descriptor_json) as LazyDeltaRow["descriptor"])
        : null;
    } catch {
      descriptor = null;
    }
    return {
      deliverableId: r.deliverable_id,
      buildId: r.build_id,
      from: r.from_sha256,
      to: r.to_sha256,
      state: "ready",
      reason: null,
      storageKey: null,
      descriptor,
      createdAt: r.created_at,
    };
  });
}
