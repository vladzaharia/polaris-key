import type { PortalAvatar, PortalProfile } from "../src/portal/api.js";

/**
 * Account → Profile fixtures (PX-22): the mockup cast's sign-in methods (PORTAL.md frames 36, 38
 * and 50), shaped like `GET /api/me/profile` (PX-W16).
 */
export const avatar = (seed: string): PortalAvatar => {
  const asset = seed.repeat(64).slice(0, 64);
  return {
    asset,
    url: `/media/avatar/${asset}`,
    url96: `/media/avatar/${asset}-96`,
  };
};

export const GOOGLE_PIC = avatar("a1");
export const STEAM_PIC = avatar("b2");
export const UPLOAD_PIC = avatar("c3");

export const GOOGLE = {
  linkId: "lnk_google",
  provider: "google",
  label: "mara.fennick@gmail.com",
  name: "Mara Fennick",
  picture: GOOGLE_PIC,
};
export const STEAM = {
  linkId: "lnk_steam",
  provider: "steam",
  label: "marafox",
  name: "marafox",
  picture: STEAM_PIC,
};
export const GAME_CENTER = {
  linkId: "lnk_gc",
  provider: "gamecenter",
  label: "Mara F.",
  name: "Mara F.",
  picture: null,
};

/** Frame 36: a typed name and the Steam picture, both chosen. */
export const CHOSEN: PortalProfile = {
  displayName: "Mara Fennick",
  displayNameSource: { kind: "typed" },
  explicitName: true,
  picture: STEAM_PIC,
  pictureSource: { kind: "provider", linkId: "lnk_steam", provider: "steam" },
  explicitPicture: true,
  locale: "en-GB",
  sources: [STEAM, GOOGLE, GAME_CENTER],
};

/** Imported from Google at sign-up and never chosen: both values follow Google. */
export const FOLLOWING: PortalProfile = {
  displayName: "Mara Fennick",
  displayNameSource: {
    kind: "provider",
    linkId: "lnk_google",
    provider: "google",
  },
  explicitName: false,
  picture: GOOGLE_PIC,
  pictureSource: { kind: "provider", linkId: "lnk_google", provider: "google" },
  explicitPicture: false,
  locale: "en-GB",
  sources: [GOOGLE, STEAM, GAME_CENTER],
};

/** Frame 38: Sam's Apple account (a name on first consent, never a picture). */
export const APPLE_ONLY: PortalProfile = {
  displayName: "Sam Okafor",
  displayNameSource: {
    kind: "provider",
    linkId: "lnk_apple",
    provider: "apple",
  },
  explicitName: false,
  picture: null,
  pictureSource: null,
  explicitPicture: false,
  locale: null,
  sources: [
    {
      linkId: "lnk_apple",
      provider: "apple",
      label: "x7k2mq9p4d@privaterelay.appleid.com",
      name: "Sam Okafor",
      picture: null,
    },
  ],
};

/** What the Worker's `updateProfile` does with a PATCH (`card/profile.ts`), for stateful mocks. */
export function applyChange(
  profile: PortalProfile,
  change: {
    name?: string;
    nameFrom?: string;
    picture?: "initials" | { from?: string; upload?: string };
    birthdate?: string | null;
  },
  uploads: readonly PortalAvatar[] = [],
): PortalProfile {
  const next = { ...profile };
  if (change.birthdate !== undefined) {
    next.birthdate = change.birthdate;
    next.birthdateSource = change.birthdate === null ? null : { kind: "user" };
  }
  if (change.name !== undefined) {
    next.displayName = change.name.trim();
    next.displayNameSource = { kind: "typed" };
    next.explicitName = true;
  } else if (change.nameFrom !== undefined) {
    const s = profile.sources.find((o) => o.linkId === change.nameFrom)!;
    next.displayName = s.name;
    next.displayNameSource = {
      kind: "provider",
      linkId: s.linkId,
      provider: s.provider,
    };
    next.explicitName = true;
  }
  const p = change.picture;
  if (p === "initials") {
    next.picture = null;
    next.pictureSource = { kind: "initials" };
    next.explicitPicture = true;
  } else if (p?.from) {
    const s = profile.sources.find((o) => o.linkId === p.from)!;
    next.picture = s.picture;
    next.pictureSource = {
      kind: "provider",
      linkId: s.linkId,
      provider: s.provider,
    };
    next.explicitPicture = true;
  } else if (p?.upload) {
    next.picture = uploads.find((u) => u.asset === p.upload) ?? null;
    next.pictureSource = { kind: "upload" };
    next.explicitPicture = true;
  }
  return next;
}
