/**
 * `signIn(verifiedIdentity)` (I-05; S-16 §5.1): the one door every front door ends in.
 *
 * A front door (the portal's OIDC callback and magic link today; the login card's providers,
 * passkeys and email code with I-06/I-07/I-16; passthrough sign-in with I-08/I-13/I-15) verifies a
 * credential its own way and hands the result here as a `VerifiedIdentity`. This function alone
 * decides which account that is:
 *
 *   - a known link signs in to its account (an absorbed account's links moved with the merge);
 *   - an unknown identity whose verified email another account already uses is a JOIN OFFER and
 *     writes nothing: "never by email match" (owner, 2026-10-04). The login card (I-07) offers to
 *     join, the person proves the other account in the same session, and `linkIdentity` or
 *     `mergeAccounts` completes it;
 *   - otherwise a new account is created, with the identity as its first link. No account row
 *     exists before this point (S-16 §5.5).
 *
 * A tenant-scoped identity (Apple's per-team id, Game Center's teamPlayerID, a PGS or EOS id) is
 * recognised only inside a product of that scope (S-16 §5.4 item 16): the lookup is exact on
 * `(issuer_key, tenant_scope, subject)`, and the product context must list the scope.
 *
 * Nothing here reads the product's Identity toggle: the account is platform-level. Only the
 * routes that reach `signIn` THROUGH a product (I-08, I-09, I-13, I-15) check the toggle.
 */

import { subjectFor } from "../../../core/accountSubjects.js";
import type { Db } from "../../../core/platform.js";
import { portalAudit } from "../portal/repo.js";
import {
  EMAIL_ISSUER,
  accountUsingEmail,
  findLink,
  getAccountRow,
  insertAccount,
  insertLink,
  normalizeEmail,
  resolveAccount,
  touchAccountSignIn,
  touchLink,
  type AccountRow,
} from "./repo.js";

/** A credential a front door has already verified. */
export interface VerifiedIdentity {
  /** The issuer URL for OIDC, `email` for an email method, a provider kind otherwise. */
  issuerKey: string;
  /** `''`/absent for a global subject; the team, game or deployment for a tenant-scoped one. */
  tenantScope?: string;
  subject: string;
  /** `oidc`, `email`, `google`, `apple`, `steam`, `passkey`, `gamecenter`, `pgs`, `eos`, … */
  kind: string;
  email?: string | null;
  /** True only when the provider asserted it (or the email method proved it). */
  emailVerified?: boolean;
  displayName?: string | null;
  amr?: readonly string[];
}

/** The product a sign-in comes through, when it comes through one. */
export interface SignInProduct {
  slug: string;
  /** The tenant scopes this product's tenant-scoped identities may carry (I-13/I-14 fill it). */
  tenantScopes?: readonly string[];
}

export type SignInResult =
  | {
      status: "signed_in";
      /** INTERNAL: Identity and Core only. */
      account: AccountRow;
      created: boolean;
      linkId: string;
      /** The pairwise subject for `product`, when the sign-in came through one. */
      subject: string | null;
    }
  | {
      status: "join_offer";
      /** INTERNAL: the account that already uses the email. Never shown to anyone. */
      existingAccountId: string;
      email: string;
    }
  | {
      status: "refused";
      reason: "invalid_identity" | "account_disabled" | "tenant_scope_mismatch";
    };

/** The identity with its defaults applied, or `null` when it is unusable. */
export function normalizeIdentity(
  identity: VerifiedIdentity,
): (Required<Omit<VerifiedIdentity, "amr">> & { amr: readonly string[] }) | null {
  const issuerKey = identity.issuerKey.trim();
  const subject = identity.subject.trim();
  if (!issuerKey || !subject || !identity.kind) return null;
  const isEmailMethod = identity.kind === "email";
  if (isEmailMethod && issuerKey !== EMAIL_ISSUER) return null;
  const email = isEmailMethod
    ? normalizeEmail(subject)
    : identity.email
      ? normalizeEmail(identity.email)
      : null;
  return {
    issuerKey,
    tenantScope: (identity.tenantScope ?? "").trim(),
    subject: isEmailMethod ? normalizeEmail(subject) : subject,
    kind: identity.kind,
    email,
    // An email method IS proof of its address; anything else carries the provider's assertion.
    emailVerified: isEmailMethod ? true : Boolean(identity.emailVerified && email),
    displayName: identity.displayName?.trim() || null,
    amr: identity.amr ?? [],
  };
}

export async function signIn(
  db: Db,
  identity: VerifiedIdentity,
  now: number,
  opts: { product?: SignInProduct } = {},
): Promise<SignInResult> {
  const id = normalizeIdentity(identity);
  if (!id) return { status: "refused", reason: "invalid_identity" };
  if (
    id.tenantScope !== "" &&
    !(opts.product?.tenantScopes ?? []).includes(id.tenantScope)
  ) {
    return { status: "refused", reason: "tenant_scope_mismatch" };
  }

  const key = {
    issuerKey: id.issuerKey,
    tenantScope: id.tenantScope,
    subject: id.subject,
  };
  const existing = await findLink(db, key);
  if (existing) {
    const account = await resolveAccount(db, existing.account_id, now);
    if (!account) return { status: "refused", reason: "invalid_identity" };
    if (account.status !== "active") {
      return { status: "refused", reason: "account_disabled" };
    }
    await touchLink(
      db,
      existing.id,
      {
        email: id.kind === "email" ? null : id.email,
        emailVerified: id.emailVerified,
        displayName: id.displayName,
      },
      now,
    );
    await touchAccountSignIn(db, account.id, now);
    await portalAudit(db, {
      accountId: account.id,
      action: "account.signin",
      targetKind: "link",
      targetId: existing.id,
      summary: `Signed in with ${id.kind}`,
      now,
    });
    return {
      status: "signed_in",
      account,
      created: false,
      linkId: existing.id,
      subject: opts.product
        ? await subjectFor(db, account.id, opts.product.slug, now)
        : null,
    };
  }

  // Never by email match: an address another account uses stops here, writing nothing.
  if (id.email && id.emailVerified) {
    const other = await accountUsingEmail(db, id.email);
    if (other) {
      return { status: "join_offer", existingAccountId: other, email: id.email };
    }
  }

  const account = await insertAccount(
    db,
    {
      primaryEmail: id.emailVerified ? id.email : null,
      primaryEmailVerified: id.emailVerified,
      displayName: id.displayName,
    },
    now,
  );
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
  if (!inserted) {
    // A concurrent first sign-in with the same identity won the UNIQUE key: drop the empty
    // account this attempt made and sign in to the one that holds the link.
    await db.run("DELETE FROM accounts WHERE id = ?", account.id);
    return signIn(db, identity, now, opts);
  }
  // A provider-verified address also becomes the account's email sign-in method (the owner's
  // provider-verified fast path, S-16 header): the same address that is now its primary email.
  if (id.kind !== "email" && id.email && id.emailVerified) {
    await insertLink(
      db,
      account.id,
      {
        issuerKey: EMAIL_ISSUER,
        tenantScope: "",
        subject: id.email,
        kind: "email",
        email: id.email,
        emailVerified: true,
        displayName: null,
        amr: null,
      },
      now,
    );
  }
  await portalAudit(db, {
    accountId: account.id,
    action: "account.create",
    targetKind: "account",
    targetId: account.id,
    summary: `Account created by a ${id.kind} sign-in`,
    now,
  });
  const fresh = (await getAccountRow(db, account.id)) ?? account;
  const link = await findLink(db, key);
  return {
    status: "signed_in",
    account: fresh,
    created: true,
    linkId: link?.id ?? "",
    subject: opts.product
      ? await subjectFor(db, account.id, opts.product.slug, now)
      : null,
  };
}
