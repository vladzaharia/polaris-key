/**
 * PX-W5 — the portal's self-service additions (docs/design/PORTAL.md §10.2 G6, G7, G22):
 *
 * - `PATCH /api/licenses/<product>/<licenseId>/devices/<deviceId>` — rename one of your devices.
 * - `POST  /api/licenses/<product>/<licenseId>/keys` — get a new license key; the old one stops
 *   activating new devices. Per-product opt-in, recent sign-in required, shown once.
 * - `POST  /api/activate/preview` — what adding a key WOULD do, before it is added: the product,
 *   the tier and terms, the platforms, how many devices it is already on (PX-23), or a typed
 *   refusal.
 * - `DELETE /api/licenses/<product>/<licenseId>` — Remove from my library (PX-23, S-24 D19).
 * - `POST  /api/key/preview` (PX-W9, WIRE-CONTRACT-V4 §12.2 rule 8) — the same question asked
 *   SIGNED OUT, for the login card's key on-ramp: the product, the tier and term, an "in an
 *   account" verdict, the key-entry meter and whether the account upgrade may be skipped.
 *
 * ── ONE EVALUATOR FOR THE PREVIEW AND THE CLAIM ─────────────────────────────────────────────
 *
 * `evaluateKeyClaim` is the only place the claim rules live. `POST /api/claim/license-key` acts on
 * its verdict and the preview reports it, so the preview can never promise an add the claim then
 * refuses, nor refuse one the claim would allow. The rules are the S-16 safety defaults the owner
 * confirmed (2026-10-04): an owned licence never moves by its key (`license_owned`, I-05), and a licence
 * that carries an email attaches only to an account with that email verified (`email_mismatch`),
 * unless the product sets `claimByKey`.
 *
 * ── ENUMERATION (THREAT-MODEL) ─────────────────────────────────────────────────────────────
 *
 * Nothing here can be reached without the WHOLE key: 128 random bits, so the preview is not a
 * key oracle. What it adds is what a key HOLDER learns, and that is kept to the design's list:
 * the product's public presentation, and for a licence they could add, its tier and terms. A
 * refusal never carries ownership details: `license_owned` says only that another account holds
 * it, and `email_mismatch` shows the first character and the domain of the address (§4.19). The
 * preview and the claim charge ONE rate bucket (`portalClaimKey`, per account), so previewing is
 * never a cheaper probe than adding.
 *
 * The signed-out preview has no account to charge, so it charges its own per-network bucket
 * (`portalKeyPreview`, 10 a minute) and answers less: never an email, a masked email, a licence
 * id, devices or an account; `license_owned` says only that the licence is in an account. It reads
 * the same resolver (`resolveClaimKey`) as the claim and never writes, so it never counts.
 *
 * ── KEY ENTRIES (PX-W9) ────────────────────────────────────────────────────────────────────
 *
 * On an Identity product both previews answer `keyEntries {used, limit}` (else `null`), and a
 * claim whose attach commits records one `portal` entry (`core/keyEntries.ts`). A claim is never
 * refused for the limit: adding the key to an account is the way past it.
 */

import {
  hashKey,
  mintLicenseKey,
  productFromKey,
  type Db,
  type Env,
} from "../../../core/platform.js";
import {
  getKey,
  getLicense,
  getProduct,
  getTier,
  replaceLicenseKeys,
  setDeviceLabel,
  getDevice,
  type LicenseRow,
} from "../../../core/data.js";
import { licenseDeviceLimit } from "../../../core/authz.js";
import { licenseUsable } from "../../../core/devices.js";
import {
  keyEntryRefusalsOn,
  keyEntryState,
  recordPortalKeyEntry,
} from "../../../core/keyEntries.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { loadProductPublic } from "../../../core/products.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { ErrorCode } from "../../../core/errors.js";
import {
  accountHasVerifiedEmail,
  getPortalLicense,
  getPortalProductSettings,
  licenseLinkedElsewhere,
  listVisibleKeys,
  normalizeEmail,
  portalAudit,
  type PortalLicenseRow,
} from "./repo.js";
import { notRemovableReason } from "./origin.js";
import { portalSessionAuthenticatedAt, type PortalSession } from "./session.js";
import { sendNotice } from "./email.js";
import { attachLicense, detachLicense } from "../accounts/claim.js";
import {
  licenseAddedNotice,
  licenseKeyReplacedNotice,
  type NoticeMessage,
} from "./notices.js";
import {
  err,
  notFound,
  portalJson,
  readBody,
  requireActionRateLimit,
  shapeLicenseSummaryWithStore,
  type PortalHooksFor,
} from "./api.js";
import { presentationFor } from "./library.js";

// ── The claim rules ─────────────────────────────────────────────────────────────────────────

/** The shared rate bucket of the preview and the claim (§10.2: "same rate bucket as add"). */
export const CLAIM_BUCKET = "portalClaimKey";
export const CLAIM_LIMIT_PER_MINUTE = 10;

interface ProductFacts {
  slug: string;
  name: string;
  branding: unknown;
}

export type KeyClaimVerdict =
  /** Not the shape of a license key at all (`LICENSE_KEY_SHAPE`). Nothing was looked up. */
  | { kind: "invalid" }
  /**
   * No such product, no such key, the key was replaced or revoked, or its licence is gone. Never
   * carries the product's facts: a well-formed guess must not reveal whether a slug exists, or its
   * name and branding.
   */
  | { kind: "unknown"; product: null }
  /** The product does not manage licences in this portal (portal or key claim switched off). */
  | { kind: "portal_off"; product: ProductFacts }
  /** Already linked to this account. */
  | {
      kind: "already_yours";
      product: ProductFacts;
      license: PortalLicenseRow;
    }
  /** Linked to another account; an owned licence never moves by its key. */
  | { kind: "license_owned"; product: ProductFacts }
  /** Carries an email this account has not verified, and the product does not allow claim by key. */
  | { kind: "email_mismatch"; product: ProductFacts; maskedEmail: string }
  /** May be added. */
  | { kind: "addable"; product: ProductFacts; license: LicenseRow };

function parseJsonOrNull(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * `m•••@proton.me`: the first character of the local part and the domain, nothing else (§4.19).
 * Enough for the holder to recognise their own address, not enough to read someone else's.
 */
export function maskEmail(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return "•••";
  return `${normalized[0]}•••@${normalized.slice(at + 1)}`;
}

/**
 * The account-free half of the claim rules: the key's shape, its product, the key and its
 * licence, and whether the product manages licences in this portal. The claim and both previews
 * start here, so none of them can disagree on what a key is.
 */
type ResolvedClaimKey =
  | { kind: "invalid" }
  | { kind: "unknown"; product: null }
  | { kind: "portal_off"; product: ProductFacts; license: LicenseRow }
  | {
      kind: "resolved";
      product: ProductFacts;
      license: LicenseRow;
      settings: Awaited<ReturnType<typeof getPortalProductSettings>>;
    };

async function resolveClaimKey(
  env: Env,
  db: Db,
  key: string,
): Promise<ResolvedClaimKey> {
  const slug = productFromKey(key);
  if (!slug) return { kind: "invalid" };
  const productRow = await getProduct(db, slug);
  if (!productRow || productRow.status === "deleted") {
    return { kind: "unknown", product: null };
  }
  const product: ProductFacts = {
    slug,
    name: productRow.name,
    branding: parseJsonOrNull(productRow.branding_json),
  };
  const keyRow = await getKey(
    db,
    slug,
    await hashKey(key, env.KEY_HASH_PEPPER),
  );
  if (!keyRow || keyRow.status !== "active")
    return { kind: "unknown", product: null };
  const license = await getLicense(db, slug, keyRow.license_id);
  if (!license) return { kind: "unknown", product: null };

  const settings = await getPortalProductSettings(db, slug);
  if (
    settings.portal_enabled !== 1 ||
    settings.license_key_claim_enabled !== 1
  ) {
    return { kind: "portal_off", product, license };
  }
  return { kind: "resolved", product, license, settings };
}

export async function evaluateKeyClaim(
  env: Env,
  db: Db,
  accountId: string,
  key: string,
): Promise<KeyClaimVerdict> {
  const resolved = await resolveClaimKey(env, db, key);
  if (resolved.kind === "invalid" || resolved.kind === "unknown")
    return resolved;
  if (resolved.kind === "portal_off")
    return { kind: "portal_off", product: resolved.product };
  const { product, license, settings } = resolved;
  const slug = product.slug;
  const mine = await getPortalLicense(db, accountId, slug, license.id);
  if (mine) return { kind: "already_yours", product, license: mine };
  if (await licenseLinkedElsewhere(db, accountId, slug, license.id)) {
    return { kind: "license_owned", product };
  }
  const email = license.email?.trim();
  if (
    email &&
    settings.claim_by_key !== 1 &&
    !(await accountHasVerifiedEmail(db, accountId, email))
  ) {
    return { kind: "email_mismatch", product, maskedEmail: maskEmail(email) };
  }
  return { kind: "addable", product, license };
}

// ── G22: the activate preview ───────────────────────────────────────────────────────────────

/** The platforms the product's newest app release ships for (through Core's catalog hook). */
export async function productPlatforms(
  db: Db,
  hooksFor: PortalHooksFor | undefined,
  slug: string,
  now: number,
): Promise<string[]> {
  if (!hooksFor) return [];
  const product = await loadProductPublic(db, slug);
  if (!product) return [];
  const catalog = hooksFor(product, now).releaseCatalog();
  if (!catalog) return [];
  try {
    // The app deliverable (`app` is its fixed id; a product with no deliverable rows yet still
    // keeps its releases under it), newest unyanked publication first.
    const newest = (await catalog.releases("app")).find((r) => !r.yanked);
    if (!newest) return [];
    const platforms = new Set<string>();
    for (const build of await catalog.builds(newest.releaseId)) {
      if (build.platform) platforms.add(build.platform);
    }
    return [...platforms].sort();
  } catch {
    // Platforms are a courtesy on the confirm step; a catalog that cannot answer never blocks it.
    return [];
  }
}

/**
 * PX-23 (S-24 §10, D22): how many devices an addable licence is already on (authorized ones), so
 * Confirm can say they come with it. A count only: never a label, platform or id, since the key
 * holder learns no more about those devices than activating would tell them (a seat count).
 */
async function boundDeviceCount(db: Db, license: LicenseRow): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM devices
      WHERE product = ? AND license_id = ? AND status = 'authorized'`,
    license.product,
    license.id,
  );
  return row?.n ?? 0;
}

async function licenseTerms(
  db: Db,
  license: LicenseRow,
  now: number,
): Promise<Record<string, unknown>> {
  const product = await loadProductPublic(db, license.product);
  const tier = license.tier_id
    ? await getTier(db, license.product, license.tier_id)
    : null;
  return {
    tier: license.tier_id,
    tierLabel: tier?.label ?? null,
    status: license.status,
    usable: licenseUsable(license, now),
    expiresAt: license.expires_at,
    deviceLimit: product
      ? await licenseDeviceLimit(db, product, license, now)
      : null,
  };
}

/**
 * The product as a key preview shows it. The developer name and the art come from the same
 * presentation the library draws (`presentationFor`, HA-07): the hosted copies when the product
 * has them, else the media proxy's URLs, sized like a library tile (the confirm step's banner and
 * icon). `null` art when there is none.
 */
async function productView(
  env: Env,
  db: Db,
  product: ProductFacts | null,
  hooksFor: PortalHooksFor | undefined,
  now: number,
): Promise<Record<string, unknown> | null> {
  if (!product) return null;
  const pub = await loadProductPublic(db, product.slug);
  const pres = pub
    ? await presentationFor(env, db, pub, hooksFor, now, "library")
    : null;
  return {
    slug: product.slug,
    name: product.name,
    branding: product.branding,
    developerName: pres?.developerName ?? null,
    iconUrl: pres?.iconUrl ?? null,
    headerUrl: pres?.headerUrl ?? null,
  };
}

export async function handleActivatePreview(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  now: number,
  hooksFor: PortalHooksFor | undefined,
  /** ST-04's settings registry: the key-entry limit is resolved by it. */
  settings?: SettingsRegistry,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  // Charged BEFORE any lookup, on the claim's own bucket: a preview costs exactly what an add costs.
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    CLAIM_BUCKET,
    now,
    CLAIM_LIMIT_PER_MINUTE,
  );
  if (limited) return limited;
  const body = await readBody(req);
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const verdict = await evaluateKeyClaim(env, db, session.accountId, key);
  if (verdict.kind === "invalid") {
    return err(422, ErrorCode.BadRequest, "invalid license key");
  }
  const base = {
    verdict: verdict.kind,
    product: await productView(env, db, verdict.product, hooksFor, now),
    // PX-W9 (§12.2 rule 8): the licence's key entries on an Identity product, for a licence this
    // account can see; `null` otherwise. Previewing never counts.
    keyEntries:
      verdict.kind === "addable" || verdict.kind === "already_yours"
        ? await keyEntryState(
            { env, db, registry: settings },
            verdict.product.slug,
            verdict.license.id,
          )
        : null,
  };
  switch (verdict.kind) {
    case "addable": {
      const product = await loadProductPublic(db, verdict.product.slug);
      return portalJson({
        ...base,
        license: await licenseTerms(db, verdict.license, now),
        platforms: await productPlatforms(
          db,
          hooksFor,
          verdict.product.slug,
          now,
        ),
        // PX-23: the devices that come with it, and whether signing in on them turns on Cloud
        // Sync (the product runs it; S-24 D22).
        devices: await boundDeviceCount(db, verdict.license),
        cloudSync: product?.services.sync?.enabled === true,
      });
    }
    case "already_yours":
      return portalJson({
        ...base,
        license: {
          id: verdict.license.id,
          ...(await licenseTerms(db, verdict.license, now)),
        },
        platforms: await productPlatforms(
          db,
          hooksFor,
          verdict.product.slug,
          now,
        ),
      });
    case "email_mismatch":
      return portalJson({ ...base, maskedEmail: verdict.maskedEmail });
    default:
      return portalJson(base);
  }
}

// ── The claim, on the same verdict ──────────────────────────────────────────────────────────

/** `license_owned` (403): another account owns the licence. Says THAT, never whom (S-16 §5.1). */
function licenseOwned(): Response {
  return portalJson(
    {
      error: "license_owned",
      message: "license is held by another account",
    },
    403,
  );
}

export async function handleClaimKey(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  now: number,
  hooksFor?: PortalHooksFor,
  /** ST-04's settings registry: the key-entry limit is resolved by it. */
  settings?: SettingsRegistry,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    CLAIM_BUCKET,
    now,
    CLAIM_LIMIT_PER_MINUTE,
  );
  if (limited) return limited;
  const body = await readBody(req);
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const verdict = await evaluateKeyClaim(env, db, session.accountId, key);
  switch (verdict.kind) {
    case "invalid":
      return err(422, ErrorCode.BadRequest, "invalid license key");
    case "unknown":
      return err(401, ErrorCode.Unauthorized, "license key not found");
    case "portal_off":
      return notFound();
    case "license_owned":
      // I-05 (plans/I-04.md §4): the claim rule's code, 403, shared with the device attach.
      return licenseOwned();
    case "email_mismatch":
      return portalJson(
        {
          error: "email_mismatch",
          message: "license joins only the account with its email verified",
          maskedEmail: verdict.maskedEmail,
        },
        403,
      );
    case "already_yours": {
      // Idempotent: nothing is written (no key entry either) and nobody is emailed a second time.
      const keyEntries = await keyEntryState(
        { env, db, registry: settings },
        verdict.product.slug,
        verdict.license.id,
      );
      return portalJson({
        ok: true,
        license: await shapeLicenseSummaryWithStore(
          db,
          verdict.license,
          now,
          hooksFor,
        ),
        ...(keyEntries ? { keyEntries } : {}),
      });
    }
    case "addable":
      break;
  }
  const { product, license } = verdict;
  const origin = new URL(req.url).origin;
  // I-05: the claim engine re-checks every rule and writes conditionally, so of two concurrent
  // claims exactly one attaches. It also creates the pairwise subject and, S-16, notifies the
  // licence's own email when that is not one of this account's verified addresses.
  const attached = await attachLicense(
    { db, env, now, origin },
    {
      accountId: session.accountId,
      product: product.slug,
      licenseId: license.id,
      via: "key",
    },
  );
  if (!attached.ok) {
    if (attached.reason === "license_owned") return licenseOwned();
    if (attached.reason === "license_email_bound") {
      return portalJson(
        {
          error: "email_mismatch",
          message: "license joins only the account with its email verified",
          maskedEmail: maskEmail(attached.email ?? ""),
        },
        403,
      );
    }
    return err(401, ErrorCode.Unauthorized, "license key not found");
  }
  // PX-W9 (§12.2 rules 1 and 4): this claim's attach committed, so it is a `portal` key entry
  // (Identity on only). A concurrent claim by the same account that got there first answers
  // `attached: false` here: a late "already yours", never counted.
  if (attached.attached)
    await recordPortalKeyEntry(db, product.slug, license.id, now);
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.license.claim",
    product: product.slug,
    targetKind: "license",
    targetId: license.id,
    summary: "Claimed license with a license key",
    now,
  });
  // The claim has committed: a mail failure must not turn it into an error (PX-W7 review).
  await sendQuietly(
    env,
    db,
    session.email,
    licenseAddedNotice({
      productName: product.name,
      productSlug: product.slug,
      origin,
    }),
    now,
  );
  const portalRow = await getPortalLicense(
    db,
    session.accountId,
    product.slug,
    license.id,
  );
  const keyEntries = await keyEntryState(
    { env, db, registry: settings },
    product.slug,
    license.id,
  );
  return portalJson({
    ok: true,
    license: portalRow
      ? await shapeLicenseSummaryWithStore(db, portalRow, now, hooksFor)
      : null,
    ...(keyEntries ? { keyEntries } : {}),
  });
}

// ── PX-W9: the signed-out key preview (WIRE-CONTRACT-V4 §12.2 rule 8) ──────────────────────

/** The signed-out preview's bucket: per client network, since there is no account to charge. */
export const KEY_PREVIEW_BUCKET = "portalKeyPreview";
export const KEY_PREVIEW_LIMIT_PER_MINUTE = 10;

/**
 * `POST /api/key/preview` — what a key would do, before anyone signs in (SIGN-IN.md §3.9, the
 * login card's "Have a license key?"). Read-only: it writes nothing, so it never counts.
 *
 * Answers `{product, verdict, license, keyEntries, upgrade}`:
 *
 *   - `verdict`: `addable`, `license_owned` (the licence is in an account; never whose) or
 *     `portal_off`. `email_mismatch` stays a signed-in verdict.
 *   - `license`: `{tierName, term}` (`term` is `perpetual` or the end in epoch seconds), `null` on
 *     `portal_off`. Activation by key already tells the key holder more (S-24 H6).
 *   - `keyEntries`: `{used, limit}` on an Identity product, else `null`.
 *   - `upgrade`: `forced` exactly when a new device would be refused `key_entry_limit` (an
 *     addable, usable licence at its limit with refusals on; plans/PX-W9.md §8 Q4), else
 *     `skippable`.
 *
 * Never an email, a masked email, a licence id, devices or an account. `422` for a string that is
 * not a licence key, `401` for an unknown key, `429` past the budget, as the claim answers.
 */
export async function handleKeyPreview(
  req: Request,
  env: Env,
  db: Db,
  now: number,
  /** ST-04's settings registry: the key-entry limit is resolved by it. */
  settings?: SettingsRegistry,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  // Charged BEFORE any lookup, so a refused guess costs as much as an accepted one.
  const allowed = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: KEY_PREVIEW_BUCKET,
      id: clientNetwork(req),
      limit: KEY_PREVIEW_LIMIT_PER_MINUTE,
      windowSec: 60,
    },
    now,
  );
  if (!allowed) return err(429, "rate_limited", "too many attempts");
  const body = await readBody(req);
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const resolved = await resolveClaimKey(env, db, key);
  if (resolved.kind === "invalid")
    return err(422, ErrorCode.BadRequest, "invalid license key");
  if (resolved.kind === "unknown")
    return err(401, ErrorCode.Unauthorized, "license key not found");
  const { product, license } = resolved;
  // Signed out, so no listing hooks: the art is the hosted copies, else the media proxy's.
  const view = (await productView(env, db, product, undefined, now))!;
  if (resolved.kind === "portal_off") {
    return portalJson({
      product: view,
      verdict: "portal_off",
      license: null,
      keyEntries: null,
      upgrade: "skippable",
    });
  }
  const verdict = license.account_id ? "license_owned" : "addable";
  const keyEntries = await keyEntryState(
    { env, db, registry: settings },
    product.slug,
    license.id,
  );
  const forced =
    verdict === "addable" &&
    keyEntries !== null &&
    keyEntries.used >= keyEntries.limit &&
    licenseUsable(license, now) &&
    (await keyEntryRefusalsOn(env, db));
  const tier = license.tier_id
    ? await getTier(db, product.slug, license.tier_id)
    : null;
  return portalJson({
    product: view,
    verdict,
    license: {
      tierName: tier?.label ?? null,
      term: license.expires_at ?? "perpetual",
    },
    keyEntries,
    upgrade: forced ? "forced" : "skippable",
  });
}

// ── PX-23: Remove from my library ───────────────────────────────────────────────────────────

/** The removals one account may make per product per minute (the device rename's shard). */
export const LICENSE_REMOVE_LIMIT_PER_MINUTE = 10;

/**
 * `DELETE /api/licenses/<product>/<licenseId>` — the holder removes a licence from their library
 * (docs/design/PORTAL.md §4.20's overflow menu; notes/S-24 §5.5, §10, D19). LX-26's
 * `detachLicense` does the work: the licence leaves the account (it keeps its email, so it waits
 * for an account that verifies it; with none it floats), an auto-attach block keeps it out of
 * THIS account until its key is added again, the account's registry tokens for it are revoked,
 * and both the detach and the block are audited. Its devices keep running and keep their seats;
 * the ones this account signed in on lose Cloud Sync for it (`resolveSyncPrincipal` reads the
 * block; lead decision, 2026-10-06).
 *
 * 404, the same as for a licence that is not yours, on a product whose portal is off. A licence
 * that could never be added back (no active key, or the product turned key claims off; the list
 * says `removable: false`) is refused with `409 not_removable` and its `reason`, before anything
 * is charged or written. Charged after ownership is proven, in the product's own shard.
 */
export async function handleLicenseRemove(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  licenseId: string,
  now: number,
): Promise<Response> {
  const settings = await getPortalProductSettings(db, product);
  if (settings.portal_enabled !== 1) return notFound();
  const license = await getPortalLicense(
    db,
    session.accountId,
    product,
    licenseId,
  );
  if (!license) return notFound();
  // Only a licence its key can bring back may leave (lead decision, 2026-10-06): refused before
  // anything is charged or written.
  const keys = await listVisibleKeys(db, product, licenseId);
  const reason = notRemovableReason(
    keys.filter((k) => k.status === "active").length,
    settings.license_key_claim_enabled === 1,
  );
  if (reason) {
    return portalJson(
      {
        error: "not_removable",
        message: "this license could not be added back, so it stays",
        reason,
      },
      409,
    );
  }
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalLicenseRemove",
    now,
    LICENSE_REMOVE_LIMIT_PER_MINUTE,
    product,
  );
  if (limited) return limited;
  const removed = await detachLicense(
    { db, env, now, origin: new URL(req.url).origin },
    { accountId: session.accountId, product, licenseId },
  );
  // Another request moved it first (a developer's relink, a concurrent remove): not yours now.
  if (!removed.ok) return notFound();
  return portalJson({ ok: true, product, licenseId });
}

// ── G6: rename a device ─────────────────────────────────────────────────────────────────────

/** The longest device name the portal stores. Short enough for a row and a notice line. */
export const DEVICE_LABEL_MAX = 64;

/**
 * A device name is display text other people's code never interprets, but it lands in emails and
 * lists, so it is held to plain text: no control characters, no bidirectional overrides (which can
 * make "Studio PC" render as something else), trimmed, at most `DEVICE_LABEL_MAX` characters.
 * `null` clears the name. Answers `undefined` for a value that is not acceptable.
 */
export function parseDeviceLabel(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ([...trimmed].length > DEVICE_LABEL_MAX) return undefined;
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(trimmed)) return undefined;
  return trimmed;
}

export async function handleDeviceRename(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  licenseId: string,
  deviceId: string,
  now: number,
): Promise<Response> {
  const settings = await getPortalProductSettings(db, product);
  if (settings.portal_enabled !== 1) return notFound();
  const license = await getPortalLicense(
    db,
    session.accountId,
    product,
    licenseId,
  );
  if (!license) return notFound();
  // Charged after ownership is proven and in this product's shard, like the disconnect (R5-05).
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalDeviceRename",
    now,
    30,
    product,
  );
  if (limited) return limited;
  const device = await getDevice(db, product, deviceId);
  if (!device || device.license_id !== licenseId) return notFound();
  const body = await readBody(req);
  if (!("label" in body)) {
    return err(422, ErrorCode.BadRequest, "label is required");
  }
  const label = parseDeviceLabel(body.label);
  if (label === undefined) {
    return err(
      422,
      ErrorCode.BadRequest,
      `label must be plain text of at most ${DEVICE_LABEL_MAX} characters`,
    );
  }
  await setDeviceLabel(db, product, deviceId, label);
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.device.rename",
    product,
    targetKind: "device",
    targetId: deviceId,
    summary: label
      ? `Renamed device ${deviceId}`
      : `Cleared the name of device ${deviceId}`,
    now,
  });
  return portalJson({ ok: true, device: { deviceId, label } });
}

// ── G7: get a new key ───────────────────────────────────────────────────────────────────────

/** How recent the sign-in must be to mint a new key (the portal's step-up, see session.ts). */
export const KEY_REISSUE_MAX_AUTH_AGE_SECONDS = 5 * 60;

export async function handleKeyReissue(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  licenseId: string,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const settings = await getPortalProductSettings(db, product);
  // Hidden, not refused, when the product has not opted in: the same 404 as a licence that is not
  // yours, so the route says nothing about a product's settings to a caller who cannot use it.
  if (settings.portal_enabled !== 1 || settings.key_reissue_enabled !== 1) {
    return notFound();
  }
  const license = await getPortalLicense(
    db,
    session.accountId,
    product,
    licenseId,
  );
  // A suspended or revoked licence gets no new key (it could not activate anything, and the
  // notice would mislead): the same 404 as a licence that is not yours.
  if (!license || license.status !== "active") return notFound();
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalKeyReissue",
    now,
    5,
    product,
    60 * 60,
  );
  if (limited) return limited;
  if (
    now - portalSessionAuthenticatedAt(session) >
    KEY_REISSUE_MAX_AUTH_AGE_SECONDS
  ) {
    return portalJson(
      {
        error: "step_up_required",
        message: "sign in again to get a new key",
        maxAgeSeconds: KEY_REISSUE_MAX_AUTH_AGE_SECONDS,
      },
      401,
    );
  }
  const key = mintLicenseKey(product);
  const hash = await hashKey(key, env.KEY_HASH_PEPPER);
  const revoked = await replaceLicenseKeys(db, {
    product,
    key_hash: hash,
    license_id: licenseId,
    status: "active",
    label: "Issued in the portal",
    created_at: now,
    created_by: `portal:${session.accountId}`,
    last_used_at: null,
  });
  await portalAudit(db, {
    accountId: session.accountId,
    action: "portal.license.key_reissue",
    product,
    targetKind: "license",
    targetId: licenseId,
    summary: `Issued a new license key; ${revoked} old key${revoked === 1 ? "" : "s"} revoked`,
    now,
  });
  const notice = licenseKeyReplacedNotice({
    productName: license.product_name,
    productSlug: product,
    origin: new URL(req.url).origin,
  });
  await sendQuietly(env, db, session.email, notice, now);
  if (
    license.email &&
    normalizeEmail(license.email) !== normalizeEmail(session.email)
  ) {
    await sendQuietly(env, db, license.email, notice, now);
  }
  // Shown ONCE: the raw key is in this response and nowhere else; only its hash is stored.
  return portalJson({ key, revokedKeys: revoked, createdAt: now }, 201);
}

/** A notice after a committed change: a failed send is swallowed (the worker has no console
 *  logging, R12), so mail trouble never reports a done change as failed. */
async function sendQuietly(
  env: Env,
  db: Db,
  to: string | null | undefined,
  message: NoticeMessage,
  now: number,
): Promise<void> {
  try {
    await sendNotice(env, db, to, message, now);
  } catch {
    // Deliberately ignored; see above.
  }
}
