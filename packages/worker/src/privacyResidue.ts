// Nightly removal of personal data that outlives its purpose.
import type { Db } from "./core/platform.js";

const DAY = 24 * 60 * 60;
/** Merge tombstones only redirect for 30 days (MERGE_REDIRECT_SECONDS); kept 90 for the audit. */
export const TOMBSTONE_RETENTION_SECONDS = 90 * DAY;
export const SUBJECT_EVENT_RETENTION_SECONDS = 180 * DAY;

export async function purgePrivacyResidue(
  db: Db,
  now: number,
): Promise<number> {
  // A holder move's before/after name and email exist for the 72-hour undo only.
  const scrubbed = await db.runChanges(
    `UPDATE license_relinks
        SET holder_json = json_set(holder_json, '$.from', json('{}'), '$.to', json('{}'))
      WHERE holder_json IS NOT NULL AND undo_until < ?
        AND (json_extract(holder_json, '$.from.email') IS NOT NULL
          OR json_extract(holder_json, '$.from.name') IS NOT NULL
          OR json_extract(holder_json, '$.to.email') IS NOT NULL
          OR json_extract(holder_json, '$.to.name') IS NOT NULL)`,
    now,
  );
  // Merge tombstones carry an email hash; erasure tombstones (merged_into NULL) hold only the id
  // and are kept, since the legacy catch-up relies on them to never resurrect an account.
  const tombs = await db.runChanges(
    "DELETE FROM account_tombstones WHERE merged_into IS NOT NULL AND deleted_at < ?",
    now - TOMBSTONE_RETENTION_SECONDS,
  );
  const events = await db.runChanges(
    "DELETE FROM subject_events WHERE created_at < ?",
    now - SUBJECT_EVENT_RETENTION_SECONDS,
  );
  return scrubbed + tombs + events;
}
