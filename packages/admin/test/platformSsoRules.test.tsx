import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AccessOffer,
  AccessRulesView,
  AreaId,
  Me,
  Member,
  MembersView,
  RulePreview,
} from "../src/api.js";
import { setStepUpRedirectForTests, stashStepUp } from "../src/lib/stepUp.js";
import { boot, resetConsole, type FetchLog } from "./consoleHarness.js";

/** Platform → Members → SSO rules (`#/platform/members?tab=sso`, ST-32.7) and the RuleEditor. */

await import("../src/console/sections/platform/index.js");

const MEMBERS = "/manage/api/members";
const RULES = "/manage/api/access/rules";
const PREVIEW = "/manage/api/access/rules/preview";
const OFFERS = "/manage/api/access/offers";

const root = {
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
  name: "Ada Lindqvist",
  email: "ada@x.io",
  lastSignInAt: null,
  disabled: false,
  you: true,
  roles: [root],
};
const jonas: Member = {
  ...ada,
  memberId: "mbr_jonas",
  name: "Jonas Weber",
  email: "jonas@x.io",
  you: false,
};

const roster: MembersView = {
  rootRule: { group: "polaris-admins" },
  truncated: false,
  incomplete: false,
  members: [ada, jonas],
  invites: [],
};

const stored = (over: Partial<AccessRulesView> = {}): AccessRulesView => ({
  version: 3,
  unreadable: false,
  editable: true,
  connections: [
    { id: "console-idp", label: "Console identity provider", domains: [] },
    { id: "okta", label: "Studio Okta", domains: ["studio.example.com"] },
  ],
  rules: [
    {
      id: "r_aaaaaaaaaaaa",
      when: { connection: "okta", group: "release-managers" },
      grant: { role: "product_admin", scope: "product:djdl", areas: ["ship"] },
    },
    {
      id: "r_bbbbbbbbbbbb",
      when: { connection: "okta", domain: "studio.example.com" },
      grant: { role: "console_access", scope: "platform" },
    },
  ],
  ...over,
});

const preview = (over: Partial<RulePreview> = {}): RulePreview => ({
  members: [
    {
      memberId: "mbr_noor",
      name: "Noor Haddad",
      email: "noor@x.io",
      grant: { role: "product_admin", scope: "product:djdl", areas: ["ship"] },
    },
  ],
  matchedMembers: 1,
  otherLinks: 2,
  scanned: 3,
  truncated: false,
  incomplete: false,
  ...over,
});

const AREAS: AreaId[] = ["console", "platform", "members", "docs"];
const asRole = (role: "superadmin" | "platform_admin"): Partial<Me> => ({
  platformAdmin: true,
  permissions: {
    roles: [{ role, scope: "platform", areas: null, source: "grant" }],
    platform: { view: AREAS, edit: AREAS },
    products: {},
  },
});

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let rules: AccessRulesView;
let previewAnswer: RulePreview | Response;
let putAnswer: unknown;

beforeEach(() => {
  resetConsole();
  sessionStorage.clear();
  rules = stored();
  previewAnswer = preview();
  putAnswer = {
    ok: true,
    rules: rules.rules,
    version: 4,
    notified: { sent: 2, of: 2 },
  };
});
afterEach(() => cleanup());

function open(me: Partial<Me> = asRole("superadmin")): FetchLog {
  return boot("#/platform/members?tab=sso", {
    me,
    extra: {
      [MEMBERS]: () => roster,
      [RULES]: () => rules,
      [`PUT ${RULES}`]: () => putAnswer,
      [PREVIEW]: () => previewAnswer,
    },
  });
}

const rulesList = () => screen.findByTestId("sso-rules");
const writes = (log: FetchLog) => log.calls.filter((c) => c.method === "PUT");

describe("SSO rules tab", () => {
  it("is a third tab with the rule count, rule rows and the read-only root rule", async () => {
    open();
    const list = await rulesList();
    expect(within(list).getByText("release-managers")).toBeTruthy();
    expect(within(list).getByText("studio.example.com")).toBeTruthy();
    expect(within(list).getAllByText(/From Studio Okta/).length).toBe(2);
    expect(within(list).getByText(/verified and enforced/)).toBeTruthy();
    expect(within(list).getByText("DJDL admin")).toBeTruthy();
    expect(within(list).getByText("Console access")).toBeTruthy();
    const tab = screen.getByRole("link", { name: /SSO rules/ });
    expect(tab.getAttribute("aria-current")).toBe("page");
    expect(tab.textContent).toContain("2");
    const rootCard = document.querySelector<HTMLElement>("[data-root-rule]")!;
    expect(within(rootCard).getByText("polaris-admins")).toBeTruthy();
    expect(within(rootCard).getByText("Superadmin")).toBeTruthy();
    expect(within(rootCard).getByText("2 people")).toBeTruthy();
    expect(within(rootCard).queryByRole("button")).toBeNull();
  });

  it("a Platform admin reads the rules and is told whom to ask", async () => {
    rules = stored({ editable: false });
    open(asRole("platform_admin"));
    await rulesList();
    expect(
      screen.getByText("Ask Ada Lindqvist or Jonas Weber to change a rule."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add rule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("says when the stored rules can't be read and offers no edit", async () => {
    rules = stored({ unreadable: true, rules: [] });
    open();
    await screen.findByText("The stored rules can't be read");
    expect(screen.queryByRole("button", { name: "Add rule" })).toBeNull();
  });
});

describe("RuleEditor", () => {
  async function newRule(log?: FetchLog) {
    const user = userEvent.setup();
    const l = log ?? open();
    await user.click(await screen.findByRole("button", { name: "Add rule" }));
    await screen.findByRole("heading", { name: "New rule" });
    return { user, log: l };
  }

  it("offers only operator connections and an enforced domain", async () => {
    const { user } = await newRule();
    const conn = screen.getByRole("combobox", { name: "Signs in with" });
    await user.click(conn);
    const opts = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(opts).toEqual(["Console identity provider", "Studio Okta"]);
    await user.keyboard("{Escape}");
    // The console's own provider has no verified domain, so a domain can't be picked on it.
    expect(
      (
        screen.getByRole("radio", {
          name: "A verified email domain",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/needs to be verified and enforced/)).toBeTruthy();
  });

  it("takes exactly one matcher and previews who it matches", async () => {
    const { user, log } = await newRule();
    // Save stays off until the matcher is filled.
    expect(
      screen
        .getByRole("button", { name: "Save rule…" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await user.type(screen.getByLabelText("Group"), "ops");
    const list = await screen.findByTestId("rule-matches");
    expect(within(list).getByText("Noor Haddad")).toBeTruthy();
    expect(within(list).getByText(/Gets DJDL admin/)).toBeTruthy();
    expect(screen.getByText("Matches 1 person")).toBeTruthy();
    expect(screen.getByText(/2 other people who signed in/)).toBeTruthy();
    const sent = log.calls.filter((c) => c.path === PREVIEW).at(-1)!.json as {
      rule: { when: unknown; grant: unknown };
    };
    expect(sent.rule.when).toEqual({ connection: "console-idp", group: "ops" });
    expect(Object.keys(sent.rule).sort()).toEqual(["grant", "when"]);

    await user.click(screen.getByRole("radio", { name: "A claim" }));
    expect(screen.queryByLabelText("Group")).toBeNull();
    await user.type(screen.getByLabelText("Claim name"), "department");
    await user.type(screen.getByLabelText("Claim value"), "qa");
    await waitFor(() => {
      const last = log.calls.filter((c) => c.path === PREVIEW).at(-1)!.json as {
        rule: { when: unknown };
      };
      expect(last.rule.when).toEqual({
        connection: "console-idp",
        claim: { name: "department", equals: "qa" },
      });
    });
  });

  it("says nobody matches yet, and still allows the save", async () => {
    previewAnswer = preview({ members: [], matchedMembers: 0, otherLinks: 0 });
    const { user } = await newRule();
    await user.type(screen.getByLabelText("Group"), "ops");
    await screen.findByText("Nobody matches yet");
    expect(
      screen
        .getByRole("button", { name: "Save rule…" })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  it("hides the other-people count when the Worker withholds it", async () => {
    previewAnswer = preview({ otherLinks: null });
    const { user } = await newRule();
    await user.type(screen.getByLabelText("Group"), "ops");
    await screen.findByTestId("rule-matches");
    expect(screen.queryByText(/other people/)).toBeNull();
  });

  it("Console access takes no product or areas", async () => {
    const { user } = await newRule();
    await user.click(screen.getByRole("combobox", { name: "Role" }));
    await user.click(
      await screen.findByRole("option", { name: "Console access" }),
    );
    expect(screen.queryByRole("combobox", { name: "Product" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Areas they get" })).toBeNull();
  });
});

/** Type the reason and the key in the open dialog, then press its confirm button. */
async function confirmIn(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  button: string,
  reason = "why",
): Promise<void> {
  await user.type(within(dialog).getByLabelText("Reason"), reason);
  await user.type(
    within(dialog).getByLabelText(/Type to confirm/),
    "console.access",
  );
  await user.click(within(dialog).getByRole("button", { name: button }));
}

describe("Saving a rule", () => {
  async function fillAndSave() {
    const user = userEvent.setup();
    const log = open();
    await user.click(await screen.findByRole("button", { name: "Add rule" }));
    await user.type(await screen.findByLabelText("Group"), "ops");
    await user.click(screen.getByRole("button", { name: "Save rule…" }));
    const dialog = await screen.findByRole("alertdialog");
    return { user, log, dialog };
  }

  it("asks for the typed key and a reason, then writes the whole list with the version", async () => {
    const { user, log, dialog } = await fillAndSave();
    const confirm = within(dialog).getByRole("button", { name: "Add rule" });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await user.type(within(dialog).getByLabelText("Reason"), "release team");
    await user.type(
      within(dialog).getByLabelText(/Type to confirm/),
      "console.access",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(writes(log)).toHaveLength(1));
    const body = writes(log)[0]!.json as {
      rules: { id?: string; when: unknown }[];
      expectedVersion: number;
      reason: string;
      confirm: string;
    };
    expect(body.expectedVersion).toBe(3);
    expect(body.reason).toBe("release team");
    expect(body.confirm).toBe("console.access");
    // The two stored rules keep their ids; the new one has none (the Worker mints it).
    expect(body.rules.map((r) => r.id)).toEqual([
      "r_aaaaaaaaaaaa",
      "r_bbbbbbbbbbbb",
      undefined,
    ]);
    expect(body.rules[2]!.when).toEqual({
      connection: "console-idp",
      group: "ops",
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("does not write until the word and the reason are right", async () => {
    const { user, log, dialog } = await fillAndSave();
    await user.type(within(dialog).getByLabelText("Reason"), "why");
    await user.type(
      within(dialog).getByLabelText(/Type to confirm/),
      "console",
    );
    expect(
      within(dialog)
        .getByRole("button", { name: "Add rule" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(writes(log)).toHaveLength(0);
  });

  it("turns into a sign-in when the Worker wants a step-up", async () => {
    let redirected = 0;
    setStepUpRedirectForTests(() => {
      redirected += 1;
    });
    putAnswer = json(
      { error: { code: "step_up_required", message: "Sign in again." } },
      403,
    );
    const { user, dialog } = await fillAndSave();
    await confirmIn(user, dialog, "Add rule");
    expect(
      await within(dialog).findByText(
        "This needs a sign-in from the last 5 minutes.",
      ),
    ).toBeTruthy();
    const again = await within(dialog).findByRole("button", {
      name: "Sign in again",
    });
    await user.click(again);
    expect(redirected).toBe(1);
    setStepUpRedirectForTests();
  });

  it("after a step-up, sends the version the list was built from and shows the conflict", async () => {
    window.location.hash = "#/platform/members?tab=sso";
    // The list was staged at version 2; the rules read now answers 3 (another Superadmin saved).
    stashStepUp("SSO rules", "console.access", {
      reason: "release team",
      rules: JSON.stringify([
        {
          when: { connection: "console-idp", group: "ops" },
          grant: { role: "console_access" },
        },
      ]),
      offer: "null",
      baseVersion: "2",
      title: "Add this rule?",
      confirmLabel: "Add rule",
      lead: "",
      intent: "caution",
    });
    putAnswer = json(
      {
        error: {
          code: "bad_request",
          message: "x",
          reason: "version_conflict",
        },
      },
      409,
    );
    const user = userEvent.setup();
    const log = open();
    const dialog = await screen.findByRole("alertdialog");
    const btn = within(dialog).getByRole("button", { name: "Add rule" });
    await waitFor(() =>
      expect(btn.getAttribute("aria-disabled")).not.toBe("true"),
    );
    await user.click(btn);
    await waitFor(() => expect(writes(log)).toHaveLength(1));
    expect(
      (writes(log)[0]!.json as { expectedVersion: number }).expectedVersion,
    ).toBe(2);
    await within(dialog).findByText("The rules changed");
  });

  it("names a version conflict", async () => {
    putAnswer = json(
      {
        error: {
          code: "bad_request",
          message: "x",
          reason: "version_conflict",
        },
      },
      409,
    );
    const { user, dialog } = await fillAndSave();
    await confirmIn(user, dialog, "Add rule");
    await within(dialog).findByText("The rules changed");
  });

  it("removing a rule writes the list without it", async () => {
    const user = userEvent.setup();
    const log = open();
    const list = await rulesList();
    await user.click(
      within(list).getAllByRole("button", { name: "Remove…" })[0]!,
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText("Reason"), "left the team");
    await user.type(
      within(dialog).getByLabelText(/Type to confirm/),
      "console.access",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Remove rule" }),
    );
    await waitFor(() => expect(writes(log)).toHaveLength(1));
    expect(
      (writes(log)[0]!.json as { rules: { id: string }[] }).rules.map(
        (r) => r.id,
      ),
    ).toEqual(["r_bbbbbbbbbbbb"]);
  });

  it("editing keeps the rule's id", async () => {
    const user = userEvent.setup();
    const log = open();
    const list = await rulesList();
    await user.click(within(list).getAllByRole("button", { name: "Edit" })[0]!);
    const group = await screen.findByLabelText("Group");
    expect((group as HTMLInputElement).value).toBe("release-managers");
    await user.clear(group);
    await user.type(group, "shippers");
    await user.click(screen.getByRole("button", { name: "Save rule…" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText("Reason"), "rename");
    await user.type(
      within(dialog).getByLabelText(/Type to confirm/),
      "console.access",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(writes(log)).toHaveLength(1));
    const sent = writes(log)[0]!.json as {
      rules: { id: string; when: { group?: string } }[];
    };
    expect(sent.rules[0]).toMatchObject({
      id: "r_aaaaaaaaaaaa",
      when: { group: "shippers" },
    });
    expect(sent.rules).toHaveLength(2);
  });
});

describe("Offers", () => {
  const offer = (
    product: string,
    name: string,
    group: string,
  ): AccessOffer => ({
    product,
    name,
    group,
  });
  let offers: AccessOffer[];
  let decideAnswer: unknown;
  beforeEach(() => {
    offers = [
      offer("djdl", "DJDL", "djdl-admins"),
      offer("tuner", "Tuner", "tuner-ops"),
    ];
    decideAnswer = {
      ok: true,
      product: "djdl",
      outcome: "accepted",
      ruleId: "r_dddddddddddd",
      notified: { sent: 2, of: 2 },
    };
  });

  function openOffers(me: Partial<Me> = asRole("superadmin")): FetchLog {
    return boot("#/platform/members?tab=sso", {
      me,
      extra: {
        [MEMBERS]: () => roster,
        [RULES]: () => rules,
        [PREVIEW]: () => previewAnswer,
        [OFFERS]: () => ({ offers }),
        [`POST ${OFFERS}`]: () => ({ ok: true, dismissed: ["djdl", "tuner"] }),
        [`POST ${OFFERS}/djdl`]: () => decideAnswer,
      },
    });
  }
  const posts = (log: FetchLog) =>
    log.calls.filter((c) => c.method === "POST" && c.path.startsWith(OFFERS));
  const MAP = "Map to DJDL admin…";

  async function clickFirst(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
  ): Promise<void> {
    const list = await screen.findByTestId("sso-offers");
    await user.click(within(list).getAllByRole("button", { name })[0]!);
  }

  /** Map the first offer, through the editor, to the open confirm dialog. */
  async function toDialog(user: ReturnType<typeof userEvent.setup>) {
    await clickFirst(user, MAP);
    await user.click(await screen.findByRole("button", { name: "Add rule…" }));
    return screen.findByRole("alertdialog");
  }

  it("lists each product with its group", async () => {
    openOffers();
    const list = await screen.findByTestId("sso-offers");
    expect(within(list).getByText("DJDL")).toBeTruthy();
    expect(within(list).getByText("djdl-admins")).toBeTruthy();
    expect(within(list).getByText("tuner-ops")).toBeTruthy();
    expect(screen.getByText("Admin groups from manifests")).toBeTruthy();
    expect(screen.queryByText(/Offers/)).toBeNull();
  });

  it("shows nothing when nothing is offered", async () => {
    offers = [];
    openOffers();
    await rulesList();
    expect(screen.queryByTestId("sso-offers")).toBeNull();
  });

  it("is read-only for a Platform admin, and names whom to ask", async () => {
    rules = stored({ editable: false });
    openOffers(asRole("platform_admin"));
    const list = await screen.findByTestId("sso-offers");
    expect(within(list).getByText("DJDL")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Map to/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Dismiss/ })).toBeNull();
  });

  it("Map opens the editor with the group, scrolled to and focused, then Cancel returns focus", async () => {
    const user = userEvent.setup();
    openOffers();
    await clickFirst(user, MAP);
    const heading = await screen.findByRole("heading", {
      name: "Map djdl-admins to DJDL admin",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const group = screen.getByLabelText("Group") as HTMLInputElement;
    expect(group.value).toBe("djdl-admins");
    expect(group.disabled).toBe(true);
    const areas = screen.getByRole("group", { name: "Areas they get" });
    expect(
      within(areas)
        .getByRole("checkbox", { name: /Members/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const first = within(await screen.findByTestId("sso-offers")).getAllByRole(
      "button",
      { name: MAP },
    )[0]!;
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it("sends the accept with the group, a caution dialog, and marks the row done", async () => {
    const user = userEvent.setup();
    const log = openOffers();
    const dialog = await toDialog(user);
    expect(
      within(dialog).getByText("Add a rule for DJDL's admin group?"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "People in djdl-admins become DJDL admins at their next sign-in.",
      ),
    ).toBeTruthy();
    await confirmIn(user, dialog, "Add rule", "convert");
    await waitFor(() => expect(posts(log)).toHaveLength(1));
    const call = posts(log)[0]!;
    expect(call.path).toBe(`${OFFERS}/djdl`);
    const body = call.json as Record<string, unknown>;
    expect(body).toMatchObject({
      action: "accept",
      group: "djdl-admins",
      connection: "console-idp",
      reason: "convert",
      confirm: "console.access",
    });
    expect(body.areas).not.toContain("members");
    await screen.findByText("Rule added");
  });

  it("on offer_changed closes the dialog, says so at the card and re-reads", async () => {
    const user = userEvent.setup();
    decideAnswer = json(
      { error: { code: "bad_request", message: "x", reason: "offer_changed" } },
      409,
    );
    const log = openOffers();
    const dialog = await toDialog(user);
    const before = log.calls.filter(
      (c) => c.path === OFFERS && c.method === "GET",
    ).length;
    await confirmIn(user, dialog, "Add rule");
    await screen.findByText("The group changed");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(
        log.calls.filter((c) => c.path === OFFERS && c.method === "GET").length,
      ).toBeGreaterThan(before),
    );
  });

  it("Dismiss asks first, then sends one dismissal and moves focus to the next row", async () => {
    const user = userEvent.setup();
    const log = openOffers();
    await clickFirst(user, "Dismiss…");
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Dismiss DJDL's admin group?"),
    ).toBeTruthy();
    expect(within(dialog).getByText("It won't be offered again.")).toBeTruthy();
    expect(posts(log)).toHaveLength(0);
    offers = [offers[1]!];
    await user.click(within(dialog).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(posts(log)).toHaveLength(1));
    expect(posts(log)[0]!.path).toBe(`${OFFERS}/djdl`);
    expect(posts(log)[0]!.json).toEqual({ action: "dismiss" });
    await waitFor(() =>
      expect(
        document.activeElement
          ?.closest("[data-offer]")
          ?.getAttribute("data-offer"),
      ).toBe("tuner"),
    );
  });

  it("Dismiss all says it can't be undone, then sends dismiss_all and focuses Rules", async () => {
    const user = userEvent.setup();
    const log = openOffers();
    await screen.findByTestId("sso-offers");
    await user.click(screen.getByRole("button", { name: "Dismiss all…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("This can't be undone.")).toBeTruthy();
    expect(posts(log)).toHaveLength(0);
    offers = [];
    await user.click(
      within(dialog).getByRole("button", { name: "Dismiss all" }),
    );
    await waitFor(() => expect(posts(log)).toHaveLength(1));
    expect(posts(log)[0]!.json).toEqual({ action: "dismiss_all" });
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("sso-rules-title"),
    );
  });

  it("switches Map off and says why once when there is no operator connection", async () => {
    rules = stored({ connections: [] });
    openOffers();
    const list = await screen.findByTestId("sso-offers");
    for (const btn of within(list).getAllByRole("button", { name: MAP }))
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(list.closest("[data-sso-offers]") as HTMLElement).getAllByText(
        /Add an operator connection first/,
      ),
    ).toHaveLength(1);
    expect(
      within(list.closest("[data-sso-offers]") as HTMLElement)
        .getByRole("link", { name: "Connections" })
        .getAttribute("href"),
    ).toBe("#/platform/connections");
  });

  it("reopens the saved accept after the sign-in when the rules read has not arrived", async () => {
    window.location.hash = "#/platform/members?tab=sso";
    stashStepUp("SSO rules", "console.access", {
      reason: "convert",
      rules: JSON.stringify([
        {
          when: { connection: "console-idp", group: "djdl-admins" },
          grant: {
            role: "product_admin",
            scope: "product:djdl",
            areas: ["ship"],
          },
        },
      ]),
      offer: JSON.stringify(offer("djdl", "DJDL", "djdl-admins")),
      title: "Add a rule for DJDL's admin group?",
      confirmLabel: "Add rule",
      lead: "People in djdl-admins become DJDL admins at their next sign-in.",
      intent: "caution",
    });
    openOffers();
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Add a rule for DJDL's admin group?"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "People in djdl-admins become DJDL admins at their next sign-in.",
      ),
    ).toBeTruthy();
    expect(
      (within(dialog).getByLabelText("Reason") as HTMLTextAreaElement).value,
    ).toBe("convert");
  });
});
