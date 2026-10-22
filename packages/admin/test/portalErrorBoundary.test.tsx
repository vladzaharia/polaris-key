import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { PortalErrorBoundary } from "../src/portal/components/PortalErrorBoundary.js";

let broken = true;
function Page(): React.ReactElement {
  if (broken) throw new TypeError("x.filter is not a function");
  return <p>the page</p>;
}

describe("PortalErrorBoundary", () => {
  it("says something didn't load, retries, and links back to the Library", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    broken = true;
    render(
      <PortalErrorBoundary resetKey="a">
        <Page />
      </PortalErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Something didn't load",
    );
    expect(
      screen.getByRole("link", { name: /Back to your library/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy details/ })).toBeTruthy();
    broken = false;
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(screen.getByText("the page")).toBeTruthy();
    spy.mockRestore();
  });

  it("clears when the route changes", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    broken = true;
    const { rerender } = render(
      <PortalErrorBoundary resetKey="a">
        <Page />
      </PortalErrorBoundary>,
    );
    broken = false;
    rerender(
      <PortalErrorBoundary resetKey="b">
        <Page />
      </PortalErrorBoundary>,
    );
    expect(screen.getByText("the page")).toBeTruthy();
    spy.mockRestore();
  });
});
