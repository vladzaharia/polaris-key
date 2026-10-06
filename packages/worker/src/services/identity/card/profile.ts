/**
 * Profile import (I-07; S-16 owner decision "import profile data from identity providers";
 * PORTAL.md §4.29 item 3 and §4.30 rules 1–3, G32).
 *
 * At link time Polaris Key records what the provider supplied, per link (`profile_json`):
 * Google's name, picture and locale; Apple's name from the first authorisation only (the front
 * door passes it once, I-06); Steam's persona name and avatar; later the platform identities'
 * alias and avatar. Pictures are copied into R2 (`avatars.ts`).
 *
 * The account's personal details (`accounts.display_name`, `avatar_key`, `locale`) follow these
 * rules, with each value's source and an explicit-choice flag in `details_source_json`:
 *
 *   1. The first provider fills the profile (a new account takes the link's values).
 *   2. Follow until chosen: a value whose source is a link, never chosen explicitly, refreshes
 *      when the person signs in with that link again.
 *   3. Explicit choices stick: a name typed in the email gate (or, with I-11, a picked source, an
 *      upload or Initials) is never overwritten by a later sign-in.
 *
 * Every imported value is untrusted display data (THREAT-MODEL "Login card"): names lose control
 * and bidirectional-override characters and are cut to 64 characters; locales must look like a
 * BCP 47 tag; nothing is ever rendered as markup.
 */

import { hashKey, type Db, type Env } from "../../../core/platform.js";
import { copyAvatar, deleteAvatars, isAllowedAvatarUrl } from "./avatars.js";

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
  /** The R2 key of the copied picture. */
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

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

export function parseLinkProfile(raw: string | null | undefined): LinkProfile {
  const p = parseJson<Partial<LinkProfile>>(raw) ?? {};
  return {
    name: typeof p.name === "string" ? p.name : null,
    locale: typeof p.locale === "string" ? p.locale : null,
    pictureRef: typeof p.pictureRef === "string" ? p.pictureRef : null,
    avatarKey: typeof p.avatarKey === "string" ? p.avatarKey : null,
  };
}

/** Whether an avatar key is still named by any row. */
async function avatarReferenced(db: Db, key: string): Promise<boolean> {
  const row = await db.first<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM accounts WHERE avatar_key = ?) +
            (SELECT COUNT(*) FROM account_links
              WHERE json_extract(profile_json, '$.avatarKey') = ?) AS n`,
    key,
    key,
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Record a link's import: the sanitized name and locale, and the picture copied into R2 when its
 * URL changed. Answers the stored import and the key it replaced (if any), which the caller
 * removes once the account no longer points at it.
 */
async function storeLinkProfile(
  env: Env,
  db: Db,
  linkId: string,
  profile: ImportedProfile,
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
  const pictureRef = url
    ? await hashKey(`avatar-src:${url}`, env.KEY_HASH_PEPPER)
    : null;
  let avatarKey = before.avatarKey;
  let replaced: string | null = null;
  if (pictureRef !== before.pictureRef) {
    const copied = url ? await copyAvatar(env, url) : null;
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
 * never chosen). `explicitName` is the name the person typed in the email gate, which sticks.
 */
export async function importProfile(
  env: Env,
  db: Db,
  input: {
    accountId: string;
    linkId: string;
    profile: ImportedProfile;
    explicitName?: string | null;
    fill: "new" | "refresh";
  },
  now: number,
): Promise<void> {
  const { stored, replaced } = await storeLinkProfile(
    env,
    db,
    input.linkId,
    input.profile,
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
  const details = parseJson<DetailsSources>(account.details_source_json) ?? {};
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
  if (stored.avatarKey && follows(details.picture, account.avatar_key)) {
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
  const retired = [replaced, account.avatar_key].filter(
    (k): k is string => typeof k === "string" && k !== avatarKey,
  );
  const unused: string[] = [];
  for (const k of new Set(retired)) {
    if (!(await avatarReferenced(db, k))) unused.push(k);
  }
  await deleteAvatars(env, unused);
}
