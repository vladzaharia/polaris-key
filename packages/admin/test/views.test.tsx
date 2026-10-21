import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { ConsoleQueryProvider } from "../src/console/data/queryClient.js";
import type { Me } from "../src/api.js";
import { Button } from "../src/ui/Button.js";
import { ConfirmDialog } from "../src/ui/ConfirmDialog.js";
import { ThemeProvider, useTheme } from "../src/components/theme.js";
import { Logo } from "../src/components/brand/Logo.js";
import { Home } from "../src/console/sections/global/pages/Home.js";
import { resetConsole, mockFetch, productRow } from "./consoleHarness.js";

// Foundation-level smoke tests: the primitive layer and brand compile, render, and behave.
// View-specific behavior lives with each view test suite; each `ui/` primitive has its own suite
// under test/ui (the legacy components/ui kit and its tests went with UX-10).

const ME: Me = {
  sub: "u1",
  name: "Ada Lovelace",
  email: "ada@x.io",
  csrf: "csrf",
  platformAdmin: true,
  products: [{ slug: "djdl", name: "DJDL", schemaVersion: 2 }],
};

function withConsole(node: ReactElement) {
  return render(<ConsoleQueryProvider>{node}</ConsoleQueryProvider>);
}

beforeEach(() => {
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
});
afterEach(cleanup);

describe("Button primitive", () => {
  it("renders, fires onClick, and disables while loading", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} loading>
        Save
      </Button>,
    );
    const busy = screen.getByRole("button", { name: /Save/ });
    expect((busy as HTMLButtonElement).disabled).toBe(false);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-busy")).toBe("true");
  });

  it("keeps focus and ignores clicks while loading, and a caller cannot re-enable it", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    button.focus();
    rerender(
      <Button onClick={onClick} loading disabled={false}>
        Save
      </Button>,
    );
    expect(document.activeElement).toBe(button);
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    rerender(<Button onClick={onClick}>Save</Button>);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
  });

  it("a loading primary keeps its variant fill and shows the spinner", () => {
    const { container } = render(<Button loading>Save</Button>);
    const busy = screen.getByRole("button", { name: /Save/ });
    expect(busy.className).toContain("bg-accent");
    expect(busy.className).not.toMatch(
      /(^|\s)aria-disabled:bg-action-disabled/,
    );
    expect(busy.className).toContain(
      "aria-disabled:not-aria-busy:bg-action-disabled",
    );
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector("button .animate-pk-spin")).not.toBeNull();
  });

  it("gives an aria-disabled (locked) filled button the disabled look and keeps it focusable", () => {
    render(<Button disabledReason="View only">Prepare</Button>);
    const locked = screen.getByRole("button", { name: "Prepare" });
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect((locked as HTMLButtonElement).disabled).toBe(false);
    expect(locked.className).toContain(
      "aria-disabled:not-aria-busy:bg-action-disabled",
    );
    expect(locked.className).toContain(
      "aria-disabled:not-aria-busy:text-action-disabled-on",
    );
    locked.focus();
    expect(document.activeElement).toBe(locked);
  });
});

describe("ConfirmDialog primitive", () => {
  it("invokes onConfirm when confirmed", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Delete it?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete" }),
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("theme toggle", () => {
  it("flips the document class between dark and light", async () => {
    function Toggle(): ReactElement {
      const { theme, toggle } = useTheme();
      return <button onClick={toggle}>theme:{theme}</button>;
    }
    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await userEvent.click(screen.getByText(/theme:/));
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });
});

describe("brand + dashboard views", () => {
  it("renders the Polaris Key logo lockup", () => {
    render(<Logo subtitle="admin" />);
    expect(screen.getByLabelText("Polaris Key")).toBeTruthy();
    expect(screen.getByText("admin")).toBeTruthy();
  });

  it("Home lists the operator's products under its page heading", async () => {
    resetConsole();
    mockFetch({
      "/manage/api/me": ME,
      "/manage/api/products": { products: [productRow("djdl", "DJDL", {})] },
    });
    withConsole(<Home />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeTruthy();
    expect(await screen.findByRole("link", { name: "DJDL" })).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
