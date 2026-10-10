/**
 * Undoing a join (PX-W12; PORTAL.md §4.11, §10.2 G27): "Joining is audited, emailed to both, and
 * undoable for 72 hours from either account."
 *
 * `mergeAccounts` (`merge.ts`, I-05) is the one join primitive: the login card's join offer (I-07)
 * and the account page's Link an existing account (`portal/link.ts`) both end in it. It now also
 * writes an `account_merges` row IN ITS OWN BATCH, holding a snapshot of what moved: the absorbed
 * account's row, the survivor's details it filled in, and the ids of the links, passkeys,
 * licences, sessions, pictures, registry tokens, relinks, grants, terms acceptances, auto-attach
 * blocks, library entries and pairwise subjects that went over. `undoMerge` replays that list backwards while the
 * window is open.
 *
 * ── WHAT AN UNDO RESTORES, AND WHAT IT CANNOT ───────────────────────────────────────────────
 *
 *   - The absorbed account comes back under its own id, with its own primary email and profile,
 *     and its tombstone goes, so its old session cookies act as it again. A primary address none
 *     of its returning methods carries (verified, if the primary is), such as one disconnected
 *     during the window and perhaps another account's now, gives way to the oldest verified
 *     address they do carry, an email method first, or to none.
 *   - Its sign-in methods that are still on the survivor go back, passkeys with their WebAuthn
 *     material. A method disconnected since the join stays disconnected: a lost passkey or a
 *     compromised provider account that was removed never comes back silently. The snapshot
 *     therefore holds method ids only, never their subjects, addresses or keys.
 *   - What still sits on the survivor goes back: licences, sessions, pictures, registry tokens,
 *     relink history, consents, terms acceptances and library entries (PS-04); a consent, terms
 *     acceptance or library entry the survivor no longer holds (withdrawn, removed, its product
 *     deleted) stays gone. Auto-attach blocks all come back, even one the survivor lifted: the
 *     cautious direction. What the survivor had before the join stays, and so does anything added
 *     to it since. A licence the survivor detached since the join stays floating (it is added
 *     again by its key, under the claim rules). A licence that goes back revokes every registry
 *     token the survivor minted on it during the window (F-21, `onLicenseOwnershipEnded`), and its
 *     devices' bindings go.
 *   - Details the survivor took from the absorbed account (a name, a picture, a primary email, the
 *     passkey user handle) are cleared again where they are still the absorbed account's values.
 *   - **Developers keep what they were told.** The join told each developer that the absorbed
 *     pairwise subject is an alias of the survivor's (`subject.merged`), and every registered store
 *     of account × product data already re-keyed onto the survivor (`runSubjectMerge`). An undo
 *     does not split that data: the alias stands, and where the absorbed subject became an alias
 *     the restored account gets a FRESH subject at its next contact with that product (to the
 *     developer, a new person). Where the absorbed subject moved over without becoming an alias
 *     (only the absorbed account knew that product) it simply goes back. Devices bound to a subject
 *     that changed hands lose the binding (Core's clearing hook) and bind again at their next
 *     sign-in. `subject_events` allows only `subject.merged` and `subject.deleted`, so nothing new
 *     is announced.
 *
 * ── GUARDS ──────────────────────────────────────────────────────────────────────────────────
 *
 *   - A sign-in to the survivor no older than 5 minutes (step-up): after a join the survivor is
 *     the only account, so "from either account" is any session on it, whichever account's
 *     method opened it.
 *   - Never orphan: refused (`last_link`) when either account would be left with no way to sign
 *     in. The first statement of the undo's batch is the guard (it aborts the batch), so a removal
 *     racing the undo cannot orphan either side.
 *   - Once only, and only inside the window: the row is claimed by a conditional UPDATE before the
 *     batch, so of two racing undos one applies.
 *   - A join is refused while either account could still undo a join of its own (`merge_pending`
 *     in `merge.ts`): absorbing that account would make the undo impossible, and absorbing INTO it
 *     would hand the second join's data and aliases to the first one's absorbed account on undo.
 *   - The snapshot holds the absorbed person's details (its account row: email, name, locale,
 *     profile sources, passkey user handle; its consents and terms acceptances), so it lives no
 *     longer than the window: an undo clears it, the nightly job deletes rows whose window ended,
 *     and deleting the survivor deletes its rows (docs/PRIVACY.md).
 */

import { randomId } from "../../../crypto.js";
import type { Db, DbParam, DbStatement } from "../../../db/types.js";
import {
  clearDeviceSubjects,
  onLicenseOwnershipEnded,
} from "../../../core/subjectHooks.js";
import { sendNotice, securityNoticeRecipients } from "../portal/email.js";
import { accountsSeparatedNotice } from "../portal/notices.js";
import { isFresh, type AccountContext, type AccountProof } from "./links.js";
import { EMAIL_ISSUER, getAccountRow } from "./repo.js";

/** How long a join can be undone (owner, PORTAL.md §4.11). */
export const MERGE_UNDO_SECONDS = 72 * 3600;

/** Every `accounts` column, in the order an undo re-inserts them (a test pins it to the table). */
export const ACCOUNT_COLUMNS = [
  "id",
  "status",
  "primary_email",
  "primary_email_verified_at",
  "display_name",
  "avatar_key",
  "locale",
  "details_source_json",
  "terms_json",
  "created_at",
  "modified_at",
  "last_sign_in_at",
  "deleted_at",
  "nudge_shown_at",
  "passkey_user_handle",
  "birthdate",
  "birthdate_source",
] as const;

/**
 * The survivor's details a join fills in from the absorbed account when the survivor has none.
 * `birthdate` stands for the pair: its source moves and goes back with it (I-33).
 */
const FILLED_COLUMNS = [
  "display_name",
  "avatar_key",
  "locale",
  "primary_email",
  "passkey_user_handle",
  "birthdate",
] as const;

type Row = Record<string, DbParam>;

interface SubjectMove {
  product: string;
  /** The absorbed account's subject for the product. */
  subject: string;
  /** The survivor's subject it became an alias of, or `null` when the row moved over whole. */
  aliasOf: string | null;
  /** Devices bound to `subject` when the join happened. */
  devices: string[];
}

/** What a join moved, enough to move it back. Never leaves Identity. */
export interface MergeSnapshot {
  v: 1;
  absorbed: Row;
  /** The survivor's {@link FILLED_COLUMNS} (and the primary email's verification) before. */
  survivorBefore: Row;
  /** The ids of the sign-in methods that moved (only what is still on the survivor goes back). */
  links: string[];
  /** The credential ids of the passkeys that moved. */
  passkeys: string[];
  licenses: Array<[string, string]>;
  sessions: string[];
  avatars: string[];
  registryTokens: Array<[string, string]>;
  relinksFrom: Array<[string, string]>;
  relinksTo: Array<[string, string]>;
  grants: Row[];
  /** Products whose consent the survivor took from the absorbed account (it had none). */
  grantsAdded: string[];
  terms: Row[];
  termsAdded: Array<[string, string]>;
  blocks: Row[];
  blocksAdded: Array<[string, string]>;
  /** PS-04's library entries (absent from a snapshot taken before they were recorded). */
  library?: Row[];
  /** Products whose library entry the survivor took from the absorbed account (it had none). */
  libraryAdded?: string[];
  subjects: SubjectMove[];
}

function pick(row: Row | null, cols: readonly string[]): Row {
  const out: Row = {};
  for (const c of cols) out[c] = row?.[c] ?? null;
  return out;
}

/**
 * Read what a join of `absorbedId` into `survivorId` is about to move. Called by `mergeAccounts`
 * after its checks and before its batch, while both accounts still exist.
 */
export async function captureMergeSnapshot(
  db: Db,
  survivorId: string,
  absorbedId: string,
  subjects: Array<{ product: string; subject: string; aliasOf: string | null }>,
): Promise<MergeSnapshot> {
  const S = survivorId;
  const A = absorbedId;
  const absorbed = await db.first<Row>(
    "SELECT * FROM accounts WHERE id = ?",
    A,
  );
  const survivor = await db.first<Row>(
    "SELECT * FROM accounts WHERE id = ?",
    S,
  );
  const ids = async (sql: string, ...params: DbParam[]) =>
    (await db.all<{ v: string }>(sql, ...params)).map((r) => r.v);
  const pairs = async (sql: string, ...params: DbParam[]) =>
    (await db.all<{ a: string; b: string }>(sql, ...params)).map(
      (r) => [r.a, r.b] as [string, string],
    );

  const grants = await db.all<Row>(
    `SELECT product, claims_json, granted_at, modified_at, scope_hash
       FROM account_product_grants WHERE account_id = ? ORDER BY product`,
    A,
  );
  const survivorGrants = new Set(
    await ids(
      "SELECT product AS v FROM account_product_grants WHERE account_id = ?",
      S,
    ),
  );
  const terms = await db.all<Row>(
    `SELECT product, version, url, accepted_at
       FROM account_terms_acceptances WHERE account_id = ? ORDER BY product, version`,
    A,
  );
  const survivorTerms = new Set(
    (
      await pairs(
        "SELECT product AS a, version AS b FROM account_terms_acceptances WHERE account_id = ?",
        S,
      )
    ).map(([p, v]) => `${p}\u0000${v}`),
  );
  const blocks = await db.all<Row>(
    `SELECT product, license_id, created_at
       FROM license_auto_attach_blocks WHERE account_id = ? ORDER BY product, license_id`,
    A,
  );
  const survivorBlocks = new Set(
    (
      await pairs(
        "SELECT product AS a, license_id AS b FROM license_auto_attach_blocks WHERE account_id = ?",
        S,
      )
    ).map(([p, l]) => `${p}\u0000${l}`),
  );

  const library = await db.all<Row>(
    `SELECT product, via, added_at
       FROM library_entries WHERE account_id = ? ORDER BY product`,
    A,
  );
  const survivorLibrary = new Set(
    await ids(
      "SELECT product AS v FROM library_entries WHERE account_id = ?",
      S,
    ),
  );

  const moves: SubjectMove[] = [];
  for (const s of subjects) {
    moves.push({
      ...s,
      devices: await ids(
        "SELECT device_id AS v FROM devices WHERE product = ? AND subject = ? ORDER BY device_id",
        s.product,
        s.subject,
      ),
    });
  }

  return {
    v: 1,
    absorbed: pick(absorbed, ACCOUNT_COLUMNS),
    survivorBefore: pick(survivor, [
      ...FILLED_COLUMNS,
      "primary_email_verified_at",
      "birthdate_source",
    ]),
    links: await ids(
      "SELECT id AS v FROM account_links WHERE account_id = ? ORDER BY created_at, id",
      A,
    ),
    passkeys: await ids(
      "SELECT credential_id AS v FROM account_passkeys WHERE account_id = ? ORDER BY created_at",
      A,
    ),
    licenses: await pairs(
      "SELECT product AS a, id AS b FROM licenses WHERE account_id = ? ORDER BY product, id",
      A,
    ),
    sessions: await ids(
      "SELECT id_hash AS v FROM account_sessions WHERE account_id = ?",
      A,
    ),
    avatars: await ids(
      "SELECT asset AS v FROM account_avatars WHERE account_id = ?",
      A,
    ),
    registryTokens: await pairs(
      "SELECT product AS a, token_id AS b FROM registry_tokens WHERE portal_account_id = ?",
      A,
    ),
    relinksFrom: await pairs(
      "SELECT product AS a, id AS b FROM license_relinks WHERE from_account_id = ?",
      A,
    ),
    relinksTo: await pairs(
      "SELECT product AS a, id AS b FROM license_relinks WHERE to_account_id = ?",
      A,
    ),
    grants,
    grantsAdded: grants
      .map((g) => String(g.product))
      .filter((p) => !survivorGrants.has(p)),
    terms,
    termsAdded: terms
      .map((t) => [String(t.product), String(t.version)] as [string, string])
      .filter(([p, v]) => !survivorTerms.has(`${p}\u0000${v}`)),
    blocks,
    blocksAdded: blocks
      .map((b) => [String(b.product), String(b.license_id)] as [string, string])
      .filter(([p, l]) => !survivorBlocks.has(`${p}\u0000${l}`)),
    library,
    libraryAdded: library
      .map((e) => String(e.product))
      .filter((p) => !survivorLibrary.has(p)),
    subjects: moves,
  };
}

/** The statement that records a join and its snapshot, for `mergeAccounts`' batch. */
export function stmtRecordMerge(
  mergeId: string,
  survivorId: string,
  absorbedId: string,
  snapshot: MergeSnapshot,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO account_merges
            (id, survivor_id, absorbed_id, merged_at, undo_until, undone_at, snapshot_json)
          VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    params: [
      mergeId,
      survivorId,
      absorbedId,
      now,
      now + MERGE_UNDO_SECONDS,
      JSON.stringify(snapshot),
    ],
  };
}

/** Whether `accountId` absorbed another account in a join that can still be undone. */
export async function hasUndoableMerge(
  db: Db,
  accountId: string,
  now: number,
): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    `SELECT 1 AS one FROM account_merges
      WHERE survivor_id = ? AND undone_at IS NULL AND undo_until > ? LIMIT 1`,
    accountId,
    now,
  );
  return row !== null;
}

/** A join the account can still undo, as the account page shows it. */
export interface UndoableMerge {
  id: string;
  mergedAt: number;
  undoUntil: number;
  /** The joined account as it was: its primary email and name (the person's own details). */
  joined: { email: string | null; name: string | null };
}

/** The joins `accountId` can still undo, newest first. */
export async function listUndoableMerges(
  db: Db,
  accountId: string,
  now: number,
): Promise<UndoableMerge[]> {
  const rows = await db.all<{
    id: string;
    merged_at: number;
    undo_until: number;
    snapshot_json: string | null;
  }>(
    `SELECT id, merged_at, undo_until, snapshot_json FROM account_merges
      WHERE survivor_id = ? AND undone_at IS NULL AND undo_until > ?
        AND snapshot_json IS NOT NULL
      ORDER BY merged_at DESC, id`,
    accountId,
    now,
  );
  return rows.map((r) => {
    const snap = parseSnapshot(r.snapshot_json);
    const email = snap?.absorbed.primary_email;
    const name = snap?.absorbed.display_name;
    return {
      id: r.id,
      mergedAt: r.merged_at,
      undoUntil: r.undo_until,
      joined: {
        email: typeof email === "string" ? email : null,
        name: typeof name === "string" ? name : null,
      },
    };
  });
}

function parseSnapshot(raw: string | null): MergeSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MergeSnapshot;
    return parsed && parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export type UndoResult =
  | { ok: true; restoredAccountId: string }
  | {
      ok: false;
      error: "step_up_required" | "not_found" | "last_link";
    };

/**
 * Whether undoing would orphan an account: the survivor keeps no method outside `moved`, or no
 * method in `moved` is still on the survivor (the absorbed account would come back with none).
 */
async function undoWouldOrphan(
  db: Db,
  survivorId: string,
  moved: string[],
): Promise<boolean> {
  const row = await db.first<{ kept: number; back: number }>(
    `SELECT
       (SELECT COUNT(*) FROM account_links
         WHERE account_id = ? AND id NOT IN (SELECT value FROM json_each(?))) AS kept,
       (SELECT COUNT(*) FROM account_links
         WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))) AS back`,
    survivorId,
    JSON.stringify(moved),
    survivorId,
    JSON.stringify(moved),
  );
  return !row || row.kept === 0 || row.back === 0;
}

function insertRow(
  table: string,
  cols: readonly string[],
  row: Row,
  orIgnore = true,
): DbStatement {
  return {
    sql: `INSERT${orIgnore ? " OR IGNORE" : ""} INTO ${table} (${cols.join(", ")})
          VALUES (${cols.map(() => "?").join(", ")})`,
    params: cols.map((c) => row[c] ?? null),
  };
}

/**
 * Undo the join `mergeId` for the survivor `proof` names, inside its window. The restored
 * account's id is INTERNAL (Identity only), like every account id.
 */
export async function undoMerge(
  ctx: AccountContext,
  proof: AccountProof,
  mergeId: string,
): Promise<UndoResult> {
  const { db, env, now } = ctx;
  if (!isFresh(proof, now)) return { ok: false, error: "step_up_required" };
  const merge = await db.first<{
    id: string;
    survivor_id: string;
    absorbed_id: string;
    undo_until: number;
    undone_at: number | null;
    snapshot_json: string | null;
  }>("SELECT * FROM account_merges WHERE id = ?", mergeId);
  if (
    !merge ||
    merge.survivor_id !== proof.accountId ||
    merge.undone_at !== null ||
    merge.undo_until <= now
  ) {
    return { ok: false, error: "not_found" };
  }
  const snap = parseSnapshot(merge.snapshot_json);
  const S = merge.survivor_id;
  const A = merge.absorbed_id;
  const survivor = await getAccountRow(db, S);
  if (!snap || !survivor || survivor.status !== "active") {
    return { ok: false, error: "not_found" };
  }
  // The absorbed id must still be this join's tombstone (and not an account again).
  const tomb = await db.first<{ merged_into: string | null }>(
    "SELECT merged_into FROM account_tombstones WHERE id = ?",
    A,
  );
  if ((await getAccountRow(db, A)) || tomb?.merged_into !== S) {
    return { ok: false, error: "not_found" };
  }

  // Never orphan either side (a fast refusal; the guard at the head of the batch is the
  // authority). A method removed since the join stays removed: only what is still on the
  // survivor under its own id goes back.
  const moved = new Set(snap.links);
  if (await undoWouldOrphan(db, S, [...moved])) {
    return { ok: false, error: "last_link" };
  }

  // Claim the undo: of two racing undos, one passes this.
  const claimed = await db.runChanges(
    "UPDATE account_merges SET undone_at = ? WHERE id = ? AND undone_at IS NULL",
    now,
    mergeId,
  );
  if (claimed === 0) return { ok: false, error: "not_found" };

  const stmts: DbStatement[] = [];
  stmts.push(
    // The never-orphan guard, atomic with the undo: when the survivor would keep no method of
    // its own, or no moved method is still on it, this inserts a row with a NULL in a NOT NULL
    // column and the whole batch aborts (a removal racing the undo cannot orphan either side).
    {
      sql: `INSERT INTO account_merges (id, survivor_id, absorbed_id, merged_at, undo_until)
            SELECT ?, NULL, NULL, 0, 0
             WHERE NOT EXISTS (SELECT 1 FROM account_links
                                WHERE account_id = ?
                                  AND id NOT IN (SELECT value FROM json_each(?)))
                OR NOT EXISTS (SELECT 1 FROM account_links
                                WHERE account_id = ?
                                  AND id IN (SELECT value FROM json_each(?)))`,
      params: [
        `${mergeId}:guard`,
        S,
        JSON.stringify([...moved]),
        S,
        JSON.stringify([...moved]),
      ],
    },
    // A plain INSERT: the id was checked free above, and a failure must fail the whole batch.
    insertRow(
      "accounts",
      ACCOUNT_COLUMNS,
      { ...snap.absorbed, id: A, status: "active", modified_at: now },
      false,
    ),
    {
      sql: "DELETE FROM account_tombstones WHERE id = ? AND merged_into = ?",
      params: [A, S],
    },
    {
      sql: `UPDATE account_links SET account_id = ?
             WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))`,
      params: [A, S, JSON.stringify([...moved])],
    },
    // The restored primary email must be an address one of the absorbed account's own methods
    // still carries (verified, if the primary is): one disconnected during the window, perhaps
    // another account's since, gives way to the oldest verified address its methods carry, an
    // email method first, or to none.
    {
      sql: `UPDATE accounts SET
              primary_email = (SELECT email FROM account_links
                                WHERE account_id = ? AND email IS NOT NULL AND email_verified = 1
                                ORDER BY issuer_key = ? DESC, created_at, id LIMIT 1),
              primary_email_verified_at = (SELECT created_at FROM account_links
                                WHERE account_id = ? AND email IS NOT NULL AND email_verified = 1
                                ORDER BY issuer_key = ? DESC, created_at, id LIMIT 1)
            WHERE id = ? AND primary_email IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM account_links l
                               WHERE l.account_id = ? AND l.email = accounts.primary_email
                                 AND (l.email_verified = 1
                                      OR accounts.primary_email_verified_at IS NULL))`,
      params: [A, EMAIL_ISSUER, A, EMAIL_ISSUER, A, A],
    },
  );
  stmts.push({
    sql: `UPDATE account_passkeys SET account_id = ?
           WHERE account_id = ? AND credential_id IN (SELECT value FROM json_each(?))`,
    params: [A, S, JSON.stringify(snap.passkeys)],
  });
  for (const [product, id] of snap.licenses) {
    stmts.push({
      sql: "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ? AND account_id = ?",
      params: [A, product, id, S],
    });
  }
  stmts.push(
    {
      sql: `UPDATE account_sessions SET account_id = ?
             WHERE account_id = ? AND id_hash IN (SELECT value FROM json_each(?))`,
      params: [A, S, JSON.stringify(snap.sessions)],
    },
    {
      sql: `UPDATE account_avatars SET account_id = ?
             WHERE account_id = ? AND asset IN (SELECT value FROM json_each(?))`,
      params: [A, S, JSON.stringify(snap.avatars)],
    },
  );
  for (const [product, tokenId] of snap.registryTokens) {
    stmts.push({
      sql: `UPDATE registry_tokens SET portal_account_id = ?
             WHERE product = ? AND token_id = ? AND portal_account_id = ?`,
      params: [A, product, tokenId, S],
    });
  }
  for (const [product, id] of snap.relinksFrom) {
    stmts.push({
      sql: `UPDATE license_relinks SET from_account_id = ?
             WHERE product = ? AND id = ? AND from_account_id = ?`,
      params: [A, product, id, S],
    });
  }
  for (const [product, id] of snap.relinksTo) {
    stmts.push({
      sql: `UPDATE license_relinks SET to_account_id = ?
             WHERE product = ? AND id = ? AND to_account_id = ?`,
      params: [A, product, id, S],
    });
  }
  // Consents and terms: the absorbed account's rows come back only while the survivor still
  // holds one for the same product (and version), so a consent withdrawn, a product deleted or
  // terms whose acceptance went during the window never return; the copies the survivor took
  // (where it had none of its own) go, unless changed since. Each restore runs before that
  // delete. Auto-attach blocks come back whatever happened since: a block the survivor lifted
  // returns on the absorbed account, the cautious direction.
  for (const g of snap.grants) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO account_product_grants
              (account_id, product, claims_json, granted_at, modified_at, scope_hash)
            SELECT ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM account_product_grants
                            WHERE account_id = ? AND product = ?)`,
      params: [
        A,
        g.product,
        g.claims_json,
        g.granted_at,
        g.modified_at,
        g.scope_hash,
        S,
        g.product,
      ],
    });
    if (snap.grantsAdded.includes(String(g.product))) {
      stmts.push({
        sql: `DELETE FROM account_product_grants
               WHERE account_id = ? AND product = ? AND granted_at = ? AND modified_at = ?`,
        params: [S, g.product, g.granted_at, g.modified_at],
      });
    }
  }
  const termsAdded = new Set(snap.termsAdded.map(([p, v]) => `${p}\u0000${v}`));
  for (const t of snap.terms) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO account_terms_acceptances
              (account_id, product, version, url, accepted_at)
            SELECT ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM account_terms_acceptances
                            WHERE account_id = ? AND product = ? AND version = ?)`,
      params: [
        A,
        t.product,
        t.version,
        t.url,
        t.accepted_at,
        S,
        t.product,
        t.version,
      ],
    });
    if (termsAdded.has(`${t.product}\u0000${t.version}`)) {
      stmts.push({
        sql: `DELETE FROM account_terms_acceptances
               WHERE account_id = ? AND product = ? AND version = ? AND accepted_at = ?`,
        params: [S, t.product, t.version, t.accepted_at],
      });
    }
  }
  const blocksAdded = new Set(
    snap.blocksAdded.map(([p, l]) => `${p}\u0000${l}`),
  );
  for (const b of snap.blocks) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO license_auto_attach_blocks
              (product, license_id, account_id, created_at)
            VALUES (?, ?, ?, ?)`,
      params: [b.product, b.license_id, A, b.created_at],
    });
    if (blocksAdded.has(`${b.product}\u0000${b.license_id}`)) {
      stmts.push({
        sql: `DELETE FROM license_auto_attach_blocks
               WHERE product = ? AND license_id = ? AND account_id = ? AND created_at = ?`,
        params: [b.product, b.license_id, S, b.created_at],
      });
    }
  }
  // PS-04's library entries, as the consents: the absorbed account's come back only while the
  // survivor still holds an entry for the product (one removed, or a product deleted, during the
  // window never returns); the copies the survivor took (where it had none of its own) go,
  // unless changed since.
  const libraryAdded = new Set(snap.libraryAdded ?? []);
  for (const e of snap.library ?? []) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO library_entries (account_id, product, via, added_at)
            SELECT ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM library_entries
                            WHERE account_id = ? AND product = ?)`,
      params: [A, e.product, e.via, e.added_at, S, e.product],
    });
    if (libraryAdded.has(String(e.product))) {
      stmts.push({
        sql: `DELETE FROM library_entries
               WHERE account_id = ? AND product = ? AND added_at = ?`,
        params: [S, e.product, e.added_at],
      });
    }
  }
  // Details the survivor took from the absorbed account, cleared where unchanged since.
  for (const col of FILLED_COLUMNS) {
    const before = snap.survivorBefore[col];
    const taken = snap.absorbed[col];
    if (before !== null || taken === null || taken === undefined) continue;
    stmts.push(
      col === "primary_email"
        ? {
            sql: `UPDATE accounts SET primary_email = NULL, primary_email_verified_at = NULL
                   WHERE id = ? AND primary_email = ?`,
            params: [S, taken],
          }
        : col === "birthdate"
          ? {
              // The pair goes back together, and only while the survivor still holds exactly
              // what the join filled in.
              sql: `UPDATE accounts SET birthdate = NULL, birthdate_source = NULL
                     WHERE id = ? AND birthdate = ? AND birthdate_source IS ?`,
              params: [S, taken, snap.absorbed.birthdate_source ?? null],
            }
          : col === "passkey_user_handle"
            ? {
                // Kept while the survivor holds a passkey created under it during the window (the
                // moved ones have left by now), so its authenticator keeps one entry.
                sql: `UPDATE accounts SET passkey_user_handle = NULL
                     WHERE id = ? AND passkey_user_handle = ?
                       AND NOT EXISTS (SELECT 1 FROM account_passkeys
                                        WHERE account_id = ? AND user_handle = ?)`,
                params: [S, taken, S, taken],
              }
            : {
                sql: `UPDATE accounts SET ${col} = NULL WHERE id = ? AND ${col} = ?`,
                params: [S, taken],
              },
    );
  }
  // A subject that moved over whole goes back; an aliased one stays the survivor's alias.
  for (const s of snap.subjects) {
    if (s.aliasOf !== null) continue;
    stmts.push({
      sql: `UPDATE account_product_subjects SET account_id = ?
             WHERE account_id = ? AND product = ? AND subject = ?`,
      params: [A, S, s.product, s.subject],
    });
  }
  stmts.push(
    {
      sql: "UPDATE account_merges SET snapshot_json = NULL WHERE id = ?",
      params: [mergeId],
    },
    {
      sql: `INSERT INTO portal_audit (id, account_id, at, action, product, target_kind, target_id, summary)
            VALUES (?, ?, ?, 'account.merge.undo', NULL, 'account', ?, ?)`,
      params: [
        randomId("paud"),
        S,
        now,
        A,
        "Separated an account joined into this one",
      ],
    },
    {
      sql: `INSERT INTO portal_audit (id, account_id, at, action, product, target_kind, target_id, summary)
            VALUES (?, ?, ?, 'account.merge.undo', NULL, 'account', ?, ?)`,
      params: [
        randomId("paud"),
        A,
        now,
        S,
        "Separated from the account it was joined into",
      ],
    },
  );
  try {
    await db.batch(stmts);
  } catch (err) {
    // Nothing applied: the join stays undoable.
    await db.run(
      "UPDATE account_merges SET undone_at = NULL WHERE id = ? AND undone_at = ?",
      mergeId,
      now,
    );
    // The guard tripped: a method went between the check above and the batch.
    if (await undoWouldOrphan(db, S, [...moved])) {
      return { ok: false, error: "last_link" };
    }
    throw err;
  }

  // F-21: a licence that went back stops every registry token the survivor minted on it during
  // the window (the absorbed account's own tokens moved back above, untouched), and its devices'
  // bindings to the survivor go; each binds again at its next sign-in.
  for (const [product, id] of snap.licenses) {
    const owner = await db.first<{ account_id: string | null }>(
      "SELECT account_id FROM licenses WHERE product = ? AND id = ?",
      product,
      id,
    );
    if (owner?.account_id !== A) continue;
    await onLicenseOwnershipEnded(db, env, {
      product,
      licenseId: id,
      accountId: S,
      reason: "relinked",
      now,
    });
    await clearDeviceSubjects(
      db,
      env,
      { kind: "license", product, licenseId: id },
      "merge_undone",
    );
  }

  // Bindings to a subject that changed hands go; each device binds again at its next sign-in.
  for (const s of snap.subjects) {
    const recorded = new Set(s.devices);
    const bound = await db.all<{ device_id: string; subject: string }>(
      `SELECT device_id, subject FROM devices
        WHERE product = ? AND subject IS NOT NULL AND subject IN (?, ?)`,
      s.product,
      s.subject,
      s.aliasOf ?? s.subject,
    );
    for (const d of bound) {
      // Aliased: the absorbed account's devices were re-keyed onto the survivor's subject.
      // Moved over: a device the survivor bound to the subject since the join.
      const stale =
        s.aliasOf !== null
          ? d.subject === s.aliasOf && recorded.has(d.device_id)
          : d.subject === s.subject && !recorded.has(d.device_id);
      if (!stale) continue;
      await clearDeviceSubjects(
        db,
        env,
        { kind: "device", product: s.product, deviceId: d.device_id },
        "merge_undone",
      );
    }
  }

  const restored = await getAccountRow(db, A);
  const recipients = [
    ...new Set([
      ...(await securityNoticeRecipients(db, S, survivor.primary_email)),
      ...(await securityNoticeRecipients(db, A, restored?.primary_email)),
    ]),
  ];
  const message = accountsSeparatedNotice({ origin: ctx.origin });
  for (const to of recipients) {
    // A notice that does not go out never undoes the undo (it already committed).
    await sendNotice(env, db, to, message, now).catch(() => false);
  }
  return { ok: true, restoredAccountId: A };
}

/** The nightly job: a join whose window ended keeps no snapshot (it holds personal details). */
export async function pruneAccountMerges(db: Db, now: number): Promise<number> {
  return db.runChanges("DELETE FROM account_merges WHERE undo_until <= ?", now);
}

/** Account deletion: the survivor's join records (and their snapshots) go with it. */
export function stmtDeleteAccountMerges(accountId: string): DbStatement {
  return {
    sql: "DELETE FROM account_merges WHERE survivor_id = ? OR absorbed_id = ?",
    params: [accountId, accountId],
  };
}
