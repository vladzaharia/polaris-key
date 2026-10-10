import {
  PortalApiError,
  type PortalAvatar,
  type PortalProfile,
  type PortalProfileChange,
  type PortalProfileSource,
  type PortalProfileSourceOption,
} from "../api.js";
import { PROFILE_COPY, sourceParts } from "../copy/profile.js";
import { portalErrorCopy } from "../errors.js";

/**
 * Account → Profile's rules on the client (PORTAL.md §4.30; the Worker's are `card/profile.ts`).
 *
 * The editor keeps a **draft**: what the person chose in this edit, per value, or `null` for a
 * value they left alone. Saving sends only the chosen values, so an imported value nobody touched
 * keeps following its provider (rule 2) and everything sent sticks (rule 3: a typed name, a
 * picked method, an upload or Initials).
 */

/** A sign-in method by its own name (`methodLabel` in the Worker's `accounts/links.ts`). */
export function providerName(kind: string | null | undefined): string | null {
  switch (kind) {
    case "google":
      return "Google";
    case "apple":
      return "Apple";
    case "steam":
      return "Steam";
    case "gamecenter":
      return "Game Center";
    case "pgs":
      return "Google Play Games";
    case "eos":
      return "Epic Online Services";
    case "oidc":
      return "Single sign-on";
    default:
      return null;
  }
}

/** What the person chose for the name in this edit. */
export type NameDraft =
  | { kind: "typed"; value: string }
  | { kind: "from"; linkId: string }
  | null;

/** What the person chose for the picture in this edit. */
export type PictureDraft =
  | { kind: "initials" }
  | { kind: "from"; linkId: string }
  | { kind: "upload"; picture: PortalAvatar }
  | null;

/**
 * What the person did to the birth date in this edit (I-33): typed one (`""` while the field is
 * empty), removed it, or nothing.
 */
export type BirthdateDraft =
  | { kind: "typed"; value: string }
  | { kind: "removed" }
  | null;

export interface ProfileDraft {
  name: NameDraft;
  picture: PictureDraft;
  /** Absent in a draft made before I-33's field existed: nothing chosen. */
  birthdate?: BirthdateDraft;
}

export const NO_DRAFT: ProfileDraft = { name: null, picture: null };

/** The birth date the editor's field shows: `YYYY-MM-DD`, or `""` for none. */
export function draftBirthdate(
  profile: PortalProfile,
  draft: ProfileDraft,
): string {
  const d = draft.birthdate;
  if (d?.kind === "typed") return d.value;
  if (d?.kind === "removed") return "";
  return profile.birthdate ?? "";
}

/** The birth date's part of the PATCH: a new date, `null` to remove the saved one, or nothing. */
function birthdateChange(
  profile: PortalProfile,
  draft: ProfileDraft,
): string | null | undefined {
  const d = draft.birthdate;
  if (!d) return undefined;
  const saved = profile.birthdate ?? null;
  const value = d.kind === "removed" ? "" : d.value.trim();
  if (value === "") return saved ? null : undefined;
  return value === saved ? undefined : value;
}

/**
 * A birth date as the reader's locale writes it ("February 28, 1987"), read as a calendar day
 * (UTC), so no time zone moves it a day.
 */
export function formatBirthdate(value: string, locale?: string): string {
  const at = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(at);
}

/** Today in the reader's own calendar, `YYYY-MM-DD`: the field's latest date. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The earliest birth date the Worker takes (`BIRTHDATE_MIN`). */
export const BIRTHDATE_MIN = "1900-01-01";

/** The methods that supplied a name: the "Use a name from" chips. */
export function nameOptions(
  profile: PortalProfile,
): (PortalProfileSourceOption & { name: string })[] {
  return profile.sources.filter(
    (s): s is PortalProfileSourceOption & { name: string } => !!s.name,
  );
}

/** The methods that supplied a picture: the picture tiles. Apple never supplies one (§4.30). */
export function pictureOptions(
  profile: PortalProfile,
): (PortalProfileSourceOption & { picture: PortalAvatar })[] {
  return profile.sources.filter(
    (s): s is PortalProfileSourceOption & { picture: PortalAvatar } =>
      !!s.picture && s.provider !== "apple",
  );
}

function optionFor(
  profile: PortalProfile,
  linkId: string,
): PortalProfileSourceOption | undefined {
  return profile.sources.find((s) => s.linkId === linkId);
}

/** A typed name equal to the saved one changes nothing (no accidental pin by retyping it). */
function typedChanges(profile: PortalProfile, value: string): boolean {
  return collapse(value) !== collapse(profile.displayName ?? "");
}

/** Whitespace as the Worker keeps a name (`sanitizeDisplayName`): runs collapsed, ends trimmed. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The name the editor shows. */
export function draftName(
  profile: PortalProfile,
  draft: ProfileDraft,
  fallback: string,
): string {
  const d = draft.name;
  if (d?.kind === "typed") return d.value;
  if (d?.kind === "from") return optionFor(profile, d.linkId)?.name ?? "";
  return profile.displayName ?? fallback;
}

/** Where the editor's name comes from. */
export function draftNameSource(
  profile: PortalProfile,
  draft: ProfileDraft,
): { source: PortalProfileSource | null; explicit: boolean } {
  const d = draft.name;
  if (d?.kind === "typed" && typedChanges(profile, d.value))
    return { source: { kind: "typed" }, explicit: true };
  if (d?.kind === "from") {
    const o = optionFor(profile, d.linkId);
    return {
      source: {
        kind: "provider",
        linkId: d.linkId,
        provider: o?.provider ?? null,
      },
      explicit: true,
    };
  }
  return { source: profile.displayNameSource, explicit: profile.explicitName };
}

/** The picture tiles' ids: a method's (`link:<id>`), an upload, an orphan current picture, Initials. */
export type PictureTile = `link:${string}` | "upload" | "current" | "initials";

/** The tile the SAVED profile uses: it says **In use**. */
export function tileInUse(profile: PortalProfile): PictureTile {
  const pic = profile.picture;
  if (!pic) return "initials";
  const src = profile.pictureSource;
  if (src?.kind === "upload") return "upload";
  const options = pictureOptions(profile);
  // A method's tile is in use only while it still holds the very picture in use: a picked
  // picture sticks when its method later supplies a new one (rule 3), and that new one stays
  // pickable.
  if (
    src?.kind === "provider" &&
    options.some(
      (o) => o.linkId === src.linkId && o.picture.asset === pic.asset,
    )
  )
    return `link:${src.linkId}`;
  const byAsset = options.find((o) => o.picture.asset === pic.asset);
  return byAsset ? `link:${byAsset.linkId}` : "current";
}

/**
 * Why the picture in use has a tile of its own (`"current"`): its method was removed, or the
 * method has since supplied a newer picture (the provider's name), or neither is known (null).
 */
export function currentPictureOrigin(
  profile: PortalProfile,
): { removed: true } | { removed: false; provider: string | null } {
  const src = profile.pictureSource;
  if (src?.kind === "provider" && src.provider === null)
    return { removed: true };
  return {
    removed: false,
    provider: src?.kind === "provider" ? providerName(src.provider) : null,
  };
}

/** The tile the editor has selected. */
export function selectedTile(
  profile: PortalProfile,
  draft: ProfileDraft,
): PictureTile {
  const d = draft.picture;
  if (d?.kind === "initials") return "initials";
  if (d?.kind === "from") return `link:${d.linkId}`;
  if (d?.kind === "upload") return "upload";
  return tileInUse(profile);
}

/** The picture the editor's preview shows, with where it came from. */
export function draftPicture(
  profile: PortalProfile,
  draft: ProfileDraft,
): { picture: PortalAvatar | null; source: PortalProfileSource | null } {
  const d = draft.picture;
  if (d?.kind === "initials")
    return { picture: null, source: { kind: "initials" } };
  if (d?.kind === "upload")
    return { picture: d.picture, source: { kind: "upload" } };
  if (d?.kind === "from") {
    const o = optionFor(profile, d.linkId);
    return {
      picture: o?.picture ?? null,
      source: {
        kind: "provider",
        linkId: d.linkId,
        provider: o?.provider ?? null,
      },
    };
  }
  return { picture: profile.picture, source: profile.pictureSource };
}

/**
 * The draft for picking a tile. Picking the tile in use changes nothing when it was chosen; when
 * it only follows its source (an imported picture, or Initials because nothing supplied one), it
 * pins it, as a name chip does.
 */
export function pickTile(
  profile: PortalProfile,
  tile: PictureTile,
  upload: PortalAvatar | null,
): PictureDraft {
  if (tile === tileInUse(profile) && !(tile === "upload" && upload)) {
    if (profile.explicitPicture || tile === "current" || tile === "upload")
      return null;
    return tile === "initials"
      ? { kind: "initials" }
      : { kind: "from", linkId: tile.slice("link:".length) };
  }
  if (tile === "initials") return { kind: "initials" };
  if (tile === "upload")
    return upload ? { kind: "upload", picture: upload } : null;
  if (tile === "current") return null;
  return { kind: "from", linkId: tile.slice("link:".length) };
}

/**
 * The draft for a name chip. The method the saved name sticks to changes nothing while it still
 * supplies that same name; once the method's name has changed (a new Steam persona), picking it
 * takes the new one. A followed name is pinned.
 */
export function pickName(profile: PortalProfile, linkId: string): NameDraft {
  const src = profile.displayNameSource;
  if (
    src?.kind === "provider" &&
    src.linkId === linkId &&
    profile.explicitName &&
    profile.displayName === optionFor(profile, linkId)?.name
  )
    return null;
  return { kind: "from", linkId };
}

/**
 * The draft without the choices whose source is gone (after a refused save re-reads the profile:
 * a method removed, an upload collected). The name field then shows the saved name again.
 */
export function reconcileDraft(
  profile: PortalProfile,
  draft: ProfileDraft,
): ProfileDraft {
  const n = draft.name;
  const p = draft.picture;
  const name =
    n?.kind === "from" &&
    !nameOptions(profile).some((o) => o.linkId === n.linkId)
      ? null
      : n;
  const picture =
    p?.kind === "from" &&
    !pictureOptions(profile).some((o) => o.linkId === p.linkId)
      ? null
      : p;
  return name === n && picture === p ? draft : { ...draft, name, picture };
}

/** A typed name that is empty once trimmed: the editor refuses it before asking (`invalid_name`). */
export function nameInvalid(draft: ProfileDraft): boolean {
  return draft.name?.kind === "typed" && draft.name.value.trim() === "";
}

/** The PATCH body for the draft, or null when nothing was chosen. */
export function profileChange(
  profile: PortalProfile,
  draft: ProfileDraft,
): PortalProfileChange | null {
  const change: PortalProfileChange = {};
  const n = draft.name;
  if (n?.kind === "typed" && typedChanges(profile, n.value))
    change.name = collapse(n.value);
  else if (n?.kind === "from") change.nameFrom = n.linkId;
  const p = draft.picture;
  if (p?.kind === "initials") change.picture = "initials";
  else if (p?.kind === "from") change.picture = { from: p.linkId };
  else if (p?.kind === "upload" && p.picture.asset !== profile.picture?.asset)
    change.picture = { upload: p.picture.asset };
  const b = birthdateChange(profile, draft);
  if (b !== undefined) change.birthdate = b;
  return Object.keys(change).length ? change : null;
}

/**
 * "Steam (marafox)", "Google", or "a sign-in method you removed". A persona names which account
 * (frame 36); an address is left out, since it is often a relay (Apple's Hide My Email) and
 * Sign-in methods already lists it.
 */
function fromWhere(
  profile: PortalProfile,
  source: Extract<PortalProfileSource, { kind: "provider" }>,
): string {
  const name = providerName(source.provider);
  if (!name) return PROFILE_COPY["profile.removedMethod"];
  const label = optionFor(profile, source.linkId)?.label;
  return label && !label.includes("@") ? `${name} (${label})` : name;
}

/**
 * Where the name and picture came from, as Account's Profile card says it (§4.26): "Name typed by
 * you · picture from Steam (marafox)", "Name from Apple · Apple doesn't share a picture".
 */
export function sourceSummary(profile: PortalProfile): string {
  const parts: string[] = [];
  const n = profile.displayNameSource;
  if (n?.kind === "typed") parts.push(sourceParts.nameTyped);
  else if (n?.kind === "provider")
    parts.push(sourceParts.nameFrom(fromWhere(profile, n)));
  const p = profile.pictureSource;
  if (profile.picture) {
    if (p?.kind === "provider")
      parts.push(sourceParts.pictureFrom(fromWhere(profile, p)));
    else if (p?.kind === "upload") parts.push(sourceParts.pictureUploaded);
  } else if (p?.kind === "initials") parts.push(sourceParts.pictureInitials);
  else if (n?.kind === "provider" && n.provider === "apple")
    parts.push(sourceParts.appleNoPicture);
  else parts.push(sourceParts.noPicture);
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * The provider whose badge sits on the avatar: the picture's, or, without a picture, the name's
 * (frame 38: an Apple account's initials carry Apple's badge).
 */
export function badgeProvider(
  picture: PortalAvatar | null,
  pictureSource: PortalProfileSource | null,
  nameSource: PortalProfileSource | null,
): string | null {
  if (picture)
    return pictureSource?.kind === "provider" ? pictureSource.provider : null;
  return nameSource?.kind === "provider" ? nameSource.provider : null;
}

/** The distinct providers that supplied a name, by name: "signing in with Steam or Google". */
export function nameProviders(profile: PortalProfile): string[] {
  const out: string[] = [];
  for (const o of nameOptions(profile)) {
    const n = providerName(o.provider);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The upload's own limits (the Worker's `AVATAR_UPLOAD_MAX_BYTES` and `UPLOAD_TYPES`). */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const UPLOAD_TYPES: readonly string[] = ["image/png", "image/jpeg"];

/**
 * A refusal in the person's words (§6.4), chosen by the Worker's `reason` (PX-W16) and, for the
 * upload's rate limit and outage, its status. Anything else falls back to the portal's copy.
 */
export function profileErrorCopy(err: unknown, op: "save" | "upload"): string {
  if (err instanceof PortalApiError) {
    switch (err.reason) {
      case "invalid_name":
        return PROFILE_COPY["profile.error.invalidName"];
      case "invalid_birthdate":
        return PROFILE_COPY["profile.error.invalidBirthdate"];
      case "unknown_source":
        return PROFILE_COPY["profile.error.unknownSource"];
      case "no_name":
        return PROFILE_COPY["profile.error.noName"];
      case "no_picture":
        return PROFILE_COPY["profile.error.noPicture"];
      case "unknown_upload":
        return PROFILE_COPY["profile.error.unknownUpload"];
      case "too_large":
        if (op === "upload") return PROFILE_COPY["profile.error.tooLarge"];
        break;
      case "unsupported_type":
        return PROFILE_COPY["profile.error.unsupportedType"];
      case "unreadable_image":
        return PROFILE_COPY["profile.error.unreadableImage"];
    }
    if (op === "upload" && err.status === 429)
      return PROFILE_COPY["profile.error.uploadLimit"];
    if (op === "upload" && err.status === 503)
      return PROFILE_COPY["profile.error.uploadUnavailable"];
  }
  const copy = portalErrorCopy(err);
  return `${copy.title}. ${copy.description}`;
}
