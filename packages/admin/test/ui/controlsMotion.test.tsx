import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, buttonVariants } from "../../src/ui/Button.js";
import { IconButton } from "../../src/ui/IconButton.js";
import { Drawer } from "../../src/ui/Drawer.js";
import { Popover } from "../../src/ui/Popover.js";
import {
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from "../../src/ui/Tooltip.js";
import { Switch } from "../../src/ui/Switch.js";
import { RadioCards } from "../../src/ui/RadioCards.js";
import { CopyButton } from "../../src/ui/CopyButton.js";

/**
 * MO-08 (notes/S-23 §6.1 enter, exit, press; §4.2): the console's overlays and controls carry the
 * motion layer's patterns. jsdom computes no animations, so these pin the classes and attributes
 * src/motion.css keys on; e2e/kit.e2e.test.ts checks the real animations, the press scale and the
 * reduced-motion swap in Chromium under the Worker's CSP.
 */

afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string =>
  readFileSync(join(here, "..", "..", "src", p), "utf8");

const VARIANTS = [
  "primary",
  "secondary",
  "outline",
  "ghost",
  "danger",
  "destructive",
  "link",
  "quiet",
  "action",
] as const;

describe("Button: press, and a hover that never snaps", () => {
  for (const variant of VARIANTS)
    it(`${variant} presses and hovers on transitioned properties only`, () => {
      const cls = buttonVariants({ variant }).split(/\s+/);
      expect(cls).toContain("pk-pressable");
      // A filter is not in pk-pressable's transition (and never animates, S-23 §6.2): a hover
      // that changes one would snap.
      expect(
        cls.filter((c) =>
          /(^|:)(brightness|contrast|saturate|hue-rotate|grayscale|invert|sepia|blur|drop-shadow|filter)\b/.test(
            c,
          ),
        ),
      ).toEqual([]);
      // A transition utility would override pk-pressable's (utilities beat components) and drop
      // the transform, so the press would snap.
      expect(cls.filter((c) => /^transition(-|$)/.test(c))).toEqual([]);
      // Hover changes only colours, which pk-pressable transitions at `micro`.
      for (const c of cls.filter((x) => x.startsWith("hover:"))) {
        const util = c.split(":").pop()!;
        expect(util, c).toMatch(/^(bg-|text-|border-|underline$)/);
      }
    });

  it("the filled variants lighten their token colour instead of using a filter", () => {
    expect(buttonVariants({ variant: "primary" })).toContain(
      "var(--pk-accent),white_10%",
    );
    expect(buttonVariants({ variant: "danger" })).toContain(
      "var(--pk-danger),white_10%",
    );
  });

  it("disabled and busy buttons opt out of the press through :disabled or aria-disabled", () => {
    render(
      <>
        <Button>Go</Button>
        <Button disabled>Off</Button>
        <Button loading>Saving</Button>
        <Button disabledReason="Not now">Retire</Button>
        <Button asChild loading>
          <a href="#/x">Link</a>
        </Button>
      </>,
    );
    const go = screen.getByRole("button", { name: "Go" });
    expect(go.className).toContain("pk-pressable");
    const disabled = (name: string | RegExp): boolean =>
      (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
    expect(disabled("Go")).toBe(false);
    expect(disabled("Off")).toBe(true);
    expect(disabled(/Saving/)).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Retire" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByRole("link", { name: "Link" }).getAttribute("aria-disabled"),
    ).toBe("true");
    // The opt-out itself lives in the stylesheet.
    expect(read("motion.css")).toContain(
      '.pk-pressable:active:not(:disabled, [aria-disabled="true"])',
    );
  });

  it("IconButton inherits the press", () => {
    render(<IconButton label="Refresh" icon={<svg />} />);
    expect(screen.getByRole("button", { name: "Refresh" }).className).toContain(
      "pk-pressable",
    );
  });
});

describe("Drawer slides from its edge", () => {
  for (const side of ["end", "start"] as const)
    it(`a ${side}-side drawer carries pk-drawer and its side`, () => {
      render(
        <Drawer open onOpenChange={() => {}} title="Device" side={side}>
          body
        </Drawer>,
      );
      const panel = screen.getByRole("dialog");
      expect(panel.className).toContain("pk-drawer");
      // Not the dialog rise: animate-pk-in would compete with the slide.
      expect(panel.className).not.toContain("animate-pk-in");
      expect(panel.getAttribute("data-drawer-side")).toBe(side);
      cleanup();
    });

  it("the stylesheet slides end drawers from +100% and start drawers from -100%", () => {
    const css = read("motion.css");
    expect(css).toContain("translateX(var(--pk-drawer-from, 100%))");
    expect(css).toMatch(
      /\.pk-drawer\[data-drawer-side="start"\]\s*\{\s*--pk-drawer-from:\s*-100%;/,
    );
  });
});

describe("popper content enters from its side", () => {
  it("a popover carries animate-pk-in and Radix's data-side", () => {
    render(
      <Popover open trigger={<button type="button">Why</button>} side="top">
        Because
      </Popover>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("animate-pk-in");
    expect(panel.getAttribute("data-side")).toBe("top");
  });

  it("a tooltip carries animate-pk-in and Radix's data-side", () => {
    render(
      <TooltipProvider>
        <TooltipRoot open>
          <TooltipTrigger asChild>
            <button type="button">Hi</button>
          </TooltipTrigger>
          <TooltipContent side="right">Label</TooltipContent>
        </TooltipRoot>
      </TooltipProvider>,
    );
    const tip = document.querySelector("[data-side]")!;
    expect(tip.className).toContain("animate-pk-in");
    expect(tip.getAttribute("data-side")).toBe("right");
  });

  it("ActionMenu, Select and Combobox keep the popper path (Combobox through PopoverContent)", () => {
    expect(read("ui/ActionMenu.tsx")).toMatch(/\banimate-pk-in\b/);
    const select = read("ui/Select.tsx");
    expect(select).toMatch(/\banimate-pk-in\b/);
    expect(select).toContain('position = "popper"');
    expect(read("ui/Combobox.tsx")).toContain("<PopoverContent");
  });
});

describe("Switch, RadioCards and CopyButton", () => {
  it("the switch presses and its thumb moves on the spring", () => {
    render(<Switch aria-label="Enabled" checked={false} />);
    const sw = screen.getByRole("switch", { name: "Enabled" });
    expect(sw.className).toContain("pk-pressable");
    expect(sw.className).not.toMatch(/\btransition-colors\b/);
    const thumb = sw.querySelector("span")!;
    expect(thumb.className).toContain(
      "translate_var(--pk-duration-slow)_var(--pk-ease-spring)",
    );
  });

  it("a radio card presses; its border and check ease at micro", () => {
    render(
      <RadioCards
        aria-label="Plan"
        value="a"
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
      />,
    );
    const card = screen.getByRole("radio", { name: "A" });
    expect(card.className).toContain("pk-pressable");
    expect(card.className).not.toMatch(/\btransition-colors\b/);
    const dot = card.querySelector("span > span")!;
    expect(dot.className).toContain("duration-(--pk-duration-micro)");
    expect(dot.className).toContain("group-data-[state=checked]:scale-100");
  });

  it("the Copied swap pops, in both forms", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    const user = userEvent.setup();
    render(
      <>
        <CopyButton value="k" label="Copy key" />
        <CopyButton value="k" label="Copy id" showLabel />
      </>,
    );
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Copy key" }));
      await user.click(screen.getByRole("button", { name: "Copy id" }));
    });
    const icon = screen.getByRole("button", { name: "Copy key: copied" });
    expect(icon.querySelector("svg")!.getAttribute("class")).toContain(
      "pk-pop-in",
    );
    const word = screen.getByText("Copied");
    expect(word.className).toContain("pk-pop-in");
  });
});

describe("CommandPalette", () => {
  const src = read("console/shell/CommandPalette.tsx");

  it("enters and exits through the overlay classes", () => {
    expect(src).toMatch(/\banimate-pk-in\b/);
    expect(src).toMatch(/\banimate-pk-overlay-in\b/);
  });

  it("the result list never animates while typing", () => {
    expect(src).not.toMatch(/pk-stagger|viewTransition|pk-transient|pk-pop-in/);
  });

  it("the selection highlight eases between rows at micro", () => {
    expect(src).toContain(
      "transition-colors duration-(--pk-duration-micro) ease-standard data-[selected=true]:bg-accent-subtle",
    );
  });
});
