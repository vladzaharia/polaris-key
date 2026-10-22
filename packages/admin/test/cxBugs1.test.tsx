/**
 * CX-BUGS-1: the Console release-candidate bugs, one test per item.
 *
 *  1  axe `aria-hidden-focus` while a menu or select is open (the page outside is `inert`)
 *  2  an unknown role names itself and a render crash shows the house error state
 *  3  a view-only member's record pages: write controls soft-disabled with the reason
 *  4  the step-up refusal shows its description
 *  5  a disabled confirm says why
 *  7  the specific consequence lines are body text
 */

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type { Me, MeRole } from "../src/api.js";
import { roleLabel } from "../src/console/access/can.js";
import { AppErrorBoundary } from "../src/ui/AppErrorBoundary.js";
import { ActionMenu } from "../src/ui/ActionMenu.js";
import { ConfirmDialog } from "../src/ui/ConfirmDialog.js";
import { Select } from "../src/ui/Select.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../src/ui/DropdownMenu.js";
import { ME, boot, resetConsole } from "./consoleHarness.js";
import { API, bootLicense } from "./licenseFixture.js";
import { stubDom } from "./releaseHarness.js";
import { CHANNELS, STORE } from "./releaseFixture.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});
const hiddenFocus: { runOnly: string[] } = {
  runOnly: ["aria-hidden-focus"],
};

beforeEach(() => {
  resetConsole();
  stubDom();
});
afterEach(cleanup);

/** A signed-in member who can view a product's areas and edit none. */
const VIEWER: Partial<Me> = {
  platformAdmin: false,
  permissions: {
    roles: [],
    platform: { view: ["console"], edit: [] },
    products: {
      djdl: {
        view: ["core", "license", "config", "ship", "settings"],
        edit: [],
      },
    },
  },
};

describe("1 · a menu or select open", () => {
  function Page(): React.ReactElement {
    return (
      <div>
        <button type="button">Outside action</button>
        <ActionMenu
          label="Row actions"
          items={[{ label: "Open", onSelect: () => undefined }]}
        />
        <DropdownMenu>
          <DropdownMenuTrigger>Account</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Select
          aria-label="Kind"
          value="a"
          options={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
          ]}
        />
      </div>
    );
  }

  it("makes the page outside inert for an action menu, and axe finds nothing focusable hidden", async () => {
    render(<Page />);
    await userEvent.click(screen.getByRole("button", { name: "Row actions" }));
    await screen.findByRole("menu");
    expect(
      (screen
        .getByText("Outside action")
        .closest("[inert]") as HTMLElement | null) !== null,
    ).toBe(true);
    expect((await axe(document.body, hiddenFocus)).violations).toEqual([]);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.querySelector("[inert]")).toBeNull();
  });

  it("does the same for the composable dropdown menu", async () => {
    render(<Page />);
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    await screen.findByRole("menu");
    expect(document.querySelector("[inert]")).not.toBeNull();
    expect((await axe(document.body, hiddenFocus)).violations).toEqual([]);
  });

  it("does the same for a select, and gives the page back when it closes", async () => {
    render(<Page />);
    await userEvent.click(screen.getByRole("combobox", { name: "Kind" }));
    await screen.findByRole("listbox");
    expect(document.querySelector("[inert]")).not.toBeNull();
    expect((await axe(document.body, hiddenFocus)).violations).toEqual([]);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(document.querySelector("[inert]")).toBeNull();
  });
});

describe("2 · an unknown role", () => {
  const strange = {
    role: "auditor",
    scope: "platform",
    areas: null,
    source: "grant",
  } as unknown as MeRole;

  it("is named by its id, never nothing", () => {
    expect(roleLabel(strange, (s) => s)).toEqual({
      label: "auditor",
      areas: null,
    });
  });

  it("does not blank the console: the no-access page names the role", async () => {
    boot("#/", {
      me: {
        platformAdmin: false,
        products: [],
        permissions: {
          roles: [strange],
          platform: { view: ["console"], edit: ["console"] },
          products: {},
        },
      },
    });
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("You don't have access to any product yet");
    expect(screen.getByText("auditor")).toBeTruthy();
  });

  it("shows the house error state, with Reload and Copy details, when a page throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload, hash: "#/x" });
    function Boom(): React.ReactElement {
      throw new Error("Cannot destructure property 'label'");
    }
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Something went wrong")).toBeTruthy();
    expect(
      within(alert).getByRole("button", { name: "Copy details" }),
    ).toBeTruthy();
    await userEvent.click(
      within(alert).getByRole("button", { name: "Reload" }),
    );
    expect(reload).toHaveBeenCalled();
    vi.unstubAllGlobals();
    log.mockRestore();
  });
});

/** A page action drawn inline as a button, or inside "More actions" as a menu item. */
async function anyAction(name: RegExp): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      screen.queryAllByRole("button", { name: "More actions" }).length +
        screen.queryAllByRole("button", { name }).length,
    ).toBeGreaterThan(0),
  );
  const inline = screen.queryAllByRole("button", { name })[0];
  if (inline) return inline;
  await userEvent.click(
    screen.getAllByRole("button", { name: "More actions" })[0]!,
  );
  return screen.findByRole("menuitem", { name });
}

describe("3 · a view-only member on a record page", () => {
  it("license record: change tier, resend, and the menu's writes are soft-disabled; reads stay live", async () => {
    bootLicense("#/p/djdl/license/licenses/lic_1", { me: VIEWER });
    const tier = await screen.findByRole("button", { name: /Change tier/ });
    expect(tier.getAttribute("aria-disabled")).toBe("true");
    // The primary action (Add key / Resend / Assign) is locked too.
    const main = screen.getByRole("button", { name: /Add key|Resend|Assign/ });
    expect(main.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "More actions" }))[0]!,
    );
    const edit = await screen.findByRole("menuitem", { name: /Edit holder/ });
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    const view = screen.getByRole("menuitem", { name: /View in activity/ });
    expect(view.getAttribute("aria-disabled")).toBeNull();
  });

  it("tier record: the inputs are read-only, New tier is soft-disabled", async () => {
    bootLicense("#/p/djdl/license/tiers/pro", { me: VIEWER });
    const form = await screen.findByRole("form", { name: "Tier" });
    const boxes = within(form).getAllByRole("textbox");
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) expect((b as HTMLInputElement).readOnly).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "New tier" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("profile payload: Edit details is soft-disabled", async () => {
    bootLicense("#/p/djdl/config/profiles/base", { me: VIEWER });
    await screen.findByRole("heading", { level: 1, name: "Base" });
    const edit = await anyAction(/Edit details/);
    expect(edit.getAttribute("aria-disabled")).toBe("true");
  });

  it("release record: Roll back and Promote are soft-disabled", async () => {
    bootLicense("#/p/djdl/release/releases/v0.4.2", {
      me: VIEWER,
      routes: {
        [`${API}/release/releases`]: STORE,
        [`${API}/release/channels`]: CHANNELS,
        [`${API}/distribution/matrix`]: {
          deliverableId: "app",
          limit: 50,
          outlets: [],
          releases: [],
          cells: [],
        },
      },
    });
    await screen.findByRole("heading", { level: 1 });
    for (const name of [/Roll back/, /Promote/]) {
      const item = await anyAction(name);
      expect(item.getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("an editor still sees live controls", async () => {
    bootLicense("#/p/djdl/license/licenses/lic_1");
    const tier = await screen.findByRole("button", { name: /Change tier/ });
    expect(tier.getAttribute("aria-disabled")).toBeNull();
  });
});

describe("4 · the step-up refusal", () => {
  it("shows its description under the title", async () => {
    const err = Object.assign(new Error("step up"), {
      status: 403,
      code: "step_up_required",
    });
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Relax it?"
        onConfirm={() => Promise.reject(err)}
        describeError={() => ({
          title: "Sign in again to confirm it's you",
          description: "Relaxing needs a recent sign-in. Nothing was saved.",
        })}
        confirmLabel="Relax"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Relax" }));
    expect(
      await screen.findByText(
        "Relaxing needs a recent sign-in. Nothing was saved.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Sign in again to confirm it's you")).toBeTruthy();
  });
});

describe("5 · a disabled confirm", () => {
  it("says why: focusable, aria-disabled, the reason linked", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Relax it?"
        onConfirm={() => undefined}
        confirmLabel="Relax"
        confirmDisabled
        confirmDisabledReason="Add a reason to continue"
      />,
    );
    const b = screen.getByRole("button", { name: "Relax" });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Add a reason to continue")).toBeTruthy();
  });
});

describe("7 · the consequence lines", () => {
  it("are body text under a lead, not muted", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Relax it?"
        lead={<p>Generic lead.</p>}
        consequences={["Sync now accepts any device."]}
        onConfirm={() => undefined}
      />,
    );
    const line = screen.getByText("Sync now accepts any device.");
    expect(line.parentElement!.className).toContain("text-fg");
    expect(line.parentElement!.className).not.toContain("text-fg-muted");
  });
});

void ME;
