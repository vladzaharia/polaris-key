import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyButton } from "../../src/ui/CopyButton.js";
import { lastAnnouncement } from "../../src/ui/LiveRegion.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubClipboard(writeText: (v: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("CopyButton", () => {
  it("copies and announces Copied", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    const onCopy = vi.fn();
    render(
      <CopyButton value="pub-key" label="Copy public key" onCopy={onCopy} />,
    );
    stubClipboard(writeText);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Copy public key" }));
    });
    expect(writeText).toHaveBeenCalledWith("pub-key");
    expect(lastAnnouncement()).toBe("Copied");
    expect(onCopy).toHaveBeenCalledWith(true);
  });

  it("on failure reveals the value selected and announces the copy chord", async () => {
    const user = userEvent.setup();
    render(<CopyButton value="pub-key" label="Copy public key" />);
    stubClipboard(async () => {
      throw new Error("denied");
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Copy public key" }));
    });
    const field = await screen.findByLabelText(/to copy/);
    expect((field as HTMLInputElement).value).toBe("pub-key");
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(lastAnnouncement()).toMatch(/^Press (⌘C|Ctrl\+C) to copy$/);
  });
});
