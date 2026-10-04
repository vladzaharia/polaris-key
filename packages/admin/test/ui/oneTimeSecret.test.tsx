import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import {
  OneTimeSecretDialog,
  saveAsFile,
} from "../../src/ui/OneTimeSecretPanel.js";

afterEach(cleanup);

function Harness({
  onDone = () => undefined,
}: {
  onDone?: () => void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <OneTimeSecretDialog
        open={open}
        onOpenChange={setOpen}
        title="License created"
        label="License key"
        value="PK-123"
        onDone={onDone}
      />
    </>
  );
}

describe("OneTimeSecretPanel close guard", () => {
  it("Escape asks before closing; keeping it open keeps the key", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByRole("dialog", { name: "License created" });
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("state").textContent).toBe("open");
    expect(screen.getByRole("alert").textContent).toContain(
      "Close without copying? The license key cannot be shown again.",
    );
    await user.click(screen.getByRole("button", { name: "Keep it open" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(
      screen.getByRole("button", { name: "Close without copying" }),
    );
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("Done is gated until the key is copied, then closes", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<Harness onDone={onDone} />);
    const done = await screen.findByRole("button", { name: "Done" });
    expect(done.getAttribute("aria-disabled")).toBe("true");
    await user.click(done);
    expect(onDone).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    await act(async () => {
      await user.click(
        screen.getByRole("button", { name: "Copy license key" }),
      );
    });
    const enabled = screen.getByRole("button", { name: "Done" });
    expect(enabled.getAttribute("aria-disabled")).toBeNull();
    await user.click(enabled);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("ticking the acknowledgement also unlocks Done", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(
      await screen.findByLabelText("I've stored this license key"),
    );
    expect(
      screen
        .getByRole("button", { name: "Done" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("saveAsFile falls back to a data URL without createObjectURL", () => {
    const original = URL.createObjectURL;
    // @ts-expect-error simulate an engine without object URLs
    URL.createObjectURL = undefined;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.href.startsWith("data:")).toBe(true);
        expect(this.download).toBe("x.pkeybundle");
      });
    expect(saveAsFile("abc", "x.pkeybundle")).toBe(true);
    expect(click).toHaveBeenCalled();
    click.mockRestore();
    URL.createObjectURL = original;
  });
});
