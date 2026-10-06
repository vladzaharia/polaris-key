import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PageHeader } from "../../src/ui/PageHeader.js";
import { Button } from "../../src/ui/Button.js";

afterEach(cleanup);

/**
 * A ghost Refresh that ends the header row has no frame, so its padding is cancelled by a
 * negative margin and its visible ink meets the content edge (the layout lint measures ink).
 */
describe("PageHeader freshness", () => {
  const freshness = { updatedAt: 1_790_000_000, onRefresh: () => undefined };
  const refresh = () => screen.getByRole("button", { name: "Refresh" });

  it("pulls a trailing ghost Refresh onto the edge at every width", () => {
    render(<PageHeader title="Operations" freshness={freshness} />);
    expect(refresh().hasAttribute("data-trailing-ghost")).toBe(true);
    expect(refresh().className).toContain("-mr-3");
    expect(refresh().className).toContain("sm:-mr-3");
  });

  it("leaves it alone when a primary action ends the row on wide screens", () => {
    render(
      <PageHeader
        title="Operations"
        freshness={freshness}
        primaryAction={<Button>Run now</Button>}
      />,
    );
    // Below 640 px the primary action takes its own row, so Refresh still trails there.
    expect(refresh().className).toMatch(/(^|\s)-mr-3/);
    expect(refresh().className).toContain("sm:mr-0");
    expect(refresh().className).not.toContain("sm:-mr-3");
  });

  it("leaves it alone beside an auto-refresh switch", () => {
    render(
      <PageHeader
        title="Operations"
        freshness={{
          ...freshness,
          auto: {
            checked: false,
            onCheckedChange: () => undefined,
            label: "Auto",
          },
        }}
      />,
    );
    expect(refresh().hasAttribute("data-trailing-ghost")).toBe(false);
  });
});
