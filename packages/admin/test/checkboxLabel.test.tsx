import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Checkbox } from "../src/ui/Checkbox.js";

describe("the Checkbox label", () => {
  it("keeps the space before a link in its text", () => {
    render(
      <Checkbox
        label={
          <>
            I agree to <a href="/terms">the terms</a>
          </>
        }
      />,
    );
    const label = screen.getByText(/I agree to/).closest("label")!;
    // The text reads as one run: "I agree to the terms", with the space intact.
    expect(label.textContent).toBe("I agree to the terms");
    // A flex label drops the whitespace before an inline child and splits the sentence into
    // columns; the label is an inline run (LF4, the L1 regression).
    expect(label.className).not.toMatch(/\b(inline-)?flex\b/);
    expect(label.className).toMatch(/inline-block/);
  });
});
