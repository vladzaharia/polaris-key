// Config's profile writes (moved from core/licensing/store.ts, P0-26b).

import type { Db } from "../../db/types.js";
import type { ProfileRow } from "../../core/repo.js";

/**
 * The console's profile write. ST-01b: a console create or edit owns the row (`source =
 * 'console'`), so a resync leaves it alone from then on — a manifest row edited here is claimed.
 *
 * `claim: false` keeps the stored owner: the one console write that is NOT a claim is setting a
 * managed secret's value, which a manifest cannot express and the resync already carries forward
 * on a manifest row (R2, `resync.ts` `withStoredSecrets`).
 */
export async function upsertProfile(
  db: Db,
  row: ProfileRow,
  opts: { claim?: boolean } = {},
): Promise<void> {
  const claim = opts.claim ?? true;
  await db.run(
    `INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at,
       source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'console')
     ON CONFLICT(product, id) DO UPDATE SET
       name = excluded.name, description = excluded.description,
       payload_json = excluded.payload_json, modified_by = excluded.modified_by,
       modified_at = excluded.modified_at${claim ? ", source = 'console'" : ""}`,
    row.product,
    row.id,
    row.name,
    row.description,
    row.payload_json,
    row.modified_by,
    row.modified_at,
  );
}

export async function deleteProfile(
  db: Db,
  product: string,
  id: string,
): Promise<void> {
  await db.run(
    "DELETE FROM profiles WHERE product = ? AND id = ?",
    product,
    id,
  );
}
