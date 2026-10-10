/**
 * The developer-facing subject feed (plans/I-04.md §8 Q8): `subject.merged` and `subject.deleted`
 * rows in `subject_events`, pulled by the console Users page and an admin cursor (I-12); push
 * webhooks come later. A row carries pairwise subjects and licence ids only, never an account id.
 */

import { randomId } from "../../../crypto.js";
import type { DbStatement } from "../../../db/types.js";

export type SubjectEvent =
  | {
      type: "subject.merged";
      product: string;
      /** The survivor's subject, which the developer keeps. */
      subject: string;
      /** The absorbed account's subject, now an alias of `subject`. */
      alias: string;
    }
  | {
      type: "subject.deleted";
      product: string;
      subject: string;
      /** The licences of this product the subject's account held when it was deleted. */
      licenseIds: string[];
      /** Whether those licences were detached (account deletion, "also remove the licence"). */
      detached: boolean;
    };

export function stmtSubjectEvent(e: SubjectEvent, now: number): DbStatement {
  const payload =
    e.type === "subject.merged"
      ? { alias: e.alias }
      : { licenseIds: e.licenseIds, detached: e.detached };
  return {
    sql: `INSERT INTO subject_events (product, id, type, subject, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    params: [
      e.product,
      randomId("sev"),
      e.type,
      e.subject,
      JSON.stringify(payload),
      now,
    ],
  };
}
