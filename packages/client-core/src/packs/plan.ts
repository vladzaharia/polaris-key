// The install planner (plans/P4-01.md §2.9; notes/A7 §4.2 exactly, with `full.requests`).
// `plan-matrix.json#rows` pins it. A pure integer function: it returns its verdicts
// (`plan-transport-unsupported`, `plan-insufficient-disk`, `plan-no-strategy`) and never throws.
// UX policy (metered consent, "replace in place" offers) stays outside it.

import { PLAN_REQUEST_WEIGHT } from "@polaris-key/protocol/core";
import type { PlanTarget } from "./select.js";

/** The strategies, in the rank that breaks a cost tie (`full` is always last). */
export const PLAN_STRATEGIES = [
  "noop",
  "platform",
  "delta",
  "chunk",
  "file",
  "full",
] as const;
export type PlanStrategy = (typeof PLAN_STRATEGIES)[number];

const RANK: Record<string, number> = Object.fromEntries(
  PLAN_STRATEGIES.map((s, i) => [s, i]),
);

/** One installed release of the pack, as the planner sees it. */
export interface PlanInstalled {
  release: string;
  payloadSha256: string;
  /** The chunk ids this release's chunk index holds (P4-11), when it is kept. */
  chunks?: { ids: string[] } | null;
  /** The file hashes this release's files index holds, when it is kept. */
  files?: string[] | null;
}

/** What the host can do. `requestWeight` defaults to `PLAN_REQUEST_WEIGHT` (16,384). */
export interface PlanCaps {
  strategies: readonly string[];
  patchMethods: readonly string[];
  transports: readonly string[];
  memBudget: number;
  freeDisk: number;
  requestWeight?: number;
}

export interface PlanInput {
  target: PlanTarget;
  installed: readonly PlanInstalled[];
  caps: PlanCaps;
}

/** A costed candidate, as the plan reports it. */
export interface PlanCandidate {
  strategy: PlanStrategy;
  /** The delta's id, for `delta`. */
  delta?: string;
  bytes: number;
  requests: number;
  cost: number;
}

export type PlanError =
  | "plan-transport-unsupported"
  | "plan-insufficient-disk"
  | "plan-no-strategy";

export type PlanResult =
  | (PlanCandidate & { peakDisk: number; fallbacks: PlanCandidate[] })
  | { strategy: "platform"; transport: string; fallbacks: [] }
  | { error: PlanError };

interface Cand {
  strategy: PlanStrategy;
  delta?: string;
  bytes: number;
  requests: number;
  ord: number;
  cost: number;
  peakDisk: number;
}

/**
 * `plan(input)`: `noop` when a release with the target payload is installed; a platform-bound
 * target takes `platform` when the host lists its transport, else `plan-transport-unsupported`.
 * Otherwise every allowed, feasible candidate is costed (`bytes + requestWeight × requests`), with
 * `peakDisk` = payload size + bytes: each delta whose method the host lists, whose base is
 * installed and whose `memBytes` fits `memBudget`; `chunk` from the installed seeds; `file` from
 * the installed files indexes; `full` whenever the target has one, whatever `strategies` says.
 * Candidates over `freeDisk` drop. The cheapest wins (ties: strategy rank, then record order);
 * the rest are fallbacks in cost order with `full` moved last.
 */
export function plan(input: PlanInput): PlanResult {
  const t = input.target;
  const inst = input.installed;
  const caps = input.caps;
  if (inst.some((i) => i.payloadSha256 === t.payload.sha256))
    return {
      strategy: "noop",
      bytes: 0,
      requests: 0,
      cost: 0,
      peakDisk: 0,
      fallbacks: [],
    };
  if (t.platform) {
    if ((caps.transports ?? []).includes(t.platform.transport))
      return {
        strategy: "platform",
        transport: t.platform.transport,
        fallbacks: [],
      };
    return { error: "plan-transport-unsupported" };
  }
  const strategies = new Set(caps.strategies ?? []);
  const have = new Set(inst.map((i) => i.payloadSha256));
  const cands: Omit<Cand, "cost" | "peakDisk">[] = [];

  if (strategies.has("delta"))
    for (const [k, d] of (t.deltas ?? []).entries())
      if (
        (caps.patchMethods ?? []).includes(d.method) &&
        have.has(d.from) &&
        d.memBytes <= caps.memBudget
      )
        cands.push({
          strategy: "delta",
          delta: d.id,
          bytes: d.artifacts.reduce((a, x) => a + x.bytes, 0),
          requests: d.artifacts.length,
          ord: k,
        });

  const seeds = inst
    .map((i) => i.chunks)
    .filter((c): c is { ids: string[] } => !!c);
  if (strategies.has("chunk") && t.chunks && seeds.length > 0) {
    const seeded = new Set<string>();
    for (const s of seeds) for (const id of s.ids) seeded.add(id);
    const seen = new Set<string>();
    let prev: [string, number, number, number, number] | null = null;
    let runs = 0;
    let bytes = t.chunks.indexBytes;
    for (const r of t.chunks.records) {
      const [id, , clen, bundle, offset] = r;
      if (seeded.has(id) || seen.has(id)) continue;
      seen.add(id);
      bytes += clen;
      if (prev === null || bundle !== prev[3] || offset !== prev[4] + prev[2])
        runs++;
      prev = r;
    }
    cands.push({ strategy: "chunk", bytes, requests: 1 + runs, ord: 0 });
  }

  const withFiles = inst.filter(
    (i) => i.files !== null && i.files !== undefined,
  );
  if (strategies.has("file") && t.files && withFiles.length > 0) {
    const held = new Set<string>();
    for (const i of withFiles) for (const x of i.files!) held.add(x);
    const missing = new Map<string, number>();
    for (const f of t.files.files)
      if (!held.has(f.sha256) && !missing.has(f.sha256))
        missing.set(f.sha256, f.blobBytes);
    let sum = 0;
    for (const v of missing.values()) sum += v;
    cands.push({
      strategy: "file",
      bytes: t.files.indexBytes + t.files.gapsBytes + sum,
      requests: 1 + (t.files.gapsBytes > 0 ? 1 : 0) + missing.size,
      ord: 0,
    });
  }

  if (t.full)
    cands.push({
      strategy: "full",
      bytes: t.full.bytes,
      requests: t.full.requests ?? 1,
      ord: 0,
    });

  if (cands.length === 0) return { error: "plan-no-strategy" };
  const w = caps.requestWeight ?? PLAN_REQUEST_WEIGHT;
  const all: Cand[] = cands.map((c) => ({
    ...c,
    cost: c.bytes + w * c.requests,
    peakDisk: t.payload.size + c.bytes,
  }));
  const feasible = all.filter((c) => c.peakDisk <= caps.freeDisk);
  if (feasible.length === 0) return { error: "plan-insufficient-disk" };
  feasible.sort(
    (a, b) =>
      a.cost - b.cost || RANK[a.strategy]! - RANK[b.strategy]! || a.ord - b.ord,
  );
  const [chosen, ...rest] = feasible as [Cand, ...Cand[]];
  const ordered = [
    ...rest.filter((c) => c.strategy !== "full"),
    ...rest.filter((c) => c.strategy === "full"),
  ];
  return {
    ...publish(chosen),
    peakDisk: chosen.peakDisk,
    fallbacks: ordered.map(publish),
  };
}

function publish(c: Cand): PlanCandidate {
  const out: PlanCandidate = { strategy: c.strategy } as PlanCandidate;
  if (c.delta !== undefined) out.delta = c.delta;
  out.bytes = c.bytes;
  out.requests = c.requests;
  out.cost = c.cost;
  return out;
}
