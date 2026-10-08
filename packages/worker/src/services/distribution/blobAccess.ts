/// <reference types="@cloudflare/workers-types" />

/**
 * Who may fetch one content-addressed object on the blob route (P2b-04's
 * `GET|HEAD /<p>/distribution/blobs/sha256/<hex>`, P4-05's pack branch; plans/P4-01.md §6 and
 * decision 35).
 *
 * A hash is never a secret (signed records and indexes publish it), so the route authorises the
 * HOLDERS of the object, never the hash. An object lives under at most two keys of the product's
 * store, and only the holders of a key decide whether that key is served:
 *
 *   blobs/sha256/<hex>         the PUBLIC path: app artifacts (`artifact` refs), registered feed
 *                              files (`feed`), and the objects of a pack published while it was
 *                              ungated (`pack-object`, `pack-upload`);
 *   gated/blobs/sha256/<hex>   the GATED path: only a pack's objects, published while it was
 *                              gated. No other holder of a `gated/` key authorises anything.
 *
 * The public path is tried first and never reads `gated/`; the gated key is tried only when the
 * public one is not held or refuses. An object never moves between prefixes (P4-14's rule too).
 *
 * ── WHAT EACH HOLDER REQUIRES ───────────────────────────────────────────────────────────────
 *
 *   - nobody, for a package version's files (`package-file`, SEC-DST-1: the package feeds serve
 *     them under their own ladder; the ref grants nothing here) and for listing art and hosted copies (`listing-asset`, `hosted-asset`; HA-07): those refs
 *     authorise nothing here (`SERVES_NOTHING_REF_KINDS`); the image host serves them;
 *   - the app side (any other non-pack ref, public path only): P2b-04's rule, unchanged — the strictest
 *     delivery mode of the deliverables whose releases carry the digest (the `app` mode when none
 *     do): `public`, a usable licence, or under `entitled` an APP release of THIS product carrying
 *     the digest whose stored version passes the window (`entitledBlobRefusal`);
 *   - a pack, on the gated path while it is gated: its CURRENT gate, the flag in its own
 *     `dist_access.entitlement` (read with every mode in one query, `readAccessTable`), held by the device's licence — never the
 *     manifest's assertion and never a record's `entitlement`, a publish-time snapshot;
 *   - a pack otherwise (its public-path objects, or gated objects of a pack un-gated later): its
 *     delivery mode (its own row, else the app's, else `entitled`; `readAccessTable`).
 *     `public` serves; `authenticated`/`licensed` want a usable licence; `entitled` wants the
 *     pack's gate when it has one. `entitled` WITHOUT a gate is FAIL-CLOSED: `entitled` means
 *     "enforce the caller's own grant", a pack's grant is its gate, and the app's version window
 *     is an app rule that does not apply to a pack (P4-02's record route says the same). So the
 *     object is refused with `403 delivery_gate_missing` until an operator sets a gate or a
 *     looser mode for the pack under Distribution → Access (P4-05's decision; the P4-01 plan left
 *     it open).
 *
 * The holders of one key combine as before ("an object is as protected as the strictest
 * deliverable holding it"): the strictest level wins (`public` < licence < a grant), and at the
 * grant level ANY holder whose grant the caller holds admits it. A public response is cacheable
 * only when every holder of a public key is `public`; anything else, and everything under
 * `gated/`, is `private, no-store` (`blobResponse` forces that for a `gated/` key regardless).
 *
 * A key no holder of this product holds is the plain not-found, after the app mode's request
 * level check (unchanged from P2b-04), so the route is no oracle for what other tenants store.
 *
 * ── LAZY DELTAS (P4-29) ─────────────────────────────────────────────────────────────────────
 *
 * A generated lazy delta (P4-17) is stored at `deltas/<from>/<to>.<method>` (or under `gated/`),
 * never at a `blobs/` key, yet the feed's delta menu names it by its own SHA-256. When neither
 * blob key is held, the hash's `deltas/` keys this product holds a `lazy-delta` ref to are the
 * candidates (`lazyDeltaKeys`), the ref naming its pack, so the pack rules above apply unchanged:
 * a `gated/deltas/…` key needs the pack's current gate. Only while P4-17's `LAZY_DELTAS` and the
 * product's opt-in are on. A cold delta (its ref dropped) is the plain not-found.
 */

import { APP_DELIVERABLE_ID, isDeliverableId } from "@polaris-key/manifest";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { ReleaseCatalog } from "../../core/hooks.js";
import { bearer } from "../../core/platform.js";
import { notFound, wireError } from "../../core/errors.js";
import {
  blobKey,
  LAZY_DELTA_REF,
  OCI_PUSH_REF,
  PACKAGE_FILE_REF,
  lazyDeltaKeys,
  parseKey,
  refHolders,
  type RefHolder,
} from "../../core/blobs.js";
import { lazyDeltasEnabled } from "../../core/deltaDemand.js";
import { HOSTED_ASSET_REF } from "../../core/hostedAssets.js";
import { LISTING_ASSET_REF } from "./listing/assets.js";
import {
  accessRefusal,
  entitlementFlagRefusal,
  fixedReleaseSelector,
} from "../../core/entitledAccess.js";
import type { Db } from "../../core/platform.js";
import { readAccessTable, stricter, type AccessTable } from "./access.js";
import type { ByteContext } from "./bytes.js";

/** What the blob route does with one request. */
export type BlobDecision =
  /** Serve `key`; `publicCache` only when every holder of a public key is `public`. */
  | {
      kind: "serve";
      key: string;
      publicCache: boolean;
      /** An app-side holder serves it: its audience can narrow, so the cache is bounded. */
      boundedCache: boolean;
    }
  /** Refused by a holder's rule. */
  | { kind: "refused"; response: Response }
  /** This product holds neither key: not-found (answered after the rate limit). */
  | { kind: "absent" };

/** One holder's requirement, by strictness level. */
type Requirement =
  | { level: 0 }
  | { level: 1 }
  | { level: 2; check: "window" }
  | { level: 2; check: "flag"; flag: string }
  | { level: 2; check: "closed"; deliverable: string };

/**
 * Holders that authorise NOTHING on this route (HA-07; notes/S-20 §4.6 #2): store listing art
 * (`listing-asset`, A-18d) and Polaris Key's hosted copies (`hosted-asset`, HA-01). They are public
 * images served from the image host (`core/imgHost.ts`), or bytes pushed to a store, never app
 * bytes: before HA-07 they counted as "app-side" here, so a `public` app served them to anyone
 * holding the digest, which the THREAT-MODEL said no route did. An object such a ref alone holds
 * is the plain not-found; one an artifact, feed file or pack also holds is served under THAT
 * holder's rule, as before.
 */
const SERVES_NOTHING_REF_KINDS: ReadonlySet<string> = new Set([
  LISTING_ASSET_REF,
  HOSTED_ASSET_REF,
]);

const PACK_REF_KINDS: ReadonlySet<string> = new Set([
  "pack-upload",
  "pack-object",
  // P4-29: a generated lazy delta, held by its pack deliverable (plans/P4-29.md §6.3).
  LAZY_DELTA_REF,
]);

/** The holders of one key, classified. */
interface KeyHolders {
  key: string;
  gated: boolean;
  /** Some non-pack ref (an app artifact, a feed file, …) holds it. */
  appSide: boolean;
  /** A package version's file (`package-file`) holds it: never serves anything here. */
  packageFile: boolean;
  /** The pack deliverables holding a ref to it, sorted. */
  packs: string[];
}

function classify(
  key: string,
  gated: boolean,
  rows: readonly RefHolder[],
): KeyHolders {
  const packs = new Set<string>();
  let appSide = false;
  let packageFile = false;
  for (const r of rows) {
    if (r.storageKey !== key) continue;
    // SEC-DST-1: a package version's file is served by its feed under the feed's own ladder,
    // never by hash on this route: the ref grants no standing here.
    if (r.refKind === PACKAGE_FILE_REF) {
      packageFile = true;
      continue;
    }
    // F-23: an OCI push upload is possession only and authorises nothing (core `OCI_PUSH_REF`).
    if (r.refKind === OCI_PUSH_REF) continue;
    // HA-07: listing art and hosted copies are the image host's, never this route's.
    if (SERVES_NOTHING_REF_KINDS.has(r.refKind)) continue;
    if (!PACK_REF_KINDS.has(r.refKind)) appSide = true;
    // A malformed holder (no `@` in a pack release id) names no pack and so admits nothing.
    else if (isDeliverableId(r.holder)) packs.add(r.holder);
  }
  return {
    key,
    gated,
    appSide,
    packageFile,
    packs: [...packs].sort(),
  };
}

function modeRequirement(
  mode: ReleaseAccess,
  gate: string | null,
  deliverable: string,
): Requirement {
  if (mode === "public") return { level: 0 };
  if (mode !== "entitled") return { level: 1 };
  return gate
    ? { level: 2, check: "flag", flag: gate }
    : { level: 2, check: "closed", deliverable };
}

/**
 * `entitled` for the app side: the request-level check proves only a usable licence, so the blob
 * is served only if a release of THIS product whose artifact has this digest passes the check
 * `files` applies (its stored version as a fixed, pinned version). Pack releases are not app
 * releases and never count here (P4-05: their version is not an app version). With no such
 * release the answer is the request-level refusal, else the flat not-found.
 */
async function entitledBlobRefusal(
  ctx: ByteContext,
  catalog: ReleaseCatalog,
  reads: BlobReads,
): Promise<Response | null> {
  const { req, env, db, product, now } = ctx;
  const releases = (await reads.carrying()).filter(
    (r) => r.deliverableId === APP_DELIVERABLE_ID,
  );
  if (!releases.length) {
    const denied = await accessRefusal(
      env,
      db,
      product,
      bearer(req),
      "entitled",
      await catalog.accessSelector(undefined),
      false,
      now,
    );
    return denied ?? notFound();
  }
  let first: Response | null = null;
  for (const { version } of releases) {
    const denied = await accessRefusal(
      env,
      db,
      product,
      bearer(req),
      "entitled",
      fixedReleaseSelector(version),
      true,
      now,
    );
    if (!denied) return null;
    first ??= denied;
  }
  return first;
}

/**
 * The reads one blob request shares: the product's delivery access (one query, every holder's
 * mode and gate) and, only when an app-side holder asks, the releases carrying the digest (one
 * query, used for both the strictest mode and the `entitled` window).
 */
interface BlobReads {
  access: AccessTable;
  carrying(): Promise<CarryingRelease[]>;
}

type CarryingRelease = { deliverableId: string; version: string };

async function blobReads(
  db: Db,
  product: string,
  catalog: ReleaseCatalog,
  sha256: string,
): Promise<BlobReads> {
  const access = await readAccessTable(db, product);
  let carrying: Promise<CarryingRelease[]> | undefined;
  return {
    access,
    carrying: () =>
      (carrying ??= catalog
        .resolve({ kind: "blob", sha256 })
        .then((r) => (r?.kind === "blob" ? r.releases : []))),
  };
}

/** The requirement list of one key's holders. */
async function requirementsOf(
  reads: BlobReads,
  h: KeyHolders,
): Promise<Requirement[]> {
  const out: Requirement[] = [];
  const { access } = reads;
  // Only a pack holder authorises a `gated/` key: nothing else is ever gated by a rule here.
  if (h.appSide && !h.gated) {
    // The strictest mode of the deliverables whose releases carry it, the app's when none do.
    const ids = new Set((await reads.carrying()).map((r) => r.deliverableId));
    if (!ids.size) ids.add(APP_DELIVERABLE_ID);
    let mode: ReleaseAccess = "public";
    for (const d of ids) mode = stricter(mode, access.mode(d));
    out.push(
      mode === "public"
        ? { level: 0 }
        : mode === "entitled"
          ? { level: 2, check: "window" }
          : { level: 1 },
    );
  }
  for (const pack of h.packs) {
    const gate = access.gate(pack);
    if (h.gated && gate) out.push({ level: 2, check: "flag", flag: gate });
    else out.push(modeRequirement(access.mode(pack), gate, pack));
  }
  return out;
}

/** `null` to serve under `reqs`, or the refusal (see the file comment for the combination). */
async function authorise(
  ctx: ByteContext,
  catalog: ReleaseCatalog,
  reads: BlobReads,
  reqs: readonly Requirement[],
): Promise<Response | null> {
  const { req, env, db, product, now } = ctx;
  const top = Math.max(...reqs.map((r) => r.level));
  if (top === 0) return null;
  if (top === 1)
    return accessRefusal(
      env,
      db,
      product,
      bearer(req),
      "licensed",
      {},
      false,
      now,
    );
  const grants = reqs.filter(
    (r): r is Extract<Requirement, { level: 2 }> => r.level === 2,
  );
  let first: Response | null = null;
  if (grants.some((r) => r.check === "window")) {
    const denied = await entitledBlobRefusal(ctx, catalog, reads);
    if (!denied) return null;
    first ??= denied;
  }
  const flags = [
    ...new Set(grants.flatMap((r) => (r.check === "flag" ? [r.flag] : []))),
  ].sort();
  if (flags.length) {
    const denied = await entitlementFlagRefusal(
      env,
      db,
      product,
      bearer(req),
      flags,
      now,
    );
    if (!denied) return null;
    first ??= denied;
  }
  const closed = grants.find((r) => r.check === "closed");
  if (closed && closed.check === "closed")
    first ??= wireError(403, "delivery_gate_missing", {
      message: `${closed.deliverable}'s delivery access is entitled, but it has no gate; an operator sets one (or a looser mode) under Distribution → Access.`,
    });
  return first ?? notFound();
}

/** Decide one blob-route request for `sha256` (see the file comment). */
export async function decideBlob(
  ctx: ByteContext,
  catalog: ReleaseCatalog,
  sha256: string,
): Promise<BlobDecision> {
  const { req, env, db, product, now } = ctx;
  const publicKey = blobKey(sha256);
  const gatedKey = blobKey(sha256, { gated: true });
  const rows = await refHolders(db, product.slug, [publicKey, gatedKey]);
  // More holders than one query reads: one unread holder could be the strictest. Fail closed.
  if (rows === null) return { kind: "refused", response: notFound() };
  const reads = await blobReads(db, product.slug, catalog, sha256);

  const candidates = [
    classify(publicKey, false, rows),
    classify(gatedKey, true, rows),
  ].filter((h) => h.packs.length > 0 || (h.appSide && !h.gated));

  // P4-29 (plans/P4-29.md §6.3): neither blob key is held, so the hash may name a lazy delta
  // (`deltas/<from>/<to>.<method>`, under `gated/` for a gated pack) this product holds a
  // `lazy-delta` ref to, served under the holding pack's rules exactly as its other objects. Only
  // while P4-17's two switches are on, so either withdraws serving with the menu.
  if (!candidates.length && (await lazyDeltasEnabled(env, db, product.slug))) {
    const keys = await lazyDeltaKeys(db, product.slug, sha256);
    if (keys.length) {
      const held = await refHolders(db, product.slug, keys);
      if (held === null) return { kind: "refused", response: notFound() };
      for (const key of keys) {
        const parsed = parseKey(key);
        if (!parsed || parsed.area !== "locked" || parsed.kind !== "delta")
          continue;
        const h = classify(key, parsed.gated, held);
        if (h.packs.length > 0) candidates.push(h);
      }
    }
  }

  if (!candidates.length) {
    // Neither key is ours: the request-level check under the app mode first (unchanged), then
    // the plain not-found once the rate limit has counted the request.
    const denied = await accessRefusal(
      env,
      db,
      product,
      bearer(req),
      reads.access.mode(APP_DELIVERABLE_ID),
      await catalog.accessSelector(undefined),
      false,
      now,
    );
    return denied
      ? { kind: "refused", response: await uniformRefusal(denied) }
      : { kind: "absent" };
  }

  let first: Response | null = null;
  for (const h of candidates) {
    const reqs = await requirementsOf(reads, h);
    const denied = await authorise(ctx, catalog, reads, reqs);
    if (!denied)
      return {
        kind: "serve",
        key: h.key,
        publicCache: !h.gated && reqs.every((r) => r.level === 0),
        boundedCache: h.appSide,
      };
    first ??= denied;
  }
  const appOnly = candidates.every((h) => h.packs.length === 0);
  const refusal = first ?? notFound();
  return {
    kind: "refused",
    response: appOnly ? await uniformRefusal(refusal) : refusal,
  };
}

/**
 * SEC-DST-12: a caller who holds a usable licence but is outside the app's entitlement window
 * must not learn, from a 403 body, that a digest exists here (the absent path answers a flat 404
 * once the licence passes). Applies to the app side only: a pack's 403 `not_entitled` is its
 * published wire contract (its hashes are named by signed records). Every 403 but the
 * operator-facing `delivery_gate_missing` becomes the plain not-found; 401 (no or bad
 * credentials) is the same for held and absent digests and stays.
 */
async function uniformRefusal(res: Response): Promise<Response> {
  if (res.status !== 403) return res;
  try {
    const body = (await res.clone().json()) as { error?: { code?: string } };
    if (body.error?.code === "delivery_gate_missing") return res;
  } catch {
    // An unreadable 403 is not the operator hint: fall through to the plain not-found.
  }
  return notFound();
}

/**
 * Whether the object's PUBLIC key may be served to anyone: every holder of `blobs/sha256/<hex>`
 * requires nothing (the blob route's rule above, at its loosest). The F-Droid relay serves its
 * registered files to anyone, so it asks this at registration and on every relay request; a key
 * no holder holds yet (a file being registered) is judged by the app side's rule.
 */
export async function publicKeyIsPublic(
  db: Db,
  product: string,
  catalog: ReleaseCatalog,
  sha256: string,
): Promise<boolean> {
  const key = blobKey(sha256);
  const rows = await refHolders(db, product, [key]);
  if (rows === null) return false;
  const h = classify(key, false, rows);
  // SEC-DST-2: a package version's file is never relay-public, whatever the app's mode is.
  if (h.packageFile) return false;
  if (!h.packs.length) h.appSide = true;
  const reqs = await requirementsOf(
    await blobReads(db, product, catalog, sha256),
    h,
  );
  return reqs.every((r) => r.level === 0);
}
