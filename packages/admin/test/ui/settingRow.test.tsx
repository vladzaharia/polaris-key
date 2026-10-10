import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import {
  SettingRow,
  type SettingRowProps,
} from "../../src/ui/settings/SettingRow.js";
import { lastAnnouncement } from "../../src/ui/LiveRegion.js";

afterEach(cleanup);
const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

const conflict = Object.assign(new Error("conflict"), { status: 409 });

function row(over: Partial<SettingRowProps> = {}) {
  const save = vi.fn(async (_v: unknown, _c: unknown) => ({ ok: true }));
  const props: SettingRowProps = {
    id: "s1",
    settingKey: "grace.days",
    label: "Grace period",
    help: "How long it stays.",
    spec: { kind: "integer", unit: "days", min: 1, max: 365 },
    confirm: { up: "L0", down: "L1" },
    value: 21,
    version: 3,
    source: <span>Code default</span>,
    save,
    isConflict: (e) => e === conflict,
    describeError: (e) => ({
      title: e instanceof Error ? e.message : "failed",
    }),
    ...over,
  };
  return { save, ...render(<SettingRow {...props} />) };
}

async function type(value: string) {
  const input = screen.getByRole("textbox", { name: "Grace period (days)" });
  await userEvent.clear(input);
  await userEvent.type(input, value);
  return input;
}

describe("SettingRow states", () => {
  it("default: the value, its owner, nothing to save", async () => {
    const { container } = row();
    expect(screen.getByText("Code default")).toBeTruthy();
    expect(screen.queryByText("Not saved")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(
      container.querySelector("[data-state]")!.getAttribute("data-state"),
    ).toBe("default");
    expect((await axe(container)).violations.map((v) => v.id)).toEqual([]);
  });

  it("changed: names Not saved and what it was, in words, with Discard", async () => {
    const { container } = row();
    const input = await type("30");
    expect(screen.getByText("Not saved")).toBeTruthy();
    expect(screen.getByText("was 21 days")).toBeTruthy();
    expect(
      container.querySelector("[data-state]")!.getAttribute("data-state"),
    ).toBe("changed");
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect((input as HTMLInputElement).value).toBe("21");
    expect(screen.queryByText("Not saved")).toBeNull();
    expect(lastAnnouncement()).toBe("Changes to Grace period discarded");
  });

  it("saves at L0 without a dialog, with the version it read", async () => {
    const { save } = row();
    await type("30");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(30, { expectedVersion: 3, level: "L0" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks first at L1 and sends nothing on Cancel", async () => {
    const { save } = row();
    await type("7");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(save).not.toHaveBeenCalled();
    // The draft survives a cancelled confirmation.
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("7");
  });

  it("a critical setting needs a reason before it can be confirmed, and sends it", async () => {
    const { save } = row({ critical: true, confirm: { up: "L1", down: "L1" } });
    await type("30");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Save 30 days",
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Reason" }),
      "Audit",
    );
    await userEvent.click(confirm);
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith(30, {
      expectedVersion: 3,
      level: "L1",
      reason: "Audit",
    });
  });

  it("L3 types the key to confirm; confirming before it matches sends nothing", async () => {
    const { save } = row({ confirm: { up: "L3", down: "L3" } });
    await type("30");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Save 30 days",
    });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(confirm);
    expect(save).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByRole("textbox"), "grace.days");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save 30 days" }),
    );
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![1]).toMatchObject({ level: "L3" });
  });

  it("error: an out-of-range draft is refused in the slot and never sent", async () => {
    const { save } = row();
    await type("999");
    await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Use 365 or less.",
    );
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  it("error: a failed save shows the API's words and keeps the input", async () => {
    const save = vi.fn(async () => {
      throw new Error("The store is down");
    });
    row({ save, confirm: { up: "L0", down: "L0" } });
    const input = await type("30");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The store is down",
    );
    expect((input as HTMLInputElement).value).toBe("30");
    expect(screen.getByText("Not saved")).toBeTruthy();
  });

  it("conflict: names it, keeps the draft, Reload, then saves against the new version", async () => {
    let version = 3;
    let value = 21;
    const save = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue({ ok: true });
    const reload = vi.fn(async () => {
      version = 4;
      value = 45;
      view.rerender(<SettingRow {...base()} />);
    });
    const base = (): SettingRowProps => ({
      id: "s1",
      settingKey: "grace.days",
      label: "Grace period",
      spec: { kind: "integer", unit: "days", min: 1, max: 365 },
      confirm: { up: "L0", down: "L0" },
      value,
      version,
      source: <span>Code default</span>,
      save,
      reload,
      isConflict: (e) => e === conflict,
    });
    const view = render(<SettingRow {...base()} />);
    const input = await type("60");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("This setting changed since you loaded it"),
    ).toBeTruthy();
    expect(screen.getByText(/your 60 days stays in the field/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(await screen.findByText("Reloaded")).toBeTruthy();
    expect(screen.getByText(/It now reads 45 days/)).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("60");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![1]).toMatchObject({ expectedVersion: 4 });
  });

  it("locked: the reason is text beside the value, and the control is off", () => {
    row({
      spec: { kind: "switch" },
      confirm: { on: "L0", off: "L0" },
      value: "off",
      locked: "Turned off at deploy time.",
    });
    expect(screen.getByText(/Turned off at deploy time/)).toBeTruthy();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("a switch commits on change; L0 needs no dialog", async () => {
    const { save } = row({
      spec: { kind: "switch" },
      confirm: { on: "L0", off: "L0" },
      value: "off",
    });
    await userEvent.click(screen.getByRole("switch", { name: "Grace period" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith("on", {
        expectedVersion: 3,
        level: "L0",
      }),
    );
  });

  it("keyboard: Enter saves a field, Escape discards it", async () => {
    const { save } = row({ confirm: { up: "L0", down: "L0" } });
    const input = await type("30");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await userEvent.clear(input);
    await userEvent.type(input, "5");
    await userEvent.keyboard("{Escape}");
    expect((input as HTMLInputElement).value).toBe("21");
  });

  it("revert asks first, then runs with the version", async () => {
    const run = vi.fn(async () => ({}));
    row({
      revertPlan: () => ({
        level: "L1",
        title: "Revert grace period?",
        confirmLabel: "Revert to 30 days",
        consequences: ["Becomes 30 days."],
        run,
      }),
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Revert grace period…" }),
    );
    expect(run).not.toHaveBeenCalled();
    await userEvent.click(
      await screen.findByRole("button", { name: "Revert to 30 days" }),
    );
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({ expectedVersion: 3 }),
    );
  });

  it("history: opens a drawer with who, when and from what to what", async () => {
    row({
      history: async () => [
        {
          id: "1",
          by: "ada@x.io",
          at: 1_790_000_000_000,
          change: "14 days → 21 days",
        },
      ],
    });
    await userEvent.click(
      screen.getByRole("button", { name: "History of grace period" }),
    );
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("14 days → 21 days")).toBeTruthy();
    expect(within(drawer).getByText(/ada@x.io/)).toBeTruthy();
  });

  it("history: a failed load says so and offers Try again", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValue([]);
    row({ history: load });
    await userEvent.click(
      screen.getByRole("button", { name: "History of grace period" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Try again" }),
    );
    expect(await screen.findByText("No changes recorded yet.")).toBeTruthy();
  });
});
