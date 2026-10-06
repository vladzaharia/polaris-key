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

export interface ProfileDraft {
  name: NameDraft;
  picture: PictureDraft;
}

export const NO_DRAFT: ProfileDraft = { name: null, picture: null };

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
  return value.trim() !== (profile.displayName ?? "").trim();
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
  if (src?.kind === "provider" && options.some((o) => o.linkId === src.linkId))
    return `link:${src.linkId}`;
  // A picture whose method was disconnected, or one a method no longer supplies: match by asset.
  const byAsset = options.find((o) => o.picture.asset === pic.asset);
  return byAsset ? `link:${byAsset.linkId}` : "current";
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

/** The draft for picking a tile: picking the tile in use changes nothing. */
export function pickTile(
  profile: PortalProfile,
  tile: PictureTile,
  upload: PortalAvatar | null,
): PictureDraft {
  if (tile === tileInUse(profile) && !(tile === "upload" && upload))
    return null;
  if (tile === "initials") return { kind: "initials" };
  if (tile === "upload")
    return upload ? { kind: "upload", picture: upload } : null;
  if (tile === "current") return null;
  return { kind: "from", linkId: tile.slice("link:".length) };
}

/** The draft for a name chip: the method the saved name already sticks to changes nothing. */
export function pickName(profile: PortalProfile, linkId: string): NameDraft {
  const src = profile.displayNameSource;
  if (src?.kind === "provider" && src.linkId === linkId && profile.explicitName)
    return null;
  return { kind: "from", linkId };
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
    change.name = n.value.trim();
  else if (n?.kind === "from") change.nameFrom = n.linkId;
  const p = draft.picture;
  if (p?.kind === "initials") change.picture = "initials";
  else if (p?.kind === "from") change.picture = { from: p.linkId };
  else if (p?.kind === "upload" && p.picture.asset !== profile.picture?.asset)
    change.picture = { upload: p.picture.asset };
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
