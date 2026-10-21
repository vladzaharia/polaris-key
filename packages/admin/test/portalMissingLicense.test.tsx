import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MissingLicense } from "../src/portal/components/MissingLicense.js";

/** PX-35: the Library's sticky "Missing a license?" strip. */
describe("MissingLicense", () => {
  it("is a labelled region, sticky to the bottom, with the three ways", () => {
    render(<MissingLicense />);
    const strip = screen.getByRole("region", { name: "Missing a license?" });
    expect(strip.className).toContain("sticky");
    expect(strip.className).toContain("desk:bottom-0");
    expect(strip.hasAttribute("data-missing-strip")).toBe(true);
    // Above the phone bar on phones.
    expect(strip.className).toContain("env(safe-area-inset-bottom)");
    expect(
      within(strip)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Add it in Sign-in methods", "Connect Steam"]);
    // Its first item is Activate a license.
    expect(within(strip).getAllByRole("button")[1]!.textContent).toBe(
      "Activate a license",
    );
    for (const a of within(strip).getAllByRole("link")) {
      expect(a.className).toContain("min-h-11");
      expect(a.className).toContain("underline");
    }
  });

  it("collapses to a disclosure on phones that opens the ways", async () => {
    render(<MissingLicense />);
    const toggle = screen.getByRole("button", { name: "Missing a license?" });
    // The button comes first in the DOM; the panel opens above it (flex-col-reverse).
    expect(toggle.nextElementSibling?.id).toBe("missing-ways");
    const list = document.getElementById("missing-ways")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(list.className).toContain("hidden");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(list.className).not.toMatch(/(^| )hidden( |$)/);
  });
});
