/**
 * The link engine (I-05; S-16 §5.1 "Rules"; THREAT-MODEL item 3, linking takeover).
 *
 *   - One link belongs to exactly one account: a link held elsewhere is refused (`link_conflict`),
 *     and the caller offers to sign in to that account or merge (never moves it).
 *   - Never orphan: removing the last sign-in method is refused (`last_link`).
 *   - Connect and disconnect under step-up: a sign-in no older than 5 minutes.
 *   - Every change is audited and emailed to every verified address on the account.
 *
 * The portal UI for these is I-11's; the login card's join offer (I-07) uses `linkIdentity` with
 * the proof it collected in the same session.
 */

import type { Db, Env } from "../../../core/platform.js";
import { onAccountEmailVerified } from "../../../core/licenseHolders.js";
import { portalAudit } from "../portal/repo.js";
import { sendSecurityNotice } from "../portal/email.js";
import {
  signInMethodAddedNotice,
  signInMethodRemovedNotice,
} from "../portal/notices.js";
import { normalizeIdentity, type VerifiedIdentity } from "./signIn.js";
import {
  EMAIL_ISSUER,
  PASSKEY_ISSUER,
  findLink,
  getAccountRow,
  insertLink,
  type AccountLinkRow,
} from "./repo.js";

/** Step-up: connect, disconnect and merge need a sign-in no older than this (owner). */
export const STEP_UP_MAX_AGE_SECONDS = 5 * 60;

export interface AccountContext {
  db: Db;
  env: Env;
  now: number;
  /** The portal origin notices link to. */
  origin: string;
}

/** Proof that the person signed in to `accountId` at `authenticatedAt` (unix seconds). */
export interface AccountProof {
  accountId: string;
  authenticatedAt: number;
}

export function isFresh(proof: AccountProof, now: number): boolean {
  return (
    proof.authenticatedAt <= now + 60 &&
    now - proof.authenticatedAt <= STEP_UP_MAX_AGE_SECONDS
  );
}

/** A sign-in method by its own name, for a notice: "Google", "A passkey", an address. */
export function methodLabel(link: {
  kind: string;
  email: string | null;
  subject: string;
}): string {
  switch (link.kind) {
    case "email":
      return link.email ?? link.subject;
    case "google":
      return "Google";
    case "apple":
      return "Apple";
    case "steam":
      return "Steam";
    case "passkey":
      return "A passkey";
    case "gamecenter":
      return "Game Center";
    case "pgs":
      return "Google Play Games";
    case "eos":
      return "Epic Online Services";
    case "oidc":
      return "Single sign-on";
    default:
      return "A sign-in method";
  }
}

export type LinkResult =
  | { ok: true; link: AccountLinkRow; already: boolean }
  | {
      ok: false;
      error: "step_up_required" | "link_conflict" | "bad_request" | "not_found";
    };

/**
 * Connect `identity` to the account `proof` names. The identity was verified by the caller's own
 * flow just now; `proof` is the account's step-up (a fresh sign-in). A link already on this
 * account is idempotent; one on another account is `link_conflict` and nothing moves.
 */
export async function linkIdentity(
  ctx: AccountContext,
  proof: AccountProof,
  identity: VerifiedIdentity,
): Promise<LinkResult> {
  const { db, now } = ctx;
  if (!isFresh(proof, now)) return { ok: false, error: "step_up_required" };
  const id = normalizeIdentity(identity);
  if (!id) return { ok: false, error: "bad_request" };
  const account = await getAccountRow(db, proof.accountId);
  if (!account || account.status !== "active") {
    return { ok: false, error: "not_found" };
  }
  const key = {
    issuerKey: id.issuerKey,
    tenantScope: id.tenantScope,
    subject: id.subject,
  };
  const held = await findLink(db, key);
  if (held) {
    return held.account_id === account.id
      ? { ok: true, link: held, already: true }
      : { ok: false, error: "link_conflict" };
  }
  const inserted = await insertLink(
    db,
    account.id,
    {
      ...key,
      kind: id.kind,
      email: id.email,
      emailVerified: id.emailVerified,
      displayName: id.displayName,
      amr: id.amr,
    },
    now,
  );
  const link = await findLink(db, key);
  if (!inserted || !link || link.account_id !== account.id) {
    // Lost a race to another account's insert: the UNIQUE key decided, and it is not ours.
    return { ok: false, error: "link_conflict" };
  }
  await portalAudit(db, {
    accountId: account.id,
    action: "account.link.add",
    targetKind: "link",
    targetId: link.id,
    summary: `Connected ${id.kind}`,
    now,
  });
  // LX-26 (S-24 §5.4): a newly verified address brings the licences waiting on it.
  if (id.email && id.emailVerified)
    await onAccountEmailVerified(db, account.id, id.email, now);
  await sendSecurityNotice(
    ctx.env,
    db,
    account.id,
    account.primary_email,
    signInMethodAddedNotice({ method: methodLabel(link), origin: ctx.origin }),
    now,
  );
  return { ok: true, link, already: false };
}

export type UnlinkResult =
  | { ok: true }
  | { ok: false; error: "step_up_required" | "last_link" | "not_found" };

/**
 * Disconnect one sign-in method. Refused when it is the account's last (`last_link`): the guard
 * is inside the DELETE, so two concurrent removals of the last two methods cannot both succeed.
 * The matching `portal_*` row goes too, so a Worker rollback never resurrects a removed method.
 */
export async function unlinkIdentity(
  ctx: AccountContext,
  proof: AccountProof,
  linkId: string,
): Promise<UnlinkResult> {
  const { db, now } = ctx;
  if (!isFresh(proof, now)) return { ok: false, error: "step_up_required" };
  const link = await db.first<AccountLinkRow>(
    "SELECT * FROM account_links WHERE id = ? AND account_id = ?",
    linkId,
    proof.accountId,
  );
  if (!link) return { ok: false, error: "not_found" };
  const removed = await db.runChanges(
    `DELETE FROM account_links
      WHERE id = ? AND account_id = ?
        AND (SELECT COUNT(*) FROM account_links WHERE account_id = ?) > 1`,
    linkId,
    proof.accountId,
    proof.accountId,
  );
  if (removed === 0) return { ok: false, error: "last_link" };
  await mirrorLinkRemoval(db, link);
  await portalAudit(db, {
    accountId: proof.accountId,
    action: "account.link.remove",
    targetKind: "link",
    targetId: link.id,
    summary: `Disconnected ${link.kind}`,
    now,
  });
  const account = await getAccountRow(db, proof.accountId);
  await sendSecurityNotice(
    ctx.env,
    db,
    proof.accountId,
    // The removed address hears about it too: it was a way in until a moment ago.
    link.kind === "email" ? link.subject : account?.primary_email,
    signInMethodRemovedNotice({
      method: methodLabel(link),
      origin: ctx.origin,
    }),
    now,
  );
  return { ok: true };
}

/** Keep the pre-I-05 `portal_*` tables from resurrecting a removed method on a rollback, and a
 *  removed passkey's WebAuthn material from outliving its method (I-16). */
async function mirrorLinkRemoval(db: Db, link: AccountLinkRow): Promise<void> {
  if (link.issuer_key === PASSKEY_ISSUER) {
    await db.run(
      "DELETE FROM account_passkeys WHERE credential_id = ? AND account_id = ?",
      link.subject,
      link.account_id,
    );
    return;
  }
  if (link.issuer_key === EMAIL_ISSUER) {
    await db.run(
      "DELETE FROM portal_account_emails WHERE email = ? AND account_id = ?",
      link.subject,
      link.account_id,
    );
    return;
  }
  if (link.tenant_scope === "") {
    await db.run(
      "DELETE FROM portal_account_identities WHERE provider = ? AND subject = ? AND account_id = ?",
      link.issuer_key,
      link.subject,
      link.account_id,
    );
  }
}
