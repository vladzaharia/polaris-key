import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import {
  DataTable,
  EMPTY_TABLE_STATE,
  SEARCH_DEBOUNCE_MS,
  filterRows,
  tableCsv,
  toCsv,
  type DataColumn,
  type DataTableProps,
  type Facet,
  type TableState,
} from "../../src/ui/data-table/index.js";

interface Row {
  id: string;
  name: string;
  status: string;
  seats: number;
}

const ROWS: Row[] = [
  { id: "a", name: "Studio Pro", status: "active", seats: 3 },
  { id: "b", name: "Lab 3", status: "expired", seats: 1 },
  { id: "c", name: "Old seat", status: "disabled", seats: 0 },
  { id: "d", name: "Archive", status: "active", seats: 5 },
];

const COLUMNS: DataColumn<Row>[] = [
  { id: "name", header: "Holder", accessorKey: "name", meta: { priority: 1 } },
  { id: "status", header: "Status", accessorKey: "status" },
  {
    id: "seats",
    header: "Seats",
    accessorKey: "seats",
    meta: { numeric: true },
  },
];

const FACETS: Facet<Row>[] = [
  {
    id: "status",
    label: "Status",
    options: [
      { value: "active", label: "Active" },
      { value: "expired", label: "Expired" },
      { value: "disabled", label: "Disabled" },
    ],
  },
];

function Harness(
  props: Partial<DataTableProps<Row>> & {
    initial?: Partial<TableState>;
    onState?: (s: TableState) => void;
  },
): React.ReactElement {
  const { initial, onState, ...rest } = props;
  const [state, setState] = React.useState<TableState>({
    ...EMPTY_TABLE_STATE,
    ...initial,
  });
  return (
    <DataTable<Row>
      id="t"
      caption="Licenses"
      data={ROWS}
      columns={COLUMNS}
      getRowId={(r) => r.id}
      rowLabel={(r) => r.name}
      facets={FACETS}
      search={{ placeholder: "Search", columns: ["name"] }}
      state={state}
      onStateChange={(s) => {
        setState(s);
        onState?.(s);
      }}
      exportCsv={false}
      {...rest}
    />
  );
}

const bodyRows = (): HTMLElement[] =>
  within(screen.getByRole("table")).getAllByRole("row").slice(1);

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DataTable", () => {
  it("renders a native table with a caption and no role=button rows", () => {
    render(<Harness rowHref={(r) => `#/licenses/${r.id}`} />);
    const table = screen.getByRole("table", { name: "Licenses" });
    expect(table.querySelector("caption")?.textContent).toBe("Licenses");
    expect(table.querySelectorAll("[role=button]")).toHaveLength(0);
    const link = screen.getByRole("link", { name: "Studio Pro" });
    expect(link.getAttribute("href")).toBe("#/licenses/a");
    expect(
      within(table).getAllByRole("columnheader")[0]!.getAttribute("scope"),
    ).toBe("col");
  });

  it("follows the row link when the row (not a control) is clicked", () => {
    const clicked = vi.fn();
    render(<Harness rowHref={(r) => `#/licenses/${r.id}`} />);
    const link = screen.getByRole("link", { name: "Lab 3" });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      clicked();
    });
    const row = link.closest("tr")!;
    fireEvent.click(row.querySelectorAll("td")[2]!);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("sorts from the header with aria-sort, and Shift adds a second key", async () => {
    const user = userEvent.setup();
    const onState = vi.fn();
    render(<Harness onState={onState} />);
    const seats = screen.getByRole("button", { name: "Seats" });
    await user.click(seats);
    expect(seats.closest("th")!.getAttribute("aria-sort")).toBe("ascending");
    expect(bodyRows().map((r) => r.textContent)).toEqual([
      "Old seatdisabled0",
      "Lab 3expired1",
      "Studio Proactive3",
      "Archiveactive5",
    ]);
    await user.click(seats);
    expect(seats.closest("th")!.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(screen.getByRole("button", { name: "Status" }), {
      shiftKey: true,
    });
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sort: [
          { id: "seats", desc: true },
          { id: "status", desc: false },
        ],
      }),
    );
  });

  it("filters by facet, shows a removable chip and counts, and clears", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    const active = await screen.findByRole("checkbox", { name: /Active/ });
    expect(active.closest("label")!.textContent).toContain("2");
    await user.click(active);
    await user.keyboard("{Escape}");
    expect(bodyRows()).toHaveLength(2);
    const chip = screen.getByRole("button", {
      name: "Remove filter Status: Active",
    });
    await user.click(chip);
    expect(bodyRows()).toHaveLength(4);
  });

  it("debounces search into the state and shows no-results with Clear filters", async () => {
    vi.useFakeTimers();
    const onState = vi.fn();
    render(<Harness onState={onState} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), {
      target: { value: "zzz" },
    });
    expect(onState).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "zzz", offset: 0, cursor: null }),
    );
    expect(screen.getByText(/No licenses match/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "", filters: {} }),
    );
  });

  it("selects with a tri-state header and hands the rows to a bulk action", async () => {
    const user = userEvent.setup();
    const bulk = vi.fn();
    render(
      <Harness
        selection={{
          mode: "multi",
          bulkActions: [{ label: "Disable…", tone: "danger", onSelect: bulk }],
        }}
      />,
    );
    const all = screen.getByRole("checkbox", {
      name: "Select all licenses",
    }) as HTMLInputElement;
    await user.click(screen.getByRole("checkbox", { name: "Select Lab 3" }));
    expect(all.indeterminate).toBe(true);
    expect(all.getAttribute("aria-checked")).toBe("mixed");
    expect(screen.getByText("1 selected")).toBeTruthy();
    // The bulk bar replaces the filter bar.
    expect(screen.queryByRole("searchbox")).toBeNull();
    await user.click(all);
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
    await user.click(screen.getByRole("button", { name: "Disable…" }));
    expect(bulk).toHaveBeenCalledWith(ROWS, { allMatching: false });
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });

  it("toggles selection with x and moves rows with j/k", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        selection={{ mode: "multi", bulkActions: [] }}
        rowHref={(r) => `#/l/${r.id}`}
      />,
    );
    const firstLink = screen.getByRole("link", { name: "Studio Pro" });
    firstLink.focus();
    await user.keyboard("j");
    const second = bodyRows()[1]!;
    expect(document.activeElement).toBe(second);
    await user.keyboard("x");
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Select Lab 3",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    await user.keyboard("k");
    expect(document.activeElement).toBe(bodyRows()[0]);
  });

  it("cursor mode: Load more and 'Showing n of total'", async () => {
    const user = userEvent.setup();
    const more = vi.fn();
    render(
      <Harness
        pagination={{
          mode: "cursor",
          hasMore: true,
          onLoadMore: more,
          total: 9,
        }}
      />,
    );
    expect(screen.getByText("Showing 4 of 9")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(more).toHaveBeenCalled();
  });

  it("offset mode pages client data with Previous and Next", async () => {
    const user = userEvent.setup();
    render(<Harness pagination={{ mode: "offset", pageSize: 3 }} />);
    expect(bodyRows()).toHaveLength(3);
    expect(screen.getByText("Showing 1–3 of 4")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText("Showing 4–4 of 4")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("virtualizes above 200 rows: a window, not all 1000", () => {
    const many: Row[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `r${i}`,
      name: `Row ${i}`,
      status: "active",
      seats: i,
    }));
    render(<Harness data={many} />);
    const rendered = document.querySelectorAll("tbody tr[data-row-id]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(100);
    expect(screen.getByText("Showing 1,000")).toBeTruthy();
  });

  it("renders the error inline with Retry, and the first-run slot when empty", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { unmount } = render(
      <Harness error={new TypeError("Failed to fetch")} onRetry={retry} />,
    );
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(retry).toHaveBeenCalled();
    unmount();
    render(<Harness data={[]} empty={<p>Create your first license</p>} />);
    expect(screen.getByText("Create your first license")).toBeTruthy();
  });

  it("shows skeleton rows while loading and announces it", () => {
    render(<Harness data={[]} loading />);
    expect(document.querySelectorAll("tbody tr[aria-hidden]")).toHaveLength(5);
    expect(screen.getByText("Loading licenses…")).toBeTruthy();
  });

  it("hides a column from the Columns menu and remembers it", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(await screen.findByRole("checkbox", { name: "Seats" }));
    expect(screen.queryByRole("columnheader", { name: /Seats/ })).toBeNull();
    unmount();
    render(<Harness />);
    expect(screen.queryByRole("columnheader", { name: /Seats/ })).toBeNull();
  });
});

describe("CSV", () => {
  it("quotes fields and exports the filtered rows over the given columns", () => {
    expect(toCsv(["a", "b"], [["x,y", 'say "hi"']])).toBe(
      'a,b\r\n"x,y","say ""hi"""',
    );
    const rows = filterRows(
      ROWS,
      COLUMNS,
      { ...EMPTY_TABLE_STATE, filters: { status: ["active"] } },
      FACETS,
    );
    expect(tableCsv(rows, COLUMNS)).toBe(
      "Holder,Status,Seats\r\nStudio Pro,active,3\r\nArchive,active,5",
    );
  });
});
