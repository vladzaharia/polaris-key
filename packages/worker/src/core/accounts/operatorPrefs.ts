/**
 * An operator's console preferences, stored per operator (`session.sub`) so they follow the
 * operator across browsers. Core's only reader and writer of `operator_prefs`.
 */

import type { Db } from "../../db/types.js";

export interface OperatorPrefs {
  setupGuideHidden: boolean;
}

export async function readOperatorPrefs(
  db: Db,
  sub: string,
): Promise<OperatorPrefs> {
  const row = await db.first<{ setup_guide_hidden: number }>(
    "SELECT setup_guide_hidden FROM operator_prefs WHERE operator_sub = ?",
    sub,
  );
  return { setupGuideHidden: row?.setup_guide_hidden === 1 };
}

export async function setSetupGuideHidden(
  db: Db,
  sub: string,
  hidden: boolean,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO operator_prefs (operator_sub, setup_guide_hidden, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(operator_sub) DO UPDATE
       SET setup_guide_hidden = excluded.setup_guide_hidden, updated_at = excluded.updated_at`,
    sub,
    hidden ? 1 : 0,
    now,
  );
}
