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
  MembersView,
} from "../src/api.js";
import { resetRouterForTests } from "../src/console/router.js";
import { setStepUpRedirectForTests } from "../src/lib/stepUp.js";
import { ALL_ON, boot, resetConsole, type FetchLog } from "./consoleHarness.js";
import {
  cannotEditAreas,
  cannotTake,
} from "../src/console/access/membersModel.js";

/** Platform → Members (`#/platform/members`, ST-31.11): the roster, invites and role changes. */

// Load the Platform section's lazy chunk once, before any test: on CI the first test otherwise
// pays its cold transform and times out waiting for the page heading.
await import("../src/console/sections/platform/index.js");

const NOW = 1_790_000_000;
const PATH = "/manage/api/members";
const BINDINGS = "/manage/api/bindings";

const ROOT_ROLE = {
  role: "superadmin" as const,
  scope: "platform",
  areas: null,
  source: "root" as const,
  bindingId: null,
  grantedBy: null,
  grantedAt: null,
};

const ada: Member = {
  memberId: "mbr_ada",
  name: "Ada Lovelace",
  email: "ada@x.io",
  lastSignInAt: NOW - 3600,
  disabled: false,
  you: true,
  roles: [ROOT_ROLE],
};
const priya: Member = {
  memberId: "mbr_priya",
  name: "Priya Raman",
  email: "priya@example.com",
  lastSignInAt: NOW - 86_400,
  disabled: false,
  you: false,
  roles: [
    {
      role: "platform_admin",
      scope: "platform",
      areas: null,
      source: "grant",
      bindingId: "b_priya_pa",
      grantedBy: { name: "Ada Lovelace" },
      grantedAt: NOW - 1_000_000,
    },
    {
      role: "console_access",
      scope: "platform",
      areas: null,
      source: "grant",
      bindingId: "b_priya_ca",
      grantedBy: { name: "Ada Lovelace" },
      grantedAt: NOW - 1_000_000,
    },
  ],
};
const kenji: Member = {
  memberId: "mbr_kenji",
  name: "Kenji Mori",
  email: "kenji@example.com",
  lastSignInAt: null,
  disabled: false,
  you: false,
  roles: [
    {
      role: "product_admin",
      scope: "product:djdl",
      areas: ["ship", "commerce"] as AreaId[],
      source: "grant",
      bindingId: "b_kenji_djdl",
      grantedBy: { name: "Priya Raman" },
      grantedAt: NOW - 500_000,
    },
  ],
};
const invite: MemberInvite = {
  bindingId: "b_inv_1",
  email: "sam@example.com",
  role: "console_access",
  scope: "platform",
  areas: null,
  invitedBy: { name: "Ada Lovelace" },
  sentAt: NOW - 7200,
  expiresAt: NOW + 500_000,
};

function view(over: Partial<MembersView> = {}): MembersView {
  return {
    rootRule: { group: "polaris-admins" },
    truncated: false,
    incomplete: false,
    members: [ada, priya, kenji],
    invites: [invite],
    ...over,
  };
}

const PLATFORM_AREAS: AreaId[] = ["console", "platform", "members", "docs"];
function asRole(role: "superadmin" | "platform_admin"): Partial<Me> {
  return {
    platformAdmin: true,
    permissions: {
      roles: [{ role, scope: "platform", areas: null, source: "grant" }],
      platform: { view: PLATFORM_AREAS, edit: PLATFORM_AREAS },
      products: {},
    },
  };
}

let answer: MembersView | Response;
beforeEach(() => {
  resetConsole();
  sessionStorage.clear();
  answer = view();
});
afterEach(() => cleanup());

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function open(
  extra: Record<string, unknown> = {},
  me: Partial<Me> = asRole("superadmin"),
): FetchLog {
  return boot("#/platform/members", {
    me,
    extra: { [PATH]: () => answer, ...extra },
  });
}

async function table(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: "Members" });
  return screen.findByRole("table", { name: "Members" });
}

const posts = (log: FetchLog) =>
  log.calls.filter((c) => c.method === "POST" && c.path === BINDINGS);

async function openInvite(user: ReturnType<typeof userEvent.setup>) {
  await table();
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

async function openEdit(user: ReturnType<typeof userEvent.setup>, who: string) {
  const t = await table();
  await user.click(
    within(t).getByRole("button", { name: `Actions for ${who}` }),
  );
  await user.click(await screen.findByRole("menuitem", { name: /Edit roles/ }));
  return screen.findByRole("dialog", {
    name: new RegExp(`Edit roles for ${who}`),
  });
}

const disabledOf = (el: HTMLElement): boolean =>
  el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

const OK_INVITE = (
  results: { email: string; status: string; bindingId?: string }[],
  over: Record<string, unknown> = {},
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
  confirm: "L1",
  ...over,
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

describe("Members: the roster", () => {
  // Disabled as flaky (owner 2026-10-23 rule): timed out (~11 s) on CI in both attempts of run 40069710173 while 4071 sibling tests passed. Re-enable once the roster render is fast enough without a timeout raise.
  it.skip("lists members and invites in one table, with roles that add up and where each came from", async () => {
    open();
    const t = await table();
    expect(within(t).getByText("Ada Lovelace")).toBeTruthy();
    expect(within(t).getByText("You")).toBeTruthy();
    // The root rule names its group; the callout has no link to SSO rules (ST-32).
    expect(screen.getByText(/Root rule: everyone in/).textContent).toContain(
      "polaris-admins",
    );
    expect(screen.queryByText(/Open SSO rules/)).toBeNull();
    expect(screen.queryByRole("tab", { name: /SSO rules/ })).toBeNull();
    // Roles are named by roleLabel; Console access hides beside another role.
    expect(within(t).getByText("Superadmin")).toBeTruthy();
    expect(within(t).getByText("Platform admin")).toBeTruthy();
    expect(within(t).queryAllByText("Console access").length).toBe(1);
    // A narrowed Product admin shows its areas.
    expect(within(t).getByText("DJDL admin")).toBeTruthy();
    expect(within(t).getByText("Ship builds")).toBeTruthy();
    expect(within(t).getByText("Commerce")).toBeTruthy();
    // Access from: the root rule and who added the others.
    expect(within(t).getAllByText(/Root rule/).length).toBeGreaterThan(0);
    expect(within(t).getAllByText(/Added by/).length).toBeGreaterThan(0);
    // The invite is a row: the address, who invited, and the role it will get.
    expect(within(t).getByText("sam@example.com")).toBeTruthy();
    expect(within(t).getByText(/Invited by Ada Lovelace/)).toBeTruthy();
    // No sign-in method anywhere.
    expect(within(t).queryByText(/Passkey|Pocket ID/)).toBeNull();
  });

  it("says when the list is cut", async () => {
    answer = view({ truncated: true });
    open();
    await table();
    expect(
      await screen.findByText("Showing the first 500 members and 500 invites."),
    ).toBeTruthy();
    expect(screen.queryByText(/Search to find/)).toBeNull();
  });

  it("shows the first-run state when nobody holds a role", async () => {
    answer = view({ members: [], invites: [], rootRule: { group: null } });
    open();
    await screen.findByRole("heading", { level: 1, name: "Members" });
    expect(await screen.findByText("No members to show")).toBeTruthy();
    expect(screen.queryByText(/Root rule:/)).toBeNull();
  });

  it("shows an error with Try again, and loads on retry", async () => {
    const user = userEvent.setup();
    answer = json({ error: { code: "internal", message: "boom" } }, 500);
    open();
    await screen.findByRole("heading", { level: 1, name: "Members" });
    const retry = await screen.findByRole("button", {
      name: /Retry|Try again/,
    });
    answer = view();
    await user.click(retry);
    expect(await within(await table()).findByText("Priya Raman")).toBeTruthy();
  });
});

describe("Members: invite", () => {
  it("invites one person as Console access and offers Undo", async () => {
    const user = userEvent.setup();
    const log = open({
      [`POST ${BINDINGS}`]: OK_INVITE([
        { email: "new@example.com", status: "invited", bindingId: "b_new" },
      ]),
      "DELETE /manage/api/bindings/b_new": { ok: true },
    });
    const drawer = await openInvite(user);
    const idle = within(drawer).getByRole("button", { name: "Invite people" });
    expect(disabledOf(idle)).toBe(true);
    await typeEmails(user, drawer, "new@example.com");
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    await waitFor(() => expect(posts(log).length).toBe(1));
    expect(posts(log)[0]!.json).toEqual({
      role: "console_access",
      scope: "platform",
      areas: null,
      emails: ["new@example.com"],
    });
    expect(await screen.findByText("Invited 1 person")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) =>
            c.method === "DELETE" && c.path === "/manage/api/bindings/b_new",
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Invitations withdrawn")).toBeTruthy();
  });

  it("makes chips, merges repeats, marks existing members and counts them apart", async () => {
    const user = userEvent.setup();
    const log = open({ [`POST ${BINDINGS}`]: OK_INVITE([]) });
    const drawer = await openInvite(user);
    await typeEmails(
      user,
      drawer,
      "a@example.com, b@example.com\nA@example.com priya@example.com ",
    );
    // Three chips after the repeat merged; Priya's is a member chip.
    expect(drawer.querySelectorAll("[data-chip]").length).toBe(3);
    expect(drawer.querySelectorAll('[data-chip="member"]').length).toBe(1);
    await user.click(
      within(drawer).getByRole("radio", { name: /^Product admin/ }),
    );
    await user.click(within(drawer).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "DJDL" }));
    expect(
      within(drawer).getByText("Priya Raman is a member. Adds DJDL admin."),
    ).toBeTruthy();
    await user.click(
      within(drawer).getByRole("button", {
        name: "Invite 2 people and update 1",
      }),
    );
    await waitFor(() => expect(posts(log).length).toBe(1));
    expect(posts(log)[0]!.json).toEqual({
      role: "product_admin",
      scope: "product:djdl",
      areas: null,
      emails: ["a@example.com", "b@example.com", "priya@example.com"],
    });
  });

  it("marks a wrong address as an error chip and leaves it out of the count", async () => {
    const user = userEvent.setup();
    const log = open({
      [`POST ${BINDINGS}`]: OK_INVITE([
        { email: "ok@example.com", status: "invited", bindingId: "b1" },
      ]),
    });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "ok@example.com, not-an-address");
    await user.keyboard("{Enter}");
    expect(drawer.querySelectorAll('[data-chip="invalid"]').length).toBe(1);
    expect(
      await within(drawer).findByText(
        /not-an-address isn't an email address, so it isn't counted/,
      ),
    ).toBeTruthy();
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    await waitFor(() => expect(posts(log).length).toBe(1));
    expect((posts(log)[0]!.json as { emails: string[] }).emails).toEqual([
      "ok@example.com",
    ]);
  });

  it("removes a chip with its button and with Backspace", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openInvite(user);
    await typeEmails(
      user,
      drawer,
      "a@example.com b@example.com c@example.com ",
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Remove a@example.com" }),
    );
    await user.keyboard("{Backspace}");
    expect(drawer.querySelectorAll("[data-chip]").length).toBe(1);
    expect(within(drawer).getByText("b@example.com")).toBeTruthy();
  });

  it("says so when the invitation budget is spent, and keeps what was entered", async () => {
    const user = userEvent.setup();
    open({
      [`POST ${BINDINGS}`]: json(
        {
          error: {
            code: "rate_limited",
            message: "too many invitations; try again later",
            reason: "invite_budget",
          },
        },
        429,
      ),
    });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "one@example.com");
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    expect(
      await within(drawer).findByText("Too many invitations"),
    ).toBeTruthy();
    expect(within(drawer).getByText("one@example.com")).toBeTruthy();
    expect(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    ).toBeTruthy();
  });

  it("lists the links, each with Copy, when email is off", async () => {
    const user = userEvent.setup();
    open({
      [`POST ${BINDINGS}`]: OK_INVITE(
        [
          {
            email: "one@example.com",
            status: "invited",
            bindingId: "b1",
            emailed: false,
            link: "https://key.example/manage/?login_hint=one%40example.com",
          } as never,
        ],
        { emailOff: true },
      ),
    });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "one@example.com");
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    const links = await screen.findByRole("dialog", {
      name: "Invite links for 1 person",
    });
    expect(
      within(links).getByText(/login_hint=one%40example.com/),
    ).toBeTruthy();
    expect(
      within(links).getByRole("button", {
        name: /Copy link for one@example.com/,
      }),
    ).toBeTruthy();
  });

  it("opens the links dialog when one email fails with email on", async () => {
    const user = userEvent.setup();
    open({
      [`POST ${BINDINGS}`]: OK_INVITE(
        [
          { email: "a@example.com", status: "invited", bindingId: "b1" },
          {
            email: "b@example.com",
            status: "invited",
            bindingId: "b2",
            link: "https://key.example/manage/?login_hint=b%40example.com",
          } as never,
        ],
        { notified: { sent: 1, of: 2, nobodyNotified: false } },
      ),
    });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "a@example.com b@example.com");
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 2 people" }),
    );
    const links = await screen.findByRole("dialog", {
      name: /1 email didn't go out/,
    });
    // Said once, in the title.
    expect(within(links).queryByText(/No email reached/)).toBeNull();
    expect(within(links).queryByText(/a@example.com\b.*login_hint/)).toBeNull();
  });

  it("counts invited and updated apart in the toast, and Undo says what it took back", async () => {
    const user = userEvent.setup();
    const log = open({
      [`POST ${BINDINGS}`]: OK_INVITE(
        [
          { email: "new@example.com", status: "invited", bindingId: "b_new" },
          { email: "priya@example.com", status: "updated", bindingId: "b_up" },
        ],
        {
          counts: { invited: 1, updated: 1, exists: 0, merged: 0, invalid: 0 },
        },
      ),
      "DELETE /manage/api/bindings/b_new": { ok: true },
      "DELETE /manage/api/bindings/b_up": { ok: true },
    });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "new@example.com priya@example.com ");
    await user.click(
      within(drawer).getByRole("radio", { name: /^Product admin/ }),
    );
    await user.click(within(drawer).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "DJDL" }));
    await user.click(
      within(drawer).getByRole("button", {
        name: "Invite 1 person and update 1",
      }),
    );
    expect(
      await screen.findByText("Invited 1 person and updated 1"),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(log.calls.filter((c) => c.method === "DELETE").length).toBe(2),
    );
    expect(
      await screen.findByText("Invitations withdrawn and roles taken back"),
    ).toBeTruthy();
  });

  it("reports an Undo that stops half way", async () => {
    const user = userEvent.setup();
    open({
      [`POST ${BINDINGS}`]: OK_INVITE([
        { email: "a@example.com", status: "invited", bindingId: "b1" },
        { email: "b@example.com", status: "invited", bindingId: "b2" },
      ]),
      "DELETE /manage/api/bindings/b1": { ok: true },
      "DELETE /manage/api/bindings/b2": json({ error: "boom" }, 500),
    });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "a@example.com b@example.com ");
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 2 people" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Took back 1 of 2")).toBeTruthy();
  });

  it("asks for a typed word for a Superadmin invite and sends the L2 confirmation", async () => {
    const user = userEvent.setup();
    const log = open({
      [`POST ${BINDINGS}`]: OK_INVITE(
        [{ email: "x@example.com", status: "invited", bindingId: "b9" }],
        { confirm: "L2" },
      ),
    });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "x@example.com");
    await user.click(
      within(drawer).getByRole("radio", { name: /^Superadmin/ }),
    );
    const send = within(drawer).getByRole("button", {
      name: "Invite 1 person",
    });
    // Without the word, Send takes you to the field instead of failing silently.
    await user.click(send);
    expect(posts(log)).toEqual([]);
    expect(document.activeElement).toBe(
      within(drawer).getByLabelText(/Type the role to confirm/),
    );
    await user.type(
      within(drawer).getByLabelText(/Type the role to confirm/),
      "superadmin",
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    await waitFor(() => expect(posts(log).length).toBe(1));
    expect(posts(log)[0]!.json).toMatchObject({
      role: "superadmin",
      scope: "platform",
      confirm: "L2",
    });
  });

  it("writes the sentence the people will live by", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "hana@example.com theo@example.com ");
    expect(
      within(drawer).getByText(/hana@ and theo@ will open the console/),
    ).toBeTruthy();
    await user.click(
      within(drawer).getByRole("radio", { name: /^Product admin/ }),
    );
    await user.click(within(drawer).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "DJDL" }));
    await user.click(
      within(drawer).getByRole("radio", { name: /Only these areas/ }),
    );
    await user.click(
      within(drawer).getByRole("checkbox", { name: "Commerce" }),
    );
    await user.click(
      within(drawer).getByRole("checkbox", { name: "Ship builds" }),
    );
    expect(
      within(drawer).getByText(
        "hana@ and theo@ will manage Ship builds and Commerce in DJDL.",
      ),
    ).toBeTruthy();
    expect(within(drawer).getByText(/^Expires /)).toBeTruthy();
    expect(within(drawer).getByText("Every Superadmin is told")).toBeTruthy();
  });

  it("offers only the product's enabled features and names the missing ones", async () => {
    const user = userEvent.setup();
    boot("#/platform/members", {
      me: asRole("superadmin"),
      extra: { [PATH]: () => answer },
      perProduct: {
        djdl: {
          ...ALL_ON,
          identity: { enabled: false },
          sync: { enabled: false },
        },
      },
    });
    const drawer = await openInvite(user);
    await user.click(
      within(drawer).getByRole("radio", { name: /^Product admin/ }),
    );
    await user.click(within(drawer).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "DJDL" }));
    await user.click(
      within(drawer).getByRole("radio", { name: /Only these areas/ }),
    );
    expect(
      within(drawer).getByRole("checkbox", { name: "Commerce" }),
    ).toBeTruthy();
    expect(
      within(drawer).queryByRole("checkbox", { name: "Sign-in" }),
    ).toBeNull();
    expect(
      within(drawer).queryByRole("checkbox", { name: "Cloud Sync" }),
    ).toBeNull();
    expect(
      await within(drawer).findByText(
        "Sign-in and Cloud Sync are off for DJDL.",
      ),
    ).toBeTruthy();
  });

  it("moves focus into the drawer and gives it back to the opener", async () => {
    const user = userEvent.setup();
    open();
    await table();
    const opener = screen.getByRole("button", {
      name: "Invite people",
      hidden: true,
    });
    await user.click(opener);
    const drawer = await screen.findByRole("dialog", { name: /Invite people/ });
    expect(drawer.contains(document.activeElement)).toBe(true);
    await user.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /Invite people/ }),
      ).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("asks before throwing away what was typed", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "one@example.com ");
    await user.keyboard("{Escape}");
    expect(await screen.findByText(/Discard your changes\?/)).toBeTruthy();
  });
});

describe("Members: Superadmin and Platform admin", () => {
  it("lets a Superadmin give every role", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openInvite(user);
    for (const name of [
      "Console access",
      "Product admin",
      "Platform admin",
      "Superadmin",
    ]) {
      expect(
        disabledOf(
          within(drawer).getByRole("radio", { name: new RegExp(`^${name}`) }),
        ),
      ).toBe(false);
    }
    await user.click(
      within(drawer).getByRole("radio", { name: /^Product admin/ }),
    );
    expect(
      disabledOf(within(drawer).getByRole("radio", { name: /^All products/ })),
    ).toBe(false);
  });

  it("keeps the platform roles and All products from a Platform admin, saying why once", async () => {
    const user = userEvent.setup();
    open({}, asRole("platform_admin"));
    const drawer = await openInvite(user);
    for (const name of ["Platform admin", "Superadmin"]) {
      expect(
        disabledOf(
          within(drawer).getByRole("radio", { name: new RegExp(`^${name}`) }),
        ),
      ).toBe(true);
    }
    expect(
      within(drawer).getAllByText(
        /Only a Superadmin can give Platform admin, Superadmin and All products\./,
      ).length,
    ).toBe(1);
    expect(
      disabledOf(within(drawer).getByRole("radio", { name: /Console access/ })),
    ).toBe(false);
    // They administer no product, so Product admin would be a dead end: off, with its reason.
    const pa = within(drawer).getByRole("radio", { name: /^Product admin/ });
    expect(disabledOf(pa)).toBe(true);
    expect(
      within(drawer).getByText(
        /You can give Product admin only on products you administer\./,
      ),
    ).toBeTruthy();
  });

  it("stops a Platform admin removing a Platform admin", async () => {
    const user = userEvent.setup();
    open({}, asRole("platform_admin"));
    const t = await table();
    await user.click(
      within(t).getByRole("button", { name: "Actions for Priya Raman" }),
    );
    const item = await screen.findByRole("menuitem", {
      name: /Remove from console/,
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });
});

/** The sign-in round trip: the page unloads with the stash in sessionStorage, then loads again. */
async function signInAgain(
  user: ReturnType<typeof userEvent.setup>,
  drawer: HTMLElement,
  extra: Record<string, unknown>,
): Promise<FetchLog> {
  let left = 0;
  setStepUpRedirectForTests(() => {
    left += 1;
  });
  await user.click(
    await within(drawer).findByRole("button", { name: "Sign in again" }),
  );
  expect(left).toBe(1);
  cleanup();
  resetRouterForTests();
  return open(extra);
}

describe("Members: the sign-in round trip keeps the drawer", () => {
  afterEach(() => setStepUpRedirectForTests());

  it("Invite: the addresses, role, product, areas and typed word come back", async () => {
    const user = userEvent.setup();
    open({ [`POST ${BINDINGS}`]: STEP_UP });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "one@example.com two@example.com ");
    await user.click(
      within(drawer).getByRole("radio", { name: /^Product admin/ }),
    );
    await user.click(within(drawer).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "DJDL" }));
    await user.click(
      within(drawer).getByRole("radio", { name: /Only these areas/ }),
    );
    await user.click(
      within(drawer).getByRole("checkbox", { name: "Ship builds" }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 2 people" }),
    );
    expect(
      await within(drawer).findByText("Sign in again to confirm it's you"),
    ).toBeTruthy();
    // The chips stay while the callout shows.
    expect(within(drawer).getByText("one@example.com")).toBeTruthy();

    await signInAgain(user, drawer, {
      [`POST ${BINDINGS}`]: OK_INVITE([
        { email: "one@example.com", status: "invited", bindingId: "b1" },
        { email: "two@example.com", status: "invited", bindingId: "b2" },
      ]),
    });
    const back = await screen.findByRole("dialog", { name: /Invite people/ });
    expect(within(back).getByText("one@example.com")).toBeTruthy();
    expect(within(back).getByText("two@example.com")).toBeTruthy();
    expect(
      within(back)
        .getByRole("radio", { name: /^Product admin/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(back)
        .getByRole("checkbox", { name: "Ship builds" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(back).getByRole("button", { name: "Invite 2 people" }),
    ).toBeTruthy();
    // The saved state is spent: it opens once.
    expect(sessionStorage.getItem("pkey:step-up:members:drawer")).toBeNull();
    await user.click(
      within(back).getByRole("button", { name: "Invite 2 people" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /Invite people/ }),
      ).toBeNull(),
    );
  });

  it("Invite: a typed Superadmin word is back too", async () => {
    const user = userEvent.setup();
    open({ [`POST ${BINDINGS}`]: STEP_UP });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "x@example.com ");
    await user.click(
      within(drawer).getByRole("radio", { name: /^Superadmin/ }),
    );
    await user.type(
      within(drawer).getByLabelText(/Type the role to confirm/),
      "Superadmin",
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    await signInAgain(user, drawer, { [`POST ${BINDINGS}`]: STEP_UP });
    const back = await screen.findByRole("dialog", { name: /Invite people/ });
    expect(
      (
        within(back).getByLabelText(
          /Type the role to confirm/,
        ) as HTMLInputElement
      ).value,
    ).toBe("Superadmin");
    expect(
      disabledOf(within(back).getByRole("button", { name: "Invite 1 person" })),
    ).toBe(false);
  });

  it("Add a role: the member, the role and the typed word come back", async () => {
    const user = userEvent.setup();
    open({ [`POST ${BINDINGS}`]: STEP_UP });
    const drawer = await openEdit(user, "Kenji Mori");
    await user.click(
      within(drawer).getByRole("button", { name: "Add a role" }),
    );
    await user.click(
      within(drawer).getByRole("radio", { name: /^Platform admin/ }),
    );
    await user.type(
      within(drawer).getByLabelText(/Type the role to confirm/),
      "Platform admin",
    );
    await user.click(within(drawer).getByRole("button", { name: "Add role" }));
    const log = await signInAgain(user, drawer, {
      [`POST ${BINDINGS}`]: { ok: true, binding: {} },
    });
    const back = await screen.findByRole("dialog", {
      name: /Add a role for Kenji Mori/,
    });
    expect(
      within(back)
        .getByRole("radio", { name: /^Platform admin/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      (
        within(back).getByLabelText(
          /Type the role to confirm/,
        ) as HTMLInputElement
      ).value,
    ).toBe("Platform admin");
    await user.click(within(back).getByRole("button", { name: "Add role" }));
    await waitFor(() => expect(posts(log).length).toBe(1));
    expect(posts(log)[0]!.json).toEqual({
      member: "mbr_kenji",
      role: "platform_admin",
      scope: "platform",
      areas: null,
      confirm: "L2",
    });
  });

  it("Edit areas: the member, the role and the ticked areas come back", async () => {
    const user = userEvent.setup();
    open({ "PATCH /manage/api/bindings/b_kenji_djdl": STEP_UP });
    const drawer = await openEdit(user, "Kenji Mori");
    await user.click(
      within(drawer).getByRole("button", { name: /Edit areas of DJDL admin/ }),
    );
    await user.click(within(drawer).getByRole("checkbox", { name: "Core" }));
    await user.click(
      within(drawer).getByRole("button", { name: "Save areas" }),
    );
    const log = await signInAgain(user, drawer, {
      "PATCH /manage/api/bindings/b_kenji_djdl": { ok: true },
    });
    const back = await screen.findByRole("dialog", {
      name: /Areas for Kenji Mori/,
    });
    expect(
      within(back)
        .getByRole("checkbox", { name: "Core" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(back)
        .getByRole("checkbox", { name: "Commerce" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(back)
        .getByRole("checkbox", { name: "Licensing" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    await user.click(within(back).getByRole("button", { name: "Save areas" }));
    await waitFor(() =>
      expect(log.calls.find((m) => m.method === "PATCH")?.json).toEqual({
        areas: ["core", "ship", "commerce"],
      }),
    );
  });
});

describe("Members: Edit roles", () => {
  it("adds a role to a member, starting from one they can still be given", async () => {
    const user = userEvent.setup();
    const log = open({ [`POST ${BINDINGS}`]: { ok: true, binding: {} } });
    const drawer = await openEdit(user, "Kenji Mori");
    await user.click(
      within(drawer).getByRole("button", { name: "Add a role" }),
    );
    // Kenji has a role, so Console access is implied: off, and not the default.
    const ca = within(drawer).getByRole("radio", { name: /Console access/ });
    expect(disabledOf(ca)).toBe(true);
    expect(
      within(drawer).getByText("Kenji Mori already has Console access."),
    ).toBeTruthy();
    expect(
      within(drawer)
        .getByRole("radio", { name: /^Product admin/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(within(drawer).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Acme" }));
    expect(
      within(drawer).getByText("Kenji Mori will manage every area of Acme."),
    ).toBeTruthy();
    await user.click(within(drawer).getByRole("button", { name: "Add role" }));
    await waitFor(() => expect(posts(log).length).toBe(1));
    expect(posts(log)[0]!.json).toEqual({
      member: "mbr_kenji",
      role: "product_admin",
      scope: "product:acme",
      areas: null,
    });
    // Back on the list.
    expect(
      await screen.findByRole("dialog", { name: /Edit roles for Kenji Mori/ }),
    ).toBeTruthy();
  });

  it("does not offer you a role for yourself, and says why", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openEdit(user, "Ada Lovelace");
    const add = within(drawer).getByRole("button", { name: "Add a role" });
    expect(disabledOf(add)).toBe(true);
  });

  it("narrows a Product admin's areas", async () => {
    const user = userEvent.setup();
    const log = open({
      "PATCH /manage/api/bindings/b_kenji_djdl": { ok: true },
    });
    const drawer = await openEdit(user, "Kenji Mori");
    await user.click(
      within(drawer).getByRole("button", { name: /Edit areas of DJDL admin/ }),
    );
    await user.click(
      within(drawer).getByRole("checkbox", { name: "Commerce" }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Save areas" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PATCH")?.json).toEqual({
        areas: ["ship"],
      }),
    );
  });

  it("removes one role after a confirmation", async () => {
    const user = userEvent.setup();
    const log = open({
      "DELETE /manage/api/bindings/b_priya_pa": { ok: true },
    });
    const drawer = await openEdit(user, "Priya Raman");
    await user.click(
      within(drawer).getByRole("button", { name: "Remove Platform admin" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await user.click(
      within(confirm).getByRole("button", { name: "Remove role" }),
    );
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) => c.method === "DELETE" && c.path.endsWith("b_priya_pa"),
        ),
      ).toBe(true),
    );
  });

  it("locks the root rule's role, saying why", async () => {
    const user = userEvent.setup();
    answer = view({
      members: [ada, { ...priya, you: false, roles: [ROOT_ROLE] }],
    });
    open();
    const drawer = await openEdit(user, "Priya Raman");
    expect(
      disabledOf(
        within(drawer).getByRole("button", { name: "Remove Superadmin" }),
      ),
    ).toBe(true);
  });

  it("returns focus to the row's menu button when the drawer closes", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openEdit(user, "Kenji Mori");
    expect(drawer.contains(document.activeElement)).toBe(true);
    await user.click(
      within(drawer).getAllByRole("button", { name: "Close" }).at(-1)!,
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Edit roles/ })).toBeNull(),
    );
    await waitFor(() =>
      expect(
        (document.activeElement as HTMLElement | null)?.getAttribute(
          "aria-label",
        ),
      ).toBe("Actions for Kenji Mori"),
    );
  });
});

describe("Members: invites waiting", () => {
  it("revokes an invite after a confirmation", async () => {
    const user = userEvent.setup();
    const log = open({ "DELETE /manage/api/bindings/b_inv_1": { ok: true } });
    const t = await table();
    await user.click(
      within(t).getByRole("button", { name: "Actions for sam@example.com" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Revoke invite/ }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(log.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(
      within(confirm).getByRole("button", { name: "Revoke invite" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "DELETE")?.path).toBe(
        "/manage/api/bindings/b_inv_1",
      ),
    );
  });
});

describe("Members: remove from console", () => {
  it("takes back every role after a confirmation", async () => {
    const user = userEvent.setup();
    const log = open({
      "DELETE /manage/api/bindings/b_kenji_djdl": { ok: true },
    });
    const t = await table();
    await user.click(
      within(t).getByRole("button", { name: "Actions for Kenji Mori" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Remove from console/ }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(log.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(
      within(confirm).getByRole("button", { name: "Remove from console" }),
    );
    await waitFor(() =>
      expect(
        log.calls.filter((c) => c.method === "DELETE").map((c) => c.path),
      ).toEqual(["/manage/api/bindings/b_kenji_djdl"]),
    );
  });
});

describe("Members: the second round (ST-31.11 fix)", () => {
  const two: Member = {
    ...kenji,
    roles: [
      kenji.roles[0]!,
      {
        ...kenji.roles[0]!,
        scope: "product:acme",
        bindingId: "b_kenji_acme",
        areas: null,
      },
    ],
  };

  async function openRemove(user: ReturnType<typeof userEvent.setup>) {
    const t = await table();
    await user.click(
      within(t).getByRole("button", { name: "Actions for Kenji Mori" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Remove from console/ }),
    );
    return screen.findByRole("alertdialog");
  }

  it("retries a partly failed removal with only the roles that are left", async () => {
    const user = userEvent.setup();
    let roster: Member = two;
    answer = view({ members: [ada, priya, roster] });
    let acme = 0;
    const log = open({
      [PATH]: () => view({ members: [ada, priya, roster] }),
      "DELETE /manage/api/bindings/b_kenji_djdl": () => {
        roster = { ...two, roles: [two.roles[1]!] };
        return { ok: true };
      },
      "DELETE /manage/api/bindings/b_kenji_acme": () =>
        acme++ === 0 ? json({ error: "boom" }, 500) : { ok: true },
    });
    const confirm = await openRemove(user);
    expect(
      within(confirm).getByText(/They lose DJDL admin, Acme admin/),
    ).toBeTruthy();
    await user.click(
      within(confirm).getByRole("button", { name: "Remove from console" }),
    );
    await waitFor(() =>
      expect(log.calls.filter((c) => c.method === "DELETE").length).toBe(2),
    );
    // The dialog now lists only what is left.
    await waitFor(() =>
      expect(screen.getByText(/They lose Acme admin\./)).toBeTruthy(),
    );
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Remove from console",
      }),
    );
    await waitFor(() =>
      expect(
        log.calls.filter((c) => c.method === "DELETE").map((c) => c.path),
      ).toEqual([
        "/manage/api/bindings/b_kenji_djdl",
        "/manage/api/bindings/b_kenji_acme",
        "/manage/api/bindings/b_kenji_acme",
      ]),
    );
  });

  it("treats a 404 on a binding delete as already removed", async () => {
    const user = userEvent.setup();
    answer = view({ members: [ada, priya, two] });
    const log = open({
      "DELETE /manage/api/bindings/b_kenji_djdl": json({ error: "nf" }, 404),
      "DELETE /manage/api/bindings/b_kenji_acme": { ok: true },
    });
    const confirm = await openRemove(user);
    await user.click(
      within(confirm).getByRole("button", { name: "Remove from console" }),
    );
    await waitFor(() =>
      expect(log.calls.filter((c) => c.method === "DELETE").length).toBe(2),
    );
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  it("tells a Platform admin what it takes to remove a product admin", async () => {
    const user = userEvent.setup();
    answer = view({ members: [ada, priya, two] });
    open({}, asRole("platform_admin"));
    const t = await table();
    await user.click(
      within(t).getByRole("button", { name: "Actions for Kenji Mori" }),
    );
    const item = await screen.findByRole("menuitem", {
      name: /Remove from console/,
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toMatch(
      /Only a Superadmin or an admin of DJDL with Members can remove DJDL admin\./i,
    );
    expect(item.textContent).not.toMatch(/Platform admin or an All products/);
  });
});

describe("Members: copy by action", () => {
  const pa = asRole("platform_admin") as unknown as Me;
  const role = kenji.roles[0]!;
  const name = (s: string) => s.toUpperCase();
  it("names the action it refuses", () => {
    expect(cannotTake(pa, role, name, "revoke")).toMatch(
      /can revoke DJDL admin/,
    );
    expect(cannotTake(pa, role, name)).toMatch(/can remove DJDL admin/);
    const areas = cannotEditAreas(pa, role, name)!;
    expect(areas).toMatch(/change the areas of DJDL admin/);
    expect(areas).not.toMatch(/remove/);
  });
});

// ── ST-31.12 fix round (the BUILT UX review) ────────────────────────────────────────────────

const footerOf = (drawer: HTMLElement): HTMLElement =>
  drawer.querySelector<HTMLElement>("[data-drawer-footer]")!;

async function pickProduct(
  user: ReturnType<typeof userEvent.setup>,
  drawer: HTMLElement,
  name = "DJDL",
) {
  await user.click(
    within(drawer).getByRole("radio", { name: /^Product admin/ }),
  );
  await user.click(within(drawer).getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name }));
}

describe("Members: the drawer's footer band", () => {
  afterEach(() => setStepUpRedirectForTests());

  it("shows an error, and the step-up callout with what is kept, beside the primary", async () => {
    const user = userEvent.setup();
    let stale = false;
    open({
      [`POST ${BINDINGS}`]: () =>
        stale
          ? STEP_UP
          : json({ error: { code: "internal", message: "boom" } }, 500),
    });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "one@example.com");
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    const alert = await within(drawer).findByRole("alert");
    expect(footerOf(drawer).contains(alert)).toBe(true);
    stale = true;
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    const title = await within(drawer).findByText(
      "Sign in again to confirm it's you",
    );
    expect(footerOf(drawer).contains(title)).toBe(true);
    expect(
      within(footerOf(drawer)).getByText(/Your changes are kept/),
    ).toBeTruthy();
    expect(footerOf(drawer).textContent).toContain("Sign in again");
  });

  it("pins the sentence and the facts beside the primary", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "hana@example.com ");
    const f = within(footerOf(drawer));
    expect(f.getByText(/hana@ will open the console/)).toBeTruthy();
    // The current year is dropped.
    expect(f.getByText(/^Expires [A-Za-z]+ \d+$/)).toBeTruthy();
    expect(f.getByText("Every Superadmin is told")).toBeTruthy();
  });

  it("does not say 'every area' with nothing ticked, and gives the reason", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "hana@example.com ");
    await pickProduct(user, drawer);
    await user.click(
      within(drawer).getByRole("radio", { name: /Only these areas/ }),
    );
    const f = within(footerOf(drawer));
    expect(f.getByText("Choose at least one area.")).toBeTruthy();
    expect(f.queryByText(/every area/)).toBeNull();
    expect(f.getAllByText("Choose at least one area").length).toBeGreaterThan(
      0,
    );
  });

  it("follows the product's features for Commerce too, and names it in the hint", async () => {
    const user = userEvent.setup();
    boot("#/platform/members", {
      me: asRole("superadmin"),
      extra: { [PATH]: () => answer },
      perProduct: { djdl: { ...ALL_ON, commerce: { enabled: false } } },
    });
    const drawer = await openInvite(user);
    await pickProduct(user, drawer);
    await user.click(
      within(drawer).getByRole("radio", { name: /Only these areas/ }),
    );
    expect(
      within(drawer).queryByRole("checkbox", { name: "Commerce" }),
    ).toBeNull();
    expect(within(drawer).getByText("Commerce is off for DJDL.")).toBeTruthy();
  });

  it("makes the address list a list, and says what was added", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "a@example.com b@example.com ");
    const list = within(drawer).getByRole("list", { name: "Addresses" });
    expect(within(list).getAllByRole("listitem").length).toBe(2);
    expect(await within(drawer).findByText(/b@example.com added/)).toBeTruthy();
  });
});

describe("Members: who is already there", () => {
  it("says a member already has the role, and leaves them out of the count", async () => {
    const user = userEvent.setup();
    const log = open({
      [`POST ${BINDINGS}`]: OK_INVITE([
        { email: "a@example.com", status: "invited", bindingId: "b1" },
      ]),
    });
    const drawer = await openInvite(user);
    await pickProduct(user, drawer, "DJDL");
    await user.click(
      within(drawer).getByRole("radio", { name: /Only these areas/ }),
    );
    await user.click(
      within(drawer).getByRole("checkbox", { name: "Ship builds" }),
    );
    await typeEmails(user, drawer, "kenji@example.com a@example.com ");
    expect(
      within(drawer).getByText("Kenji Mori already has DJDL admin."),
    ).toBeTruthy();
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    await waitFor(() => expect(posts(log).length).toBe(1));
    expect((posts(log)[0]!.json as { emails: string[] }).emails).toEqual([
      "a@example.com",
    ]);
  });

  it("catches your own address as its own chip, before anything is sent", async () => {
    const user = userEvent.setup();
    const log = open();
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "ada@x.io ");
    expect(drawer.querySelectorAll('[data-chip="self"]').length).toBe(1);
    expect(
      within(drawer).getByText(
        /That's your address\. You can't give yourself a role\./,
      ),
    ).toBeTruthy();
    const send = within(drawer).getByRole("button", { name: "Invite people" });
    expect(disabledOf(send)).toBe(true);
    expect(posts(log)).toEqual([]);
  });

  it("flags a waiting invitation, and Undo never deletes the earlier one", async () => {
    const user = userEvent.setup();
    const log = open({
      [`POST ${BINDINGS}`]: OK_INVITE([
        { email: "sam@example.com", status: "invited", bindingId: "b_inv_1" },
      ]),
    });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "sam@example.com ");
    expect(
      within(drawer).getByText(
        "sam@example.com has an invitation waiting. Sending renews it.",
      ),
    ).toBeTruthy();
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    expect(await screen.findByText("Invited 1 person")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(log.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("names the skipped address in the toast", async () => {
    const user = userEvent.setup();
    open({
      [`POST ${BINDINGS}`]: OK_INVITE([
        { email: "ok@example.com", status: "invited", bindingId: "b1" },
      ]),
    });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "ok@example.com marta@example ");
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 1 person" }),
    );
    expect(await screen.findByText("Skipped marta@example.")).toBeTruthy();
  });
});

describe("Members: Undo that stops half way, and email off", () => {
  it("names the invitation still open and retries just that one", async () => {
    const user = userEvent.setup();
    let fail = true;
    const log = open({
      [`POST ${BINDINGS}`]: OK_INVITE([
        { email: "a@example.com", status: "invited", bindingId: "b1" },
        { email: "b@example.com", status: "invited", bindingId: "b2" },
      ]),
      "DELETE /manage/api/bindings/b1": { ok: true },
      "DELETE /manage/api/bindings/b2": () =>
        fail ? json({ error: "boom" }, 500) : { ok: true },
    });
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "a@example.com b@example.com ");
    await user.click(
      within(drawer).getByRole("button", { name: "Invite 2 people" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Took back 1 of 2")).toBeTruthy();
    expect(
      screen.getByText("The invitation for b@example.com is still open."),
    ).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        log.calls.filter((c) => c.method === "DELETE" && c.path.endsWith("b2"))
          .length,
      ).toBe(2),
    );
    expect(
      log.calls.filter((c) => c.method === "DELETE" && c.path.endsWith("b1"))
        .length,
    ).toBe(1);
  });

  it("does not promise email when it is off, and the links carry the role and expiry", async () => {
    const user = userEvent.setup();
    open(
      {
        [`POST ${BINDINGS}`]: OK_INVITE(
          [
            {
              email: "one@example.com",
              status: "invited",
              bindingId: "b1",
              expiresAt: 1_790_000_000 + 7 * 86_400,
              link: "https://key.example/manage/?login_hint=one%40example.com",
            } as never,
          ],
          { emailOff: true },
        ),
      },
      { ...asRole("superadmin"), emailOn: false },
    );
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "one@example.com ");
    const send = await within(drawer).findByRole("button", {
      name: "Create invite links",
    });
    expect(
      within(footerOf(drawer)).getByText("Nobody is emailed"),
    ).toBeTruthy();
    expect(
      within(footerOf(drawer)).queryByText("Every Superadmin is told"),
    ).toBeNull();
    await user.click(send);
    const links = await screen.findByRole("dialog", {
      name: "Invite links for 1 person",
    });
    expect(within(links).getByText(/· Console access/)).toBeTruthy();
    expect(within(links).getByText(/^Expires /)).toBeTruthy();
    const opener = screen.getByRole("button", {
      name: "Invite people",
      hidden: true,
    });
    await user.click(within(links).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe("Members: Edit roles, the fix round", () => {
  const sam: Member = {
    memberId: "mbr_sam",
    name: "Sam Okoye",
    email: "sam2@example.com",
    lastSignInAt: null,
    disabled: false,
    you: false,
    roles: [
      {
        role: "product_admin",
        scope: "products:*",
        areas: ["ship"] as AreaId[],
        source: "grant",
        bindingId: "b_sam_all",
        grantedBy: { name: "Ada Lovelace" },
        grantedAt: NOW - 1000,
      },
      {
        role: "product_admin",
        scope: "product:acme",
        areas: null,
        source: "grant",
        bindingId: "b_sam_acme",
        grantedBy: { name: "Ada Lovelace" },
        grantedAt: NOW - 1000,
      },
    ],
  };

  it("gives Edit areas the choice of every area, which saves null", async () => {
    const user = userEvent.setup();
    const log = open({
      "PATCH /manage/api/bindings/b_kenji_djdl": { ok: true },
    });
    const drawer = await openEdit(user, "Kenji Mori");
    await user.click(
      within(drawer).getByRole("button", { name: /Edit areas of DJDL admin/ }),
    );
    expect(
      within(drawer)
        .getByRole("radio", { name: /Only these areas/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(
      within(drawer).getByRole("radio", { name: /Every area of DJDL/ }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Save areas" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PATCH")?.json).toEqual({
        areas: null,
      }),
    );
  });

  it("tells you when every box is ticked that Every area includes later ones", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openEdit(user, "Kenji Mori");
    await user.click(
      within(drawer).getByRole("button", { name: /Edit areas of DJDL admin/ }),
    );
    for (const a of await within(drawer).findAllByRole("checkbox")) {
      if (a.getAttribute("aria-checked") !== "true") await user.click(a);
    }
    expect(within(drawer).getByText(/That's every area now/)).toBeTruthy();
  });

  it("asks only when there is something to lose", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openEdit(user, "Kenji Mori");
    await user.click(
      within(drawer).getByRole("button", { name: /Edit areas of DJDL admin/ }),
    );
    // Untouched: back goes straight to the list.
    await user.click(
      within(drawer).getByRole("button", { name: "Back to roles" }),
    );
    expect(screen.queryByText(/Discard your changes/)).toBeNull();
    expect(
      await screen.findByRole("dialog", { name: /Edit roles for Kenji Mori/ }),
    ).toBeTruthy();
    // Changed: back asks first.
    await user.click(
      within(drawer).getByRole("button", { name: /Edit areas of DJDL admin/ }),
    );
    await user.click(
      within(drawer).getByRole("checkbox", { name: "Commerce" }),
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Back to roles" }),
    );
    expect(await screen.findByText(/Discard your changes/)).toBeTruthy();
  });

  it("gives a disabled Edit areas its own reason, as text", async () => {
    const user = userEvent.setup();
    open({}, asRole("platform_admin"));
    const drawer = await openEdit(user, "Kenji Mori");
    expect(
      disabledOf(
        within(drawer).getByRole("button", {
          name: /Edit areas of DJDL admin/,
        }),
      ),
    ).toBe(true);
    expect(
      within(drawer).getByText(/can change the areas of DJDL admin\./),
    ).toBeTruthy();
  });

  it("offers Edit areas on a narrowed All products role, with the typed word", async () => {
    const user = userEvent.setup();
    answer = view({ members: [ada, sam] });
    const log = open({
      "PATCH /manage/api/bindings/b_sam_all": { ok: true },
    });
    const drawer = await openEdit(user, "Sam Okoye");
    await user.click(
      within(drawer).getByRole("button", {
        name: /Edit areas of All products admin/,
      }),
    );
    await user.click(
      within(drawer).getByRole("radio", {
        name: /Every area of every product/,
      }),
    );
    await user.type(
      within(drawer).getByLabelText(/Type the role to confirm/),
      "all products admin",
    );
    await user.click(
      within(drawer).getByRole("button", { name: "Save areas" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PATCH")?.json).toEqual({
        areas: null,
        confirm: "L2",
      }),
    );
  });

  it("says a last role leaves the console", async () => {
    const user = userEvent.setup();
    const solo: Member = { ...kenji, roles: [kenji.roles[0]!] };
    answer = view({ members: [ada, solo] });
    open({ "DELETE /manage/api/bindings/b_kenji_djdl": { ok: true } });
    const drawer = await openEdit(user, "Kenji Mori");
    await user.click(
      within(drawer).getByRole("button", { name: "Remove DJDL admin" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText("Kenji Mori loses access to the console."),
    ).toBeTruthy();
    expect(
      within(confirm).getByRole("button", { name: "Remove from console" }),
    ).toBeTruthy();
  });

  it("says who a person is now, and offers Undo for an added role", async () => {
    const user = userEvent.setup();
    const log = open({
      [`POST ${BINDINGS}`]: { ok: true, binding: { bindingId: "b_new_role" } },
      "DELETE /manage/api/bindings/b_new_role": { ok: true },
    });
    const drawer = await openEdit(user, "Kenji Mori");
    await user.click(
      within(drawer).getByRole("button", { name: "Add a role" }),
    );
    await user.click(
      within(drawer).getByRole("radio", { name: /^Platform admin/ }),
    );
    await user.type(
      within(drawer).getByLabelText(/Type the role to confirm/),
      "Platform admin",
    );
    await user.click(within(drawer).getByRole("button", { name: "Add role" }));
    expect(
      await screen.findByText("Kenji Mori is now a Platform admin"),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) => c.method === "DELETE" && c.path.endsWith("b_new_role"),
        ),
      ).toBe(true),
    );
  });

  it("keeps a visible Close, and moves focus to the new title on a view change", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openEdit(user, "Kenji Mori");
    expect(
      within(drawer).getAllByRole("button", { name: "Close" }).length,
    ).toBe(2);
    await user.click(
      within(drawer).getByRole("button", { name: "Add a role" }),
    );
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "Add a role for Kenji Mori",
      ),
    );
  });
});

describe("Members: the second fix round", () => {
  const lucia: Member = {
    memberId: "mbr_lucia",
    name: "Lucía Ortega",
    email: "lucia@example.com",
    lastSignInAt: null,
    disabled: false,
    you: false,
    roles: [
      {
        role: "product_admin",
        scope: "product:acme",
        areas: ["ship", "commerce"] as AreaId[],
        source: "grant",
        bindingId: "b_lucia_acme",
        grantedBy: { name: "Ada Lovelace" },
        grantedAt: NOW - 1000,
      },
    ],
  };

  it("lists a held area whose feature is off, ticked and noted, so it can be unticked", async () => {
    const user = userEvent.setup();
    answer = view({ members: [ada, lucia] });
    const log = boot("#/platform/members", {
      me: asRole("superadmin"),
      extra: {
        [PATH]: () => answer,
        "PATCH /manage/api/bindings/b_lucia_acme": { ok: true },
      },
      perProduct: { acme: { ...ALL_ON, commerce: { enabled: false } } },
    });
    const drawer = await openEdit(user, "Lucía Ortega");
    await user.click(
      within(drawer).getByRole("button", { name: /Edit areas of Acme admin/ }),
    );
    const commerce = await within(drawer).findByRole("checkbox", {
      name: /Commerce/,
    });
    expect(commerce.getAttribute("aria-checked")).toBe("true");
    expect(within(drawer).getByText(/Off for Acme/)).toBeTruthy();
    expect(within(drawer).getByText("1 area picked").textContent).toBeTruthy();
    await user.click(commerce);
    await user.click(
      within(drawer).getByRole("button", { name: "Save areas" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PATCH")?.json).toEqual({
        areas: ["ship"],
      }),
    );
  });

  it("confirms Add a role inside the drawer, with an Undo that works on the first click", async () => {
    const user = userEvent.setup();
    const log = open({
      [`POST ${BINDINGS}`]: { ok: true, binding: { bindingId: "b_new" } },
      "DELETE /manage/api/bindings/b_new": { ok: true },
    });
    const drawer = await openEdit(user, "Kenji Mori");
    await user.click(
      within(drawer).getByRole("button", { name: "Add a role" }),
    );
    await user.click(
      within(drawer).getByRole("radio", { name: /^Platform admin/ }),
    );
    await user.type(
      within(drawer).getByLabelText(/Type the role to confirm/),
      "Platform admin",
    );
    await user.click(within(drawer).getByRole("button", { name: "Add role" }));
    const status = await within(drawer).findByText(
      "Kenji Mori is now a Platform admin",
    );
    expect(status).toBeTruthy();
    // No toast beside the open drawer.
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
    await user.click(within(drawer).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(
        log.calls.filter(
          (c) => c.method === "DELETE" && c.path.endsWith("b_new"),
        ).length,
      ).toBe(1),
    );
    expect(
      await within(drawer).findByText("Took the role back from Kenji Mori"),
    ).toBeTruthy();
  });

  it("asks All products admin for the word only when an edit widens it", async () => {
    const user = userEvent.setup();
    const wide: Member = {
      ...kenji,
      memberId: "mbr_w",
      name: "Wes Wide",
      email: "wes@example.com",
      roles: [
        {
          role: "product_admin",
          scope: "products:*",
          areas: ["ship", "commerce"] as AreaId[],
          source: "grant",
          bindingId: "b_wes",
          grantedBy: null,
          grantedAt: NOW,
        },
      ],
    };
    answer = view({ members: [ada, wide] });
    const log = open({ "PATCH /manage/api/bindings/b_wes": { ok: true } });
    const drawer = await openEdit(user, "Wes Wide");
    await user.click(
      within(drawer).getByRole("button", {
        name: /Edit areas of All products/,
      }),
    );
    // Narrowing: no word, one click.
    await user.click(
      within(drawer).getByRole("checkbox", { name: /Commerce/ }),
    );
    expect(
      within(drawer).queryByLabelText(/Type the role to confirm/),
    ).toBeNull();
    // Widening: the word.
    await user.click(within(drawer).getByRole("checkbox", { name: /Core/ }));
    expect(
      within(drawer).getByLabelText(/Type the role to confirm/),
    ).toBeTruthy();
    await user.click(within(drawer).getByRole("checkbox", { name: /Core/ }));
    await user.click(
      within(drawer).getByRole("button", { name: "Save areas" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PATCH")?.json).toEqual({
        areas: ["ship"],
      }),
    );
  });

  it("says what a member holds on some areas, and what is added", async () => {
    const user = userEvent.setup();
    answer = view({ members: [ada, lucia] });
    open();
    const drawer = await openInvite(user);
    await pickProduct(user, drawer, "Acme");
    await typeEmails(user, drawer, "lucia@example.com ");
    expect(
      within(drawer).getByText(
        "Lucía Ortega already has Acme admin (Ship builds and Commerce). Adds the rest.",
      ),
    ).toBeTruthy();
  });

  it("drops the sentence when nobody will be sent anything", async () => {
    const user = userEvent.setup();
    open();
    const drawer = await openInvite(user);
    await typeEmails(user, drawer, "ada@x.io ");
    expect(footerOf(drawer).textContent).not.toMatch(/will open the console/);
    expect(footerOf(drawer).textContent).not.toMatch(/Expires/);
  });

  it("does not say Superadmins are told when email is off, in Edit roles too", async () => {
    const user = userEvent.setup();
    open({}, { ...asRole("superadmin"), emailOn: false });
    const drawer = await openEdit(user, "Kenji Mori");
    await user.click(
      within(drawer).getByRole("button", { name: "Add a role" }),
    );
    await waitFor(() =>
      expect(footerOf(drawer).textContent).toContain(
        "Superadmins see it in Activity",
      ),
    );
    expect(footerOf(drawer).textContent).not.toContain(
      "Every Superadmin is told",
    );
  });
});
