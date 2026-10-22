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
import { boot, resetConsole, type FetchLog } from "./consoleHarness.js";

/** Platform → Members (`#/platform/members`, ST-31.11): the roster, invites and role changes. */

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
  return screen.findByRole("alertdialog", { name: /Invite people/ });
}

async function typeEmails(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  text: string,
) {
  await user.click(within(dialog).getByLabelText("Email addresses"));
  await user.paste(text);
}

describe("Members: the roster", () => {
  it("lists members and invites in one table, with roles that add up and where each came from", async () => {
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
    expect(await screen.findByText(/The list is cut/)).toBeTruthy();
  });

  it("shows the first-run state when nobody holds a role", async () => {
    answer = view({ members: [], invites: [], rootRule: { group: null } });
    open();
    await screen.findByRole("heading", { level: 1, name: "Members" });
    expect(await screen.findByText("No one has a role yet")).toBeTruthy();
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
      [`POST ${BINDINGS}`]: {
        ok: true,
        results: [
          { email: "new@example.com", status: "invited", bindingId: "b_new" },
        ],
        counts: { invited: 1, updated: 0, exists: 0, merged: 0, invalid: 0 },
        emailOff: false,
        notified: { sent: 2, of: 2, nobodyNotified: false },
        confirm: "L1",
      },
      "DELETE /manage/api/bindings/b_new": { ok: true },
    });
    const dialog = await openInvite(user);
    const send = within(dialog).getByRole("button", {
      name: "Invite 0 people",
    });
    expect(
      (send as HTMLButtonElement).disabled ||
        send.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    await typeEmails(user, dialog, "new@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "Invite 1 person" }),
    );
    await waitFor(() => expect(posts(log).length).toBe(1));
    expect(posts(log)[0]!.json).toEqual({
      role: "console_access",
      scope: "platform",
      areas: null,
      emails: ["new@example.com"],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) =>
            c.method === "DELETE" && c.path === "/manage/api/bindings/b_new",
        ),
      ).toBe(true),
    );
  });

  it("invites several people to one product, merges repeats and counts existing members", async () => {
    const user = userEvent.setup();
    const log = open({
      [`POST ${BINDINGS}`]: {
        ok: true,
        results: [],
        counts: { invited: 2, updated: 1, exists: 0, merged: 0, invalid: 0 },
        emailOff: false,
        notified: { sent: 1, of: 1, nobodyNotified: false },
        confirm: "L1",
      },
    });
    const me = asRole("superadmin");
    void me;
    const dialog = await openInvite(user);
    await typeEmails(
      user,
      dialog,
      "a@example.com, b@example.com\nA@example.com priya@example.com",
    );
    await user.click(within(dialog).getByText("Product admin"));
    await user.click(within(dialog).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "DJDL" }));
    // Three people after the repeat merged; one of them (Priya) is a member already.
    await user.click(
      within(dialog).getByRole("button", {
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

  it("refuses an address that is not one, before anything is sent", async () => {
    const user = userEvent.setup();
    const log = open();
    const dialog = await openInvite(user);
    await typeEmails(user, dialog, "ok@example.com, not-an-address");
    expect(
      await within(dialog).findByText(/Not an email address: not-an-address/),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: /^Invite/ }));
    expect(posts(log)).toEqual([]);
  });

  it("says so when the invitation budget is spent", async () => {
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
    const dialog = await openInvite(user);
    await typeEmails(user, dialog, "one@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "Invite 1 person" }),
    );
    expect(
      await within(dialog).findByText("Too many invitations"),
    ).toBeTruthy();
    // The input is kept for another try.
    expect(
      (within(dialog).getByLabelText("Email addresses") as HTMLTextAreaElement)
        .value,
    ).toContain("one@example.com");
  });

  it("lists the links, each with Copy, when email is off", async () => {
    const user = userEvent.setup();
    open({
      [`POST ${BINDINGS}`]: {
        ok: true,
        results: [
          {
            email: "one@example.com",
            status: "invited",
            bindingId: "b1",
            emailed: false,
            link: "https://key.example/manage/?login_hint=one%40example.com",
          },
        ],
        counts: { invited: 1, updated: 0, exists: 0, merged: 0, invalid: 0 },
        emailOff: true,
        notified: { sent: 0, of: 1, nobodyNotified: true },
        confirm: "L1",
      },
    });
    const dialog = await openInvite(user);
    await typeEmails(user, dialog, "one@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "Invite 1 person" }),
    );
    const links = await screen.findByRole("dialog", {
      name: "Send these links",
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

  it("asks for a typed word for a Superadmin invite and sends the L2 confirmation", async () => {
    const user = userEvent.setup();
    const log = open({
      [`POST ${BINDINGS}`]: {
        ok: true,
        results: [
          { email: "x@example.com", status: "invited", bindingId: "b9" },
        ],
        counts: { invited: 1, updated: 0, exists: 0, merged: 0, invalid: 0 },
        emailOff: false,
        notified: { sent: 1, of: 1, nobodyNotified: false },
        confirm: "L2",
      },
    });
    const dialog = await openInvite(user);
    await typeEmails(user, dialog, "x@example.com");
    await user.click(within(dialog).getByText("Superadmin"));
    const send = within(dialog).getByRole("button", {
      name: "Invite 1 person",
    });
    await user.click(send);
    expect(posts(log)).toEqual([]);
    await user.type(
      within(dialog).getByLabelText(/Type the role to confirm/),
      "superadmin",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Invite 1 person" }),
    );
    await waitFor(() => expect(posts(log).length).toBe(1));
    expect(posts(log)[0]!.json).toMatchObject({
      role: "superadmin",
      scope: "platform",
      confirm: "L2",
    });
  });

  it("turns a stale sign-in into the one sign-in callout and keeps what was typed", async () => {
    const user = userEvent.setup();
    open({
      [`POST ${BINDINGS}`]: json(
        {
          error: {
            code: "step_up_required",
            message: "Sign in again to confirm it's you.",
          },
        },
        403,
      ),
    });
    const dialog = await openInvite(user);
    await typeEmails(user, dialog, "one@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "Invite 1 person" }),
    );
    expect(
      await within(dialog).findByText("Sign in again to confirm it's you"),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Sign in again" }),
    ).toBeTruthy();
    expect(
      (within(dialog).getByLabelText("Email addresses") as HTMLTextAreaElement)
        .value,
    ).toContain("one@example.com");
  });
});

describe("Members: Superadmin and Platform admin", () => {
  it("lets a Superadmin give every role", async () => {
    const user = userEvent.setup();
    open();
    const dialog = await openInvite(user);
    for (const name of ["Superadmin", "Platform admin", "All products admin"]) {
      const radio = within(dialog).getByRole("radio", {
        name: new RegExp(`^${name}`),
      });
      expect(
        radio.hasAttribute("disabled") ||
          radio.getAttribute("aria-disabled") === "true",
      ).toBe(false);
    }
  });

  it("keeps the platform roles and All products from a Platform admin, saying why", async () => {
    const user = userEvent.setup();
    open({}, asRole("platform_admin"));
    const dialog = await openInvite(user);
    for (const name of ["Superadmin", "Platform admin", "All products admin"]) {
      const radio = within(dialog).getByRole("radio", {
        name: new RegExp(`^${name}`),
      });
      expect(
        radio.hasAttribute("disabled") ||
          radio.getAttribute("aria-disabled") === "true",
      ).toBe(true);
    }
    expect(
      within(dialog).getAllByText("Only a Superadmin can give this role.")
        .length,
    ).toBe(3);
    // Console access they can give.
    expect(
      within(dialog)
        .getByRole("radio", { name: /Console access/ })
        .hasAttribute("disabled"),
    ).toBe(false);
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

describe("Members: change a role", () => {
  it("adds a role to a member", async () => {
    const user = userEvent.setup();
    const log = open({
      [`POST ${BINDINGS}`]: { ok: true, binding: {} },
    });
    const t = await table();
    await user.click(
      within(t).getByRole("button", { name: "Actions for Kenji Mori" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Edit roles/ }),
    );
    const edit = await screen.findByRole("dialog", {
      name: /Edit roles for Kenji Mori/,
    });
    await user.click(within(edit).getByRole("button", { name: "Add a role" }));
    const add = await screen.findByRole("alertdialog", {
      name: /Add a role for Kenji Mori/,
    });
    await user.click(within(add).getByRole("button", { name: "Add role" }));
    await waitFor(() => expect(posts(log).length).toBe(1));
    expect(posts(log)[0]!.json).toEqual({
      member: "mbr_kenji",
      role: "console_access",
      scope: "platform",
      areas: null,
    });
  });

  it("narrows a Product admin's areas", async () => {
    const user = userEvent.setup();
    const log = open({
      "PATCH /manage/api/bindings/b_kenji_djdl": { ok: true },
    });
    const t = await table();
    await user.click(
      within(t).getByRole("button", { name: "Actions for Kenji Mori" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Edit roles/ }),
    );
    const edit = await screen.findByRole("dialog", {
      name: /Edit roles for Kenji Mori/,
    });
    await user.click(
      within(edit).getByRole("button", { name: /Edit areas of DJDL admin/ }),
    );
    const areas = await screen.findByRole("alertdialog", {
      name: /Areas of DJDL admin/,
    });
    await user.click(within(areas).getByRole("checkbox", { name: "Commerce" }));
    await user.click(within(areas).getByRole("button", { name: "Save areas" }));
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PATCH")?.json).toEqual({
        areas: ["ship"],
      }),
    );
  });

  it("removes one role", async () => {
    const user = userEvent.setup();
    const log = open({
      "DELETE /manage/api/bindings/b_priya_pa": { ok: true },
    });
    const t = await table();
    await user.click(
      within(t).getByRole("button", { name: "Actions for Priya Raman" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Edit roles/ }),
    );
    const edit = await screen.findByRole("dialog", {
      name: /Edit roles for Priya Raman/,
    });
    await user.click(
      within(edit).getByRole("button", { name: "Remove Platform admin" }),
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
    open();
    const t = await table();
    await user.click(
      within(t).getByRole("button", { name: "Actions for Ada Lovelace" }),
    );
    const item = await screen.findByRole("menuitem", {
      name: /Remove from console/,
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
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
