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
import { Dialog } from "../src/ui/Dialog.js";
import { WriteLock } from "../src/ui/WriteLock.js";
import { useInertOutside } from "../src/ui/useInertOutside.js";
import {
  DataTable,
  EMPTY_TABLE_STATE,
  type DataColumn,
  type TableState,
} from "../src/ui/data-table/index.js";
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

describe("read controls stay live under a WriteLock", () => {
  it("the license record's revoked-keys toggle works for a view-only member", async () => {
    bootLicense("#/p/djdl/license/licenses/lic_1/keys", { me: VIEWER });
    const toggle = await screen.findByRole("button", {
      name: /Show 1 revoked/,
    });
    expect(toggle.getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(toggle);
    expect(
      screen
        .getByRole("button", { name: /Hide 1 revoked/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  interface Row {
    id: string;
    name: string;
    status: string;
  }
  const ROWS: Row[] = [
    { id: "a", name: "Studio", status: "active" },
    { id: "b", name: "Lab", status: "expired" },
  ];
  const COLUMNS: DataColumn<Row>[] = [
    { id: "name", header: "Holder", accessorKey: "name" },
    { id: "status", header: "Status", accessorKey: "status" },
  ];
  function Locked({ q }: { q: string }): React.ReactElement {
    const [state, setState] = React.useState<TableState>({
      ...EMPTY_TABLE_STATE,
      q,
    });
    return (
      <WriteLock locked reason="View only">
        <DataTable<Row>
          id="t"
          caption="Rows"
          data={ROWS}
          columns={COLUMNS}
          getRowId={(r) => r.id}
          rowLabel={(r) => r.name}
          search={{ placeholder: "Search", columns: ["name"] }}
          facets={[
            {
              id: "status",
              label: "Status",
              options: [
                { value: "active", label: "Active" },
                { value: "expired", label: "Expired" },
              ],
            },
          ]}
          state={state}
          onStateChange={setState}
          exportCsv={false}
          pagination={{
            mode: "cursor",
            local: true,
            hasMore: true,
            onLoadMore: more,
            onSearchAll: searchAll,
          }}
        />
      </WriteLock>
    );
  }
  const more = vi.fn();
  const searchAll = vi.fn();

  it("DataTable: Load more, Search all and the filters are not locked", async () => {
    more.mockClear();
    searchAll.mockClear();
    render(<Locked q="" />);
    const load = screen.getByRole("button", { name: "Load more" });
    expect(load.getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(load);
    expect(more).toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /Filter by status/ }),
    );
    const opt = await screen.findByRole("checkbox", { name: /Active/ });
    expect(opt.getAttribute("aria-readonly")).toBeNull();
    await userEvent.click(opt);
    expect(
      screen.getByRole("button", { name: /Status: 1 selected/ }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      screen.getByRole("button", { name: "Clear filters" }),
    );
    cleanup();
    render(<Locked q="zzz" />);
    const all = await screen.findAllByRole("button", { name: "Search all" });
    for (const b of all) expect(b.getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(all[0]!);
    expect(searchAll).toHaveBeenCalled();
  });
});

describe("popups inside a dialog, and overlapping popups", () => {
  function InDialog(): React.ReactElement {
    return (
      <Dialog open onOpenChange={() => undefined} title="Edit">
        <Select
          aria-label="Kind"
          value="a"
          options={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
          ]}
        />
        <ActionMenu
          label="More"
          items={[{ label: "Go", onSelect: () => undefined }]}
        />
      </Dialog>
    );
  }

  it("a select and an action menu in a dialog give the page back on Escape, and focus returns", async () => {
    render(<InDialog />);
    for (const [trigger, popup] of [
      [() => screen.getByRole("combobox", { name: "Kind" }), "listbox"],
      [() => screen.getByRole("button", { name: "More" }), "menu"],
    ] as const) {
      const t = trigger();
      await userEvent.click(t);
      await screen.findByRole(popup);
      expect(document.querySelector("[inert]")).not.toBeNull();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole(popup)).toBeNull());
      expect(document.querySelector("[inert]")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(t));
      expect(screen.getByRole("dialog")).toBeTruthy();
    }
  });

  it("unmounting the tree while a popup is open leaves nothing inert", async () => {
    const { unmount } = render(<Page2 />);
    await userEvent.click(screen.getByRole("combobox", { name: "Kind" }));
    await screen.findByRole("listbox");
    unmount();
    expect(document.querySelector("[inert]")).toBeNull();
  });

  function Page2(): React.ReactElement {
    return (
      <div>
        <button type="button">Page</button>
        <Select
          aria-label="Kind"
          value="a"
          options={[{ value: "a", label: "A" }]}
        />
      </div>
    );
  }

  function Popup({ name }: { name: string }): React.ReactElement {
    const ref = useInertOutside<HTMLDivElement>();
    return <div ref={ref} data-popup={name} />;
  }

  it("overlapping popups: the page stays inert until the last closes, and a pre-inert element is never freed", () => {
    const page = document.createElement("div");
    const pre = document.createElement("div");
    pre.setAttribute("inert", "");
    document.body.append(page, pre);
    const a = render(<Popup name="a" />);
    const aEl = document.querySelector("[data-popup=a]")!.parentElement!;
    expect(page.hasAttribute("inert")).toBe(true);
    const b = render(<Popup name="b" />);
    expect(aEl.hasAttribute("inert")).toBe(true);
    a.unmount();
    expect(page.hasAttribute("inert")).toBe(true);
    b.unmount();
    expect(page.hasAttribute("inert")).toBe(false);
    expect(pre.hasAttribute("inert")).toBe(true);
    page.remove();
    pre.remove();
  });
});

describe("the error boundary's copied details", () => {
  it("carry the page path without its query", async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: write },
      configurable: true,
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.location.hash = "#/p/djdl/license/licenses?q=ada%40x.io";
    function Boom(): React.ReactElement {
      throw new Error("x");
    }
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Copy details" }),
    );
    await waitFor(() => expect(write).toHaveBeenCalled());
    const copied = String((write.mock.calls[0] as unknown[])[0]);
    expect(copied).toContain("#/p/djdl/license/licenses");
    expect(copied).not.toContain("ada");
    log.mockRestore();
  });
});
