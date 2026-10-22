import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelPicker } from "../../src/ui/ChannelPicker.js";

afterEach(cleanup);

describe("ChannelPicker locked stable", () => {
  it("draws stable ticked and locked, with Always included said once", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ChannelPicker value={["beta"]} onChange={onChange} fixed={["stable"]} />,
    );
    const stable = screen.getByRole("checkbox", { name: "stable" });
    expect(stable.getAttribute("aria-checked")).toBe("true");
    expect((stable as HTMLButtonElement).disabled).toBe(true);
    const chip = document.querySelector<HTMLElement>("[data-locked]")!;
    expect(chip.className).toContain("border-dashed");
    await user.tab();
    expect(document.activeElement).toBe(chip);
    // Said once: the visible description, with no tooltip repeating it to assistive tech.
    expect(screen.getAllByText("Always included")).toHaveLength(1);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.click(stable);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never adds stable to the value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChannelPicker value={[]} onChange={onChange} fixed={["stable"]} />);
    await user.click(screen.getByRole("checkbox", { name: "beta" }));
    expect(onChange).toHaveBeenCalledWith(["beta"]);
  });

  it("without fixed, stable is an ordinary option", () => {
    render(<ChannelPicker value={[]} />);
    expect(
      (screen.getByRole("checkbox", { name: "stable" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
