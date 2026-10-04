import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import * as React from "react";
import { configureAxe } from "vitest-axe";
import { KitProviders } from "../src/kit/KitProviders.js";
import { STORIES } from "../src/kit/stories/index.js";

/**
 * The gallery is chunk 3's acceptance surface (ADMIN.md §7.2): every story renders, has a unique
 * id, and passes axe in jsdom in both themes. jsdom computes no layout or colour, so
 * `color-contrast` is left to the brand package's contrast suite (BRAND.md §9) and the browser.
 * `region` is off because a story is a fragment, not a page.
 */
const axe = configureAxe({
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  },
});

// jsdom has no ResizeObserver; Radix's size hook (Switch, Checkbox, RadioCards) needs one.
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??=
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

describe("kit gallery", () => {
  it("has stories with unique ids", () => {
    expect(STORIES.length).toBeGreaterThan(0);
    const ids = STORIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const theme of ["dark", "light"] as const) {
    describe(`${theme} theme`, () => {
      for (const story of STORIES) {
        it(`${story.id} passes axe`, async () => {
          document.documentElement.setAttribute("data-theme", theme);
          const { container } = render(
            <KitProviders>
              <div data-service="core">{story.render()}</div>
            </KitProviders>,
          );
          const rules = Object.fromEntries(
            (story.axeDisable ?? []).map((id) => [id, { enabled: false }]),
          );
          const results = await axe(container, { rules });
          expect(
            results.violations.map(
              (v) =>
                `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
            ),
          ).toEqual([]);
        });
      }
    });
  }
});
