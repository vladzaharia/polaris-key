import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionMenu } from "../../src/ui/ActionMenu.js";

afterEach(cleanup);

describe("ActionMenu", () => {
  it("shows a disabled item with its reason and never fires it; enabled items fire", async () => {
    const user = userEvent.setup();
    const yank = vi.fn();
    const promote = vi.fn();
    render(
      <ActionMenu
        label="Actions for release 2.4.0"
        items={[
          { label: "Promote…", onSelect: promote },
          { type: "separator" },
          {
            label: "Yank…",
            tone: "danger",
            disabledReason: "Already yanked",
            onSelect: yank,
          },
        ]}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Actions for release 2.4.0" }),
    );
    const item = await screen.findByRole("menuitem", { name: /Yank/ });
    expect(item.textContent).toContain("Already yanked");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await user.click(item);
    expect(yank).not.toHaveBeenCalled();
    expect(screen.getByRole("separator")).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "Promote…" }));
    expect(promote).toHaveBeenCalledTimes(1);
  });
});
