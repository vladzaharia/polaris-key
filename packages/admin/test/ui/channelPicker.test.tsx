import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelPicker } from "../../src/ui/ChannelPicker.js";

afterEach(cleanup);

describe("ChannelPicker locked stable", () => {
  it("draws stable ticked and locked, with Always included on focus", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChannelPicker value={["beta"]} onChange={onChange} />);
    const stable = screen.getByRole("checkbox", { name: "stable" });
    expect(stable.getAttribute("aria-checked")).toBe("true");
    expect((stable as HTMLButtonElement).disabled).toBe(true);
    const chip = document.querySelector<HTMLElement>("[data-locked]")!;
    expect(chip.className).toContain("border-dashed");
    // Keyboard first: the tooltip opens on keyboard focus, not after a pointer press.
    await user.tab();
    expect(document.activeElement).toBe(chip);
    expect(
      (await screen.findAllByText("Always included")).length,
    ).toBeGreaterThan(0);
    await user.click(stable);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never adds stable to the value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChannelPicker value={[]} onChange={onChange} />);
    await user.click(screen.getByRole("checkbox", { name: "beta" }));
    expect(onChange).toHaveBeenCalledWith(["beta"]);
  });

  it("lockStable=false keeps stable an ordinary option", () => {
    render(<ChannelPicker value={[]} lockStable={false} />);
    expect(
      (screen.getByRole("checkbox", { name: "stable" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
