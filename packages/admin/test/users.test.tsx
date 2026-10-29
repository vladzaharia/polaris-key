/**
 * Core → Users (I-12): the list keyed by pairwise subject, the sign-in columns only with Identity
 * on, the record's tabs, export and typed data deletion, detach, and the relink tool's step-up,
 * target and reason gates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  Me,
  ProductDetail,
  ProductUserDetail,
  ProductUserQuery,
  ProductUserResponse,
  ProductUsersPage,
  ProductUserSummary,
} from "../src/api.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const NOW = Math.floor(Date.now() / 1000);
const SUBJECT = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "ps_BBBBBBBBBBBBBBBBBBBBBB";
const ALIAS = "ps_CCCCCCCCCCCCCCCCCCCCCC";

const me = vi.fn<() => Promise<Me>>();
const product = vi.fn<(slug: string) => Promise<{ product: ProductDetail }>>();
const productUsers =
  vi.fn<(slug: string, q: ProductUserQuery) => Promise<ProductUsersPage>>();
const productUser =
  vi.fn<(slug: string, subject: string) => Promise<ProductUserResponse>>();
const productUserExport = vi.fn();
const deleteProductUserData = vi.fn();
const detachProductUserLicense = vi.fn();
const relinkProductUserLicense = vi.fn();
const undoRelink = vi.fn();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      me: () => me(),
      product: (s: string) => product(s),
      productUsers: (s: string, q: ProductUserQuery) => productUsers(s, q),
      productUser: (s: string, sub: string) => productUser(s, sub),
      productUserExport: (...a: unknown[]) => productUserExport(...a),
      deleteProductUserData: (...a: unknown[]) => deleteProductUserData(...a),
      detachProductUserLicense: (...a: unknown[]) =>
        detachProductUserLicense(...a),
      relinkProductUserLicense: (...a: unknown[]) =>
        relinkProductUserLicense(...a),
      undoRelink: (...a: unknown[]) => undoRelink(...a),
    },
  };
});

const { HttpError } = await import("../src/api.js");
const { UsersPage } =
  await import("../src/console/sections/core/pages/Users.js");
const { isSteppedUp, stepUpHref } =
  await import("../src/console/sections/core/pages/UserRelink.js");
const { useRoute } = await import("../src/console/router.js");

function meWith(authAt: number | null): Me {
  return {
    sub: "op1",
    name: "Ada",
    email: "ada@x.io",
    csrf: "c",
    platformAdmin: true,
    products: ["djdl"],
    authAt,
    stepUpMaxAgeSeconds: 300,
  } as unknown as Me;
}

function productWith(identity: boolean, connect = false): ProductDetail {
  return {
    slug: "djdl",
    name: "DJDL",
    services: {
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: false },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: identity },
      connect: { enabled: connect },
    },
  } as unknown as ProductDetail;
}

function row(over: Partial<ProductUserSummary> = {}): ProductUserSummary {
  return {
    subject: SUBJECT,
    createdAt: NOW - 1000,
    contactEmail: "buyer@x.io",
    contactSource: "license",
    licenses: 1,
    devices: 2,
    mergedFrom: 0,
    ...over,
  };
}

function detail(over: Partial<ProductUserDetail> = {}): ProductUserDetail {
  return {
    subject: SUBJECT,
    createdAt: NOW - 1000,
    identityOn: false,
    contact: { email: "buyer@x.io", source: "license" },
    name: null,
    mergedFrom: [],
    licenses: [
      {
        id: "lic_1",
        name: "Ada's license",
        email: "buyer@x.io",
        tierId: "pro",
        status: "active",
        activatedAt: NOW - 900,
        expiresAt: null,
      },
    ],
    devices: [],
    data: { bytes: 0, stores: [] },
    events: [],
    relinks: [],
    audit: [],
    ...over,
  };
}

function Routed() {
  const route = useRoute();
  return (
    <UsersPage
      slug="djdl"
      subject={route.kind === "product" ? route.id : undefined}
      tab={route.kind === "product" ? route.tab : undefined}
    />
  );
}

const mount = (hash: string) => renderAt(hash, <Routed />);

beforeEach(() => {
  resetCore();
  for (const m of [
    me,
    product,
    productUsers,
    productUser,
    productUserExport,
    deleteProductUserData,
    detachProductUserLicense,
    relinkProductUserLicense,
    undoRelink,
  ])
    m.mockReset();
  me.mockResolvedValue(meWith(NOW - 10));
  product.mockResolvedValue({ product: productWith(false) });
});

afterEach(cleanup);

describe("Users list", () => {
  it("lists subjects with no sign-in column while Identity is off", async () => {
    productUsers.mockResolvedValue({
      identityOn: false,
      users: [row()],
      nextCursor: null,
    });
    const { container } = mount("#/p/djdl/users");
    expect(await screen.findAllByText(SUBJECT)).not.toHaveLength(0);
    expect(screen.getAllByText("buyer@x.io").length).toBeGreaterThan(0);
    expect(screen.queryByText("Last sign-in")).toBeNull();
    await expectNoAxeViolations(container);
  });

  it("adds the sign-in column while Identity is on", async () => {
    productUsers.mockResolvedValue({
      identityOn: true,
      users: [row({ lastSignInAt: NOW - 60, signedInDevices: 1 })],
      nextCursor: null,
    });
    mount("#/p/djdl/users");
    expect((await screen.findAllByText("Last sign-in")).length).toBeGreaterThan(
      0,
    );
  });

  it("shows the readable support code beside each user, and nothing before one is asked for (I-41)", async () => {
    productUsers.mockResolvedValue({
      identityOn: false,
      users: [row({ supportCode: "K7M-4QX-9TZ" }), row({ supportCode: null })],
      nextCursor: null,
    });
    mount("#/p/djdl/users");
    expect((await screen.findAllByText("K7M-4QX-9TZ")).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("None yet")).toBeNull();
  });

  it("sends a support code as the search, however it was typed", async () => {
    productUsers.mockResolvedValue({
      identityOn: false,
      users: [row({ supportCode: "K7M-4QX-9TZ" })],
      nextCursor: null,
    });
    mount("#/p/djdl/users?q=k7m4qx9tz");
    await waitFor(() =>
      expect(productUsers).toHaveBeenCalledWith(
        "djdl",
        expect.objectContaining({ q: "k7m4qx9tz" }),
      ),
    );
  });

  it("a plain search finds no code note, and a code with no match says so with a way to search every product (I-41)", async () => {
    productUsers.mockResolvedValue({
      identityOn: false,
      users: [],
      nextCursor: null,
    });
    mount("#/p/djdl/users?q=john.smith");
    await screen.findByText(/match these filters/);
    expect(screen.queryByText(/never contain/)).toBeNull();
    expect(screen.queryByText(/One character is wrong/)).toBeNull();
    cleanup();
    mount("#/p/djdl/users?q=K7M-4QX-9TZ");
    expect(
      await screen.findByText(
        "No user of this product has support code K7M-4QX-9TZ",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Search all products" }),
    ).toBeTruthy();
  });

  it("says where a contact email came from", async () => {
    productUsers.mockResolvedValue({
      identityOn: false,
      users: [row({ contactSource: "consented", contactEmail: "a@x.io" })],
      nextCursor: null,
    });
    mount("#/p/djdl/users");
    expect(
      (await screen.findAllByText("Shared by the user")).length,
    ).toBeGreaterThan(0);
  });
});

describe("User record", () => {
  it("shows the subject, no sign-ins with Identity off, and the four tabs", async () => {
    productUser.mockResolvedValue({ user: detail() });
    mount(`#/p/djdl/users/${SUBJECT}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: SUBJECT }),
    ).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "User sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent?.replace(/\d+$/, "")),
    ).toEqual(["Overview", "Licenses", "Devices", "Activity"]);
    expect(screen.queryByRole("heading", { name: "Sign-ins" })).toBeNull();
  });

  const withDevice = () =>
    detail({
      devices: [
        {
          deviceId: "dev_1_aaaaaaaaaaaaaaaaaaaa",
          label: "Laptop",
          platform: "macos",
          appVersion: "1.0.0",
          status: "authorized",
          signedIn: false,
          lastSeen: NOW - 60,
        },
      ] as ProductUserDetail["devices"],
    });

  it("links Devices to the person's linked devices while Cloud Connect is on", async () => {
    productUser.mockResolvedValue({ user: withDevice() });
    product.mockResolvedValue({ product: productWith(false, true) });
    mount(`#/p/djdl/users/${SUBJECT}/devices`);
    const link = await screen.findByRole("link", { name: "Linked devices" });
    expect(link.getAttribute("href")).toContain(
      `connect/devices?subject=${SUBJECT}`,
    );
  });

  it("offers no linked-devices link while Cloud Connect is off", async () => {
    productUser.mockResolvedValue({ user: withDevice() });
    mount(`#/p/djdl/users/${SUBJECT}/devices`);
    await screen.findByRole("heading", { name: "Devices" });
    expect(screen.queryByRole("link", { name: "Linked devices" })).toBeNull();
  });

  it("shows the support code in the header with Copy, when the person has one (I-41)", async () => {
    productUser.mockResolvedValue({
      user: detail({ supportCode: "K7M-4QX-9TZ" }),
    });
    mount(`#/p/djdl/users/${SUBJECT}`);
    const group = await screen.findByRole("group", { name: "Support code" });
    expect(within(group).getByText("K7M-4QX-9TZ")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy support code" }),
    ).toBeTruthy();
  });

  it("spells the support code out behind a small toggle in the header (I-41s)", async () => {
    productUser.mockResolvedValue({
      user: detail({ supportCode: "K7M-4QX-9TZ" }),
    });
    mount(`#/p/djdl/users/${SUBJECT}`);
    const toggle = await screen.findByRole("button", { name: "Spell it out" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getAllByRole("list", { name: /^Part \d of 3$/ }),
    ).toHaveLength(3);
    expect(screen.getByText("Q as in Quebec")).toBeTruthy();
  });

  it("has no spell-out before the person has a support code (I-41s)", async () => {
    productUser.mockResolvedValue({ user: detail({ supportCode: null }) });
    mount(`#/p/djdl/users/${SUBJECT}`);
    await screen.findAllByText(SUBJECT);
    expect(screen.queryByRole("button", { name: "Spell it out" })).toBeNull();
  });

  it("lists sign-ins by method kind with Identity on", async () => {
    productUser.mockResolvedValue({
      user: detail({
        identityOn: true,
        signIns: [{ at: NOW - 30, method: "steam" }],
      }),
    });
    mount(`#/p/djdl/users/${SUBJECT}`);
    expect(await screen.findByText("Signed in with Steam")).toBeTruthy();
  });

  it("resolves a merged subject to the survivor's record", async () => {
    productUser.mockImplementation(async (_s, sub) =>
      sub === ALIAS
        ? { mergedInto: SUBJECT }
        : {
            user: detail({
              mergedFrom: [{ subject: ALIAS, mergedAt: NOW - 100 }],
            }),
          },
    );
    mount(`#/p/djdl/users/${ALIAS}`);
    expect(await screen.findByText(ALIAS)).toBeTruthy();
    await waitFor(() =>
      expect(window.location.hash).toBe(`#/p/djdl/users/${SUBJECT}`),
    );
    expect(screen.getByRole("heading", { name: "Merged from" })).toBeTruthy();
  });

  it("answers an unknown subject with not found", async () => {
    productUser.mockRejectedValue(new HttpError(404));
    mount(`#/p/djdl/users/${OTHER}`);
    expect(
      await screen.findByText("This product has no such user"),
    ).toBeTruthy();
  });

  it("deletes the product's data only after typing delete", async () => {
    productUser.mockResolvedValue({ user: detail() });
    deleteProductUserData.mockResolvedValue({ ok: true, stores: [] });
    mount(`#/p/djdl/users/${SUBJECT}`);
    await screen.findByRole("heading", { level: 1, name: SUBJECT });
    await userEvent.click(
      screen.getAllByRole("button", { name: "More actions" })[0]!,
    );
    await userEvent.click(
      await screen.findByRole("menuitem", {
        name: "Delete data for this product…",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    const confirm = () =>
      within(dialog).getByRole("button", { name: "Delete data" });
    expect(confirm().getAttribute("aria-disabled")).toBe("true");
    await userEvent.type(within(dialog).getByRole("textbox"), "delete");
    await userEvent.click(confirm());
    await waitFor(() =>
      expect(deleteProductUserData).toHaveBeenCalledWith("djdl", SUBJECT),
    );
  });

  it("detaches a licence after a danger confirm", async () => {
    productUser.mockResolvedValue({ user: detail() });
    detachProductUserLicense.mockResolvedValue({ ok: true });
    mount(`#/p/djdl/users/${SUBJECT}/licenses`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Detach…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Detach license" }),
    );
    await waitFor(() =>
      expect(detachProductUserLicense).toHaveBeenCalledWith(
        "djdl",
        SUBJECT,
        "lic_1",
      ),
    );
  });
});

describe("relink", () => {
  const openRelink = async () => {
    productUser.mockResolvedValue({ user: detail() });
    mount(`#/p/djdl/users/${SUBJECT}/licenses`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Relink…" }),
    );
    return screen.findByRole("alertdialog");
  };
  const confirmOf = (dialog: HTMLElement) =>
    within(dialog).getByRole("button", { name: "Relink license" });
  const disabled = (el: HTMLElement) =>
    el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

  it("names a mistyped or lookalike support code under the field, linked to it (I-41)", async () => {
    const dialog = await openRelink();
    const field = within(dialog).getByRole("textbox", { name: "Move to user" });
    for (const [typed, line] of [
      ["K7M-4QX-9TB", "One character is wrong. Ask them to read it again."],
      ["K7M-4QX-9T0", "Support codes never contain 0, 1, I, L, O or U."],
    ] as const) {
      await userEvent.clear(field);
      await userEvent.type(field, typed);
      const msg = within(dialog).getByText(line);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")).toContain(msg.id);
    }
  });

  it("spells a valid typed code out so the agent can confirm it, and offers nothing for a typo (I-41s)", async () => {
    const dialog = await openRelink();
    const field = within(dialog).getByRole("textbox", { name: "Move to user" });
    expect(
      within(dialog).queryByRole("button", { name: "Spell it out" }),
    ).toBeNull();
    await userEvent.type(field, "K7M-4QX-9TB");
    expect(
      within(dialog).queryByRole("button", { name: "Spell it out" }),
    ).toBeNull();
    await userEvent.clear(field);
    await userEvent.type(field, "k7m 4qx 9tz");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Spell it out" }),
    );
    expect(within(dialog).getByText("M as in Mike")).toBeTruthy();
  });

  it("asks for a fresh sign-in, back to this user, when the last one is too old", async () => {
    me.mockResolvedValue(meWith(NOW - 600));
    const dialog = await openRelink();
    const link = await within(dialog).findByRole("link", {
      name: "Sign in again",
    });
    expect(link.getAttribute("href")).toBe(
      stepUpHref(`#/p/djdl/users/${SUBJECT}/licenses`),
    );
    expect(link.getAttribute("href")).toContain("stepUp=1");
    expect(disabled(confirmOf(dialog))).toBe(true);
  });

  it("needs a subject of the right shape and a reason, then sends both", async () => {
    relinkProductUserLicense.mockResolvedValue({
      ok: true,
      relinkId: "rlk_1",
      subject: OTHER,
      undoUntil: NOW + 72 * 3600,
      noticesSent: 2,
      alert: false,
    });
    const dialog = await openRelink();
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("link", { name: "Sign in again" }),
      ).toBeNull(),
    );
    const target = within(dialog).getByRole("textbox", {
      name: "Move to user",
    });
    await userEvent.type(target, "buyer@x.io");
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Reason" }),
      "Lost access to the old account",
    );
    expect(disabled(confirmOf(dialog))).toBe(true);
    await userEvent.clear(target);
    await userEvent.type(target, OTHER);
    expect(disabled(confirmOf(dialog))).toBe(false);
    await userEvent.click(confirmOf(dialog));
    await waitFor(() =>
      expect(relinkProductUserLicense).toHaveBeenCalledWith(
        "djdl",
        SUBJECT,
        "lic_1",
        { target: OTHER, reason: "Lost access to the old account" },
      ),
    );
  });

  it("falls back to the step-up prompt when the server refuses it", async () => {
    const refusal = new HttpError(403, { code: "step_up_required" });
    refusal.message = "Sign in again to continue.";
    relinkProductUserLicense.mockRejectedValue(refusal);
    const dialog = await openRelink();
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("link", { name: "Sign in again" }),
      ).toBeNull(),
    );
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Move to user" }),
      OTHER,
    );
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Reason" }),
      "Support ticket 42",
    );
    await userEvent.click(confirmOf(dialog));
    expect(
      await within(dialog).findByRole("link", { name: "Sign in again" }),
    ).toBeTruthy();
  });

  it("offers Undo on an open relink, with a reason", async () => {
    productUser.mockResolvedValue({
      user: detail({
        relinks: [
          {
            id: "rlk_1",
            licenseId: "lic_1",
            direction: "in",
            otherSubject: OTHER,
            reason: "Support ticket 42",
            actorName: "Ada",
            createdAt: NOW - 100,
            undoUntil: NOW + 3600,
            undoneAt: null,
            undoable: true,
          },
        ],
      }),
    });
    undoRelink.mockResolvedValue({
      ok: true,
      licenseId: "lic_1",
      subject: OTHER,
    });
    mount(`#/p/djdl/users/${SUBJECT}/licenses`);
    await userEvent.click(await screen.findByRole("button", { name: "Undo…" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Reason" }),
      "Wrong person",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Undo relink" }),
    );
    await waitFor(() =>
      expect(undoRelink).toHaveBeenCalledWith("djdl", "rlk_1", {
        reason: "Wrong person",
      }),
    );
  });

  it("names the side of a holder move that had no account as an email address (LX-30)", async () => {
    const move = {
      licenseId: "lic_1",
      reason: "Sold",
      actorName: "Ada",
      createdAt: NOW - 100,
      undoUntil: NOW + 3600,
      undoneAt: null,
      undoable: false,
    };
    productUser.mockResolvedValue({
      user: detail({
        relinks: [
          // Reassigned from a waiting address into this user's account.
          {
            ...move,
            id: "rlk_2",
            kind: "reassign",
            direction: "in",
            otherSubject: null,
          },
          // An I-12 relink from an account deleted since.
          {
            ...move,
            id: "rlk_3",
            kind: "relink",
            direction: "in",
            otherSubject: null,
          },
          {
            ...move,
            id: "rlk_4",
            kind: "floating",
            direction: "out",
            otherSubject: null,
          },
        ],
      }),
    });
    mount(`#/p/djdl/users/${SUBJECT}/licenses`);
    expect(await screen.findByText("an email address")).toBeTruthy();
    expect(screen.getByText("a deleted account")).toBeTruthy();
    expect(screen.getByText(/made floating/)).toBeTruthy();
  });

  it("reads the step-up window from me", () => {
    expect(isSteppedUp(meWith(NOW - 10), NOW)).toBe(true);
    expect(isSteppedUp(meWith(NOW - 290), NOW)).toBe(false);
    expect(isSteppedUp(meWith(null), NOW)).toBe(false);
    expect(isSteppedUp(undefined, NOW)).toBe(false);
  });
});
