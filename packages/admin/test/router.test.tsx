import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Link,
  blockNavigation,
  navigate,
  resetRouterForTests,
  useLocation,
} from "../src/console/router.js";

/** The hash router's blocker (ADMIN.md §2.6): the unsaved-changes guard builds on it. */

function Probe(): React.ReactElement {
  const { hash } = useLocation();
  return (
    <>
      <output aria-label="hash">{hash}</output>
      <Link to="#/products">Products</Link>
    </>
  );
}

beforeEach(() => {
  window.location.hash = "#/";
  resetRouterForTests();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the navigation blocker", () => {
  it("asks once for a link click it allows, and the page follows", async () => {
    const guard = vi.fn(() => true);
    render(<Probe />);
    const unblock = blockNavigation(guard);
    await userEvent.click(screen.getByRole("link", { name: "Products" }));
    await waitFor(() =>
      expect(screen.getByLabelText("hash").textContent).toBe("#/products"),
    );
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledWith("#/products");
    unblock();
  });

  it("keeps the page when a guard refuses a link", async () => {
    render(<Probe />);
    const unblock = blockNavigation(() => false);
    await userEvent.click(screen.getByRole("link", { name: "Products" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(window.location.hash).toBe("#/");
    unblock();
  });

  it("refuses navigate() and rolls back a hashchange it could not prevent", async () => {
    render(<Probe />);
    const unblock = blockNavigation((next) => next !== "#/platform-x");
    expect(navigate("#/platform-x")).toBe(false);
    window.location.hash = "#/platform-x";
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    unblock();
  });

  it("asks once for navigate()", async () => {
    const guard = vi.fn(() => true);
    render(<Probe />);
    const unblock = blockNavigation(guard);
    navigate("#/products");
    await waitFor(() =>
      expect(screen.getByLabelText("hash").textContent).toBe("#/products"),
    );
    expect(guard).toHaveBeenCalledTimes(1);
    unblock();
  });
});
