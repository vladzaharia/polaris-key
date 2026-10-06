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

const { ApiError } = await import("../src/api.js");
const { UsersPage } = await import("../src/console/pages/core/Users.js");
const { isSteppedUp, stepUpHref } =
  await import("../src/console/pages/core/UserRelink.js");
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

function productWith(identity: boolean): ProductDetail {
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
    productUser.mockRejectedValue(new ApiError(404));
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
    const refusal = new ApiError(403, undefined, "step_up_required");
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

  it("reads the step-up window from me", () => {
    expect(isSteppedUp(meWith(NOW - 10), NOW)).toBe(true);
    expect(isSteppedUp(meWith(NOW - 290), NOW)).toBe(false);
    expect(isSteppedUp(meWith(null), NOW)).toBe(false);
    expect(isSteppedUp(undefined, NOW)).toBe(false);
  });
});
