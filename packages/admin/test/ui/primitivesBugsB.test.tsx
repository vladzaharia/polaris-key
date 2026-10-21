import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import * as React from "react";
import { BUTTON_VARIANTS } from "../../src/ui/classes.js";
import { Dialog, DialogBody } from "../../src/ui/Dialog.js";
import { OneTimeSecretPanel } from "../../src/ui/OneTimeSecretPanel.js";
import { PageHeader } from "../../src/ui/PageHeader.js";
import { Timestamp } from "../../src/ui/Timestamp.js";
import { DataTable } from "../../src/ui/data-table/DataTable.js";
import { EMPTY_TABLE_STATE } from "../../src/ui/data-table/types.js";
import { PageTabs } from "../../src/console/components/PageTabs.js";

afterEach(cleanup);

/** Stabilization package B: the shared console primitives (B-018 to B-027; B-017 is in buttonHoverContrast). */

describe("B-018 a dialog's own form fills the dialog's column", () => {
  it("styles a direct form child as the flex column the body scrolls in, but not a contents form", () => {
    render(
      <Dialog open onOpenChange={() => undefined} title="Issue">
        <form>
          <DialogBody>x</DialogBody>
        </form>
      </Dialog>,
    );
    const cls = screen.getByRole("dialog").className;
    for (const u of ["flex", "min-h-0", "flex-1", "flex-col"])
      expect(cls).toContain(`[&>form:not(.contents)]:${u}`);
  });
});

describe("B-019 the close button does not take a column from the description", () => {
  it("is absolute below sm and pads only the title line", () => {
    render(
      <Dialog
        open
        onOpenChange={() => undefined}
        title="Issue"
        description="A long description"
      >
        <DialogBody>x</DialogBody>
      </Dialog>,
    );
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.className).toContain("max-sm:absolute");
    expect(screen.getByRole("heading", { name: "Issue" }).className).toContain(
      "max-sm:pe-10",
    );
    expect(screen.getByText("A long description").className).not.toContain(
      "pr-",
    );
  });
});

describe("B-020 the link button reads as a link at rest", () => {
  it("is underlined without hover (the Locker rule keys on .underline)", () => {
    expect(BUTTON_VARIANTS.link.split(" ")).toContain("underline");
  });
});

describe("B-021 Timestamp says the instant once", () => {
  it("the table form's screen-reader text is the absolute time alone", () => {
    const at = Date.UTC(2026, 0, 3, 9, 0);
    const now = Date.UTC(2026, 9, 3, 9, 0); // months later: the shown text is a date
    const { container } = render(
      <Timestamp at={at} now={now} timeZone="UTC" locale="en-GB" />,
    );
    const time = container.querySelector("time")!;
    const sr = time.querySelector(".sr-only")!.textContent!;
    expect(sr).toBe("3 Jan 2026, 09:00 UTC");
    // aria-hidden shown text + the sr-only text: the date is in the accessible name once.
    expect(sr.match(/2026/g)).toHaveLength(1);
    expect(time.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("B-022 and B-023 the page header's freshness", () => {
  const freshness = {
    updatedAt: 1_790_000_000,
    now: 1_790_000_300,
    onRefresh: () => undefined,
  };
  it("shows Updated … on a phone too (not hidden below sm)", () => {
    render(<PageHeader title="Operations" freshness={freshness} />);
    const line = screen.getByText(/^Updated /);
    expect(line.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });
  it("takes its own row when the header is under 24 rem, so the title is not squeezed", () => {
    render(<PageHeader title="Operations" freshness={freshness} />);
    const cluster = screen
      .getByRole("button", { name: "Refresh" })
      .closest("div.justify-end")!;
    expect(cluster.className).toContain("max-sm:@max-sm:col-span-2");
  });
});

describe("B-024 and B-025 DataTable", () => {
  interface Row {
    id: string;
    name: string;
  }
  const data: Row[] = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
  ];
  function Table({
    state,
  }: {
    state: Partial<typeof EMPTY_TABLE_STATE>;
  }): React.ReactElement {
    return (
      <DataTable<Row>
        id="t"
        caption="Licenses"
        data={data}
        columns={[{ id: "name", header: "Holder", accessorKey: "name" }]}
        getRowId={(r) => r.id}
        rowLabel={(r) => r.name}
        search={{ placeholder: "Search", columns: ["name"] }}
        state={{ ...EMPTY_TABLE_STATE, ...state }}
        onStateChange={() => undefined}
        exportCsv={false}
        pagination={{
          mode: "cursor",
          local: true,
          hasMore: true,
          onLoadMore: vi.fn(),
          total: 90,
        }}
      />
    );
  }
  it("names the banner by its cause: Sorted, Searched or Filtered", () => {
    const { unmount } = render(
      <Table state={{ sort: [{ id: "name", desc: false }] }} />,
    );
    expect(screen.getByText(/^Sorted the 2 newest of 90/)).toBeTruthy();
    unmount();
    const s = render(<Table state={{ q: "Al" }} />);
    expect(screen.getByText(/^Searched the 2 newest of 90/)).toBeTruthy();
    s.unmount();
  });
  it("a sortable header button is at least 24 px tall", () => {
    render(<Table state={{}} />);
    const th = screen.getByRole("columnheader", { name: /Holder/ });
    expect(within(th).getByRole("button").className).toContain("min-h-6");
  });
});

describe("B-026 a scrolling tab strip gives up the indicator's view-transition name", () => {
  it("flags the strip while it overflows, and the stylesheet drops the name under the flag", () => {
    const sw = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockReturnValue(900);
    const cw = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(300);
    try {
      render(
        <PageTabs
          label="Sections"
          value="a"
          onChange={() => undefined}
          items={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
          ]}
        />,
      );
      expect(
        screen.getByRole("tablist").hasAttribute("data-strip-overflow"),
      ).toBe(true);
    } finally {
      sw.mockRestore();
      cw.mockRestore();
    }
    const css = readFileSync(
      join(__dirname, "..", "..", "src", "motion.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\[data-strip-overflow\] \.pk-vt-indicator\s*\{\s*view-transition-name:\s*none/,
    );
  });
  it("does not flag a strip that fits", () => {
    render(
      <PageTabs
        label="Sections"
        value="a"
        onChange={() => undefined}
        items={[{ value: "a", label: "Alpha" }]}
      />,
    );
    expect(
      screen.getByRole("tablist").hasAttribute("data-strip-overflow"),
    ).toBe(false);
  });
});

describe("B-027 the shown-once panel's buttons are 44 px on phones", () => {
  it("the download and close-guard buttons carry max-sm:min-h-11", () => {
    render(
      <Dialog open onOpenChange={() => undefined} title="Key">
        <OneTimeSecretPanel
          label="Key"
          value="PK-1"
          onDone={() => undefined}
          download={{ filename: "key.txt" }}
          closeRequested
        />
      </Dialog>,
    );
    for (const name of [
      /^Download key\.txt/,
      "Keep it open",
      "Close without copying",
    ])
      expect(screen.getByRole("button", { name }).className).toContain(
        "max-sm:min-h-11",
      );
  });
});
