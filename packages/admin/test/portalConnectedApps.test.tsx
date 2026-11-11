import { describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  NOW_S,
  axeViolations,
  fetchedRequests,
  mockFetch,
  renderPortal,
  signedIn,
  useCleanPortal,
} from "./portalHarness.js";

/**
 * Account → Connected apps (I-21.15): the list, Disconnect with its confirm, and the Change panel.
 * The routes are `GET`, `PATCH` and `DELETE /api/me/connected-apps`.
 */

const gets = (over: Record<string, Partial<{ granted: boolean }>> = {}) =>
  [
    { item: "name", granted: true, fixed: false },
    { item: "picture", granted: false, fixed: false },
    { item: "email", granted: true, fixed: true },
    { item: "entitlements", granted: true, fixed: true },
    { item: "offline", granted: true, fixed: true },
  ].map((g) => ({ ...g, ...over[g.item] }));

const COMPANION = {
  clientId: "cl_companion",
  name: "Quill Companion",
  developer: "Quill Studio",
  partner: false,
  iconUrl: null,
  returnHost: "companion.quill.example",
  available: true,
  gets: gets(),
  grantedAt: NOW_S - 86400 * 40,
  lastUsedAt: NOW_S - 3600,
};
const MAPS = {
  ...COMPANION,
  clientId: "cl_maps",
  name: "Hexside Maps",
  developer: "Hexside Ltd",
  partner: true,
  returnHost: null,
  lastUsedAt: null,
};
const OFF = {
  ...COMPANION,
  clientId: "cl_off",
  name: "Old Companion",
  available: false,
};
const group = (clients: unknown[]) => ({
  products: [{ product: "quill", name: "Quill", iconUrl: null, clients }],
});
const URL_OF = (id: string) => `/api/me/connected-apps/quill/${id}`;

useCleanPortal();

/** Switches the picture on in the open Change panel and saves. */
const savePicture = async (card: HTMLElement) => {
  await userEvent.click(
    within(card).getByRole("switch", {
      name: "Share your picture with Quill Companion",
    }),
  );
  await userEvent.click(within(card).getByRole("button", { name: "Save" }));
};

const accountSettled = () =>
  screen.findByRole("heading", { level: 1, name: "Account" });
const absent = () =>
  screen.queryByRole("region", { name: "Connected apps" }) === null;

const region = () => screen.findByRole("region", { name: "Connected apps" });

describe("Account → Connected apps", () => {
  it("lists each app under its product, with who made it, where it returns, and what it gets", async () => {
    mockFetch(
      signedIn([], { "/api/me/connected-apps": group([COMPANION, MAPS]) }),
    );
    renderPortal();
    const card = await region();
    expect(
      within(card).getByRole("heading", { name: "Signed in with Quill" }),
    ).toBeTruthy();
    const row = within(card).getByText("Quill Companion").closest("li")!;
    expect(within(row).getByText(/companion\.quill\.example · Last used/));
    expect(within(row).queryByText("by Quill Studio")).toBeNull();
    const chips = within(row).getByRole("list", {
      name: "What Quill Companion gets",
    });
    expect(within(chips).getByText("Your screen name")).toBeTruthy();
    expect(within(chips).getByText("Not your picture")).toBeTruthy();
    expect(
      within(chips).getByText("Which Quill features you have"),
    ).toBeTruthy();
    const maps = within(card).getByText("Hexside Maps").closest("li")!;
    expect(within(maps).getByText("by Hexside Ltd")).toBeTruthy();
    expect(within(maps).getByText(/^Connected /)).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "On this page" });
    expect(
      within(nav).getByRole("link", { name: "Connected apps" }),
    ).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it("is absent with nothing connected and on a Worker without the route", async () => {
    mockFetch(signedIn([], { "/api/me/connected-apps": { products: [] } }));
    renderPortal();
    await accountSettled();
    await waitFor(() =>
      expect(fetchedRequests()).toContain("GET /api/me/connected-apps"),
    );
    expect(absent()).toBe(true);
    cleanup();
    mockFetch(signedIn());
    renderPortal();
    await accountSettled();
    expect(absent()).toBe(true);
  });

  it("keeps an app its product turned off, with Disconnect only", async () => {
    mockFetch(signedIn([], { "/api/me/connected-apps": group([OFF]) }));
    renderPortal();
    const card = await region();
    expect(within(card).getByText("Quill turned this app off")).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "Disconnect Old Companion" }),
    ).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /^Change/ })).toBeNull();
    expect(within(card).queryByText("Your screen name")).toBeNull();
  });

  it("a failed load keeps the section, with the error and Try again", async () => {
    window.history.replaceState(null, "", "/#/account/apps");
    let fail = true;
    mockFetch(
      signedIn([], {
        "/api/me/connected-apps": () =>
          fail
            ? { status: 500, body: { error: "internal" } }
            : group([COMPANION]),
      }),
    );
    renderPortal();
    const card = await region();
    expect(
      await within(card).findByText("Couldn't load your connected apps."),
    ).toBeTruthy();
    fail = false;
    await userEvent.click(
      within(card).getByRole("button", { name: "Try again" }),
    );
    expect(await within(card).findByText("Quill Companion")).toBeTruthy();
  });

  describe("Disconnect", () => {
    it("says what happens, keeps the app on Keep, and ends it on confirm", async () => {
      let clients: unknown[] = [COMPANION, MAPS];
      mockFetch(
        signedIn([], {
          "/api/me/connected-apps": () => group(clients),
          [`DELETE ${URL_OF("cl_maps")}`]: () => {
            clients = [COMPANION];
            return { status: 204 };
          },
        }),
      );
      renderPortal();
      const card = await region();
      await userEvent.click(
        await within(card).findByRole("button", {
          name: "Disconnect Hexside Maps",
        }),
      );
      const heading = await within(card).findByRole("heading", {
        name: "Disconnect Hexside Maps?",
      });
      await waitFor(() => expect(document.activeElement).toBe(heading));
      expect(
        within(card).getByText(
          "Hexside Maps loses access within 10 minutes. It keeps what it already received; ask Hexside Ltd to delete it.",
        ),
      ).toBeTruthy();
      expect(
        within(card).getByText("Signing in again asks what to share."),
      ).toBeTruthy();
      await userEvent.click(
        within(card).getByRole("button", { name: "Keep Hexside Maps" }),
      );
      expect(fetchedRequests()).not.toContain(`DELETE ${URL_OF("cl_maps")}`);
      await userEvent.click(
        await within(card).findByRole("button", {
          name: "Disconnect Hexside Maps",
        }),
      );
      await userEvent.click(
        await within(card).findByRole("button", {
          name: "Disconnect Hexside Maps",
        }),
      );
      expect(
        await screen.findByText("Hexside Maps is disconnected"),
      ).toBeTruthy();
      await waitFor(() =>
        expect(within(card).queryByText("Hexside Maps")).toBeNull(),
      );
      expect(fetchedRequests()).toContain(`DELETE ${URL_OF("cl_maps")}`);
    });

    it("after the last app the card stays with a line and focus on its heading", async () => {
      let clients: unknown[] = [COMPANION];
      mockFetch(
        signedIn([], {
          "/api/me/connected-apps": () => group(clients),
          [`DELETE ${URL_OF("cl_companion")}`]: () => {
            clients = [];
            return { status: 204 };
          },
        }),
      );
      renderPortal();
      const card = await region();
      await userEvent.click(
        await within(card).findByRole("button", {
          name: "Disconnect Quill Companion",
        }),
      );
      await userEvent.click(
        await within(card).findByRole("button", {
          name: "Disconnect Quill Companion",
        }),
      );
      expect(await within(card).findByText("No connected apps.")).toBeTruthy();
      const heading = within(card).getByRole("heading", {
        name: "Connected apps",
      });
      await waitFor(() => expect(document.activeElement).toBe(heading));
    });

    it("a refused Disconnect keeps the row and says so; a rate limit says to wait", async () => {
      let status = 500;
      mockFetch(
        signedIn([], {
          "/api/me/connected-apps": group([COMPANION]),
          [`DELETE ${URL_OF("cl_companion")}`]: () => ({
            status,
            body: { error: status === 429 ? "rate_limited" : "internal" },
          }),
        }),
      );
      renderPortal();
      const card = await region();
      const open = async () =>
        userEvent.click(
          await within(card).findByRole("button", {
            name: "Disconnect Quill Companion",
          }),
        );
      await open();
      await userEvent.click(
        await within(card).findByRole("button", {
          name: "Disconnect Quill Companion",
        }),
      );
      expect(
        await within(card).findByText(
          "Couldn't disconnect Quill Companion. Try again.",
        ),
      ).toBeTruthy();
      status = 429;
      await userEvent.click(
        within(card).getByRole("button", {
          name: "Disconnect Quill Companion",
        }),
      );
      const alert = await within(card).findByText(/Too many attempts/);
      expect(alert.textContent).not.toMatch(/Disconnect|Change/);
      expect(within(card).getByText("Quill Companion")).toBeTruthy();
    });
  });

  describe("Change", () => {
    const open = async (card: HTMLElement) => {
      await userEvent.click(
        await within(card).findByRole("button", {
          name: "Change what Quill Companion gets",
        }),
      );
      return within(card).findByRole("heading", {
        name: "What Quill Companion gets",
      });
    };

    it("offers a switch for the optional items already decided, and marks the rest as needed", async () => {
      mockFetch(signedIn([], { "/api/me/connected-apps": group([COMPANION]) }));
      renderPortal();
      const card = await region();
      const heading = await open(card);
      await waitFor(() => expect(document.activeElement).toBe(heading));
      const name = within(card).getByRole("switch", {
        name: "Share your screen name with Quill Companion",
      });
      expect(name.getAttribute("aria-checked")).toBe("true");
      expect(
        within(card)
          .getByRole("switch", {
            name: "Share your picture with Quill Companion",
          })
          .getAttribute("aria-checked"),
      ).toBe("false");
      expect(
        within(card).getAllByText("Needed by Quill Companion"),
      ).toHaveLength(3);
      expect(within(card).queryByRole("switch", { name: /email/ })).toBeNull();
      expect(
        (
          within(card).getByRole("button", {
            name: "Save",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });

    it("saves only what moved, says so, and returns focus to Change", async () => {
      let body: unknown = null;
      mockFetch(
        signedIn([], {
          "/api/me/connected-apps": group([COMPANION]),
          [`PATCH ${URL_OF("cl_companion")}`]: (
            init: RequestInit | undefined,
          ) => {
            body = JSON.parse(String(init?.body));
            return { ...COMPANION, gets: gets({ picture: { granted: true } }) };
          },
        }),
      );
      renderPortal();
      const card = await region();
      await open(card);
      await savePicture(card);
      expect(await screen.findByText("Saved")).toBeTruthy();
      expect(body).toEqual({ claims: { picture: true } });
      const change = within(card).getByRole("button", {
        name: "Change what Quill Companion gets",
      });
      await waitFor(() => expect(document.activeElement).toBe(change));
    });

    it("Cancel and Escape drop the draft and return focus to Change", async () => {
      mockFetch(signedIn([], { "/api/me/connected-apps": group([COMPANION]) }));
      renderPortal();
      const card = await region();
      await open(card);
      await userEvent.click(
        within(card).getByRole("switch", {
          name: "Share your picture with Quill Companion",
        }),
      );
      await userEvent.keyboard("{Escape}");
      const change = within(card).getByRole("button", {
        name: "Change what Quill Companion gets",
      });
      await waitFor(() => expect(document.activeElement).toBe(change));
      await open(card);
      expect(
        within(card)
          .getByRole("switch", {
            name: "Share your picture with Quill Companion",
          })
          .getAttribute("aria-checked"),
      ).toBe("false");
      expect(fetchedRequests().some((r) => r.startsWith("PATCH"))).toBe(false);
    });

    it("a changed app (409) keeps the panel and offers Reload, which reads the list again", async () => {
      let reads = 0;
      mockFetch(
        signedIn([], {
          "/api/me/connected-apps": () => {
            reads += 1;
            return group([COMPANION]);
          },
          [`PATCH ${URL_OF("cl_companion")}`]: {
            status: 409,
            body: { error: "conflict" },
          },
        }),
      );
      renderPortal();
      const card = await region();
      await open(card);
      await savePicture(card);
      expect(
        await within(card).findByText(/This app's access changed\./),
      ).toBeTruthy();
      expect(
        within(card)
          .getByRole("switch", {
            name: "Share your picture with Quill Companion",
          })
          .getAttribute("aria-checked"),
      ).toBe("true");
      const before = reads;
      await userEvent.click(
        within(card).getByRole("button", { name: "Reload" }),
      );
      await waitFor(() => expect(reads).toBeGreaterThan(before));
    });

    it("a gone app (404) leaves the list and closes the panel", async () => {
      let clients: unknown[] = [COMPANION];
      mockFetch(
        signedIn([], {
          "/api/me/connected-apps": () => group(clients),
          [`PATCH ${URL_OF("cl_companion")}`]: () => {
            clients = [MAPS];
            return { status: 404, body: { error: "not_found" } };
          },
        }),
      );
      renderPortal();
      const card = await region();
      await open(card);
      await savePicture(card);
      await waitFor(() =>
        expect(within(card).queryByText("Quill Companion")).toBeNull(),
      );
      expect(within(card).getByText("Hexside Maps")).toBeTruthy();
    });

    it("a rate limit on Save names the wait and nothing about Disconnect", async () => {
      mockFetch(
        signedIn([], {
          "/api/me/connected-apps": group([COMPANION]),
          [`PATCH ${URL_OF("cl_companion")}`]: {
            status: 429,
            body: { error: "rate_limited" },
          },
        }),
      );
      renderPortal();
      const card = await region();
      await open(card);
      await savePicture(card);
      const alert = await within(card).findByText(/Too many attempts/);
      expect(alert.textContent).not.toMatch(/Disconnect/);
    });
  });
});
