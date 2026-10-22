import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AreaId, Me, Member, MembersView } from "../src/api.js";
import { ROLES_MATRIX } from "../src/console/access/rolesMatrix.generated.js";
import { boot, resetConsole } from "./consoleHarness.js";

/** Platform → Members → Roles (`#/platform/members?tab=roles`, ST-31.13). */

const PATH = "/manage/api/members";

function member(id: string, roles: string[]): Member {
  return {
    memberId: id,
    name: id,
    email: `${id}@x.io`,
    lastSignInAt: null,
    disabled: false,
    you: false,
    roles: roles.map((role) => ({
      role: role as "superadmin",
      scope: role === "product_admin" ? "product:djdl" : "platform",
      areas: null,
      source: "grant" as const,
      bindingId: `b_${id}_${role}`,
      grantedBy: null,
      grantedAt: null,
    })),
  };
}

function view(over: Partial<MembersView> = {}): MembersView {
  return {
    rootRule: { group: null },
    truncated: false,
    incomplete: false,
    members: [
      member("ada", ["superadmin", "console_access"]),
      member("bo", ["superadmin"]),
      member("cy", ["product_admin"]),
      member("di", ["product_admin", "product_admin"]),
      member("ed", ["product_admin"]),
    ],
    invites: [],
    ...over,
  };
}

const AREAS: AreaId[] = ["console", "platform", "members", "docs"];
function asRole(role: "superadmin" | "platform_admin"): Partial<Me> {
  return {
    platformAdmin: true,
    permissions: {
      roles: [{ role, scope: "platform", areas: null, source: "grant" }],
      platform: { view: AREAS, edit: AREAS },
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

function open(me: Partial<Me> = asRole("superadmin")) {
  return boot("#/platform/members?tab=roles", {
    me,
    extra: { [PATH]: () => answer },
  });
}

const cardOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-role-card="${id}"]`)!;

describe("Members: Roles tab", () => {
  it("shows four role cards in order, with who gives each and how many hold it", async () => {
    open();
    await screen.findByRole("heading", { level: 2, name: "Superadmin" });
    const names = [...document.querySelectorAll("[data-role-card] h2")].map(
      (h) => h.textContent,
    );
    expect(names).toEqual([
      "Superadmin",
      "Platform admin",
      "Product admin",
      "Console access",
    ]);
    await within(cardOf("superadmin")).findByText("2 people");
    expect(
      within(cardOf("superadmin")).getByText(
        /Given by a Superadmin or the root rule/,
      ),
    ).toBeTruthy();
    expect(
      within(cardOf("platform_admin")).getByText("No one yet"),
    ).toBeTruthy();
    // A member with two bindings of one role counts once.
    expect(within(cardOf("product_admin")).getByText("3 people")).toBeTruthy();
    expect(within(cardOf("console_access")).getByText("1 person")).toBeTruthy();
    expect(screen.queryByText(/Create role/i)).toBeNull();
  });

  it("renders the matrix exactly as generated: rows, ticks, words, footnotes", async () => {
    open();
    const table = await screen.findByRole("table", {
      name: /What each role can do/,
    });
    const rows = [...table.querySelectorAll("[data-matrix-row]")];
    const expected = [
      ...ROLES_MATRIX.productRows,
      ...ROLES_MATRIX.platformRows,
    ];
    expect(rows.map((r) => r.getAttribute("data-matrix-row"))).toEqual(
      expected.map((r) => r.id),
    );
    expected.forEach((row, i) => {
      const tr = rows[i] as HTMLElement;
      expect(within(tr).getByText(row.name)).toBeTruthy();
      if (row.detail) expect(within(tr).getByText(row.detail)).toBeTruthy();
      row.cells.forEach((cell, c) => {
        const td = tr.querySelectorAll("td")[c]!;
        expect(td.getAttribute("data-role-col")).toBe(
          ROLES_MATRIX.roles[c]!.id,
        );
        if (cell.kind === "tick")
          expect(within(td).getByRole("img", { name: "Manage" })).toBeTruthy();
        else if (cell.kind === "none")
          expect(within(td).getByText("No access")).toBeTruthy();
        else {
          const w = within(td).getByText(cell.word);
          expect(w.getAttribute("aria-describedby")).toBe(
            `roles-note-${cell.note}`,
          );
        }
      });
    });
    for (const f of ROLES_MATRIX.footnotes) {
      const li = document.getElementById(`roles-note-${f.id}`)!;
      expect(li.textContent).toContain(f.word);
      expect(li.textContent?.toLowerCase()).toContain(f.text.toLowerCase());
    }
    expect(screen.getByText(/A person’s roles add up/)).toBeTruthy();
  });

  it("phone tiles pick the one role column the matrix shows", async () => {
    const user = userEvent.setup();
    open();
    const tiles = await screen.findByRole("group", { name: "Role" });
    const product = within(tiles).getByRole("button", {
      name: /Product admin/,
    });
    expect(product.getAttribute("aria-pressed")).toBe("true");
    const shown = () =>
      [...document.querySelectorAll("thead th[data-role-col]")]
        .filter((th) => !th.className.includes("max-sm:hidden"))
        .map((th) => th.getAttribute("data-role-col"));
    expect(shown()).toEqual(["product_admin"]);
    await user.click(
      within(tiles).getByRole("button", { name: /Console access/ }),
    );
    expect(shown()).toEqual(["console_access"]);
    expect(
      screen.getByText(/Every other role includes it/, {
        selector: "#roles-detail p",
      }),
    ).toBeTruthy();
  });

  it("looks the same to a Platform admin", async () => {
    open(asRole("platform_admin"));
    await screen.findByRole("table", { name: /What each role can do/ });
    expect(
      await within(cardOf("superadmin")).findByText("2 people"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite people" })).toBeNull();
  });

  it("says a count is a floor when the list is cut", async () => {
    answer = view({ truncated: true });
    open();
    await screen.findByRole("heading", { level: 2, name: "Superadmin" });
    expect(
      await within(cardOf("superadmin")).findByText("At least 2 people"),
    ).toBeTruthy();
  });

  it("keeps the matrix and says the counts failed, with Try again", async () => {
    const user = userEvent.setup();
    answer = new Response(
      JSON.stringify({ error: { code: "internal", message: "boom" } }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
    open();
    const retry = await screen.findByRole("button", {
      name: /Retry|Try again/,
    });
    expect(
      screen.getByRole("table", { name: /What each role can do/ }),
    ).toBeTruthy();
    expect(within(cardOf("superadmin")).getByText("Not counted")).toBeTruthy();
    answer = view();
    await user.click(retry);
    expect(
      await within(cardOf("superadmin")).findByText("2 people"),
    ).toBeTruthy();
  });

  it("the tab strip moves between Members and Roles", async () => {
    const user = userEvent.setup();
    open();
    const nav = await screen.findByRole("navigation", { name: "Members" });
    const members = within(nav).getByRole("link", { name: /^Members/ });
    expect(
      within(nav)
        .getByRole("link", { name: "Roles" })
        .getAttribute("aria-current"),
    ).toBe("page");
    await user.click(members);
    expect(await screen.findByRole("table", { name: "Members" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite people" })).toBeTruthy();
  });
});
