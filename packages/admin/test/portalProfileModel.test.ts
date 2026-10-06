import { describe, expect, it } from "vitest";
import { PortalApiError } from "../src/portal/api.js";
import { avatarSrc } from "../src/portal/components/Avatar.js";
import {
  currentPictureOrigin,
  NO_DRAFT,
  pickName,
  reconcileDraft,
  pickTile,
  profileChange,
  profileErrorCopy,
  selectedTile,
  sourceSummary,
  tileInUse,
} from "../src/portal/model/profile.js";
import {
  APPLE_ONLY,
  avatar,
  CHOSEN,
  FOLLOWING,
  GOOGLE_PIC,
  STEAM_PIC,
  UPLOAD_PIC,
} from "./portalProfileFixture.js";

/** Account → Profile's client rules (PORTAL.md §4.30; PX-22). */

describe("profileChange: only what the person chose is sent (rules 2 and 3)", () => {
  it("sends nothing for an untouched draft", () => {
    expect(profileChange(FOLLOWING, NO_DRAFT)).toBeNull();
  });

  it("a typed name, trimmed; the same name retyped is no change", () => {
    expect(
      profileChange(FOLLOWING, {
        name: { kind: "typed", value: "  Mara F " },
        picture: null,
      }),
    ).toEqual({ name: "Mara F" });
    expect(
      profileChange(FOLLOWING, {
        name: { kind: "typed", value: "Mara Fennick " },
        picture: null,
      }),
    ).toBeNull();
  });

  it("a method's name; picking the method a chosen name already sticks to is no change", () => {
    expect(pickName(FOLLOWING, "lnk_google")).toEqual({
      kind: "from",
      linkId: "lnk_google",
    });
    const pinned = {
      ...FOLLOWING,
      explicitName: true,
    };
    expect(pickName(pinned, "lnk_google")).toBeNull();
    expect(
      profileChange(FOLLOWING, {
        name: pickName(FOLLOWING, "lnk_steam"),
        picture: null,
      }),
    ).toEqual({ nameFrom: "lnk_steam" });
  });

  it("pictures: a method's, Initials, an upload; the tile in use is no change", () => {
    expect(tileInUse(CHOSEN)).toBe("link:lnk_steam");
    expect(pickTile(CHOSEN, "link:lnk_steam", null)).toBeNull();
    expect(
      profileChange(CHOSEN, {
        name: null,
        picture: pickTile(CHOSEN, "link:lnk_google", null),
      }),
    ).toEqual({ picture: { from: "lnk_google" } });
    expect(
      profileChange(CHOSEN, {
        name: null,
        picture: pickTile(CHOSEN, "initials", null),
      }),
    ).toEqual({ picture: "initials" });
    expect(
      profileChange(CHOSEN, {
        name: null,
        picture: pickTile(CHOSEN, "upload", UPLOAD_PIC),
      }),
    ).toEqual({ picture: { upload: UPLOAD_PIC.asset } });
    // The saved upload, re-selected, is no change.
    const uploaded = {
      ...CHOSEN,
      picture: UPLOAD_PIC,
      pictureSource: { kind: "upload" as const },
    };
    expect(tileInUse(uploaded)).toBe("upload");
    expect(pickTile(uploaded, "upload", null)).toBeNull();
  });

  it("a picture whose method was removed has its own tile and stays put", () => {
    const orphan = {
      ...CHOSEN,
      picture: STEAM_PIC,
      pictureSource: {
        kind: "provider" as const,
        linkId: "lnk_gone",
        provider: null,
      },
      sources: CHOSEN.sources.filter((s) => s.linkId !== "lnk_steam"),
    };
    expect(tileInUse(orphan)).toBe("current");
    expect(selectedTile(orphan, NO_DRAFT)).toBe("current");
    expect(pickTile(orphan, "current", null)).toBeNull();
    expect(sourceSummary(orphan)).toBe(
      "Name typed by you · picture from a sign-in method you removed",
    );
  });

  it("Apple is never a picture tile, and no picture means Initials is in use", () => {
    expect(tileInUse(APPLE_ONLY)).toBe("initials");
  });
});

describe("a picked method that later changes stays re-pickable (review B1)", () => {
  // Steam was picked for both; then the person renamed themselves on Steam and changed avatar.
  // The Worker keeps the account's chosen values and records the new ones on the link.
  const NEW_STEAM = avatar("d4");
  const renamed = {
    ...CHOSEN,
    displayName: "marafox",
    displayNameSource: {
      kind: "provider" as const,
      linkId: "lnk_steam",
      provider: "steam",
    },
    explicitName: true,
    sources: CHOSEN.sources.map((s) =>
      s.linkId === "lnk_steam"
        ? { ...s, label: "marafox_2", name: "marafox_2", picture: NEW_STEAM }
        : s,
    ),
  };

  it("the Steam chip takes the new name", () => {
    expect(pickName(renamed, "lnk_steam")).toEqual({
      kind: "from",
      linkId: "lnk_steam",
    });
    expect(
      profileChange(renamed, {
        name: pickName(renamed, "lnk_steam"),
        picture: null,
      }),
    ).toEqual({ nameFrom: "lnk_steam" });
    // Unchanged on Steam: picking it again is still no change.
    expect(
      pickName({ ...renamed, displayName: "marafox_2" }, "lnk_steam"),
    ).toBeNull();
  });

  it("In use is the old picture's own tile, and the Steam tile takes the new picture", () => {
    expect(tileInUse(renamed)).toBe("current");
    expect(currentPictureOrigin(renamed)).toEqual({
      removed: false,
      provider: "Steam",
    });
    expect(pickTile(renamed, "link:lnk_steam", null)).toEqual({
      kind: "from",
      linkId: "lnk_steam",
    });
    expect(
      profileChange(renamed, {
        name: null,
        picture: pickTile(renamed, "link:lnk_steam", null),
      }),
    ).toEqual({ picture: { from: "lnk_steam" } });
  });
});

describe("re-picking what is followed pins it (review N1)", () => {
  it("a followed picture's tile pins it; a chosen one is no change", () => {
    expect(tileInUse(FOLLOWING)).toBe("link:lnk_google");
    expect(pickTile(FOLLOWING, "link:lnk_google", null)).toEqual({
      kind: "from",
      linkId: "lnk_google",
    });
    expect(pickTile(CHOSEN, "link:lnk_steam", null)).toBeNull();
  });

  it("an Apple-only account can pin Initials", () => {
    const draft = {
      name: null,
      picture: pickTile(APPLE_ONLY, "initials", null),
    };
    expect(profileChange(APPLE_ONLY, draft)).toEqual({ picture: "initials" });
  });
});

describe("names and drafts as the Worker keeps them (review N2, N3)", () => {
  it("whitespace collapses before comparing and sending", () => {
    expect(
      profileChange(FOLLOWING, {
        name: { kind: "typed", value: " Mara   Fennick " },
        picture: null,
      }),
    ).toBeNull();
    expect(
      profileChange(FOLLOWING, {
        name: { kind: "typed", value: "Mara   F " },
        picture: null,
      }),
    ).toEqual({ name: "Mara F" });
  });

  it("drops the choices whose method is gone after a re-read", () => {
    const gone = {
      ...FOLLOWING,
      sources: FOLLOWING.sources.filter((s) => s.linkId !== "lnk_steam"),
    };
    const draft = {
      name: { kind: "from" as const, linkId: "lnk_steam" },
      picture: { kind: "from" as const, linkId: "lnk_steam" },
    };
    expect(reconcileDraft(gone, draft)).toEqual(NO_DRAFT);
    const typed = {
      name: { kind: "typed" as const, value: "x" },
      picture: null,
    };
    expect(reconcileDraft(gone, typed)).toBe(typed);
  });
});

describe("sourceSummary (§4.26)", () => {
  it.each([
    [CHOSEN, "Name typed by you · picture from Steam (marafox)"],
    [FOLLOWING, "Name from Google · picture from Google"],
    [APPLE_ONLY, "Name from Apple · Apple doesn't share a picture"],
    [
      {
        ...CHOSEN,
        picture: null,
        pictureSource: { kind: "initials" as const },
      },
      "Name typed by you · initials instead of a picture",
    ],
    [
      {
        ...CHOSEN,
        displayNameSource: null,
        picture: null,
        pictureSource: null,
      },
      "No picture",
    ],
  ])("%#", (profile, line) => {
    expect(sourceSummary(profile)).toBe(line);
  });
});

describe("profileErrorCopy: from the Worker's reason, never its message", () => {
  const refusal = (status: number, reason?: string) => {
    const e = new PortalApiError(status, "bad_request");
    e.message = "raw worker message";
    if (reason) e.reason = reason;
    return e;
  };

  it.each([
    ["invalid_name", "save", "Enter a name."],
    [
      "no_name",
      "save",
      "That sign-in method didn't share a name. Choose another or type one.",
    ],
    [
      "unknown_upload",
      "save",
      "That upload has expired. Upload the picture again.",
    ],
    ["too_large", "upload", "Use a picture of 5 MB or less."],
    ["unsupported_type", "upload", "Use a PNG or JPEG picture."],
  ] as const)("%s", (reason, op, copy) => {
    expect(profileErrorCopy(refusal(400, reason), op)).toBe(copy);
  });

  it("an unknown case falls back to the portal's copy", () => {
    expect(profileErrorCopy(refusal(500), "save")).toBe(
      "Something went wrong. Try again. If it keeps happening, contact the developer.",
    );
    expect(profileErrorCopy(refusal(429), "upload")).toBe(
      "You can upload 10 pictures an hour. Try again later.",
    );
  });
});

describe("avatarSrc: stored same-origin pictures only", () => {
  it("takes the 96 px rendition up to 48 px and the 256 px one above", () => {
    expect(avatarSrc(GOOGLE_PIC.url, 32)).toBe(GOOGLE_PIC.url96);
    expect(avatarSrc(GOOGLE_PIC.url, 48)).toBe(GOOGLE_PIC.url96);
    expect(avatarSrc(GOOGLE_PIC.url, 56)).toBe(GOOGLE_PIC.url);
    expect(avatarSrc(GOOGLE_PIC.url96, 96)).toBe(GOOGLE_PIC.url96);
  });

  it("refuses anything else", () => {
    for (const url of [
      null,
      "",
      "https://lh3.googleusercontent.com/a/x",
      `https://key.plrs.im${GOOGLE_PIC.url}`,
      `${GOOGLE_PIC.url}?x=1`,
      "/media/avatar/abc",
      "/media/nightfall/icon",
    ])
      expect(avatarSrc(url, 32), String(url)).toBeNull();
  });
});
