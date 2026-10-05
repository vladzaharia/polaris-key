/**
 * What every flow runtime shares (A-18j): turning ledger results into a step's outcome, the
 * store's failures into a refusal the console can show, and the listing model projected for one
 * store. Nothing here names a store.
 */

import type { StoreWriteResult } from "../../../core/storefront/ledger.js";
import {
  StoreVendorError,
  StoreWriteDenied,
} from "../../../core/storefront/errors.js";
import type { ListingStore } from "../../../core/storefront/listingProfiles.js";
import {
  fitReport,
  type FitReportRow,
} from "../../../core/storefront/projection.js";
import type { Db } from "../../../core/platform.js";
import { readListing } from "../listing/store.js";
import type { FlowRefusal, RunOutcome } from "./runtime.js";

export const refusal = (
  status: FlowRefusal["status"],
  reason: string,
  message: string,
  fields?: string[],
): FlowRefusal => ({
  ok: false,
  status,
  reason,
  message,
  ...(fields ? { fields } : {}),
});

/** Is it a refusal (`{ok: false}`) rather than a result? */
export function isRefusal(v: unknown): v is FlowRefusal {
  return (
    typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false
  );
}

/**
 * One step's outcome from the ledger results of its writes, in order: `written` when any write
 * was sent, `existing` when every one was already satisfied, `replayed` when every one replayed.
 * `after` is each write's vendor re-read (never the request).
 */
export function runOutcome(results: readonly StoreWriteResult[]): RunOutcome {
  if (results.length === 0)
    return refusal(422, "nothing_to_push", "there is nothing to send");
  const conflict = results.find((r) => r.outcome === "conflict");
  if (conflict)
    return refusal(
      409,
      "idempotency_conflict",
      "this Idempotency-Key was used for a different request",
    );
  const resultIds: Record<string, string> = {};
  const after: unknown[] = [];
  let opId = "";
  for (const r of results) {
    if (r.outcome === "replayed") {
      opId = r.row.op_id;
      try {
        Object.assign(resultIds, JSON.parse(r.row.result_ids_json ?? "{}"));
        after.push(JSON.parse(r.row.after_json ?? "null"));
      } catch {
        after.push(null);
      }
    } else if (r.outcome !== "conflict") {
      opId = r.opId;
      Object.assign(resultIds, r.resultIds);
      after.push(r.after);
    }
  }
  const outcome = results.some((r) => r.outcome === "written")
    ? "written"
    : results.every((r) => r.outcome === "replayed")
      ? "replayed"
      : "existing";
  return { ok: true, outcome, opId, resultIds, after };
}

/** Run a store step, answering a gate refusal or a store failure as a refusal (status only). */
export async function storeStep(
  fn: () => Promise<RunOutcome>,
): Promise<RunOutcome> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StoreWriteDenied)
      return refusal(422, "write_denied", e.message);
    if (e instanceof StoreVendorError)
      return refusal(e.status === 429 ? 429 : 502, "store_refused", e.message);
    throw e;
  }
}

/** The listing projected for one store column (S-15 §7.3), or null before a listing exists. */
export async function projectionFor(
  db: Db,
  product: string,
  store: ListingStore,
): Promise<FitReportRow | null> {
  const stored = await readListing(db, product);
  if (!stored) return null;
  return fitReport({ model: stored.model }, [store])[0] ?? null;
}

/** Why a store's listing cannot be pushed, or null when its payload is ready. */
export function fitBlocker(
  row: FitReportRow | null,
  label: string,
): string | null {
  if (!row) return "Write the listing first (Distribution → Listing).";
  if (!row.payload) {
    const n = row.issues.filter((i) => i.severity === "block").length;
    return `The listing does not fit ${label} yet: ${n} field${n === 1 ? "" : "s"} to fix in the fit report.`;
  }
  return null;
}
