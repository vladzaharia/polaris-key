/**
 * The passkey rows (I-16; S-16 §5.1 `account_passkeys`): one row per WebAuthn credential, on the
 * console host's RP id (`key.plrs.im` in production), TWINNED with a sign-in method in
 * `account_links` (`issuer_key = 'passkey'`, `subject` = the credential id, `kind = 'passkey'`).
 *
 * Why two rows. The link makes a passkey a sign-in method like any other, so I-05's link engine
 * applies to it unchanged: one account per credential (the links' UNIQUE key), the last-method
 * guard inside the DELETE, step-up, the audit row and the notice, the nudge's method count, merge
 * and deletion. The passkey row holds what only WebAuthn needs: the COSE public key, the signature
 * counter, the transports, the RP id and the user handle it was created under. Both rows are
 * written in ONE batch; removal deletes the link first (under the guard) and then the passkey row
 * (`links.ts`, `mirrorLinkRemoval`), and a passkey row whose link is gone is inert: sign-in
 * refuses it and the settings list does not show it.
 *
 * The account id is INTERNAL (Identity and Core). Nothing here hands it out; the credential id
 * and the user handle are not derived from it.
 */

import { randomId, type Db } from "../../../core/platform.js";
import { randomSecret } from "../portal/accountSessions.js";
import { PASSKEY_ISSUER } from "../accounts/repo.js";

/** Passkeys one account may hold. Rate limits bound how fast they are added; this bounds rows. */
export const MAX_PASSKEYS_PER_ACCOUNT = 20;

/** The transports a browser may report (WebAuthn Level 3); anything else is dropped. */
const TRANSPORTS = new Set([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

export interface PasskeyRow {
  credential_id: string;
  account_id: string;
  /** The credential's COSE public key, base64url. */
  public_key: string;
  sign_count: number;
  transports_json: string | null;
  rp_id: string;
  /** The account's user handle when this passkey was created (base64url). */
  user_handle: string;
  created_at: number;
  last_used_at: number | null;
  /** `PasskeyDetails` as JSON; NULL on a row read before the column existed. */
  details_json?: string | null;
}

/** Display facts about a passkey (`details_json`). Never read by verification. */
export interface PasskeyDetails {
  aaguid?: string;
  deviceType?: "singleDevice" | "multiDevice";
  backedUp?: boolean;
  addedFrom?: string | null;
}

export function parseDetails(raw: string | null | undefined): PasskeyDetails {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as PasskeyDetails)
      : {};
  } catch {
    return {};
  }
}

/** The transports a row stored, filtered to the known set. */
export function parseTransports(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v)
      ? v.filter((t): t is string => typeof t === "string" && TRANSPORTS.has(t))
      : [];
  } catch {
    return [];
  }
}

/** A browser's reported transports, filtered to the known set and de-duplicated. */
export function cleanTransports(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter(
        (t): t is string => typeof t === "string" && TRANSPORTS.has(t),
      ),
    ),
  ];
}

export async function findPasskey(
  db: Db,
  credentialId: string,
): Promise<PasskeyRow | null> {
  return db.first<PasskeyRow>(
    "SELECT * FROM account_passkeys WHERE credential_id = ?",
    credentialId,
  );
}

/** The account's passkeys that are sign-in methods (their link exists), oldest first. */
export async function listAccountPasskeys(
  db: Db,
  accountId: string,
): Promise<Array<PasskeyRow & { link_id: string }>> {
  return db.all<PasskeyRow & { link_id: string }>(
    `SELECT p.*, l.id AS link_id
       FROM account_passkeys p
       JOIN account_links l
         ON l.issuer_key = ? AND l.tenant_scope = '' AND l.subject = p.credential_id
        AND l.account_id = p.account_id
      WHERE p.account_id = ?
      ORDER BY p.created_at, p.credential_id`,
    PASSKEY_ISSUER,
    accountId,
  );
}

/**
 * The account's WebAuthn user handle: 32 random bytes (base64url), minted on first use and kept,
 * so every passkey the person adds lands under ONE "Polaris Key" entry in their authenticator.
 * The conditional write makes two concurrent first uses agree on one value.
 */
export async function accountUserHandle(
  db: Db,
  accountId: string,
): Promise<string | null> {
  await db.run(
    `UPDATE accounts SET passkey_user_handle = ?
      WHERE id = ? AND passkey_user_handle IS NULL`,
    randomSecret(32),
    accountId,
  );
  const row = await db.first<{ passkey_user_handle: string | null }>(
    "SELECT passkey_user_handle FROM accounts WHERE id = ?",
    accountId,
  );
  return row?.passkey_user_handle ?? null;
}

export interface NewPasskey {
  accountId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  rpId: string;
  userHandle: string;
  details: PasskeyDetails;
}

/**
 * Store a verified passkey and its sign-in method in one batch. Plain INSERTs, never REPLACE: a
 * credential id another account already holds (an authenticator can choose its own ids) fails the
 * whole batch, so it can never overwrite someone's key. Answers the new link's id, or `conflict`.
 */
export async function insertPasskey(
  db: Db,
  input: NewPasskey,
  now: number,
): Promise<{ linkId: string } | "conflict"> {
  const linkId = randomId("lnk");
  try {
    await db.batch([
      {
        sql: `INSERT INTO account_passkeys
                (credential_id, account_id, public_key, sign_count, transports_json, rp_id,
                 user_handle, created_at, last_used_at, details_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        params: [
          input.credentialId,
          input.accountId,
          input.publicKey,
          input.counter,
          JSON.stringify(input.transports),
          input.rpId,
          input.userHandle,
          now,
          JSON.stringify(input.details),
        ],
      },
      {
        sql: `INSERT INTO account_links
                (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified,
                 display_name, amr_json, created_at, last_used_at)
              VALUES (?, ?, ?, '', ?, 'passkey', NULL, 0, NULL, ?, ?, ?)`,
        params: [
          linkId,
          input.accountId,
          PASSKEY_ISSUER,
          input.credentialId,
          JSON.stringify(["passkey"]),
          now,
          now,
        ],
      },
    ]);
  } catch (e) {
    // A UNIQUE / PRIMARY KEY violation rolled the batch back; anything else is a real failure.
    const held =
      (await findPasskey(db, input.credentialId)) ??
      (await db.first(
        "SELECT id FROM account_links WHERE issuer_key = ? AND tenant_scope = '' AND subject = ?",
        PASSKEY_ISSUER,
        input.credentialId,
      ));
    if (held) return "conflict";
    throw e;
  }
  return { linkId };
}

/**
 * Record a verified sign-in: the new signature counter, the backup flags and the time. A
 * compare-and-set on the counter the assertion was checked against, so of two assertions racing
 * on one counter value (a cloned authenticator) at most one is accepted. Synced passkeys report 0
 * every time and are unaffected. False when the row changed underneath (refuse the sign-in).
 */
export async function recordPasskeyUse(
  db: Db,
  row: PasskeyRow,
  use: {
    counter: number;
    deviceType: "singleDevice" | "multiDevice";
    backedUp: boolean;
  },
  now: number,
): Promise<boolean> {
  const details: PasskeyDetails = {
    ...parseDetails(row.details_json),
    deviceType: use.deviceType,
    backedUp: use.backedUp,
  };
  const changed = await db.runChanges(
    `UPDATE account_passkeys
        SET sign_count = ?, last_used_at = ?, details_json = ?
      WHERE credential_id = ? AND account_id = ? AND sign_count = ?`,
    use.counter,
    now,
    JSON.stringify(details),
    row.credential_id,
    row.account_id,
    row.sign_count,
  );
  return changed > 0;
}
