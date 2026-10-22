import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AreaId,
  Me,
  Member,
  MemberInvite,
  ProductMembersView,
} from "../src/api.js";
import { resetRouterForTests } from "../src/console/router.js";
import { setStepUpRedirectForTests } from "../src/lib/stepUp.js";
import { ALL_ON, boot, resetConsole, type FetchLog } from "./consoleHarness.js";

/** Product → Settings → Members (ST-31.14; mockup `admin.product-members`). */

const NOW = 1_790_000_000;
const PATH = "/manage/api/products/djdl/members";
const ALL_AREAS: AreaId[] = [
  "core",
  "license",
  "config",
  "ship",
  "signin",
  "sync",
  "commerce",
  "keys",
  "settings",
  "members",
];

const role = (over: Partial<Member["roles"][number]> = {}) => ({
  role: "product_admin" as const,
  scope: "product:djdl",
  areas: null,
  source: "grant" as const,
  bindingId: "b_kenji",
  grantedBy: { name: "Ada Lindqvist" },
  grantedAt: NOW - 500_000,
  ...over,
});

const kenji: Member = {
  memberId: "mbr_kenji",
  name: "Kenji Mori",
  email: "kenji@example.com",
  lastSignInAt: null,
  disabled: false,
  you: true,
  roles: [role()],
};
const lucia: Member = {
  memberId: "mbr_lucia",
  name: "Lucía Ortega",
  email: "lucia@example.com",
  lastSignInAt: null,
  disabled: false,
  you: false,
  roles: [
    role({ bindingId: "b_lucia", areas: ["ship", "commerce"] as AreaId[] }),
  ],
};
const marco: MemberInvite = {
  bindingId: "b_marco",
  email: "marco@example.com",
  role: "product_admin",
  scope: "product:djdl",
  areas: ["commerce"],
  invitedBy: { name: "Kenji Mori" },
  sentAt: NOW - 3600,
  expiresAt: NOW + 500_000,
};

function view(over: Partial<ProductMembersView> = {}): ProductMembersView {
  return {
    product: "djdl",
    truncated: false,
    incomplete: false,
    members: [kenji, lucia],
    invites: [marco],
    platformRoles: [
      {
        memberId: "mbr_ada",
        name: "Ada Lindqvist",
        email: "ada@example.com",
        role: "superadmin",
        scope: "platform",
        areas: null,
        source: "root",
      },
    ],
    ...over,
  };
}

/** A member of the product only, with these areas (view and edit alike). */
function productAdmin(
  areas: AreaId[] | null = null,
  edit: AreaId[] | null = areas,
): Partial<Me> {
  const held = areas ?? ALL_AREAS;
  return {
    platformAdmin: false,
    email: "kenji@example.com",
    permissions: {
      roles: [
        {
          role: "product_admin",
          scope: "product:djdl",
          areas,
          source: "grant",
        },
      ],
      platform: { view: ["console"], edit: [] },
      products: { djdl: { view: held, edit: edit ?? ALL_AREAS } },
    },
  };
}

function superadmin(): Partial<Me> {
  return {
    platformAdmin: true,
    permissions: {
      roles: [
        { role: "superadmin", scope: "platform", areas: null, source: "root" },
      ],
      platform: { view: ["console", "members"], edit: ["console", "members"] },
      products: { djdl: { view: ALL_AREAS, edit: ALL_AREAS } },
    },
  };
}

let answer: ProductMembersView | Response;
beforeEach(() => {
  resetConsole();
  sessionStorage.clear();
  answer = view();
});
afterEach(() => {
  cleanup();
  setStepUpRedirectForTests();
});

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function open(
  me: Partial<Me> = productAdmin(),
  extra: Record<string, unknown> = {},
): FetchLog {
  return boot("#/p/djdl/settings/members", {
    me,
    services: ALL_ON,
    extra: { [PATH]: () => answer, ...extra },
  });
}

async function admins(): Promise<HTMLElement> {
  return screen.findByRole("table", { name: "Admins" });
}

const disabledOf = (el: HTMLElement): boolean =>
  el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

const OK_INVITE = (
  results: { email: string; status: string; bindingId?: string }[],
) => ({
  ok: true,
  results,
  counts: {
    invited: results.length,
    updated: 0,
    exists: 0,
    merged: 0,
    invalid: 0,
  },
  emailOff: false,
  notified: { sent: 1, of: 1, nobodyNotified: false },
});

const STEP_UP = json(
  {
    error: {
      code: "step_up_required",
      message: "Sign in again to confirm it's you.",
    },
  },
  403,
);

async function openInvite(user: ReturnType<typeof userEvent.setup>) {
  await admins();
  await user.click(screen.getByRole("button", { name: "Invite people" }));
  return screen.findByRole("dialog", { name: /Invite people/ });
}

async function typeEmails(
  user: ReturnType<typeof userEvent.setup>,
  drawer: HTMLElement,
  text: string,
) {
  await user.click(within(drawer).getByLabelText("Email addresses"));
  await user.paste(text);
}

const calls = (log: FetchLog, method: string, path: string) =>
  log.calls.filter((c) => c.method === method && c.path === path);

describe("Product Members: the page", () => {
  it("lists this product's admins and invites, then the platform roles read-only", async () => {
    open();
    const t = await admins();
    expect(within(t).getByText("Kenji Mori")).toBeTruthy();
    expect(within(t).getByText("You")).toBeTruthy();
    expect(within(t).getByText("Lucía Ortega")).toBeTruthy();
    // The role column names this product's role only; the narrowed one lists its areas.
    expect(within(t).getAllByText("DJDL admin").length).toBe(3);
    expect(within(t).getAllByText("Commerce").length).toBe(2);
    expect(within(t).getByText("Ship builds")).toBeTruthy();
    // A pending invite is a row, with no name guessed from the address.
    expect(within(t).getByText("marco@example.com")).toBeTruthy();
    expect(within(t).queryByText("Marco")).toBeNull();
    expect(within(t).getByText(/Invited by Kenji Mori/)).toBeTruthy();
    // Platform roles: Ada, read-only, with no menu.
    const p = screen.getByRole("table", { name: "Platform roles" });
    expect(within(p).getByText("Ada Lindqvist")).toBeTruthy();
    expect(within(p).getByText("Superadmin")).toBeTruthy();
    expect(within(p).queryByRole("button")).toBeNull();
    // The tab counts the Admins table, people and invites.
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("link", { name: /Members/ }).textContent).toBe(
      "Members3",
    );
  });

  it("shows the empty state when no one holds the product", async () => {
    answer = view({ members: [], invites: [] });
    open();
    expect(await screen.findByText("No product admins")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Platform roles" })).toBeTruthy();
  });

  it("shows an error with a retry", async () => {
    const user = userEvent.setup();
    answer = json({ error: { code: "internal", message: "boom" } }, 500);
    open();
    const retry = await screen.findByRole("button", {
      name: /Retry|Try again/,
    });
    answer = view();
    await user.click(retry);
    expect(
      await within(await admins()).findByText("Lucía Ortega"),
    ).toBeTruthy();
  });

  it("is refused without the members area: no request, and no tab on the other tabs", async () => {
    const noMembers = (): Partial<Me> => ({
      ...productAdmin(["core", "license"]),
      permissions: {
        roles: [
          {
            role: "product_admin",
            scope: "product:djdl",
            areas: ["core", "license"],
            source: "grant",
          },
        ],
        platform: { view: ["console"], edit: [] },
        products: {
          djdl: { view: ["core", "license"], edit: ["core", "license"] },
        },
      },
    });
    const log = open(noMembers());
    expect(
      (await screen.findByRole("heading", { level: 1 })).textContent,
    ).toContain("You don't have access to DJDL");
    expect(calls(log, "GET", PATH).length).toBe(0);
    cleanup();
    resetRouterForTests();
    const other = boot("#/p/djdl/settings/presentation", {
      me: noMembers(),
      services: ALL_ON,
      extra: { [PATH]: () => answer },
    });
    const nav = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(nav).queryByRole("link", { name: /Members/ })).toBeNull();
    expect(
      within(nav).getByRole("link", { name: /Presentation/ }),
    ).toBeTruthy();
    expect(calls(other, "GET", PATH).length).toBe(0);
  });

  it("a view-only member sees no live controls", async () => {
    // Members is viewable, not editable.
    open(productAdmin(["members"], []));
    const t = await admins();
    expect(within(t).getByText("Lucía Ortega")).toBeTruthy();
    expect(
      disabledOf(screen.getByRole("button", { name: "Invite people" })),
    ).toBe(true);
    expect(
      within(t).queryByRole("button", { name: /^Actions for/ }),
    ).toBeNull();
  });
});

describe("Product Members: the drawer from the product", () => {
  it("fixes the role, offers only the held areas, and gives a Product admin role", async () => {
    const user = userEvent.setup();
    const log = open(productAdmin(["members", "license", "ship"]), {
      [`POST ${PATH}`]: OK_INVITE([
        { email: "new@example.com", status: "invited", bindingId: "b_new" },
      ]),
      "DELETE /manage/api/products/djdl/members/b_new": { ok: true },
    });
    const drawer = await openInvite(user);
    // No role cards: Product admin of DJDL, and where the platform roles are given.
    expect(
      within(drawer).queryByRole("radio", { name: /Superadmin/ }),
    ).toBeNull();
    expect(drawer.querySelector("[data-fixed-role]")?.textContent).toContain(
      "DJDL admin",
    );
    expect(drawer.textContent).toContain(
      "Platform roles are given in Platform → Members. Only a Superadmin can give them.",
    );
    // Holding only some areas: Every area is off, and only the held ones can be ticked.
    expect(
      disabledOf(
        within(drawer).getByRole("radio", { name: /Every area of DJDL/ }),
      ),
    ).toBe(true);
    expect(
      disabledOf(within(drawer).getByRole("checkbox", { name: "Commerce" })),
    ).toBe(true);
    await typeEmails(user, drawer, "new@example.com");
    await user.click(
      within(drawer).getByRole("checkbox", { name: "Licensing" }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    await waitFor(() => expect(calls(log, "POST", PATH).length).toBe(1));
    expect(calls(log, "POST", PATH)[0]!.json).toEqual({
      emails: ["new@example.com"],
      areas: ["license"],
      role: "product_admin",
    });
    expect(await screen.findByText("Invited 1 person")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(
        calls(log, "DELETE", "/manage/api/products/djdl/members/b_new").length,
      ).toBe(1),
    );
    expect(await screen.findByText("Invitations withdrawn")).toBeTruthy();
  });

  it("a Superadmin may give every area, and the note drops the Superadmin line", async () => {
    const user = userEvent.setup();
    const log = open(superadmin(), {
      [`POST ${PATH}`]: OK_INVITE([
        { email: "new@example.com", status: "invited", bindingId: "b_new" },
      ]),
    });
    const drawer = await openInvite(user);
    expect(drawer.textContent).not.toContain("Only a Superadmin can give them");
    await typeEmails(user, drawer, "new@example.com");
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    await waitFor(() => expect(calls(log, "POST", PATH).length).toBe(1));
    expect(calls(log, "POST", PATH)[0]!.json).toMatchObject({ areas: null });
  });

  it("keeps the addresses and areas across the sign-in round trip", async () => {
    const user = userEvent.setup();
    open(productAdmin(), { [`POST ${PATH}`]: STEP_UP });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "one@example.com two@example.com ");
    await user.click(
      within(drawer).getByRole("radio", { name: /Only these areas/ }),
    );
    await user.click(
      within(drawer).getByRole("checkbox", { name: "Commerce" }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 2 people" }),
    );
    expect(
      await within(drawer).findByText("Sign in again to confirm it's you"),
    ).toBeTruthy();
    let left = 0;
    setStepUpRedirectForTests(() => {
      left += 1;
    });
    await user.click(
      within(drawer).getByRole("button", { name: "Sign in again" }),
    );
    expect(left).toBe(1);
    cleanup();
    resetRouterForTests();
    const log = open(productAdmin(), {
      [`POST ${PATH}`]: OK_INVITE([
        { email: "one@example.com", status: "invited", bindingId: "b1" },
        { email: "two@example.com", status: "invited", bindingId: "b2" },
      ]),
    });
    const back = await screen.findByRole("dialog", { name: /Invite people/ });
    expect(within(back).getByText("one@example.com")).toBeTruthy();
    expect(within(back).getByText("two@example.com")).toBeTruthy();
    // Still scoped: the role is fixed, the areas are back.
    expect(
      within(back).queryByRole("radio", { name: /Superadmin/ }),
    ).toBeNull();
    expect(
      within(back)
        .getByRole("checkbox", { name: "Commerce" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(sessionStorage.getItem("pkey:step-up:members:drawer")).toBeNull();
    await user.click(
      within(back).getByRole("button", { name: "Invite 2 people" }),
    );
    await waitFor(() => expect(calls(log, "POST", PATH).length).toBe(1));
    expect(calls(log, "POST", PATH)[0]!.json).toMatchObject({
      emails: ["one@example.com", "two@example.com"],
      areas: ["commerce"],
    });
  });
});

describe("Product Members: a row's menu", () => {
  async function menu(user: ReturnType<typeof userEvent.setup>, who: string) {
    const t = await admins();
    await user.click(
      within(t).getByRole("button", { name: `Actions for ${who}` }),
    );
  }

  it("Edit areas opens the drawer on the areas and saves through the product route", async () => {
    const user = userEvent.setup();
    const log = open(productAdmin(), {
      "PATCH /manage/api/products/djdl/members/b_lucia": { ok: true },
    });
    await menu(user, "Lucía Ortega");
    await user.click(
      await screen.findByRole("menuitem", { name: /Edit areas/ }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: /Areas for Lucía Ortega/,
    });
    await user.click(
      within(drawer).getByRole("checkbox", { name: "Licensing" }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Save areas" }),
    );
    await waitFor(() =>
      expect(
        calls(log, "PATCH", "/manage/api/products/djdl/members/b_lucia").length,
      ).toBe(1),
    );
    expect(
      calls(log, "PATCH", "/manage/api/products/djdl/members/b_lucia")[0]!.json,
    ).toEqual({ areas: ["license", "ship", "commerce"] });
  });

  it("Remove from DJDL confirms, then deletes the binding", async () => {
    const user = userEvent.setup();
    const log = open(productAdmin(), {
      "DELETE /manage/api/products/djdl/members/b_lucia": { ok: true },
    });
    await menu(user, "Lucía Ortega");
    await user.click(
      await screen.findByRole("menuitem", { name: /Remove from DJDL/ }),
    );
    const dlg = await screen.findByRole("alertdialog", {
      name: /Remove Lucía Ortega from DJDL/,
    });
    expect(dlg.textContent).toContain("Any other role they hold stays");
    await user.click(
      within(dlg).getByRole("button", { name: "Remove from DJDL" }),
    );
    await waitFor(() =>
      expect(
        calls(log, "DELETE", "/manage/api/products/djdl/members/b_lucia")
          .length,
      ).toBe(1),
    );
  });

  it("withdraws an invite", async () => {
    const user = userEvent.setup();
    const log = open(productAdmin(), {
      "DELETE /manage/api/products/djdl/members/b_marco": { ok: true },
    });
    await menu(user, "marco@example.com");
    await user.click(
      await screen.findByRole("menuitem", { name: /Withdraw invite/ }),
    );
    const dlg = await screen.findByRole("alertdialog", {
      name: /Withdraw the invite/,
    });
    await user.click(
      within(dlg).getByRole("button", { name: "Withdraw invite" }),
    );
    await waitFor(() =>
      expect(
        calls(log, "DELETE", "/manage/api/products/djdl/members/b_marco")
          .length,
      ).toBe(1),
    );
  });

  it("says why a role beyond the member's areas cannot be changed", async () => {
    const user = userEvent.setup();
    // Holds Members and Licensing only; Lucía has Ship builds and Commerce.
    open(productAdmin(["members", "license"]));
    await menu(user, "Lucía Ortega");
    const edit = await screen.findByRole("menuitem", { name: /Edit areas/ });
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    expect(edit.textContent).toMatch(/Only a Superadmin or an admin of DJDL/);
  });
});
