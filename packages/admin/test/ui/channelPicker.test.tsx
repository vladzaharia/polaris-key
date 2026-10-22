import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelPicker } from "../../src/ui/ChannelPicker.js";

afterEach(cleanup);

describe("ChannelPicker locked stable", () => {
  it("draws stable ticked and locked, with Always included on focus", async () => {
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

describe("ChannelPicker dev includes beta", () => {
  it("draws beta ticked and locked with the catalog reason when dev is chosen", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChannelPicker value={["dev"]} onChange={onChange} />);
    const beta = screen.getByRole("checkbox", { name: "beta" });
    expect(beta.getAttribute("aria-checked")).toBe("true");
    expect((beta as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Included with dev.")).toBeTruthy();
    await user.click(beta);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("choosing dev returns beta with it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChannelPicker value={[]} onChange={onChange} held={["dev"]} />);
    await user.click(screen.getByRole("checkbox", { name: "dev" }));
    expect(onChange).toHaveBeenCalledWith(["beta", "dev"]);
  });
});
