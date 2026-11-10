/**
 * The per-product removal ledger (U-12.1): where "remove my data from <Product>" is recorded
 * OUTSIDE D1, so a D1 restore cannot bring the removed data back unnoticed.
 *
 * A removal ends one pairwise subject: its managed overrides, key ring, Cloud Sync object and
 * directory row, the device bindings and the subject row itself. A D1 Time Travel restore rewinds
 * all the D1 half of that together. The ledger is the record a restore does not touch: one
 * object per removed (product, subject) in the existing `BLOBS` bucket,
 *
 *   subject-erasures/<product>/<subject>   {"v":1,"product":"…","subject":"…","erasedAt":<unix seconds>}
 *
 * The product slug, the random pairwise subject and a timestamp: nothing that names the person.
 * The prefix is NOT `erasures/`: the account replay reads every key under that prefix as an
 * account id, and the two ledgers never see each other's entries.
 *
 * WRITE-AHEAD AND CREATE-ONLY. The removal records here BEFORE it clears a device binding or
 * deletes a store. The write is `If-None-Match: *`: the first record wins and a repeat answers
 * `exists`. A write that fails refuses the removal while nothing has been removed.
 */

import { PRODUCT_SLUG_RE } from "@polaris-key/manifest";
import { PAIRWISE_SUBJECT_PATTERN } from "../../../core/accounts/accountSubjects.js";
import type { Env } from "../../../platform/env.js";
import { ErasureLedgerError } from "./erasureLedger.js";

/** Every per-product ledger object lives under this prefix. Never `erasures/`. */
export const SUBJECT_ERASURE_PREFIX = "subject-erasures/";

/** The record's `v`. */
export const SUBJECT_ERASURE_RECORD_VERSION = 1;

/** What the ledger stores per removed subject. */
export interface SubjectErasureRecord {
  v: typeof SUBJECT_ERASURE_RECORD_VERSION;
  product: string;
  subject: string;
  /** Unix seconds. */
  erasedAt: number;
}

/** The ledger key of one (product, subject). */
export function subjectErasureKey(product: string, subject: string): string {
  return `${SUBJECT_ERASURE_PREFIX}${product}/${subject}`;
}

const messageOf = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 160);

/**
 * Record a removal, create-only. `created` the first time; `exists` when the ledger already holds
 * it (the first record, and its timestamp, stand). Throws {@link ErasureLedgerError} when the
 * record cannot be made durable or the names are not a product slug and a pairwise subject: the
 * caller must not start the removal.
 */
export async function recordSubjectErasure(
  env: Env,
  product: string,
  subject: string,
  erasedAt: number,
): Promise<"created" | "exists"> {
  if (!PRODUCT_SLUG_RE.test(product) || !PAIRWISE_SUBJECT_PATTERN.test(subject))
    throw new ErasureLedgerError(
      "a removal record needs a product slug and a pairwise subject",
    );
  const bucket = env.BLOBS;
  if (!bucket)
    throw new ErasureLedgerError(
      "removal ledger unavailable: the BLOBS bucket is not bound, so the removal cannot be recorded",
    );
  const record: SubjectErasureRecord = {
    v: SUBJECT_ERASURE_RECORD_VERSION,
    product,
    subject,
    erasedAt,
  };
  let stored: R2Object | null;
  try {
    stored = await bucket.put(
      subjectErasureKey(product, subject),
      JSON.stringify(record),
      {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        httpMetadata: { contentType: "application/json" },
      },
    );
  } catch (e) {
    throw new ErasureLedgerError(
      `removal ledger unavailable: recording the removal failed: ${messageOf(e)}`,
      { cause: e },
    );
  }
  return stored === null ? "exists" : "created";
}
