// PX-33: the product passport. Tailwind's `passport:` variant is a media query jsdom does not
// evaluate, so the layout switch itself is checked in the browser (e2e/portalPassport.e2e.test.ts);
// here: the structure that makes the switch possible, the art that is loaded only in landscape,
// and what must never get a pane (portal-direct sign-in).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { configureAxe } from "vitest-axe";
import { AuthCard, CardHeader } from "../src/ui/auth/index.js";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

function landscape(on: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query.includes("min-aspect-ratio: 6/5"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function card(
  header: boolean,
  art: string | null = "/media/diceroll/header?v=ab",
) {
  return render(
    <AuthCard
      brand={<span>Polaris Locker</span>}
      stepKey="methods"
      header={
        header ? (
          <CardHeader
            variant="app"
            icon={<span aria-hidden>D</span>}
            name="Diceroll"
            developer="Example Games"
            where={{ glyph: "globe", text: "diceroll.example" }}
            art={art}
          />
        ) : undefined
      }
      footer={<p>Polaris Locker signs you in for Diceroll.</p>}
    >
      <h1>Sign in</h1>
    </AuthCard>,
  );
}

describe("the passport structure", () => {
  it("puts the app request header in a pane that the landscape query turns into a start pane", () => {
    landscape(false);
    const { container } = card(true);
    const pane = container.querySelector("[data-pane='passport']")!;
    expect(pane).not.toBeNull();
    expect(pane.className).toContain("passport:bg-surface-sunken");
    expect(pane.className).toContain("passport:border-r");
    expect(container.querySelector("[data-passport]")!.className).toContain(
      "passport:max-w-[46rem]",
    );
    expect(pane.className).not.toMatch(/bg-surface-(page|raised)/);
    // One header in the DOM, in both layouts: the text is not duplicated for the pane.
    expect(
      screen.getAllByText("wants you to sign in", { exact: false }),
    ).toHaveLength(1);
  });

  it("has no pane on a portal-direct sign-in (no header)", () => {
    landscape(true);
    const { container } = card(false);
    expect(container.querySelector("[data-pane]")).toBeNull();
    expect(container.querySelector("[data-passport]")).toBeNull();
    expect(container.querySelector("[data-pane-art]")).toBeNull();
  });
});

describe("the pane's art", () => {
  it("is not loaded in the stacked layout", () => {
    landscape(false);
    const { container } = card(true);
    expect(container.querySelector("[data-pane-art]")).toBeNull();
  });

  it("is a decorative 16:10 cover image in landscape", () => {
    landscape(true);
    const { container } = card(true);
    const img = container.querySelector<HTMLImageElement>("[data-pane-art]")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("src")).toBe("/media/diceroll/header?v=ab");
    expect(img.className).toContain("aspect-[16/10]");
    expect(img.className).toContain("max-h-[40%]");
    expect(img.className).toContain("object-cover");
  });

  it("draws nothing, and no generated fill, when the product has no art", () => {
    landscape(true);
    const { container } = card(true, null);
    expect(container.querySelector("[data-pane-art]")).toBeNull();
    expect(container.innerHTML).not.toMatch(/gradient/);
  });

  it("passes axe in both layouts", async () => {
    for (const on of [true, false]) {
      landscape(on);
      const { container, unmount } = card(true);
      expect((await axe(container)).violations).toEqual([]);
      unmount();
    }
  });
});
