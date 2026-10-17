import type { Db } from "../../db/types.js";
import { randomId } from "../../platform/crypto.js";

/** One `portal_audit` row: account-visible history, never a secret or an address. */
export async function portalAudit(
  db: Db,
  input: {
    accountId?: string | null;
    action: string;
    product?: string | null;
    targetKind?: string | null;
    targetId?: string | null;
    summary?: string | null;
    now: number;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO portal_audit
       (id, account_id, at, action, product, target_kind, target_id, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    randomId("paud"),
    input.accountId ?? null,
    input.now,
    input.action,
    input.product ?? null,
    input.targetKind ?? null,
    input.targetId ?? null,
    input.summary ?? null,
  );
}
