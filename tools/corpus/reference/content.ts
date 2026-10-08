// Reference: content members, revocations, holds and the content decision (plans/P4-13.md
// §2.6), and the helpers tools/gen-content-corpus.ts is passed (`REF_JSON`).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import type { RefJson } from "../../gen-content-corpus.js";
import {
  MAX_WIRE_INTEGER_REF,
  pointerToken,
  sha256Hex,
  utf8Bytes,
} from "../common.js";
import { type ClaimCtx, ctxOf, hasOwn, isObj } from "./claims.js";
import { refParseStrict } from "./config.js";
import { REF_OUTLET_ID_RE, refEffectiveCapabilities } from "./outlet.js";
import { refContentClaims } from "./pack-claims.js";
import {
  REF_AXIS_RE,
  REF_AXIS_VALUE_RE,
  REF_ENGINE_RE,
  REF_FEED_PLATFORM_RE,
  REF_RECORD_VERSION_RE,
  REF_SALT_RE,
  REF_SHA256_RE,
  REF_VOCAB_RE,
  refHex64,
  refPackIdShape,
} from "./patterns.js";
import { PLAIN_INTEGER_REF, refNonWire } from "./tokens.js";
import { refBootDecision, refDecideUpdate, type RefInput } from "./update.js";
import { REF_SCHEMES, refCompareVersions } from "./versions.js";

/** The reference helpers the content generator borrows (it imports nothing it checks). */
export const REF_JSON: RefJson = {
  parseStrict: (text) => refParseStrict(text),
  nonWire: (text) => refNonWire(text),
  // A stamp's members sit at its top level; re-rooted under `/content` so §2.5's minimum table
  // and `refContentClaims` apply unchanged.
  stampContentClaims: (text) => {
    const wrapped = `{"content":${text}}`;
    const parsed = refParseStrict(wrapped);
    if (!parsed.ok || !isObj(parsed.value)) return false;
    return refContentClaims(parsed.value.content, ctxOf(wrapped), "/content");
  },
  // plans/P4-13.md §2.4: the stamp's holds, re-rooted under `/content` like the claims.
  stampHolds: (text) => {
    const wrapped = `{"content":${text}}`;
    const parsed = refParseStrict(wrapped);
    if (!parsed.ok || !isObj(parsed.value)) return null;
    const c = parsed.value.content;
    if (!isObj(c)) return null;
    return refHoldsOf(c, ctxOf(wrapped), "/content");
  },
};

// ── plans/P4-13.md: content members, revocations, holds and the content decision ────────────
// The generator's own references (it imports nothing it checks): `refFeedContent` (§2.2),
// `refRevocationOf` and the revocation verifier (§2.3), `refHoldsOf` (§2.4) and the content
// decision (§2.6), plus the fixtures of `feedContentCases`, `revocationCases`, the three appended
// `feedCases` and `update-matrix.json#/contentRows`.

export const refCmpBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
export const refPackId = (v: unknown): v is string =>
  refPackIdShape(v) && v !== "app";
const P13_SCHEMES: readonly string[] = REF_SCHEMES;
const P13_REASON_MAX = 512;

/** A content integer member (V4 §3.1's token rule, read from the payload's own tokens). */
export function p13Int(
  ctx: ClaimCtx | null,
  v: unknown,
  pointer: string,
  min: number,
  max = MAX_WIRE_INTEGER_REF,
): v is number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) return false;
  if (ctx !== null) {
    const t = ctx.tokens.get(pointer);
    if (t === undefined || !PLAIN_INTEGER_REF.test(t)) return false;
  }
  return v >= min && v <= max;
}

/** `packSetId` (plans/P4-01.md §2.9), from first principles. */
export function refPackSetId(
  entries: [pack: string, sha256: string][],
): string {
  const text = [...entries]
    .sort((a, b) => refCmpBytes(a[0], b[0]))
    .map(([p, h]) => `${p} ${h}\n`)
    .join("");
  return sha256Hex(text);
}

const refVariantKey = (v: Record<string, string>): string =>
  Object.keys(v)
    .sort(refCmpBytes)
    .map((k) => `${k}=${v[k]}`)
    .join(";");

/** §2.2's table, member by member; each returns the parsed member or null. */
export function refFeedContent(
  doc: Record<string, any>,
  ctx: ClaimCtx | null,
): { packSets: unknown; packFloors: unknown; revocations: unknown } {
  const packSets = ((): unknown => {
    if (!hasOwn(doc, "packSets")) return null;
    const ps = doc.packSets;
    if (!isObj(ps)) return null;
    for (const k of ["releases", "sets", "rows"])
      if (!hasOwn(ps, k)) return null;
    if (!isObj(ps.releases) || !isObj(ps.sets) || !Array.isArray(ps.rows))
      return null;
    const releases: Record<string, unknown> = {};
    for (const h of Object.keys(ps.releases)) {
      const r = ps.releases[h];
      if (!REF_SHA256_RE.test(h) || !isObj(r)) return null;
      if (!refPackId(r.pack)) return null;
      if (
        typeof r.version !== "string" ||
        !REF_RECORD_VERSION_RE.test(r.version)
      )
        return null;
      if (!p13Int(ctx, r.seq, `/packSets/releases/${h}/seq`, 1)) return null;
      releases[h] = { pack: r.pack, version: r.version, seq: r.seq };
    }
    const sets: Record<string, string[]> = {};
    for (const id of Object.keys(ps.sets)) {
      const m = ps.sets[id];
      if (!REF_SHA256_RE.test(id) || !Array.isArray(m)) return null;
      const seen: string[] = [];
      for (const h of m) {
        if (typeof h !== "string" || !hasOwn(releases, h)) return null;
        const pack = (releases[h] as { pack: string }).pack;
        if (seen.includes(pack)) return null;
        seen.push(pack);
      }
      sets[id] = [...m];
    }
    const sel = isObj(doc.selector) ? doc.selector : {};
    const rows: unknown[] = [];
    const keys = new Set<string>();
    for (const [i, r] of ps.rows.entries()) {
      if (!isObj(r)) return null;
      if (!p13Int(ctx, r.contentApi, `/packSets/rows/${i}/contentApi`, 1))
        return null;
      if (
        typeof r.platform !== "string" ||
        !REF_FEED_PLATFORM_RE.test(r.platform)
      )
        return null;
      if (hasOwn(sel, "platform") && r.platform !== sel.platform) return null;
      if (
        typeof r.engine !== "string" ||
        (r.engine !== "" && !REF_ENGINE_RE.test(r.engine))
      )
        return null;
      if (!isObj(r.variant) || Object.keys(r.variant).length > 4) return null;
      const variant: Record<string, string> = {};
      for (const [a, x] of Object.entries(r.variant)) {
        if (!REF_AXIS_RE.test(a)) return null;
        if (typeof x !== "string" || !REF_AXIS_VALUE_RE.test(x)) return null;
        variant[a] = x;
      }
      if (typeof r.set !== "string" || !hasOwn(sets, r.set)) return null;
      const key = `${r.contentApi}|${r.platform}|${r.engine}|${refVariantKey(variant)}`;
      if (keys.has(key)) return null;
      keys.add(key);
      rows.push({
        contentApi: r.contentApi,
        platform: r.platform,
        engine: r.engine,
        variant,
        set: r.set,
      });
    }
    const out: Record<string, unknown> = { releases, sets, rows };
    if (hasOwn(ps, "outlets")) {
      if (!isObj(ps.outlets)) return null;
      const outlets: Record<string, unknown> = {};
      for (const id of Object.keys(ps.outlets)) {
        const e = ps.outlets[id];
        if (!REF_OUTLET_ID_RE.test(id) || !isObj(e)) return null;
        const o: Record<string, unknown> = {};
        if (hasOwn(e, "pinned")) {
          if (!Array.isArray(e.pinned)) return null;
          if (!e.pinned.every(refPackId)) return null;
          if (new Set(e.pinned).size !== e.pinned.length) return null;
          o.pinned = [...e.pinned];
        }
        if (hasOwn(e, "gates")) {
          if (!isObj(e.gates)) return null;
          const gates: Record<string, unknown> = {};
          for (const h of Object.keys(e.gates)) {
            const g = e.gates[h];
            if (!hasOwn(releases, h) || !isObj(g)) return null;
            if (typeof g.halted !== "boolean") return null;
            const gate: Record<string, unknown> = { halted: g.halted };
            if (hasOwn(g, "rollout")) {
              const ro = g.rollout;
              if (!isObj(ro)) return null;
              const at = `/packSets/outlets/${pointerToken(id)}/gates/${h}/rollout/bp`;
              if (!p13Int(ctx, ro.bp, at, 0, 10000)) return null;
              if (typeof ro.salt !== "string" || !REF_SALT_RE.test(ro.salt))
                return null;
              gate.rollout = { bp: ro.bp, salt: ro.salt };
            }
            if (!hasOwn(g, "fallback")) return null;
            if (
              g.fallback !== null &&
              !(typeof g.fallback === "string" && hasOwn(releases, g.fallback))
            )
              return null;
            gate.fallback = g.fallback;
            gates[h] = gate;
          }
          o.gates = gates;
        }
        outlets[id] = o;
      }
      out.outlets = outlets;
    }
    return out;
  })();

  const packFloors = ((): unknown => {
    if (!hasOwn(doc, "packFloors")) return null;
    const fs = doc.packFloors;
    if (!Array.isArray(fs)) return null;
    const out: unknown[] = [];
    const keys = new Set<string>();
    for (const [i, f] of fs.entries()) {
      if (!isObj(f) || !refPackId(f.pack)) return null;
      if (!p13Int(ctx, f.contentApi, `/packFloors/${i}/contentApi`, 1))
        return null;
      if (
        typeof f.minVersion !== "string" ||
        !REF_RECORD_VERSION_RE.test(f.minVersion)
      )
        return null;
      if (typeof f.versionScheme !== "string") return null;
      const key = `${f.pack}|${f.contentApi}`;
      if (keys.has(key)) return null;
      keys.add(key);
      if (P13_SCHEMES.includes(f.versionScheme))
        out.push({
          pack: f.pack,
          contentApi: f.contentApi,
          minVersion: f.minVersion,
          versionScheme: f.versionScheme,
        });
    }
    return out;
  })();

  const revocations = ((): unknown => {
    if (!hasOwn(doc, "revocations")) return null;
    const rs = doc.revocations;
    if (!Array.isArray(rs)) return null;
    const out: unknown[] = [];
    const seen = new Set<string>();
    for (const [i, r] of rs.entries()) {
      if (!isObj(r)) return null;
      if (!refHex64(r.record) || !refPackId(r.pack) || !refHex64(r.target))
        return null;
      if (
        typeof r.version !== "string" ||
        !REF_RECORD_VERSION_RE.test(r.version)
      )
        return null;
      if (!p13Int(ctx, r.seq, `/revocations/${i}/seq`, 1)) return null;
      if (seen.has(r.record as string)) return null;
      seen.add(r.record as string);
      // plans/P4-19.md §2.7: `kind` absent or `delegation`; another vocabulary token drops the
      // entry alone; anything else makes the member unusable.
      if (hasOwn(r, "kind")) {
        if (typeof r.kind !== "string" || !REF_VOCAB_RE.test(r.kind))
          return null;
        if (r.kind !== "delegation") continue;
      }
      out.push({
        record: r.record,
        pack: r.pack,
        target: r.target,
        version: r.version,
        seq: r.seq,
        ...(hasOwn(r, "kind") ? { kind: r.kind } : {}),
      });
    }
    return out;
  })();

  return { packSets, packFloors, revocations };
}

/** §2.3: the revocation body, or null. */
export function refRevocationOf(
  doc: Record<string, any>,
  ctx: ClaimCtx | null,
): Record<string, unknown> | null {
  if (doc.kind !== "revocation" || !refPackId(doc.deliverable)) return null;
  if (!refHex64(doc.revokes)) return null;
  let replacement: Record<string, unknown> | null = null;
  if (hasOwn(doc, "replacement")) {
    const r = doc.replacement;
    if (!isObj(r) || !refHex64(r.sha256) || r.sha256 === doc.revokes)
      return null;
    if (!p13Int(ctx, r.seq, "/replacement/seq", 1)) return null;
    if (typeof r.version !== "string" || !REF_RECORD_VERSION_RE.test(r.version))
      return null;
    replacement = { sha256: r.sha256, seq: r.seq, version: r.version };
  }
  if (typeof doc.reason !== "string") return null;
  const n = utf8Bytes(doc.reason).length;
  if (n < 1 || n > P13_REASON_MAX) return null;
  return {
    pack: doc.deliverable,
    target: doc.revokes,
    replacement,
    reason: doc.reason,
    issuedAt: doc.issuedAt,
  };
}

/** §2.4: the holds of a `content` object at `at`, or null when unusable. */
export function refHoldsOf(
  c: Record<string, any>,
  ctx: ClaimCtx | null,
  at: string,
): unknown[] | null {
  if (!hasOwn(c, "holds")) return [];
  const hs = c.holds;
  if (!Array.isArray(hs) || hs.length > 256) return null;
  const pinned = new Set(
    (Array.isArray(c.pins) ? c.pins : []).map((p: any) => p?.pack),
  );
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const [i, h] of hs.entries()) {
    if (!isObj(h) || !refPackId(h.pack)) return null;
    if (seen.has(h.pack) || pinned.has(h.pack)) return null;
    seen.add(h.pack);
    const r = h.release;
    if (!isObj(r) || !refHex64(r.sha256)) return null;
    if (!p13Int(ctx, r.seq, `${at}/holds/${i}/release/seq`, 1)) return null;
    if (typeof r.version !== "string" || !REF_RECORD_VERSION_RE.test(r.version))
      return null;
    if (hasOwn(h, "reason") && typeof h.reason !== "string") return null;
    out.push({
      pack: h.pack,
      release: { sha256: r.sha256, seq: r.seq, version: r.version },
      ...(hasOwn(h, "reason") ? { reason: h.reason } : {}),
    });
  }
  return out;
}

/**
 * plans/P4-29.md §2.2: the delta menu, from first principles. Null when absent or unusable;
 * otherwise target → the kept `payload` entries (known members only). Both caps and both
 * uniqueness rules count dropped entries too.
 */
const P29_MAX_FEED_DELTAS = 64;
const P29_MAX_PER_TARGET = 4;
export function refFeedDeltas(
  doc: Record<string, any>,
  ctx: ClaimCtx | null,
): Record<string, unknown[]> | null {
  if (!hasOwn(doc, "deltas")) return null;
  const m = doc.deltas;
  if (!isObj(m)) return null;
  const out: Record<string, unknown[]> = {};
  const artifacts: string[] = [];
  let total = 0;
  for (const to of Object.keys(m)) {
    if (!REF_SHA256_RE.test(to)) return null;
    const list = m[to];
    if (!Array.isArray(list)) return null;
    if (list.length < 1 || list.length > P29_MAX_PER_TARGET) return null;
    total += list.length;
    if (total > P29_MAX_FEED_DELTAS) return null;
    const pairs: string[] = [];
    const kept: unknown[] = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!isObj(e)) return null;
      if (typeof e.from !== "string" || !REF_SHA256_RE.test(e.from))
        return null;
      if (e.from === to) return null;
      if (typeof e.method !== "string" || !REF_VOCAB_RE.test(e.method))
        return null;
      if (typeof e.scope !== "string" || !REF_VOCAB_RE.test(e.scope))
        return null;
      if (!p13Int(ctx, e.memBytes, `/deltas/${to}/${i}/memBytes`, 1))
        return null;
      const a = e.artifact;
      if (!isObj(a)) return null;
      if (typeof a.sha256 !== "string" || !REF_SHA256_RE.test(a.sha256))
        return null;
      if (!p13Int(ctx, a.bytes, `/deltas/${to}/${i}/artifact/bytes`, 1))
        return null;
      if (artifacts.includes(a.sha256)) return null;
      artifacts.push(a.sha256);
      const pair = `${e.from} ${e.method}`;
      if (pairs.includes(pair)) return null;
      pairs.push(pair);
      if (e.scope !== "payload") continue;
      kept.push({
        from: e.from,
        method: e.method,
        scope: "payload",
        memBytes: e.memBytes,
        artifact: { sha256: a.sha256, bytes: a.bytes },
      });
    }
    if (kept.length > 0) out[to] = kept;
  }
  return out;
}

// ── The content decision (plans/P4-13.md §2.6), the generator's reference ────────────────────

interface RefContentInput {
  stamp: {
    contentApi: number;
    pins: { pack: string; release: Record<string, any> }[];
    expects: { pack: string; required: boolean; delivery: string }[];
    holds: { pack: string; release: Record<string, any> }[] | null;
  };
  active: Record<string, Record<string, any>>;
  axes: Record<string, string[]>;
  revocations: {
    target: string;
    pack: string;
    replacement: Record<string, any> | null;
    replacementUsable: boolean;
  }[];
  buckets: Record<string, number | null>;
}
export type RefContentRowInput = RefInput & { content: RefContentInput };

/** The key of the install's outlet entry in `target`, by §2.8 step 3's rule. */
function refEntryId(
  target: Record<string, any> | undefined,
  outlet: { id: string | null; kind: string },
): string | null {
  if (!target || outlet.kind === "unknown") return null;
  const outlets = target.outlets as Record<string, Record<string, any>>;
  if (outlet.id !== null && hasOwn(outlets, outlet.id)) {
    if (outlets[outlet.id]!.kind === outlet.kind) return outlet.id;
  }
  const ids = Object.keys(outlets).filter(
    (k) => outlets[k]!.kind === outlet.kind,
  );
  return ids.length === 1 ? ids[0]! : null;
}

/** §2.6 steps 1–5: the feed target per pack at one level and engine (pins and gates applied). */
function refFeedTargets(
  ps: Record<string, any> | null,
  level: number,
  platform: string,
  engine: string,
  axes: Record<string, string[]>,
  outlet: Record<string, any> | null,
  buckets: Record<string, number | null>,
): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  if (ps === null) return out;
  const best = new Map<string, { idx: number[]; set: string }>();
  for (const row of ps.rows as Record<string, any>[]) {
    if (row.contentApi !== level || row.platform !== platform) continue;
    if (row.engine !== engine) continue;
    const names = Object.keys(row.variant).sort(refCmpBytes);
    const idx = names.map((a) =>
      hasOwn(axes, a) ? axes[a]!.indexOf(row.variant[a]) : -1,
    );
    if (idx.some((k) => k < 0)) continue;
    const g = names.join("\u0000");
    const cur = best.get(g);
    let lower = cur === undefined;
    if (cur !== undefined)
      for (let k = 0; k < idx.length; k++)
        if (idx[k] !== cur.idx[k]) {
          lower = idx[k]! < cur.idx[k]!;
          break;
        }
    if (lower) best.set(g, { idx, set: row.set });
  }
  const count = new Map<string, number>();
  const named = new Map<string, string>();
  for (const { set } of best.values())
    for (const h of ps.sets[set] as string[]) {
      const pack = ps.releases[h].pack as string;
      count.set(pack, (count.get(pack) ?? 0) + 1);
      named.set(pack, h);
    }
  const pinned: string[] = outlet?.pinned ?? [];
  const gates: Record<string, any> = outlet?.gates ?? {};
  for (const [pack, h0] of named) {
    if (count.get(pack)! > 1 || pinned.includes(pack)) continue;
    let h: string | null = h0;
    if (hasOwn(gates, h0)) {
      const g = gates[h0];
      const inBucket =
        !g.halted &&
        (!hasOwn(g, "rollout") ||
          (typeof buckets[g.rollout.salt] === "number" &&
            (buckets[g.rollout.salt] as number) < g.rollout.bp));
      if (!inBucket) h = g.fallback;
    }
    if (h !== null) {
      const r = ps.releases[h];
      out.set(pack, { sha256: h, seq: r.seq, version: r.version });
    }
  }
  return out;
}

interface RefComposed {
  install: { pack: string; release: Record<string, any> }[];
  revoke: string[];
  set: { pack: string; sha256: string }[];
  R: boolean;
  F: boolean;
}

function refCompose(
  c: RefContentInput,
  ps: Record<string, any> | null,
  floors: Record<string, any>[],
  outlet: Record<string, any> | null,
  dataUpdates: boolean,
  platform: string,
  engine: string,
): RefComposed {
  const L = c.stamp.contentApi;
  const revs = new Map(c.revocations.map((r) => [r.target, r]));
  const revoked = (x: Record<string, any> | null | undefined): boolean =>
    !!x && revs.has(x.sha256);
  const pin = new Map(c.stamp.pins.map((p) => [p.pack, p.release]));
  const hold = new Map((c.stamp.holds ?? []).map((h) => [h.pack, h.release]));
  const exp = new Map(c.stamp.expects.map((e) => [e.pack, e]));
  const pinnedOut: string[] = ps !== null ? (outlet?.pinned ?? []) : [];
  const targets = refFeedTargets(
    ps,
    L,
    platform,
    engine,
    c.axes,
    ps !== null ? outlet : null,
    c.buckets,
  );
  const packs = [
    ...new Set([
      ...pin.keys(),
      ...hold.keys(),
      ...exp.keys(),
      ...Object.keys(c.active),
      ...targets.keys(),
    ]),
  ].sort(refCmpBytes);
  const out: RefComposed = {
    install: [],
    revoke: [],
    set: [],
    R: false,
    F: false,
  };
  for (const p of packs) {
    const narrowed = pinnedOut.includes(p);
    const replace = (
      x: Record<string, any> | null,
    ): Record<string, any> | null => {
      if (x === null) return null;
      if (!revoked(x)) return x;
      const r = revs.get(x.sha256)!;
      return r.replacementUsable &&
        r.replacement !== null &&
        !revoked(r.replacement) &&
        dataUpdates &&
        !narrowed
        ? r.replacement
        : null;
    };
    const required = exp.get(p)?.required === true;
    const essential = exp.get(p)?.delivery === "essential";
    const act = hasOwn(c.active, p) ? c.active[p]! : null;
    let base: Record<string, any> | null = null;
    if (pin.has(p)) base = pin.get(p)!;
    else if (hold.has(p)) base = hold.get(p)!;
    else if (!narrowed && c.stamp.holds !== null && dataUpdates && ps !== null)
      base = targets.get(p) ?? null;
    let cand = replace(base);
    if (cand === null && revoked(act)) cand = replace(act);
    const install =
      cand !== null &&
      cand.sha256 !== act?.sha256 &&
      (act !== null || required || essential) &&
      (pin.has(p) ||
        hold.has(p) ||
        act === null ||
        revoked(act) ||
        cand.seq > act.seq);
    if (install) out.install.push({ pack: p, release: cand! });
    const eff = install ? cand : act !== null && !revoked(act) ? act : cand;
    if (eff !== null) out.set.push({ pack: p, sha256: eff.sha256 });
    const noFix =
      cand === null && (revoked(act) || (revoked(base) && act === null));
    if (noFix && required) out.R = true;
    if (noFix && !required && act !== null) out.revoke.push(p);
    if (!noFix && (act !== null || required)) {
      const f = floors.find((x) => x.pack === p && x.contentApi === L);
      if (f) {
        const k =
          eff === null
            ? null
            : refCompareVersions(f.versionScheme, eff.version, f.minVersion);
        if (k === null || k < 0) out.F = true;
      }
    }
  }
  return out;
}

/** §2.6 "Order", over P3-01's answer from `refDecideUpdate`. */
export function refDecideWithContent(
  inp: RefContentRowInput,
): Record<string, unknown> {
  const app = refDecideUpdate(inp);
  const c = inp.content;
  const feed = inp.feed;
  const target = (feed.app.targets as Record<string, any>[]).find(
    (t) => t.platform === inp.installed.platform,
  );
  const id = refEntryId(target, inp.outlet);
  const entry = id !== null ? target!.outlets[id] : null;
  const caps = refEffectiveCapabilities(inp.outlet.kind, {
    platform: inp.installed.platform,
    subkind: inp.subkind,
    server: entry?.capabilities,
  });
  const fc = refFeedContent(feed, null) as {
    packSets: Record<string, any> | null;
    packFloors: Record<string, any>[] | null;
  };
  const outlet =
    fc.packSets !== null && id !== null && hasOwn(fc.packSets.outlets ?? {}, id)
      ? fc.packSets.outlets[id]
      : null;
  const engine = inp.installed.engine ?? "";
  const floors = fc.packFloors ?? [];
  const staged = inp.staged !== null;

  if (
    app.action === "none" &&
    (app.reason === "stale" || app.reason === "unknown-version")
  ) {
    const k = refCompose(
      c,
      null,
      floors,
      null,
      caps.dataUpdates,
      inp.installed.platform,
      engine,
    );
    return k.R
      ? { action: "blocked", reason: "revoked-content", discardStaged: staged }
      : app;
  }
  const k = refCompose(
    c,
    fc.packSets,
    floors,
    outlet,
    caps.dataUpdates,
    inp.installed.platform,
    engine,
  );
  const block = k.R ? "revoked-content" : k.F ? "content-floor" : null;
  if (app.action === "blocked")
    return block === null ? app : { ...app, contentBlock: block };
  if (["binary", "store", "platform"].includes(app.action as string)) {
    let a = app;
    if (app.action === "binary") {
      // Prestage: the offered record's new level, required and essential, minus the embeds.
      const rec = inp.record;
      const rc = rec?.content;
      let prestage: unknown[] = [];
      if (rc && rc.contentApi !== c.stamp.contentApi) {
        const build = (rec!.builds as Record<string, any>[]).find(
          (b) => b.id === app.build,
        );
        const embeds: string[] = build?.embeds ?? [];
        const bEngine =
          isObj(build?.requires) && typeof build!.requires.engine === "string"
            ? build!.requires.engine
            : engine;
        const holds = refHoldsOf(rc, null, "/content");
        const tgts =
          holds === null || !caps.dataUpdates
            ? new Map<string, Record<string, any>>()
            : refFeedTargets(
                fc.packSets,
                rc.contentApi,
                inp.installed.platform,
                bEngine,
                c.axes,
                outlet,
                c.buckets,
              );
        const revs = new Map(c.revocations.map((r) => [r.target, r]));
        for (const e of rc.expects as Record<string, any>[]) {
          if (
            !(e.required || e.delivery === "essential") ||
            embeds.includes(e.pack)
          )
            continue;
          const narrowed = (outlet?.pinned ?? []).includes(e.pack);
          let rel: Record<string, any> | null =
            (rc.pins as Record<string, any>[]).find((x) => x.pack === e.pack)
              ?.release ??
            (holds as Record<string, any>[] | null)?.find(
              (x) => x.pack === e.pack,
            )?.release ??
            tgts.get(e.pack) ??
            null;
          if (rel && revs.has(rel.sha256)) {
            const r = revs.get(rel.sha256)!;
            rel =
              r.replacementUsable &&
              r.replacement &&
              !revs.has(r.replacement.sha256) &&
              caps.dataUpdates &&
              !narrowed
                ? r.replacement
                : null;
          }
          if (!rel || c.active[e.pack]?.sha256 === rel.sha256) continue;
          prestage.push({ pack: e.pack, release: rel });
        }
        prestage = (prestage as { pack: string }[]).sort((x, y) =>
          refCmpBytes(x.pack, y.pack),
        );
      }
      a = { ...app, prestage };
    }
    if (block !== null) return { ...a, mandatory: true, contentBlock: block };
    if (app.mandatory === true || app.action === "binary") return a;
  }
  if (block !== null)
    return { action: "blocked", reason: block, discardStaged: staged };
  if (app.action === "code-ready") return app;
  if (caps.dataUpdates && (k.install.length > 0 || k.revoke.length > 0))
    return {
      action: "packs",
      install: k.install,
      revoke: k.revoke,
      set: k.set,
      discardStaged: staged,
    };
  return app;
}

/** §2.6's boot table over P3-01's. */
export function refBootDecisionV2(d: Record<string, unknown>): string {
  if (d.reason === "revoked-content" || d.contentBlock === "revoked-content")
    return "required";
  if (d.action === "packs") return "none";
  return refBootDecision(d);
}
