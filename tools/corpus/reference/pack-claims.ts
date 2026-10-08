// Reference: the pack claim checks (plans/P4-01.md §4.6).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import { utf8Bytes } from "../common.js";
import { type ClaimCtx, hasOwn, isObj, refInt } from "./claims.js";
import {
  REF_AXIS_RE,
  REF_AXIS_VALUE_RE,
  REF_ENGINE_RE,
  REF_ENTITLEMENT_RE,
  REF_HANDLER_PREFIX_RE,
  REF_OBJECT_FORMAT_RE,
  REF_PACK_TYPE_RE,
  REF_RECORD_VERSION_RE,
  refHex64,
  refPackIdShape,
  refVocab,
} from "./patterns.js";

/** The generator's registry of the 83 claim checks (§4.6's table, and plans/P4-10.md §2.2's
 *  81–83). A check id outside it throws; the per-check self-check proves each has a case its
 *  check alone refuses. */
export const PACK_CLAIM_CHECKS = [
  // kind: pack (1–55)
  "deliverable.not-app",
  "builds.absent",
  "type",
  "formatVersion",
  "handler",
  "handler.mountOrder",
  "handler.prefixes",
  "handler.prefixes.count",
  "handler.prefixes.item",
  "handler.prefixes.length",
  "handler.prefixes.unique",
  "handler.activation",
  "entitlement",
  "variants",
  "variants.count",
  "variants.item",
  "variants.key-unique",
  "variants.axes-same",
  "variant",
  "variant.count",
  "variant.axis",
  "variant.value",
  "payload",
  "payload.size",
  "payload.sha256",
  "full",
  "ref.sha256",
  "ref.bytes",
  "ref.size",
  "ref.codec",
  "ref.none-bytes",
  "files",
  "files.format",
  "files.layout",
  "files.gaps",
  "files.gaps-container",
  "files.gaps-tree",
  "deltas",
  "deltas.count",
  "deltas.item",
  "deltas.id-unique",
  "delta.method",
  "delta.scope",
  "delta.scope-tree",
  "delta.from",
  "delta.memBytes",
  "delta.artifact",
  "delta.artifact.sha256",
  "delta.artifact.bytes",
  "delta.patch",
  "delta.data",
  "delta.data.sha256",
  "delta.data.bytes",
  "requires",
  "requires.engine",
  // kind: app (56–80)
  "content",
  "content.contentApi",
  "content.pins",
  "content.pins.count",
  "content.pins.item",
  "content.pins.unique",
  "pin.pack",
  "pin.pack.not-app",
  "pin.release",
  "pin.release.sha256",
  "pin.release.seq",
  "pin.release.version",
  "content.expects",
  "content.expects.count",
  "content.expects.item",
  "content.expects.unique",
  "expect.pack",
  "expect.pack.not-app",
  "expect.required",
  "expect.delivery",
  "embeds",
  "embeds.count",
  "embeds.item",
  "embeds.not-app",
  "embeds.unique",
  // kind: pack, plans/P4-10.md §2.2 (81–83): `chunks` absent or an object, its `format`, its
  // `params` absent or an object (the object ref stands on checks 27–31).
  "chunks",
  "chunks.format",
  "chunks.params",
] as const;
export type PackCheck = (typeof PACK_CLAIM_CHECKS)[number];
export const PACK_CHECK_SET: ReadonlySet<string> = new Set(PACK_CLAIM_CHECKS);

/** A registered check is on unless `check:<id>` is switched off. Switching a check off skips
 *  that member and everything under it. */
export function on(ctx: ClaimCtx, id: PackCheck): boolean {
  if (!PACK_CHECK_SET.has(id)) throw new Error(`unregistered pack check ${id}`);
  return !ctx.off.has(`check:${id}`);
}

/** The one object-ref check (checks 27–31), at every site. */
function refObjectRef(
  ctx: ClaimCtx,
  v: Record<string, unknown>,
  at: string,
): boolean {
  if (on(ctx, "ref.sha256") && !refHex64(v.sha256)) return false;
  if (on(ctx, "ref.bytes")) {
    if (typeof v.bytes !== "number") return false;
    if (!refInt(ctx, "pack", v.bytes, `${at}/bytes`)) return false;
  }
  if (on(ctx, "ref.size")) {
    if (typeof v.size !== "number") return false;
    if (!refInt(ctx, "pack", v.size, `${at}/size`)) return false;
  }
  if (on(ctx, "ref.codec") && !refVocab(v.codec)) return false;
  if (on(ctx, "ref.none-bytes") && v.codec === "none" && v.bytes !== v.size)
    return false;
  return true;
}

/** A `{sha256, bytes}` member (a delta's `artifact` or `data`). */
function refHashBytes(
  ctx: ClaimCtx,
  v: Record<string, unknown>,
  at: string,
  sha: PackCheck,
  bytes: PackCheck,
): boolean {
  if (on(ctx, sha) && !refHex64(v.sha256)) return false;
  if (on(ctx, bytes)) {
    if (typeof v.bytes !== "number") return false;
    if (!refInt(ctx, "pack", v.bytes, `${at}/bytes`)) return false;
  }
  return true;
}

/** §2.3: the pack record's claims, after the common ones. */
export function refPackClaims(
  doc: Record<string, unknown>,
  ctx: ClaimCtx,
): boolean {
  if (on(ctx, "deliverable.not-app") && doc.deliverable === "app") return false;
  if (on(ctx, "builds.absent") && hasOwn(doc, "builds")) return false;
  if (
    on(ctx, "type") &&
    !(typeof doc.type === "string" && REF_PACK_TYPE_RE.test(doc.type))
  )
    return false;
  if (on(ctx, "formatVersion")) {
    if (typeof doc.formatVersion !== "number") return false;
    if (!refInt(ctx, "pack", doc.formatVersion, "/formatVersion")) return false;
  }
  if (hasOwn(doc, "handler") && on(ctx, "handler")) {
    const h = doc.handler;
    if (!isObj(h)) return false;
    if (hasOwn(h, "mountOrder") && on(ctx, "handler.mountOrder")) {
      if (typeof h.mountOrder !== "number") return false;
      if (!refInt(ctx, "pack", h.mountOrder, "/handler/mountOrder"))
        return false;
    }
    if (hasOwn(h, "prefixes") && on(ctx, "handler.prefixes")) {
      const p = h.prefixes;
      if (!Array.isArray(p)) return false;
      if (on(ctx, "handler.prefixes.count") && (p.length < 1 || p.length > 32))
        return false;
      for (const x of p) {
        if (
          on(ctx, "handler.prefixes.item") &&
          !(typeof x === "string" && REF_HANDLER_PREFIX_RE.test(x))
        )
          return false;
        if (
          on(ctx, "handler.prefixes.length") &&
          typeof x === "string" &&
          utf8Bytes(x).length > 256
        )
          return false;
      }
      if (
        on(ctx, "handler.prefixes.unique") &&
        new Set(p.map((x) => JSON.stringify(x))).size !== p.length
      )
        return false;
    }
    if (
      hasOwn(h, "activation") &&
      on(ctx, "handler.activation") &&
      !refVocab(h.activation)
    )
      return false;
  }
  if (
    hasOwn(doc, "entitlement") &&
    on(ctx, "entitlement") &&
    !(
      typeof doc.entitlement === "string" &&
      REF_ENTITLEMENT_RE.test(doc.entitlement)
    )
  )
    return false;
  if (on(ctx, "variants")) {
    const vs = doc.variants;
    if (!Array.isArray(vs)) return false;
    if (on(ctx, "variants.count") && (vs.length < 1 || vs.length > 32))
      return false;
    const keys: string[] = [];
    const axisSets: string[] = [];
    for (const [i, v] of vs.entries()) {
      if (!on(ctx, "variants.item")) continue;
      if (!isObj(v)) return false;
      const sel = refVariantClaims(v, i, ctx);
      if (sel === false) return false;
      const names = Object.keys(sel).sort();
      keys.push(names.map((n) => `${n}=${String(sel[n])}`).join(";"));
      axisSets.push(JSON.stringify(names));
    }
    if (on(ctx, "variants.key-unique") && new Set(keys).size !== keys.length)
      return false;
    if (on(ctx, "variants.axes-same") && new Set(axisSets).size > 1)
      return false;
  }
  return true;
}

/** One variant's claims; its axis selection when they hold. */
function refVariantClaims(
  v: Record<string, unknown>,
  i: number,
  ctx: ClaimCtx,
): Record<string, unknown> | false {
  const at = `/variants/${i}`;
  let sel: Record<string, unknown> = {};
  if (on(ctx, "variant")) {
    if (!isObj(v.variant)) return false;
    sel = v.variant;
    const names = Object.keys(sel);
    if (on(ctx, "variant.count") && names.length > 4) return false;
    for (const n of names) {
      if (on(ctx, "variant.axis") && !REF_AXIS_RE.test(n)) return false;
      if (
        on(ctx, "variant.value") &&
        !(typeof sel[n] === "string" && REF_AXIS_VALUE_RE.test(sel[n]))
      )
        return false;
    }
  }
  if (on(ctx, "payload")) {
    const p = v.payload;
    if (!isObj(p)) return false;
    if (on(ctx, "payload.size")) {
      if (typeof p.size !== "number") return false;
      if (!refInt(ctx, "pack", p.size, `${at}/payload/size`)) return false;
    }
    if (on(ctx, "payload.sha256") && !refHex64(p.sha256)) return false;
  }
  if (on(ctx, "full")) {
    if (!isObj(v.full)) return false;
    if (!refObjectRef(ctx, v.full, `${at}/full`)) return false;
  }
  let layout: unknown = undefined;
  if (on(ctx, "files")) {
    const f = v.files;
    if (!isObj(f)) return false;
    layout = f.layout;
    if (
      on(ctx, "files.format") &&
      !(typeof f.format === "string" && REF_OBJECT_FORMAT_RE.test(f.format))
    )
      return false;
    if (on(ctx, "files.layout") && !refVocab(f.layout)) return false;
    if (!refObjectRef(ctx, f, `${at}/files`)) return false;
    if (hasOwn(f, "gaps") && on(ctx, "files.gaps")) {
      if (!isObj(f.gaps)) return false;
      if (!refObjectRef(ctx, f.gaps, `${at}/files/gaps`)) return false;
    }
    if (
      on(ctx, "files.gaps-container") &&
      f.layout === "container" &&
      !hasOwn(f, "gaps")
    )
      return false;
    if (on(ctx, "files.gaps-tree") && f.layout === "tree" && hasOwn(f, "gaps"))
      return false;
  }
  if (hasOwn(v, "deltas") && on(ctx, "deltas")) {
    const ds = v.deltas;
    if (!Array.isArray(ds)) return false;
    if (on(ctx, "deltas.count") && ds.length > 16) return false;
    const ids: string[] = [];
    for (const [j, d] of ds.entries()) {
      if (!on(ctx, "deltas.item")) continue;
      if (!isObj(d)) return false;
      const dt = `${at}/deltas/${j}`;
      if (on(ctx, "delta.method") && !refVocab(d.method)) return false;
      if (on(ctx, "delta.scope") && !refVocab(d.scope)) return false;
      if (
        on(ctx, "delta.scope-tree") &&
        d.scope === "payload" &&
        layout === "tree"
      )
        return false;
      if (on(ctx, "delta.from") && !refHex64(d.from)) return false;
      if (on(ctx, "delta.memBytes")) {
        if (typeof d.memBytes !== "number") return false;
        if (!refInt(ctx, "pack", d.memBytes, `${dt}/memBytes`)) return false;
      }
      if (d.scope === "payload" && on(ctx, "delta.artifact")) {
        if (!isObj(d.artifact)) return false;
        if (
          !refHashBytes(
            ctx,
            d.artifact,
            `${dt}/artifact`,
            "delta.artifact.sha256",
            "delta.artifact.bytes",
          )
        )
          return false;
        ids.push(String(d.artifact.sha256));
      }
      if (d.scope === "files") {
        if (on(ctx, "delta.patch")) {
          if (!isObj(d.patch)) return false;
          if (!refObjectRef(ctx, d.patch, `${dt}/patch`)) return false;
          ids.push(String(d.patch.sha256));
        }
        if (on(ctx, "delta.data")) {
          if (!isObj(d.data)) return false;
          if (
            !refHashBytes(
              ctx,
              d.data,
              `${dt}/data`,
              "delta.data.sha256",
              "delta.data.bytes",
            )
          )
            return false;
        }
      }
    }
    if (on(ctx, "deltas.id-unique") && new Set(ids).size !== ids.length)
      return false;
  }
  if (hasOwn(v, "requires") && on(ctx, "requires")) {
    const r = v.requires;
    if (!isObj(r)) return false;
    if (
      hasOwn(r, "engine") &&
      on(ctx, "requires.engine") &&
      !(typeof r.engine === "string" && REF_ENGINE_RE.test(r.engine))
    )
      return false;
  }
  // plans/P4-10.md §2.2: checks 81–83 and the object ref at `chunks`; other members ignored.
  if (hasOwn(v, "chunks") && on(ctx, "chunks")) {
    const c = v.chunks;
    if (!isObj(c)) return false;
    if (
      on(ctx, "chunks.format") &&
      !(typeof c.format === "string" && REF_OBJECT_FORMAT_RE.test(c.format))
    )
      return false;
    if (!refObjectRef(ctx, c, `${at}/chunks`)) return false;
    if (hasOwn(c, "params") && on(ctx, "chunks.params") && !isObj(c.params))
      return false;
  }
  return sel;
}

/** §2.4's `content` (checks 57–75), at `at` (`/content` in a record). */
export function refContentClaims(
  c: unknown,
  ctx: ClaimCtx,
  at: string,
): boolean {
  if (!isObj(c)) return false;
  if (on(ctx, "content.contentApi")) {
    if (typeof c.contentApi !== "number") return false;
    if (!refInt(ctx, "content", c.contentApi, `${at}/contentApi`)) return false;
  }
  if (on(ctx, "content.pins")) {
    const pins = c.pins;
    if (!Array.isArray(pins)) return false;
    if (on(ctx, "content.pins.count") && pins.length > 256) return false;
    const packs: unknown[] = [];
    for (const [i, p] of pins.entries()) {
      if (!on(ctx, "content.pins.item")) continue;
      if (!isObj(p)) return false;
      packs.push(p.pack);
      if (on(ctx, "pin.pack") && !refPackIdShape(p.pack)) return false;
      if (on(ctx, "pin.pack.not-app") && p.pack === "app") return false;
      if (on(ctx, "pin.release")) {
        const r = p.release;
        if (!isObj(r)) return false;
        if (on(ctx, "pin.release.sha256") && !refHex64(r.sha256)) return false;
        if (on(ctx, "pin.release.seq")) {
          if (typeof r.seq !== "number") return false;
          if (!refInt(ctx, "content", r.seq, `${at}/pins/${i}/release/seq`))
            return false;
        }
        if (
          on(ctx, "pin.release.version") &&
          !(
            typeof r.version === "string" &&
            REF_RECORD_VERSION_RE.test(r.version)
          )
        )
          return false;
      }
    }
    if (
      on(ctx, "content.pins.unique") &&
      new Set(packs.map((x) => JSON.stringify(x))).size !== packs.length
    )
      return false;
  }
  if (on(ctx, "content.expects")) {
    const es = c.expects;
    if (!Array.isArray(es)) return false;
    if (on(ctx, "content.expects.count") && es.length > 256) return false;
    const packs: unknown[] = [];
    for (const e of es) {
      if (!on(ctx, "content.expects.item")) continue;
      if (!isObj(e)) return false;
      packs.push(e.pack);
      if (on(ctx, "expect.pack") && !refPackIdShape(e.pack)) return false;
      if (on(ctx, "expect.pack.not-app") && e.pack === "app") return false;
      if (on(ctx, "expect.required") && typeof e.required !== "boolean")
        return false;
      if (on(ctx, "expect.delivery") && !refVocab(e.delivery)) return false;
    }
    if (
      on(ctx, "content.expects.unique") &&
      new Set(packs.map((x) => JSON.stringify(x))).size !== packs.length
    )
      return false;
  }
  return true;
}

/** §2.4's `builds[].embeds` (checks 77–80). */
export function refEmbedsClaims(e: unknown, ctx: ClaimCtx): boolean {
  if (!Array.isArray(e)) return false;
  if (on(ctx, "embeds.count") && e.length > 64) return false;
  for (const x of e) {
    if (on(ctx, "embeds.item") && !refPackIdShape(x)) return false;
    if (on(ctx, "embeds.not-app") && x === "app") return false;
  }
  if (
    on(ctx, "embeds.unique") &&
    new Set(e.map((x) => JSON.stringify(x))).size !== e.length
  )
    return false;
  return true;
}
