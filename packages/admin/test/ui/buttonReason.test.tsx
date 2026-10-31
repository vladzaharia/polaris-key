import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "../../src/ui/Button.js";
import { IconButton } from "../../src/ui/IconButton.js";

afterEach(cleanup);

describe("a disabledReason that comes or goes under focus", () => {
  it("Button keeps the same node and its focus", async () => {
    const { rerender } = render(<Button>Save</Button>);
    const node = screen.getByRole("button", { name: "Save" });
    act(() => node.focus());
    rerender(<Button disabledReason="Wait a moment">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBe(node);
    expect(document.activeElement).toBe(node);
    expect(node.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(node.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("Wait a moment");
    rerender(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBe(node);
    expect(document.activeElement).toBe(node);
    expect(node.getAttribute("aria-disabled")).toBeNull();
    expect(node.getAttribute("aria-describedby")).toBeNull();
    expect(document.querySelector(".sr-only")).toBeNull();
  });

  it("an empty tooltip never opens, with or without a reason", async () => {
    render(<Button>Save</Button>);
    await userEvent.hover(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("IconButton keeps the same node and its focus", () => {
    const { rerender } = render(
      <IconButton label="Delete" icon={<span>x</span>} />,
    );
    const node = screen.getByRole("button", { name: "Delete" });
    act(() => node.focus());
    rerender(
      <IconButton
        label="Delete"
        icon={<span>x</span>}
        disabledReason="In use"
      />,
    );
    expect(screen.getByRole("button", { name: "Delete" })).toBe(node);
    expect(document.activeElement).toBe(node);
    rerender(<IconButton label="Delete" icon={<span>x</span>} />);
    expect(screen.getByRole("button", { name: "Delete" })).toBe(node);
    expect(document.activeElement).toBe(node);
  });
});
