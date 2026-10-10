import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PortalProfile } from "../src/portal/api.js";
import { Avatar } from "../src/portal/components/Avatar.js";
import {
  ACCOUNT,
  axeViolations,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
  type MockRoute,
} from "./portalHarness.js";
import {
  APPLE_ONLY,
  applyChange,
  CHOSEN,
  FOLLOWING,
  STEAM_PIC,
  UPLOAD_PIC,
} from "./portalProfileFixture.js";

/**
 * Account → Profile (PORTAL.md §4.30, PX-22): the Profile card, the in-place editor (name chips,
 * picture tiles, upload, the Your choice tag), explicit choices that stick, refusals worded from
 * the Worker's `reason`, and the one `Avatar` (never a picture before authentication).
 */

beforeEach(() => {
  window.history.replaceState(null, "", "/#/account/profile");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The PATCH bodies sent so far. */
function patches(): unknown[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === "PATCH")
    .map(([, init]) => JSON.parse(String(init!.body)));
}

/** A stateful profile route: GET answers the current profile, PATCH applies a change. */
function profileRoutes(
  start: PortalProfile,
  extra: Record<string, MockRoute> = {},
): Record<string, MockRoute> {
  let profile = start;
  return signedIn([], {
    "GET /api/me/profile": () => ({ profile }),
    "PATCH /api/me/profile": (init: RequestInit | undefined) => {
      const headers = new Headers(init?.headers);
      if (headers.get("X-PKey-Portal-CSRF") !== "csrf-token")
        return { status: 403, body: { error: "forbidden" } };
      profile = applyChange(profile, JSON.parse(String(init!.body)), [
        UPLOAD_PIC,
      ]);
      return { profile };
    },
    ...extra,
  });
}

async function openProfile(): Promise<HTMLElement> {
  renderPortal();
  const card = await screen.findByRole("region", { name: "Profile" });
  await within(card).findByRole("button", { name: "Edit profile" });
  return card;
}

async function openEditor(): Promise<HTMLElement> {
  const card = await openProfile();
  await userEvent.click(
    within(card).getByRole("button", { name: "Edit profile" }),
  );
  await within(card).findByRole("textbox", { name: "Screen name" });
  return card;
}

describe("the Profile card (§4.26)", () => {
  it("leads Account: picture, name, where each came from, Edit profile", async () => {
    mockFetch(profileRoutes(CHOSEN));
    const card = await openProfile();
    const nav = screen.getByRole("navigation", { name: "On this page" });
    expect(within(nav).getAllByRole("link")[0]!.textContent).toBe("Profile");
    expect(within(card).getByText("Mara Fennick")).toBeTruthy();
    expect(
      within(card).getByText(
        "Name typed by you · picture from Steam (marafox)",
      ),
    ).toBeTruthy();
    const img = card.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(STEAM_PIC.url);
    expect(img.getAttribute("alt")).toBe("");
    // The badge of the provider the picture came from.
    expect(card.querySelector("[data-avatar] svg")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Add a picture" })).toBe(
      null,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it("an Apple account says Apple shares no picture and offers Add a picture (frame 38)", async () => {
    mockFetch(profileRoutes(APPLE_ONLY));
    const card = await openProfile();
    expect(
      within(card).getByText("Name from Apple · Apple doesn't share a picture"),
    ).toBeTruthy();
    expect(card.querySelector("img")).toBeNull();
    await userEvent.click(
      within(card).getByRole("button", { name: "Add a picture" }),
    );
    // No method supplied a picture, so focus lands on Upload; Apple is never a picture tile.
    const upload = await within(card).findByRole("button", { name: "Upload" });
    await waitFor(() => expect(document.activeElement).toBe(upload));
    const picture = within(card).getByRole("group", { name: "Picture" });
    expect(
      within(picture)
        .getAllByRole("radio")
        .map((r) => r.closest("label")!.getAttribute("data-tile")),
    ).toEqual(["initials"]);
  });

  it("on a Worker without the profile route: the session's name and initials, no editor", async () => {
    mockFetch(signedIn());
    renderPortal();
    const card = await screen.findByRole("region", { name: "Profile" });
    expect(await within(card).findByText("Mara Fennick")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Edit profile" })).toBe(
      null,
    );
    expect(card.querySelector("img")).toBeNull();
  });

  it("a failed read says so and retries", async () => {
    let fail = true;
    mockFetch(
      signedIn([], {
        "GET /api/me/profile": () =>
          fail
            ? { status: 500, body: { error: "internal" } }
            : { profile: CHOSEN },
      }),
    );
    renderPortal();
    const card = await screen.findByRole("region", { name: "Profile" });
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toContain("Your profile didn't load");
    fail = false;
    await userEvent.click(
      within(alert).getByRole("button", { name: "Try again" }),
    );
    expect(
      await within(card).findByRole("button", { name: "Edit profile" }),
    ).toBeTruthy();
  });
});

describe("explicit choices (§4.30 rules 2 and 3)", () => {
  it("a typed name is Your choice and sticks; untouched values are not sent", async () => {
    mockFetch(profileRoutes(FOLLOWING));
    const card = await openEditor();
    const field = within(card).getByRole("textbox", { name: "Screen name" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    // Imported and never chosen: it follows Google, and there is no Your choice tag.
    expect(
      within(card).getByText(
        "This name comes from Google and follows it until you type or pick one yourself.",
      ),
    ).toBeTruthy();
    expect(within(card).getByText("Your choice").hidden).toBe(true);

    await userEvent.clear(field);
    await userEvent.type(field, "Mara F");
    expect(within(card).getByText("Your choice").hidden).toBe(false);
    expect(
      within(card).getByText(
        "You typed this name, so signing in with Google, Steam or Game Center won't change it.",
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(card).getByRole("button", { name: "Save profile" }),
    );
    // Only the name: the picture still follows Google.
    await waitFor(() => expect(patches()).toEqual([{ name: "Mara F" }]));
    expect(
      await within(card).findByText("Name typed by you · picture from Google"),
    ).toBeTruthy();
    expect(await screen.findByText("Profile saved")).toBeTruthy();
    const edit = within(card).getByRole("button", { name: "Edit profile" });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    // The header chip follows the saved name at once.
    expect(
      screen.getByRole("button", { name: "Account: Mara F" }),
    ).toBeTruthy();
  });

  it("a name chip picks a method's name and says it sticks", async () => {
    mockFetch(profileRoutes(FOLLOWING));
    const card = await openEditor();
    const chip = within(card).getByRole("button", {
      name: "Use the name marafox from Steam",
    });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(
      (
        within(card).getByRole("textbox", {
          name: "Screen name",
        }) as HTMLInputElement
      ).value,
    ).toBe("marafox");
    expect(
      within(card).getByText(
        "You picked the name from Steam, so signing in won't change it.",
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(card).getByRole("button", { name: "Save profile" }),
    );
    await waitFor(() => expect(patches()).toEqual([{ nameFrom: "lnk_steam" }]));
    expect(
      await within(card).findByText(
        "Name from Steam (marafox) · picture from Google",
      ),
    ).toBeTruthy();
  });

  it("picture tiles: In use on the saved one; a method's picture or Initials is sent alone", async () => {
    mockFetch(profileRoutes(CHOSEN));
    const card = await openEditor();
    const picture = within(card).getByRole("group", { name: "Picture" });
    const radios = within(picture).getAllByRole("radio") as HTMLInputElement[];
    expect(
      radios.map((r) => r.closest("label")!.getAttribute("data-tile")),
    ).toEqual(["link:lnk_steam", "link:lnk_google", "initials"]);
    const steam = within(picture).getByRole("radio", { name: /Steam/ });
    expect((steam as HTMLInputElement).checked).toBe(true);
    expect(steam.closest("label")!.textContent).toContain("In use");
    await userEvent.click(
      within(picture).getByRole("radio", { name: /Initials/ }),
    );
    // The preview shows the initials now.
    const preview = card.querySelector("[data-profile-preview]")!;
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.textContent).toContain("MF");
    await userEvent.click(
      within(card).getByRole("button", { name: "Save profile" }),
    );
    await waitFor(() => expect(patches()).toEqual([{ picture: "initials" }]));
    expect(
      await within(card).findByText(
        "Name typed by you · initials instead of a picture",
      ),
    ).toBeTruthy();
    // A typed name and Initials: no provider, so no (empty) badge on the avatar.
    expect(card.querySelector("[data-avatar]")!.children).toHaveLength(1);
  });

  it("a picked Steam picture that Steam has since replaced keeps its own tile; the new one is pickable", async () => {
    const NEW_STEAM = { ...STEAM_PIC, asset: "d4".repeat(32) };
    NEW_STEAM.url = `/media/avatar/${NEW_STEAM.asset}`;
    NEW_STEAM.url96 = `${NEW_STEAM.url}-96`;
    mockFetch(
      profileRoutes({
        ...CHOSEN,
        sources: CHOSEN.sources.map((o) =>
          o.linkId === "lnk_steam" ? { ...o, picture: NEW_STEAM } : o,
        ),
      }),
    );
    const card = await openEditor();
    const picture = within(card).getByRole("group", { name: "Picture" });
    const current = within(picture).getByRole("radio", {
      name: /Current picture/,
    }) as HTMLInputElement;
    expect(current.checked).toBe(true);
    expect(current.closest("label")!.textContent).toContain(
      "An earlier picture from Steam",
    );
    expect(current.closest("label")!.textContent).toContain("In use");
    await userEvent.click(
      within(picture).getByRole("radio", { name: /^Steam/ }),
    );
    await userEvent.click(
      within(card).getByRole("button", { name: "Save profile" }),
    );
    await waitFor(() =>
      expect(patches()).toEqual([{ picture: { from: "lnk_steam" } }]),
    );
  });

  it("choosing nothing, or retyping the saved name, saves nothing", async () => {
    mockFetch(profileRoutes(FOLLOWING));
    const card = await openEditor();
    const field = within(card).getByRole("textbox", { name: "Screen name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Mara Fennick");
    expect(within(card).getByText("Your choice").hidden).toBe(true);
    await userEvent.click(
      within(card).getByRole("button", { name: "Save profile" }),
    );
    expect(
      await within(card).findByRole("button", { name: "Edit profile" }),
    ).toBeTruthy();
    expect(patches()).toEqual([]);
  });

  it("Cancel discards the draft and returns focus to Edit profile", async () => {
    mockFetch(profileRoutes(CHOSEN));
    const card = await openEditor();
    await userEvent.type(
      within(card).getByRole("textbox", { name: "Screen name" }),
      " Jr",
    );
    await userEvent.click(within(card).getByRole("button", { name: "Cancel" }));
    const edit = await within(card).findByRole("button", {
      name: "Edit profile",
    });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(within(card).getByText("Mara Fennick")).toBeTruthy();
    expect(patches()).toEqual([]);
  });

  it("an empty name is refused before asking", async () => {
    mockFetch(profileRoutes(CHOSEN));
    const card = await openEditor();
    const field = within(card).getByRole("textbox", { name: "Screen name" });
    await userEvent.clear(field);
    await userEvent.click(
      within(card).getByRole("button", { name: "Save profile" }),
    );
    expect(within(card).getByRole("alert").textContent).toBe("Enter a name.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field);
    expect(patches()).toEqual([]);
  });

  it("words a save refusal from its reason, on the field it belongs to", async () => {
    mockFetch(
      profileRoutes(FOLLOWING, {
        "PATCH /api/me/profile": {
          status: 400,
          body: {
            error: "bad_request",
            reason: "no_picture",
            message: "That sign-in method didn't share a picture.",
          },
        },
      }),
    );
    const card = await openEditor();
    await userEvent.click(
      within(within(card).getByRole("group", { name: "Picture" })).getByRole(
        "radio",
        { name: /Steam/ },
      ),
    );
    await userEvent.click(
      within(card).getByRole("button", { name: "Save profile" }),
    );
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toBe(
      "That sign-in method didn't share a picture. Choose another picture.",
    );
    expect(
      within(card)
        .getByRole("group", { name: "Picture" })
        .getAttribute("aria-describedby"),
    ).toBe(alert.id);
  });

  it("is axe-clean while editing", async () => {
    mockFetch(profileRoutes(CHOSEN));
    await openEditor();
    expect(await axeViolations()).toEqual([]);
  });
});

describe("the birth date (I-33): optional, private, added, changed and removed here", () => {
  const birthField = (card: HTMLElement) =>
    within(card).getByLabelText("Birth date") as HTMLInputElement;

  it("says it is optional and private, and the card shows nothing while there is none", async () => {
    mockFetch(profileRoutes(CHOSEN));
    const card = await openProfile();
    expect(within(card).queryByText(/^Born /)).toBeNull();
    await userEvent.click(
      within(card).getByRole("button", { name: "Edit profile" }),
    );
    const field = birthField(card);
    expect(field.type).toBe("date");
    expect(field.value).toBe("");
    expect(field.min).toBe("1900-01-01");
    expect(field.autocomplete).toBe("bday");
    expect(within(card).getByText("Optional")).toBeTruthy();
    const hint = within(card).getByText(
      "Private to you. Apps never receive it.",
    );
    expect(field.getAttribute("aria-describedby")).toBe(hint.id);
    expect(
      within(card).queryByRole("button", { name: "Remove birth date" }),
    ).toBeNull();
  });

  it("a typed date is sent alone, and the card then shows it in the reader's words", async () => {
    mockFetch(profileRoutes(CHOSEN));
    const card = await openEditor();
    await userEvent.type(birthField(card), "1987-02-28");
    await userEvent.click(
      within(card).getByRole("button", { name: "Save profile" }),
    );
    await waitFor(() =>
      expect(patches()).toEqual([{ birthdate: "1987-02-28" }]),
    );
    expect(
      await within(card).findByText("Born February 28, 1987"),
    ).toBeTruthy();
  });

  it("Remove birth date sends null and moves focus to the emptied field", async () => {
    mockFetch(profileRoutes({ ...CHOSEN, birthdate: "1987-02-28" }));
    const card = await openProfile();
    expect(within(card).getByText("Born February 28, 1987")).toBeTruthy();
    await userEvent.click(
      within(card).getByRole("button", { name: "Edit profile" }),
    );
    expect(birthField(card).value).toBe("1987-02-28");
    await userEvent.click(
      within(card).getByRole("button", { name: "Remove birth date" }),
    );
    expect(birthField(card).value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(birthField(card)));
    await userEvent.click(
      within(card).getByRole("button", { name: "Save profile" }),
    );
    await waitFor(() => expect(patches()).toEqual([{ birthdate: null }]));
    await waitFor(() => expect(within(card).queryByText(/^Born /)).toBeNull());
  });

  it("an unchanged date, or none touched, sends nothing", async () => {
    mockFetch(profileRoutes({ ...CHOSEN, birthdate: "1987-02-28" }));
    const card = await openEditor();
    const field = birthField(card);
    await userEvent.clear(field);
    await userEvent.type(field, "1987-02-28");
    await userEvent.click(
      within(card).getByRole("button", { name: "Save profile" }),
    );
    await waitFor(() =>
      expect(
        within(card).queryByRole("button", { name: "Save profile" }),
      ).toBeNull(),
    );
    expect(patches()).toEqual([]);
  });

  it("the Worker's invalid_birthdate lands on the field, worded for a person, and the input stays", async () => {
    mockFetch(
      profileRoutes(CHOSEN, {
        "PATCH /api/me/profile": {
          status: 400,
          body: {
            error: "bad_request",
            reason: "invalid_birthdate",
            message: "Enter a real date, no later than today.",
          },
        },
      }),
    );
    const card = await openEditor();
    await userEvent.type(birthField(card), "2023-02-28");
    await userEvent.click(
      within(card).getByRole("button", { name: "Save profile" }),
    );
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toBe("Enter a real date, no later than today.");
    const field = birthField(card);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toContain(alert.id);
    expect(field.value).toBe("2023-02-28");
    expect(document.activeElement).toBe(field);
    expect(await axeViolations()).toEqual([]);
  });
});

describe("upload (§4.30, G33)", () => {
  const png = (bytes = 64) =>
    new File([new Uint8Array(bytes)], "me.png", { type: "image/png" });

  it("uploads the bytes, selects Your upload, and saves it as an explicit choice", async () => {
    let uploaded: { body: unknown; headers: Headers } | null = null;
    mockFetch(
      profileRoutes(CHOSEN, {
        "POST /api/me/profile/picture": (init: RequestInit | undefined) => {
          uploaded = { body: init?.body, headers: new Headers(init?.headers) };
          return { status: 201, body: { upload: UPLOAD_PIC } };
        },
      }),
    );
    const card = await openEditor();
    const file = png();
    await userEvent.upload(
      card.querySelector<HTMLInputElement>("input[type=file]")!,
      file,
    );
    await waitFor(() => expect(uploaded).not.toBeNull());
    expect(uploaded!.body).toBe(file);
    expect(uploaded!.headers.get("Content-Type")).toBe("image/png");
    expect(uploaded!.headers.get("X-PKey-Portal-CSRF")).toBe("csrf-token");
    const mine = await within(card).findByRole("radio", {
      name: /Your upload/,
    });
    expect((mine as HTMLInputElement).checked).toBe(true);
    const preview = card.querySelector("[data-profile-preview] img")!;
    expect(preview.getAttribute("src")).toBe(UPLOAD_PIC.url);
    await userEvent.click(
      within(card).getByRole("button", { name: "Save profile" }),
    );
    await waitFor(() =>
      expect(patches()).toEqual([{ picture: { upload: UPLOAD_PIC.asset } }]),
    );
    expect(
      await within(card).findByText(
        "Name typed by you · picture uploaded by you",
      ),
    ).toBeTruthy();
  });

  it("refuses a picture over 5 MB without sending it", async () => {
    mockFetch(profileRoutes(CHOSEN));
    const card = await openEditor();
    await userEvent.upload(
      card.querySelector<HTMLInputElement>("input[type=file]")!,
      png(5 * 1024 * 1024 + 1),
    );
    expect((await within(card).findByRole("alert")).textContent).toBe(
      "Use a picture of 5 MB or less.",
    );
    expect(fetchedRequests()).not.toContain("POST /api/me/profile/picture");
  });

  for (const [answer, copy] of [
    [
      {
        status: 415,
        body: {
          error: "bad_request",
          reason: "unsupported_type",
          message: "Use a PNG or JPEG picture.",
        },
      },
      "Use a PNG or JPEG picture.",
    ],
    [
      {
        status: 422,
        body: {
          error: "bad_request",
          reason: "unreadable_image",
          message: "x",
        },
      },
      "We couldn't read that picture. Try another PNG or JPEG.",
    ],
    [
      { status: 429, body: { error: "rate_limited" } },
      "You can upload 10 pictures an hour. Try again later.",
    ],
    [
      { status: 503, body: { error: "unavailable" } },
      "Picture uploads aren't available right now. Try again later.",
    ],
  ] as const) {
    it(`words ${answer.status} from its reason: "${copy}"`, async () => {
      mockFetch(
        profileRoutes(CHOSEN, { "POST /api/me/profile/picture": answer }),
      );
      const card = await openEditor();
      await userEvent.upload(
        card.querySelector<HTMLInputElement>("input[type=file]")!,
        png(),
      );
      expect((await within(card).findByRole("alert")).textContent).toBe(copy);
      expect(within(card).queryByRole("radio", { name: /Your upload/ })).toBe(
        null,
      );
    });
  }
});

describe("Avatar: never a picture before authentication (§4.30 rule 4)", () => {
  it("the signed-out login card loads no picture and asks for no profile", async () => {
    window.history.replaceState(null, "", "/");
    mockFetch({
      "/api/me": { status: 401, body: { error: "unauthorized" } },
      "/api/capabilities": {
        auth: { oidc: false, magic: true, providers: ["google", "steam"] },
        modules: { licensing: true, claim: true, releases: true },
      },
    });
    renderPortal();
    expect(
      await screen.findByRole("heading", { level: 1, name: /Sign in/ }),
    ).toBeTruthy();
    expect(document.querySelector("img[src*='/media/avatar/']")).toBeNull();
    expect(document.querySelector("[data-avatar]")).toBeNull();
    expect(fetchedRequests().filter((r) => /profile|avatar/.test(r))).toEqual(
      [],
    );
  });

  it("signed in, the header chip and the menu show the session's picture (96 px)", async () => {
    window.history.replaceState(null, "", "/");
    mockFetch(
      signedIn([], {
        "/api/me": {
          account: { ...ACCOUNT, avatarUrl: STEAM_PIC.url },
          csrf: "csrf-token",
        },
      }),
    );
    renderPortal();
    const chip = await screen.findByRole("button", {
      name: `Account: ${ACCOUNT.name}`,
    });
    expect(chip.querySelector("img")!.getAttribute("src")).toBe(
      STEAM_PIC.url96,
    );
    await userEvent.click(chip);
    await screen.findAllByRole("menuitem");
    expect(document.querySelector("[role=menu] img")!.getAttribute("src")).toBe(
      STEAM_PIC.url96,
    );
  });

  it("loads only a stored same-origin picture; anything else, or a failed load, is initials", () => {
    for (const url of [
      "https://lh3.googleusercontent.com/a/ACg8ocK-mara=s96-c",
      "//avatars.steamstatic.com/abc_full.jpg",
      "/media/avatar/../../api/me",
      "/media/nightfall/icon",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
    ]) {
      const { container, unmount } = render(
        <Avatar name="Mara Fennick" email="m@x" picture={url} />,
      );
      expect(container.querySelector("img"), url).toBeNull();
      expect(container.textContent).toBe("MF");
      unmount();
    }
    const { container } = render(
      <Avatar name="Mara Fennick" email="m@x" picture={STEAM_PIC.url} />,
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(STEAM_PIC.url96);
    img.dispatchEvent(new Event("error"));
    return waitFor(() => {
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toBe("MF");
    });
  });
});
