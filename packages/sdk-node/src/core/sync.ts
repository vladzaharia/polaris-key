// `sync()` — the single Core loop that replaces v2's `refresh()`.
//
// ── THE ORCHESTRATION, IN ORDER ─────────────────────────────────────────────────────────────
//
//   1. no token ⇒ return immediately, ZERO network calls. An unactivated client that polls
//      must not generate traffic, and an offline-first `init()` must not either.
//   2. re-arm the single re-acquire budget for this pass (`TokenManager.beginPass`).
//   3. TRUST REFRESH on Core's own cadence (§4.2) — before the documents, independent of them.
//      v2 rode this on the `/config` fetch, which meant a product that fetched no config
//      advanced no clock. Errors are swallowed: a manifest we could not fetch is a manifest we
//      keep, not a reason to fail the sync.
//   4. the ENABLED documents in PARALLEL. License and Config are independent services with
//      independent ETags; serialising them would make every sync cost two round trips for no
//      reason, and a product that runs only one must not pay for the other at all.
//   5. verify each through client-core against the effective trust set, with the per-TYPE
//      anti-replay floor taken from the document currently held (§3).
//   6. ONE cache write folding every slice that changed plus the unsigned hints.
//   7. the floor rises from whatever verified (done inside `CacheManager.apply*`).
//   8. telemetry to `POST /<p>/devices/report`, best-effort.
//
// ── WHY THE CACHE WRITE IS SINGULAR ─────────────────────────────────────────────────────────
//
// Two parallel fetches finishing microseconds apart would otherwise both read-modify-write the
// record, and the loser's slice would vanish. Each document's outcome is collected as a plain
// value; the record is touched exactly once, after both have settled.

import {
  verifyConfigDoc,
  verifyLicenseDoc,
  REFRESH_MARGIN_SECONDS,
  type BlockedState,
  type CacheRecordV3,
} from "@plrs/client-core";
import type { ConfigDoc } from "@plrs/protocol/config";
import type { LicenseDoc } from "@plrs/protocol/license";
import { fetchLicenseDocument } from "../license/endpoints.js";
import { fetchConfigDocument } from "../config/fetch.js";
import type { CacheManager } from "./cache.js";
import { nowSec, type CoreContext, type DocumentResult } from "./context.js";
import type { TokenManager } from "./token.js";
import type { TrustManager } from "./trust.js";

/** What happened to one document this pass. */
export type DocOutcome =
  | { kind: "applied" }
  | { kind: "unchanged" }
  | { kind: "unauthorized" }
  | { kind: "blocked"; blocked: BlockedState }
  | { kind: "device-cap"; limit?: number; deviceCount?: number }
  | { kind: "skipped" }
  | { kind: "error" };

export interface SyncResult {
  /** True when ANY document's content changed and was applied. */
  applied: boolean;
  /** Set when a document fetch ended on a hard 401 after the single re-acquire. */
  unauthorized?: boolean;
  /** Set when `/license/document` answered 403 with a version/channel block. */
  blocked?: boolean;
  /** Set when the server refused on the device cap. */
  deviceCap?: boolean;
  /** Per-service detail, for callers that fetch more than one document. */
  documents: { license?: DocOutcome; config?: DocOutcome };
}

/** Everything `sync()` needs. Passed as a bag rather than a class so the loop stays a
 *  function: it has no state of its own, and every piece of state it touches is owned by one
 *  of these four managers. */
export interface SyncDeps {
  ctx: CoreContext;
  trust: TrustManager;
  cache: CacheManager;
  tokens: TokenManager;
  /** Best-effort device telemetry (`POST /<p>/devices/report`). */
  report: () => Promise<void>;
}

export interface SyncOptions {
  /** Skip conditional requests and re-ask unconditionally. */
  force?: boolean;
}

const IDLE: SyncResult = { applied: false, documents: {} };

export async function sync(
  deps: SyncDeps,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const { ctx, trust, cache, tokens } = deps;
  const token = tokens.current;
  // §5 — nothing to authenticate with means nothing to fetch. Returning here is what makes
  // "offline init performs zero network calls" a structural property rather than a habit.
  if (!token) return { ...IDLE };

  tokens.beginPass();

  // ── 3. Trust, on Core's own cadence ─────────────────────────────────────────────────────
  let trustJws: string | null = null;
  if (ctx.trustRefreshEnabled) {
    trustJws = await trust.refresh().catch(() => null);
  }

  // ── 4/5. The enabled documents, in parallel ─────────────────────────────────────────────
  const wantLicense = ctx.enabled("license");
  const wantConfig = ctx.enabled("config");
  const [license, config] = await Promise.all([
    wantLicense
      ? syncLicense(deps, opts.force === true)
      : Promise.resolve<DocSync>({ outcome: { kind: "skipped" } }),
    wantConfig
      ? syncConfig(deps, opts.force === true)
      : Promise.resolve<DocSync>({ outcome: { kind: "skipped" } }),
  ]);

  // ── 6. One write ────────────────────────────────────────────────────────────────────────
  const patch: Partial<CacheRecordV3> = {};
  if (trustJws) patch.trustJws = trustJws;

  const outcomes = [license.outcome, config.outcome];
  const unauthorized = outcomes.some((o) => o.kind === "unauthorized");
  const blockedOutcome = outcomes.find((o) => o.kind === "blocked");
  const capOutcome = outcomes.find((o) => o.kind === "device-cap");
  const applied = outcomes.some((o) => o.kind === "applied");
  // A successful authenticated exchange — 200 OR 304 — clears both unsigned hints. They can
  // only ever tighten the gate (§4.1), so clearing them on evidence of a healthy session is
  // safe; setting them requires the server to have said so.
  const healthy = outcomes.some(
    (o) => o.kind === "applied" || o.kind === "unchanged",
  );
  if (unauthorized) {
    patch.lastSyncUnauthorized = true;
  } else if (healthy) {
    patch.lastSyncUnauthorized = false;
  }
  if (blockedOutcome?.kind === "blocked") {
    patch.blocked = blockedOutcome.blocked;
  } else if (healthy) {
    patch.blocked = undefined;
  }
  // `applyLicense`/`applyConfig` already staged the document slices; this is the flush.
  if (
    Object.keys(patch).length > 0 ||
    applied ||
    license.outcome.kind === "unchanged" ||
    config.outcome.kind === "unchanged"
  ) {
    await cache.flush(patch);
  }

  const result: SyncResult = {
    applied,
    documents: {
      ...(wantLicense ? { license: license.outcome } : {}),
      ...(wantConfig ? { config: config.outcome } : {}),
    },
  };
  if (unauthorized) result.unauthorized = true;
  if (blockedOutcome) result.blocked = true;
  if (capOutcome) result.deviceCap = true;

  // ── 8. Telemetry ────────────────────────────────────────────────────────────────────────
  // Skipped only on a hard 401 with nothing applied: reporting with a credential the server
  // has just rejected is noise, and the report is best-effort in every other respect.
  if (applied || !unauthorized) await deps.report().catch(() => undefined);
  return result;
}

interface DocSync {
  outcome: DocOutcome;
}

/**
 * One document's fetch → verify → stage cycle, including the §5 half-life escalation and the
 * single 401 re-acquire. Written once, generic over the two documents, because the two rules
 * that matter — "a 304 renews freshness but not the signed window" and "exactly one
 * re-acquire" — are contract-level and must not be able to differ per service.
 */
async function syncDocument(
  deps: SyncDeps,
  slice: "license" | "config",
  force: boolean,
  fetchDoc: (token: string, etag?: string) => Promise<DocumentResult>,
  /** Verify the arrived artifact and, on success, STAGE it in the cache manager. Returning
   *  false means "not a document" — nothing is staged and nothing previously held moves. */
  verify: (jws: string, etag: string | null) => Promise<boolean>,
  currentExpiresAt: () => number | undefined,
  allowReacquire = true,
): Promise<DocSync> {
  const { cache, tokens } = deps;
  const token = tokens.current;
  if (!token) return { outcome: { kind: "skipped" } };

  const res = await fetchDoc(token, force ? undefined : cache.etag(slice));
  switch (res.kind) {
    case "not-modified": {
      // §5 — a 304 means "content unchanged, freshness RENEWED". The ETag deliberately
      // excludes the timestamps, so a content-stable document 304s forever; left alone a
      // continuously online, continuously authenticated client coasts into `grace` at
      // `expiresAt` and `expired` at `graceUntil` (R2-11). Past the half-life we re-ask
      // UNCONDITIONALLY so the server re-signs the validity window.
      const expiresAt = currentExpiresAt();
      if (
        !force &&
        expiresAt !== undefined &&
        nowSec() > expiresAt - REFRESH_MARGIN_SECONDS
      ) {
        return syncDocument(
          deps,
          slice,
          true,
          fetchDoc,
          verify,
          currentExpiresAt,
          allowReacquire,
        );
      }
      cache.markVerified();
      return { outcome: { kind: "unchanged" } };
    }
    case "unauthorized": {
      if (allowReacquire && (await tokens.reacquireOnce())) {
        // One retry, with re-acquire now spent for this pass.
        return syncDocument(
          deps,
          slice,
          force,
          fetchDoc,
          verify,
          currentExpiresAt,
          false,
        );
      }
      return { outcome: { kind: "unauthorized" } };
    }
    case "device-cap":
      return {
        outcome: {
          kind: "device-cap",
          limit: res.limit,
          deviceCount: res.deviceCount,
        },
      };
    case "blocked":
      return {
        outcome: {
          kind: "blocked",
          blocked: { reason: res.reason, allowedRange: res.allowedRange },
        },
      };
    case "ok": {
      // A document that fails verification is simply not applied — and, crucially, nothing
      // about the previous one is disturbed. The anti-replay floor `verify` uses is DERIVED
      // from the document currently held, never from an on-disk counter (R4-03).
      const ok = await verify(res.jws, res.etag);
      if (!ok) return { outcome: { kind: "error" } };
      cache.markVerified();
      return { outcome: { kind: "applied" } };
    }
    case "error":
      return { outcome: { kind: "error" } };
  }
}

function syncLicense(deps: SyncDeps, force: boolean): Promise<DocSync> {
  const { ctx, cache, trust } = deps;
  return syncDocument(
    deps,
    "license",
    force,
    (token, etag) => fetchLicenseDocument(ctx, token, etag),
    async (jws, etag) => {
      const doc: LicenseDoc | null = await verifyLicenseDoc(jws, {
        trust: trust.effective,
        expectedAud: ctx.product,
        deviceId: ctx.deviceId,
        lastAcceptedIssuedAt: cache.state.license?.doc.issuedAt,
      });
      if (!doc) return false;
      cache.applyLicense(jws, doc, etag);
      return true;
    },
    () => cache.state.license?.doc.expiresAt,
  );
}

function syncConfig(deps: SyncDeps, force: boolean): Promise<DocSync> {
  const { ctx, cache, trust } = deps;
  return syncDocument(
    deps,
    "config",
    force,
    (token, etag) => fetchConfigDocument(ctx, token, etag),
    async (jws, etag) => {
      const doc: ConfigDoc | null = await verifyConfigDoc(jws, {
        trust: trust.effective,
        expectedAud: ctx.product,
        deviceId: ctx.deviceId,
        lastAcceptedIssuedAt: cache.state.config?.doc.issuedAt,
      });
      if (!doc) return false;
      cache.applyConfig(jws, doc, etag);
      return true;
    },
    () => cache.state.config?.doc.expiresAt,
  );
}
