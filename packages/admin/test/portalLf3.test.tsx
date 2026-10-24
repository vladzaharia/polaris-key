import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Keep } from "../src/portal/components/Keep.js";
import { LibraryToolbar } from "../src/portal/components/LibraryToolbar.js";
import { portalErrorCopy } from "../src/portal/errors.js";
import { HttpError } from "../src/portal/api.js";

afterEach(cleanup);

describe("Keep: phrases that must not break across lines (LF3, minor 6)", () => {
  const nowrap = (root: HTMLElement): string[] =>
    [...root.querySelectorAll("span.whitespace-nowrap")].map(
      (e) => e.textContent ?? "",
    );

  it("holds a seat position and the idle-devices note together, text unchanged", () => {
    const { container } = render(
      <p>
        <Keep>{"Mara's Pixel 8 becomes device 2 of 3"}</Keep>
        <Keep>1 more device signed in, not using a seat</Keep>
        <Keep>2 more devices signed in, not using a seat</Keep>
      </p>,
    );
    expect(nowrap(container)).toEqual([
      "device 2 of 3",
      "1 more device",
      "signed in,",
      "not using a seat",
      "2 more devices",
      "signed in,",
      "not using a seat",
    ]);
    expect(container.textContent).toBe(
      "Mara's Pixel 8 becomes device 2 of 31 more device signed in, not using a seat2 more devices signed in, not using a seat",
    );
  });

  it("leaves other text alone", () => {
    const { container } = render(
      <p>
        <Keep>2 of 3 devices in use</Keep>
      </p>,
    );
    expect(nowrap(container)).toEqual([]);
  });
});

describe("Library toolbar: sort and the view toggle share a row (LF3, minor 8)", () => {
  it("keeps the reading order and puts sort and the toggle in one row, apart from the chips", () => {
    const { container } = render(
      <LibraryToolbar
        total={9}
        q=""
        filter="all"
        sort="recent"
        mode="grid"
        attentionCount={1}
        onChange={() => undefined}
        onMode={() => undefined}
      />,
    );
    const row = container.querySelector("[data-library-view-row]")!;
    const chips = screen.getByRole("group", { name: "Filter" });
    const sort = screen.getByRole("combobox");
    const toggle = screen.getByRole("radiogroup", { name: "View" });
    expect(row.contains(sort)).toBe(true);
    expect(row.contains(toggle)).toBe(true);
    expect(row.contains(chips)).toBe(false);
    // Tab order is DOM order: search, chips, sort, toggle (WCAG 2.4.3).
    const order = [screen.getByRole("searchbox"), chips, sort, toggle].map(
      (e) => e,
    );
    for (let i = 1; i < order.length; i += 1)
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    // Phones: the row takes the full width under the chips.
    expect(row.className).toContain("max-sm:basis-full");
  });
});

describe("load errors say what happened (LF3, minor 3)", () => {
  it("a server error is the catch-all, not a connection problem; a dropped connection is", () => {
    const server = portalErrorCopy(new HttpError(500, { code: "internal" }));
    expect(server.generic).toBe(true);
    expect(server.line).not.toMatch(/connection/i);
    const offline = portalErrorCopy(new HttpError(0, { code: "network" }));
    expect(offline.generic).toBeUndefined();
    expect(offline.line).toMatch(/Check your connection/);
  });
});
