/**
 * Moving `provider: platform` end users off the platform IdP (I-17; S-16 §3.1, §5.4 items 1 and
 * 11, §8 I-17, §9 risk 11; plans/I-04.md §6.1 and §8 Q6).
 *
 * The platform IdP (`PLATFORM_OIDC_*`, Pocket ID at id.plrs.im) has signed in three populations:
 * console operators, customers on the portal, and the end users of every `provider: platform`
 * product. Operators have their own client since I-03 and stay. End users move to their Polaris
 * Key account, and Pocket ID ends up holding operators only (S-16 §5.4 item 1, G5).
 *
 * The admin REST API that could export Pocket ID's users needs an admin API key (it answers 401
 * without one), so people move by CLAIM AT NEXT SIGN-IN: each platform-IdP sign-in lands its
 * subject on an account, keeping the subject as a temporary `oidc` sign-in method keyed by the
 * issuer (`oidc:https://id.plrs.im`). People whose IdP asserts no verified email keep only that
 * method, so the sunset (when the method stops working) is set only after the email-less count
 * (`platformMigrationReport`) has been read.
 *
 * ── THE SWITCH (deploy-time only; the owner's go/no-go is a reviewed change to wrangler.toml) ──
 *
 *   PLATFORM_OIDC_MIGRATION   `off` (the default, and what anything unrecognised reads as): every
 *                             platform-IdP sign-in behaves exactly as before this package.
 *                             `claim`: each end-user sign-in lands on an account (below).
 *                             `operators-only`: only subjects that already hold the temporary
 *                             method still sign in through the platform IdP; nobody new does.
 *   PLATFORM_OIDC_SUNSET      `YYYY-MM-DD` (UTC). Unset by default. In `claim` or
 *                             `operators-only`, from 00:00 UTC that day no end user signs in
 *                             through the platform IdP at all. Ignored while the mode is `off`.
 *                             A value that is not a real date reads as unset (and the report
 *                             says so), so a typo can never end everyone's sign-in early.
 *
 * Console operator sign-in (`ADMIN_OIDC_*`, or the platform trio while I-03's client is unset)
 * never reads either value.
 *
 * ── THE CLAIM (never by email match; THREAT-MODEL "Moving end users off the platform IdP") ──
 *
 *   - A subject that already holds the method signs in to its account (`signIn`, I-05).
 *   - Otherwise its verified email decides, under the same narrowing as every provider
 *     (`providerVouchesForEmail`): if no account uses that address, a new account gets it as its
 *     primary email and email sign-in method, beside the temporary method. If ONE account uses
 *     it, nothing is written: it is the email step's join offer (the email gate, `card/gate.ts`),
 *     where the person proves that account in the same browser before anything joins. If MORE
 *     than one account uses it, nothing is written and nothing is offered (ambiguous).
 *   - A subject with no verified email gets an account whose only method is the temporary one.
 *   - Licences: the ones the subject's sign-ins created (`licenses.sub`, platform products only)
 *     attach through the method, by the portal's existing link sweep (`syncAccountLicenseLinks`):
 *     first attach only, never an owned licence, never a custom-issuer product's.
 */

import { normalizeEmail } from "../../../platform/email.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import {
  portalIdentityIssuerKey,
  recordLinkGroups,
  rekeyLegacyPortalIdentities,
  syncAccountLicenseLinks,
} from "../portal/repo.js";
import { providerVouchesForEmail } from "../providers/vouch.js";
import {
  EMAIL_ISSUER,
  LEGACY_OIDC_ISSUER,
  findLink,
  getAccountRow,
  rekeyLegacyAccountLinks,
  resolveAccount,
  type AccountLinkRow,
} from "./repo.js";
import { signIn, type SignInResult, type VerifiedIdentity } from "./signIn.js";

// ── the switch ───────────────────────────────────────────────────────────────────────────────

export const PLATFORM_OIDC_MIGRATION_MODES = [
  "off",
  "claim",
  "operators-only",
] as const;
export type PlatformOidcMigrationMode =
  (typeof PLATFORM_OIDC_MIGRATION_MODES)[number];

export interface PlatformOidcMigration {
  mode: PlatformOidcMigrationMode;
  /** `PLATFORM_OIDC_MIGRATION` holds something that is not a mode; it reads as `off`. */
  modeUnrecognised: boolean;
  /** The sunset day and its first second (unix, UTC), or `null` when unset or invalid. */
  sunset: { date: string; at: number } | null;
  /** `PLATFORM_OIDC_SUNSET` holds something that is not a `YYYY-MM-DD` date; it reads as unset. */
  sunsetInvalid: boolean;
}

function varOf(env: Env, name: string): string {
  const v = (env as unknown as Record<string, unknown>)[name];
  return typeof v === "string" ? v.trim() : "";
}

/** `YYYY-MM-DD` → its 00:00 UTC in unix seconds, or `null` for anything that is not a real day. */
export function parseSunsetDate(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // `Date.UTC` rolls 2027-02-30 over into March: only a day that survives the round trip is real.
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d
  )
    return null;
  return Math.floor(ms / 1000);
}

/** The deploy's migration settings, parsed. Reads the env only. */
export function platformOidcMigration(env: Env): PlatformOidcMigration {
  const rawMode = varOf(env, "PLATFORM_OIDC_MIGRATION").toLowerCase();
  const known = (PLATFORM_OIDC_MIGRATION_MODES as readonly string[]).includes(
    rawMode,
  );
  const rawSunset = varOf(env, "PLATFORM_OIDC_SUNSET");
  const at = rawSunset === "" ? null : parseSunsetDate(rawSunset);
  return {
    mode: known ? (rawMode as PlatformOidcMigrationMode) : "off",
    modeUnrecognised: rawMode !== "" && !known,
    sunset: at === null ? null : { date: rawSunset, at },
    sunsetInvalid: rawSunset !== "" && at === null,
  };
}

/**
 * What an end user's platform-IdP sign-in may do at `now`:
 *
 *   `as-before`  the mode is `off`: exactly the pre-I-17 behaviour;
 *   `claim`      the subject lands on an account; with `linkedOnly`, only through the method it
 *                already holds (`operators-only`, before the sunset);
 *   `ended`      the sunset has passed: no end user signs in through the platform IdP.
 */
export type PlatformSignInPolicy =
  | { kind: "as-before" }
  | { kind: "claim"; linkedOnly: boolean }
  | { kind: "ended" };

export function platformSignInPolicy(
  env: Env,
  now: number,
): PlatformSignInPolicy {
  const m = platformOidcMigration(env);
  if (m.mode === "off") return { kind: "as-before" };
  if (m.sunset && now >= m.sunset.at) return { kind: "ended" };
  return { kind: "claim", linkedOnly: m.mode === "operators-only" };
}

/** Whether the platform IdP has stopped signing end users in (the portal hides its button). */
export function platformSignInEnded(env: Env, now: number): boolean {
  return platformSignInPolicy(env, now).kind === "ended";
}

/**
 * The refusal page's copy, shared by the portal's and the products' callbacks (SIGN-IN.md §3.13,
 * "Single sign-on ended"). "Single sign-on" is what the login card calls the platform IdP; no
 * "OIDC" or "portal" in UI copy.
 */
export const PLATFORM_SIGNIN_ENDED = {
  heading: "This way of signing in has ended",
  body: "Single sign-on no longer signs you in here. Sign in to your Polaris Key account with your email, a passkey or another way you added.",
  action: "Sign in to Polaris Key",
} as const;

// ── the subject's account ────────────────────────────────────────────────────────────────────

/**
 * The sign-in method a platform-IdP subject holds, whichever account holds it: keyed by the
 * issuer (S-16 G14), or by the pre-I-01 literal `oidc` the portal has not re-keyed yet. Both name
 * the same IdP, so both count. Read-only: the re-key itself stays the callbacks' (the claim, the
 * portal).
 */
export async function platformSubjectLink(
  db: Db,
  issuer: string,
  rawSub: string,
): Promise<AccountLinkRow | null> {
  // The same subject `signIn` looks up: trimmed.
  const sub = rawSub.trim();
  return (
    (await findLink(db, {
      issuerKey: portalIdentityIssuerKey(issuer),
      tenantScope: "",
      subject: sub,
    })) ??
    (await findLink(db, {
      issuerKey: LEGACY_OIDC_ISSUER,
      tenantScope: "",
      subject: sub,
    }))
  );
}

/**
 * Whether a platform-IdP subject belongs to a Polaris Key account that can no longer sign in
 * (the I-17 review's N9): the subject holds a method whose account is disabled, is being deleted
 * (`deleted`), or no longer resolves. A product sign-in is then refused, in every migration mode,
 * before anything is minted or written; without this its floating `sub`-keyed licence still
 * signed the subject in. A subject that holds no method has no account (a floating licence, or
 * an erased account, which leaves no link): `false`, and it signs in exactly as before.
 * Read-only.
 */
export async function platformSubjectAccountRefused(
  db: Db,
  issuer: string,
  sub: string,
  now: number,
): Promise<boolean> {
  const link = await platformSubjectLink(db, issuer, sub);
  if (!link) return false;
  // As `signIn` reads it: an absorbed account's sign-ins go to the survivor for 30 days.
  const account = await resolveAccount(db, link.account_id, now);
  return !account || account.status !== "active";
}

// ── the claim ────────────────────────────────────────────────────────────────────────────────

/** A platform-IdP sign-in, as its front door verified it. */
export interface PlatformSubjectSignIn {
  /** The platform issuer the ID token was verified against. */
  issuer: string;
  sub: string;
  /** The `email` claim; it counts only with `emailVerified`. */
  email?: string | null;
  /** The `email_verified` claim was `true`. */
  emailVerified: boolean;
  displayName?: string | null;
  /** The `groups` claim (PX-W10: what Discover evaluates); `undefined` = not asserted. */
  groups?: readonly string[];
  /** The product the sign-in came through, if any (its sign-in history, its pairwise subject). */
  product?: string | null;
}

export type PlatformClaim =
  /** The mode is `off`: the caller does exactly what it did before I-17. */
  | { status: "off" }
  /** Past the sunset, or `operators-only` and the subject holds no method: refused. */
  | { status: "ended" }
  /** More than one account uses the verified email: nothing written, nothing offered. */
  | { status: "ambiguous" }
  /** One account uses the verified email: nothing written; the email step offers to join. */
  | { status: "join_offer"; email: string; identity: VerifiedIdentity }
  | {
      status: "signed_in";
      result: Extract<SignInResult, { status: "signed_in" }>;
    }
  | { status: "refused"; result: Extract<SignInResult, { status: "refused" }> };

/**
 * Every account that uses `email` the way `accountUsingEmail` (the join offer's lookup) reads it:
 * as an email sign-in method (whatever the account's status), or as the verified primary email
 * of an account that is not deleted. All of them, where that one stops at the first.
 */
export async function accountsUsingEmail(
  db: Db,
  email: string,
): Promise<string[]> {
  const normalized = normalizeEmail(email);
  const rows = await db.all<{ account_id: string }>(
    `SELECT account_id FROM account_links
      WHERE issuer_key = ? AND tenant_scope = '' AND subject = ?
     UNION
     SELECT id AS account_id FROM accounts
      WHERE primary_email = ? AND primary_email_verified_at IS NOT NULL
        AND status != 'deleted'`,
    EMAIL_ISSUER,
    normalized,
    normalized,
  );
  return rows.map((r) => r.account_id);
}

/**
 * Claim at next sign-in: land a platform-IdP subject on its Polaris Key account (see the module
 * comment). Writes nothing while the mode is `off`, past the sunset, for an unknown subject in
 * `operators-only`, on a join offer, or on an ambiguous email.
 */
export async function claimPlatformSubject(
  db: Db,
  env: Env,
  input: PlatformSubjectSignIn,
  now: number,
): Promise<PlatformClaim> {
  const policy = platformSignInPolicy(env, now);
  if (policy.kind === "as-before") return { status: "off" };
  if (policy.kind === "ended") return { status: "ended" };

  const issuerKey = portalIdentityIssuerKey(input.issuer);
  // A pre-I-01 row still keyed by the literal `oidc` is the same IdP's subject: re-key it before
  // the lookup, as the portal callback does, or the person would get a second account.
  await rekeyLegacyPortalIdentities(db, issuerKey);
  await rekeyLegacyAccountLinks(db, issuerKey);

  const asserted = input.email?.trim() ? normalizeEmail(input.email) : null;
  // The one narrowing every provider's address goes through (PX-W15); for the platform IdP it is
  // its own `email_verified`. An address it does not vouch for is attacker-chosen, so it is not
  // kept at all, not even as unverified on the method (R8-05b).
  const vouched = providerVouchesForEmail(
    { kind: "oidc", email: asserted, emailVerified: input.emailVerified },
    null,
  );
  const identity: VerifiedIdentity = {
    issuerKey,
    subject: input.sub,
    kind: "oidc",
    email: vouched ? asserted : null,
    emailVerified: vouched,
    displayName: input.displayName ?? null,
  };

  const link = await findLink(db, {
    issuerKey,
    tenantScope: "",
    subject: input.sub,
  });
  if (!link) {
    if (policy.linkedOnly) return { status: "ended" };
    // Refuse ambiguity before `signIn`, which would offer to join whichever account it met first.
    if (identity.email && identity.emailVerified) {
      const using = await accountsUsingEmail(db, identity.email);
      if (using.length > 1) return { status: "ambiguous" };
    }
  }

  const result = await signIn(db, identity, now, {
    product: input.product ? { slug: input.product } : undefined,
    linkedOnly: policy.linkedOnly,
  });
  switch (result.status) {
    case "signed_in":
      await recordLinkGroups(db, result.linkId, input.groups);
      return { status: "signed_in", result };
    case "join_offer":
      return { status: "join_offer", email: result.email, identity };
    case "refused":
      return { status: "refused", result };
  }
}

/**
 * After a product sign-in activated or minted its licence: attach the floating licences the
 * claimed account can prove it holds (the subject's `sub`-keyed ones on platform products, and
 * the ones waiting on its verified emails), by the portal's link sweep. Nothing for an account
 * that is no longer active.
 */
export async function attachClaimedLicenses(
  db: Db,
  accountId: string,
  now: number,
): Promise<void> {
  const account = await getAccountRow(db, accountId);
  if (!account || account.status !== "active") return;
  await syncAccountLicenseLinks(db, accountId, now);
}

// ── the count ────────────────────────────────────────────────────────────────────────────────

/** "Recently used" for the report: the platform IdP signed the person in within this window. */
export const RECENT_USE_SECONDS = 90 * 86_400;

export interface PlatformMigrationReport {
  generatedAt: number;
  mode: PlatformOidcMigrationMode;
  modeUnrecognised: boolean;
  sunset: string | null;
  sunsetInvalid: boolean;
  /** The sunset has passed (and the mode is not `off`): the platform IdP signs no end user in. */
  ended: boolean;
  /** `PLATFORM_OIDC_ISSUER` and `PLATFORM_OIDC_CLIENT_ID` are set. */
  platformIdpConfigured: boolean;
  /** Subjects that hold the temporary method on an active account. */
  linked: {
    subjects: number;
    /** The account has another way in (email, passkey, a provider): it keeps it after the sunset. */
    withOtherMethod: number;
    /** The temporary method is the account's only way in: locked out at the sunset. */
    onlyMethod: number;
    /** Of `onlyMethod`, the ones the platform IdP signed in within `RECENT_USE_SECONDS`. */
    onlyMethodRecent: number;
  };
  /** Subjects seen only on licences (`licenses.sub`, platform products) and never claimed. */
  unlinked: {
    subjects: number;
    /** One of the subject's licences is already on an account: that account is the way in. */
    onAccount: number;
    /** A floating licence names a verified email: it attaches by email once that address has an
     *  account, so the person can sign up by email after the sunset. */
    withEmail: number;
    /** Every licence floating and none names an email: no way in after the sunset. */
    emailLess: number;
  };
  /** The email-less count the sunset follows: `linked.onlyMethod + unlinked.emailLess`. */
  emailLess: number;
}

/**
 * The email-less count (S-16 §9 risk 11: the sunset follows the count, never precedes it). Counts
 * only; no subject, address or account id leaves this function. Read-only and unaffected by the
 * mode, so it can be read before the rollout starts.
 */
export async function platformMigrationReport(
  db: Db,
  env: Env,
  now: number,
): Promise<PlatformMigrationReport> {
  const m = platformOidcMigration(env);
  const issuer = varOf(env, "PLATFORM_OIDC_ISSUER");
  const configured =
    issuer !== "" && varOf(env, "PLATFORM_OIDC_CLIENT_ID") !== "";
  // Both keys name the platform IdP: its issuer, and the pre-I-01 literal not re-keyed yet.
  const issuerKey = issuer
    ? portalIdentityIssuerKey(issuer)
    : LEGACY_OIDC_ISSUER;
  const keys = [issuerKey, LEGACY_OIDC_ISSUER];

  const linked = await db.first<{
    subjects: number;
    with_other: number | null;
    only: number | null;
    only_recent: number | null;
  }>(
    `SELECT COUNT(*) AS subjects,
            SUM(CASE WHEN x.other > 0 THEN 1 ELSE 0 END) AS with_other,
            SUM(CASE WHEN x.other = 0 THEN 1 ELSE 0 END) AS only,
            SUM(CASE WHEN x.other = 0 AND x.last_used_at >= ? THEN 1 ELSE 0 END) AS only_recent
       FROM (SELECT l.last_used_at,
                    (SELECT COUNT(*) FROM account_links o
                      WHERE o.account_id = l.account_id
                        AND o.issuer_key NOT IN (?, ?)) AS other
               FROM account_links l
               JOIN accounts a ON a.id = l.account_id
              WHERE l.issuer_key IN (?, ?) AND l.tenant_scope = '' AND l.kind = 'oidc'
                AND a.status = 'active') x`,
    now - RECENT_USE_SECONDS,
    ...keys,
    ...keys,
  );

  const unlinked = await db.first<{
    subjects: number;
    on_account: number | null;
    with_email: number | null;
    email_less: number | null;
  }>(
    `SELECT COUNT(*) AS subjects,
            SUM(CASE WHEN s.on_account = 1 THEN 1 ELSE 0 END) AS on_account,
            SUM(CASE WHEN s.on_account = 0 AND s.has_email = 1 THEN 1 ELSE 0 END) AS with_email,
            SUM(CASE WHEN s.on_account = 0 AND s.has_email = 0 THEN 1 ELSE 0 END) AS email_less
       FROM (SELECT l.sub,
                    MAX(CASE WHEN l.account_id IS NOT NULL THEN 1 ELSE 0 END) AS on_account,
                    MAX(CASE WHEN l.account_id IS NULL AND COALESCE(l.email, '') != ''
                             THEN 1 ELSE 0 END) AS has_email
               FROM licenses l
               LEFT JOIN oidc_config o ON o.product = l.product
              WHERE l.sub IS NOT NULL AND l.sub != ''
                AND COALESCE(o.provider, 'platform') = 'platform'
                AND NOT EXISTS (SELECT 1 FROM account_links k
                                 WHERE k.issuer_key IN (?, ?) AND k.tenant_scope = ''
                                   AND k.subject = l.sub)
              GROUP BY l.sub) s`,
    ...keys,
  );

  const linkedCounts = {
    subjects: linked?.subjects ?? 0,
    withOtherMethod: linked?.with_other ?? 0,
    onlyMethod: linked?.only ?? 0,
    onlyMethodRecent: linked?.only_recent ?? 0,
  };
  const unlinkedCounts = {
    subjects: unlinked?.subjects ?? 0,
    onAccount: unlinked?.on_account ?? 0,
    withEmail: unlinked?.with_email ?? 0,
    emailLess: unlinked?.email_less ?? 0,
  };
  return {
    generatedAt: now,
    mode: m.mode,
    modeUnrecognised: m.modeUnrecognised,
    sunset: m.sunset?.date ?? null,
    sunsetInvalid: m.sunsetInvalid,
    ended: platformSignInEnded(env, now),
    platformIdpConfigured: configured,
    linked: linkedCounts,
    unlinked: unlinkedCounts,
    emailLess: linkedCounts.onlyMethod + unlinkedCounts.emailLess,
  };
}
