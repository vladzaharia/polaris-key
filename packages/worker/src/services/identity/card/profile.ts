/**
 * Profile import (I-07; S-16 owner decision "import profile data from identity providers";
 * PORTAL.md §4.29 item 3 and §4.30 rules 1–3, G32).
 *
 * At link time Polaris Key records what the provider supplied, per link (`profile_json`):
 * Google's name, picture and locale; Apple's name from the first authorisation only (the front
 * door passes it once, I-06); Steam's persona name and avatar; later the platform identities'
 * alias and avatar. Pictures are re-encoded and stored by `avatars.ts` (PX-W16, G33).
 *
 * The account's personal details (`accounts.display_name`, `avatar_key`, `locale`) follow these
 * rules, with each value's source and an explicit-choice flag in `details_source_json`:
 *
 *   1. The first provider fills the profile (a new account takes the link's values).
 *   2. Follow until chosen: a value whose source is a link, never chosen explicitly, refreshes
 *      when the person signs in with that link again.
 *   3. Explicit choices stick: a name typed in the email gate or in Account → Profile, a picked
 *      source, an upload or Initials (PX-W16, `PATCH /api/me/profile`) is never overwritten by a
 *      later sign-in.
 *
 * Every imported value is untrusted display data (THREAT-MODEL "Login card"): names lose control
 * and bidirectional-override characters and are cut to 64 characters; locales must look like a
 * BCP 47 tag; nothing is ever rendered as markup.
 */

import { hashKey } from "../../../platform/crypto.js";
import { parseJsonColumn } from "../../../platform/json.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import {
  AVATAR_ASSET_PATTERN,
  avatarView,
  copyProviderAvatar,
  isAllowedAvatarUrl,
  releaseAvatars,
  type AvatarView,
} from "./avatars.js";
import {
  birthdateSourceView,
  parseBirthdate,
  type BirthdateSourceView,
} from "../accounts/birthdate.js";

/** What a front door hands over about the person (all optional, all untrusted). */
export interface ImportedProfile {
  name?: string | null;
  pictureUrl?: string | null;
  locale?: string | null;
}

/** One link's stored import. */
export interface LinkProfile {
  name: string | null;
  locale: string | null;
  /** Peppered hash of the provider's picture URL, so an unchanged URL is not re-fetched. */
  pictureRef: string | null;
  /** The asset holding the re-encoded picture (`avatars.ts`). */
  avatarKey: string | null;
}

interface DetailSource {
  /** `link:<linkId>`, `explicit`, `upload`, `initials`. */
  source: string;
  explicit: boolean;
}

/** `accounts.details_source_json`. */
export interface DetailsSources {
  name?: DetailSource;
  picture?: DetailSource;
  locale?: DetailSource;
}

/** The longest display name kept, in code points. */
export const DISPLAY_NAME_MAX = 64;

// C0 and C1 controls, bidirectional embeddings, overrides and isolates, and zero-width marks.
// A name with them could reorder the text around it on the card or in a notice.
const UNSAFE_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** A display name made safe to show, or null when nothing is left. */
export function sanitizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  return [...clean].slice(0, DISPLAY_NAME_MAX).join("").trim() || null;
}

/** A BCP 47-looking locale (`en`, `en-GB`, `pt_BR`, `zh-Hant-TW`), normalised with `-`. */
export function sanitizeLocale(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (v.length > 35) return null;
  return /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(v)
    ? v.replace(/_/g, "-")
    : null;
}

/** A stored JSON object, or `null`. An array passes too, as it always has here. */
function storedObject<T>(raw: string | null | undefined): T | null {
  const v = parseJsonColumn(raw);
  return v && typeof v === "object" ? (v as T) : null;
}

export function parseLinkProfile(raw: string | null | undefined): LinkProfile {
  const p = storedObject<Partial<LinkProfile>>(raw) ?? {};
  return {
    name: typeof p.name === "string" ? p.name : null,
    locale: typeof p.locale === "string" ? p.locale : null,
    pictureRef: typeof p.pictureRef === "string" ? p.pictureRef : null,
    avatarKey: typeof p.avatarKey === "string" ? p.avatarKey : null,
  };
}

/**
 * The `pictureRef` of a provider's picture URL. `v2` (PX-W16): a reference recorded before
 * pictures were re-encoded no longer matches, so the next sign-in copies the picture again.
 */
async function pictureRefOf(env: Env, url: string): Promise<string> {
  return hashKey(`avatar-src:v2:${url}`, env.KEY_HASH_PEPPER);
}

/**
 * Record a link's import: the sanitized name and locale, and the picture re-encoded and stored
 * when its URL changed. Answers the stored import and the asset it replaced (if any), which the
 * caller deletes once nothing uses it.
 */
async function storeLinkProfile(
  env: Env,
  db: Db,
  accountId: string,
  linkId: string,
  profile: ImportedProfile,
  now: number,
): Promise<{ stored: LinkProfile; replaced: string | null }> {
  const row = await db.first<{ profile_json: string | null }>(
    "SELECT profile_json FROM account_links WHERE id = ?",
    linkId,
  );
  const before = parseLinkProfile(row?.profile_json);
  const url =
    typeof profile.pictureUrl === "string" &&
    isAllowedAvatarUrl(profile.pictureUrl)
      ? profile.pictureUrl
      : null;
  const pictureRef = url ? await pictureRefOf(env, url) : null;
  let avatarKey = before.avatarKey;
  let replaced: string | null = null;
  if (pictureRef !== before.pictureRef) {
    const copied = url
      ? await copyProviderAvatar(env, db, accountId, url, now)
      : null;
    replaced = before.avatarKey;
    avatarKey = copied;
  }
  const stored: LinkProfile = {
    name: sanitizeDisplayName(profile.name) ?? before.name,
    locale: sanitizeLocale(profile.locale) ?? before.locale,
    // A failed copy keeps no reference, so the next sign-in tries again.
    pictureRef: avatarKey || !url ? pictureRef : null,
    avatarKey,
  };
  await db.run(
    `UPDATE account_links
        SET profile_json = ?, display_name = COALESCE(?, display_name)
      WHERE id = ?`,
    JSON.stringify(stored),
    stored.name,
    linkId,
  );
  return { stored, replaced };
}

/**
 * Import a provider's profile onto a link and apply the follow/explicit rules to its account.
 *
 * `fill: "new"` is the first provider of a new account (it fills every value it has);
 * `"refresh"` is a later sign-in with that link (it refreshes only values sourced from it and
 * never chosen). `explicitName` is the name the person typed in the email gate, which sticks;
 * `explicitInitials` is FinishStep's "Initials" picture (I-33), which sticks too. The link still
 * keeps its copy of the provider's picture, so Account → Profile can offer it later.
 */
export async function importProfile(
  env: Env,
  db: Db,
  input: {
    accountId: string;
    linkId: string;
    profile: ImportedProfile;
    explicitName?: string | null;
    explicitInitials?: boolean;
    fill: "new" | "refresh";
  },
  now: number,
): Promise<void> {
  const { stored, replaced } = await storeLinkProfile(
    env,
    db,
    input.accountId,
    input.linkId,
    input.profile,
    now,
  );
  const account = await db.first<{
    display_name: string | null;
    avatar_key: string | null;
    locale: string | null;
    details_source_json: string | null;
  }>(
    "SELECT display_name, avatar_key, locale, details_source_json FROM accounts WHERE id = ?",
    input.accountId,
  );
  if (!account) return;
  const details =
    storedObject<DetailsSources>(account.details_source_json) ?? {};
  const source = `link:${input.linkId}`;
  // A value follows this link when the account is new, when it already follows this link and
  // was never chosen, or when it was never set at all.
  const follows = (d: DetailSource | undefined, current: unknown): boolean =>
    input.fill === "new" ||
    (d !== undefined && d.source === source && !d.explicit) ||
    (d === undefined && (current === null || current === undefined));

  let displayName = account.display_name;
  let avatarKey = account.avatar_key;
  let locale = account.locale;
  const explicit = sanitizeDisplayName(input.explicitName);
  if (explicit) {
    displayName = explicit;
    details.name = { source: "explicit", explicit: true };
  } else if (stored.name && follows(details.name, account.display_name)) {
    displayName = stored.name;
    details.name = { source, explicit: false };
  }
  if (input.explicitInitials) {
    avatarKey = null;
    details.picture = { source: "initials", explicit: true };
  } else if (stored.avatarKey && follows(details.picture, account.avatar_key)) {
    avatarKey = stored.avatarKey;
    details.picture = { source, explicit: false };
  } else if (
    !stored.avatarKey &&
    details.picture?.source === source &&
    !details.picture.explicit
  ) {
    // The followed provider stopped supplying a picture: fall back to initials.
    avatarKey = null;
    delete details.picture;
  }
  if (stored.locale && follows(details.locale, account.locale)) {
    locale = stored.locale;
    details.locale = { source, explicit: false };
  }
  await db.run(
    `UPDATE accounts
        SET display_name = ?, avatar_key = ?, locale = ?, details_source_json = ?, modified_at = ?
      WHERE id = ?`,
    displayName,
    avatarKey,
    locale,
    JSON.stringify(details),
    now,
    input.accountId,
  );
  // A replaced copy and a picture the account moved away from go once nothing uses them.
  await releaseAvatars(
    env,
    db,
    [replaced, account.avatar_key].filter((k) => k !== avatarKey),
  );
}

// ── Account → Profile (PX-W16, PORTAL.md §4.30, G32) ───────────────────────────────────────

/** Where a profile value came from, as the portal API shows it. */
export type ProfileSource =
  /** A sign-in method's import. `provider` is null once that method was disconnected (the value
   *  stays and no longer follows anything, SIGN-IN.md §3.16). */
  | { kind: "provider"; linkId: string; provider: string | null }
  | { kind: "typed" }
  | { kind: "upload" }
  | { kind: "initials" };

/** One sign-in method that supplied a name or a picture: the editor's chips and tiles. */
export interface ProfileSourceOption {
  linkId: string;
  /** The method's kind: `google`, `apple`, `steam`, later the platform identities. */
  provider: string;
  /** The connected identity, as Account → Sign-in methods shows it (the address or persona). */
  label: string | null;
  name: string | null;
  picture: AvatarView | null;
}

/** `GET /api/me/profile`. */
export interface ProfileView {
  /** The screen name (I-33's UI word for `accounts.display_name`). */
  displayName: string | null;
  displayNameSource: ProfileSource | null;
  explicitName: boolean;
  /** The picture in use; null shows initials. */
  picture: AvatarView | null;
  pictureSource: ProfileSource | null;
  explicitPicture: boolean;
  locale: string | null;
  sources: ProfileSourceOption[];
  /**
   * I-33: the optional birth date (`YYYY-MM-DD`) and where it came from. This route, the person's
   * own, is the one place it is answered (`accounts/birthdate.ts`).
   */
  birthdate: string | null;
  birthdateSource: BirthdateSourceView | null;
}

function sourceOf(
  d: DetailSource | undefined,
  kinds: ReadonlyMap<string, string>,
): ProfileSource | null {
  if (!d || typeof d.source !== "string") return null;
  if (d.source === "explicit") return { kind: "typed" };
  if (d.source === "upload") return { kind: "upload" };
  if (d.source === "initials") return { kind: "initials" };
  if (d.source.startsWith("link:")) {
    const linkId = d.source.slice(5);
    return { kind: "provider", linkId, provider: kinds.get(linkId) ?? null };
  }
  return null;
}

/** The account's profile, its sources and explicit flags, and what each method supplied. */
export async function profileView(
  db: Db,
  accountId: string,
): Promise<ProfileView | null> {
  const account = await db.first<{
    display_name: string | null;
    avatar_key: string | null;
    locale: string | null;
    details_source_json: string | null;
    birthdate: string | null;
    birthdate_source: string | null;
  }>(
    `SELECT display_name, avatar_key, locale, details_source_json, birthdate, birthdate_source
       FROM accounts WHERE id = ?`,
    accountId,
  );
  if (!account) return null;
  const links = await db.all<{
    id: string;
    kind: string;
    email: string | null;
    display_name: string | null;
    profile_json: string | null;
  }>(
    `SELECT id, kind, email, display_name, profile_json FROM account_links
      WHERE account_id = ? ORDER BY created_at, id`,
    accountId,
  );
  const kinds = new Map(links.map((l) => [l.id, l.kind]));
  const details =
    storedObject<DetailsSources>(account.details_source_json) ?? {};
  const sources: ProfileSourceOption[] = [];
  for (const l of links) {
    const p = parseLinkProfile(l.profile_json);
    const picture = avatarView(p.avatarKey);
    if (!p.name && !picture) continue;
    sources.push({
      linkId: l.id,
      provider: l.kind,
      label: l.email ?? l.display_name,
      name: p.name,
      picture,
    });
  }
  return {
    displayName: account.display_name,
    displayNameSource: sourceOf(details.name, kinds),
    explicitName: details.name?.explicit === true,
    picture: avatarView(account.avatar_key),
    pictureSource: sourceOf(details.picture, kinds),
    explicitPicture: details.picture?.explicit === true,
    locale: account.locale,
    sources,
    birthdate: account.birthdate,
    birthdateSource: account.birthdate
      ? birthdateSourceView(account.birthdate_source)
      : null,
  };
}

/** An edit from Account → Profile. Every value it sets is an explicit choice. */
export interface ProfileChange {
  name?: { typed: string } | { from: string };
  picture?: { initials: true } | { from: string } | { upload: string };
  /** I-33: a birth date the person typed (`YYYY-MM-DD`, checked against `now`), or `null` to
   *  remove it. */
  birthdate?: string | null;
}

export type ProfileChangeRefusal =
  /** The typed name is empty once made safe. */
  | "invalid_name"
  /** Not a real date from 1900-01-01 to today (`parseBirthdate`). */
  | "invalid_birthdate"
  /** The named sign-in method is not this account's. */
  | "unknown_source"
  /** That method supplied no name, or no picture. */
  | "no_name"
  | "no_picture"
  /** Not one of this account's uploads (or it was already collected). */
  | "unknown_upload";

async function linkProfileOf(
  db: Db,
  accountId: string,
  linkId: string,
): Promise<LinkProfile | null> {
  const row = await db.first<{ profile_json: string | null }>(
    "SELECT profile_json FROM account_links WHERE id = ? AND account_id = ?",
    linkId,
    accountId,
  );
  return row ? parseLinkProfile(row.profile_json) : null;
}

/**
 * Apply an edit: a typed name or a method's name, and Initials, a method's picture or an upload.
 * Each sticks (rule 3). The picture moved away from is deleted once nothing uses it.
 */
export async function updateProfile(
  env: Env,
  db: Db,
  accountId: string,
  change: ProfileChange,
  now: number,
): Promise<{ ok: true } | { ok: false; reason: ProfileChangeRefusal }> {
  const account = await db.first<{
    display_name: string | null;
    avatar_key: string | null;
    details_source_json: string | null;
    birthdate: string | null;
    birthdate_source: string | null;
  }>(
    `SELECT display_name, avatar_key, details_source_json, birthdate, birthdate_source
       FROM accounts WHERE id = ?`,
    accountId,
  );
  if (!account) return { ok: false, reason: "unknown_source" };
  const details =
    storedObject<DetailsSources>(account.details_source_json) ?? {};
  let displayName = account.display_name;
  let avatarKey = account.avatar_key;
  let birthdate = account.birthdate;
  let birthdateSource = account.birthdate_source;

  if (change.birthdate !== undefined) {
    if (change.birthdate === null) {
      birthdate = null;
      birthdateSource = null;
    } else {
      const value = parseBirthdate(change.birthdate, now);
      if (!value) return { ok: false, reason: "invalid_birthdate" };
      // The same date again keeps where it came from (an accepted connection claim stays one).
      if (value !== account.birthdate) {
        birthdate = value;
        birthdateSource = "user";
      }
    }
  }

  if (change.name && "typed" in change.name) {
    const clean = sanitizeDisplayName(change.name.typed);
    if (!clean) return { ok: false, reason: "invalid_name" };
    displayName = clean;
    details.name = { source: "explicit", explicit: true };
  } else if (change.name) {
    const link = await linkProfileOf(db, accountId, change.name.from);
    if (!link) return { ok: false, reason: "unknown_source" };
    if (!link.name) return { ok: false, reason: "no_name" };
    displayName = link.name;
    details.name = { source: `link:${change.name.from}`, explicit: true };
  }

  if (change.picture && "initials" in change.picture) {
    avatarKey = null;
    details.picture = { source: "initials", explicit: true };
  } else if (change.picture && "from" in change.picture) {
    const link = await linkProfileOf(db, accountId, change.picture.from);
    if (!link) return { ok: false, reason: "unknown_source" };
    if (!link.avatarKey || !AVATAR_ASSET_PATTERN.test(link.avatarKey))
      return { ok: false, reason: "no_picture" };
    avatarKey = link.avatarKey;
    details.picture = { source: `link:${change.picture.from}`, explicit: true };
  } else if (change.picture) {
    const upload = await db.first<{ asset: string }>(
      `SELECT asset FROM account_avatars
        WHERE asset = ? AND account_id = ? AND origin = 'upload'`,
      change.picture.upload,
      accountId,
    );
    if (!upload) return { ok: false, reason: "unknown_upload" };
    avatarKey = upload.asset;
    details.picture = { source: "upload", explicit: true };
  }

  await db.run(
    `UPDATE accounts
        SET display_name = ?, avatar_key = ?, details_source_json = ?, birthdate = ?,
            birthdate_source = ?, modified_at = ?
      WHERE id = ?`,
    displayName,
    avatarKey,
    JSON.stringify(details),
    birthdate,
    birthdateSource,
    now,
    accountId,
  );
  if (account.avatar_key !== avatarKey)
    await releaseAvatars(env, db, [account.avatar_key]);
  return { ok: true };
}
