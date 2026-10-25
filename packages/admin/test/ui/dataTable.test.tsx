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

  it("reports intent on the primary link's pointerenter and focus, not on the rest of the row", () => {
    const intent = vi.fn();
    render(
      <Harness
        rowHref={(r) => `#/licenses/${r.id}`}
        onRowIntent={(r) => intent(r.id)}
      />,
    );
    const link = screen.getByRole("link", { name: "Lab 3" });
    fireEvent.pointerEnter(link);
    expect(intent).toHaveBeenLastCalledWith("b");
    act(() => link.focus());
    expect(intent).toHaveBeenCalledTimes(2);
    fireEvent.pointerEnter(screen.getByText("expired"));
    expect(intent).toHaveBeenCalledTimes(2);
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
    await user.click(screen.getByRole("button", { name: /Try again/ }));
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

  it("offers Columns and density only where they earn their row", () => {
    // A small table with nothing hidden: no Columns, no density (and no count footer).
    const { unmount } = render(<Harness />);
    expect(screen.queryByRole("button", { name: "Columns" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Row density" })).toBeNull();
    expect(screen.queryByText(/^Showing/)).toBeNull();
    unmount();
    render(<Harness chrome="full" />);
    expect(screen.getByRole("button", { name: "Columns" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Row density" })).toBeTruthy();
  });

  it("shows only the first-run state when nothing exists and nothing is filtered", () => {
    render(<Harness data={[]} empty={<p>Create your first license</p>} />);
    expect(screen.getByText("Create your first license")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("hides a column from the Columns menu and remembers it", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness chrome="full" />);
    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(await screen.findByRole("checkbox", { name: "Seats" }));
    expect(screen.queryByRole("columnheader", { name: /Seats/ })).toBeNull();
    unmount();
    render(<Harness chrome="full" />);
    expect(screen.queryByRole("columnheader", { name: /Seats/ })).toBeNull();
  });

  it("starts a defaultHidden column hidden at every width, and Columns shows it", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        columns={[
          ...COLUMNS.slice(0, 2),
          { ...COLUMNS[2]!, meta: { numeric: true, defaultHidden: true } },
        ]}
      />,
    );
    expect(screen.queryByRole("columnheader", { name: /Seats/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(await screen.findByRole("checkbox", { name: "Seats" }));
    expect(screen.getByRole("columnheader", { name: /Seats/ })).toBeTruthy();
  });

  it("leaves a quiet field out of a mobile card (pills mean attention)", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 1023px)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    try {
      render(
        <Harness
          mobile="cards"
          columns={[
            COLUMNS[0]!,
            {
              id: "status",
              header: "Status",
              accessorKey: "status",
              meta: {
                priority: 1,
                quiet: (r: Row) => r.status === "active",
              },
            },
          ]}
        />,
      );
      const cards = within(
        screen.getByRole("list", { name: "Licenses" }),
      ).getAllByRole("listitem");
      const card = (name: string) =>
        cards.find((c) => c.textContent?.includes(name))!;
      expect(within(card("Studio Pro")).queryByText("Status")).toBeNull();
      expect(within(card("Lab 3")).getByText("Status")).toBeTruthy();
      expect(within(card("Lab 3")).getByText("expired")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders no action menu for a row with no valid action", () => {
    render(
      <Harness
        rowActions={(r) =>
          r.status === "active"
            ? [{ label: "Disable", onSelect: () => undefined }]
            : [{ type: "separator" }]
        }
      />,
    );
    expect(
      screen.getByRole("button", { name: "Actions for Studio Pro" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Actions for Old seat" }),
    ).toBeNull();
  });
});

describe("opt-in console additions", () => {
  const width = (px: number) =>
    vi.stubGlobal("matchMedia", (query: string) => {
      const max = /max-width: (\d+)px/.exec(query);
      return {
        matches: max ? px <= Number(max[1]) : false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
    });
  afterEach(() => vi.unstubAllGlobals());

  it("compact toolbar: Columns and Export are named icon buttons below 1600 px, no density", () => {
    width(1440);
    render(
      <Harness
        chrome="full"
        exportCsv
        toolbarMode="compact"
        columns={[
          ...COLUMNS.slice(0, 2),
          { ...COLUMNS[2]!, meta: { numeric: true, defaultHidden: true } },
        ]}
      />,
    );
    const columns = screen.getByRole("button", { name: "Columns" });
    const exp = screen.getByRole("button", { name: "Export CSV" });
    expect(columns.textContent).toBe("");
    expect(exp.textContent).toBe("");
    expect(screen.queryByRole("group", { name: "Row density" })).toBeNull();
  });

  it("compact toolbar: labels return from 1600 px", () => {
    width(1920);
    render(<Harness chrome="full" exportCsv toolbarMode="compact" />);
    expect(screen.getByRole("button", { name: "Export CSV" }).textContent).toBe(
      "Export CSV",
    );
  });

  it("default toolbar keeps labelled Columns, density and Export at 1440", () => {
    width(1440);
    render(
      <Harness
        chrome="full"
        exportCsv
        columns={[
          ...COLUMNS.slice(0, 2),
          { ...COLUMNS[2]!, meta: { numeric: true, defaultHidden: true } },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Columns" }).textContent).toBe(
      "Columns",
    );
    expect(screen.getByRole("group", { name: "Row density" })).toBeTruthy();
  });

  it("a row menu item does not open the row", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onDisable = vi.fn();
    render(
      <Harness
        rowHref={(r) => `#/licenses/${r.id}`}
        linkComponent={({ to, className, children }) => (
          <a href={to} className={className} onClick={onOpen}>
            {children}
          </a>
        )}
        rowActions={() => [{ label: "Disable", onSelect: onDisable }]}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Actions for Studio Pro" }),
    );
    const menu = await screen.findByRole("menu");
    // The menu's own padding is inside the portal, not the row.
    await user.click(menu);
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("menuitem", { name: "Disable" }));
    expect(onDisable).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("errorThing names the failure with a centred Retry and a quiet Copy details", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <Harness
        data={[]}
        error={new Error("boom")}
        onRetry={onRetry}
        errorThing="Licenses"
      />,
    );
    expect(screen.getByText("Licenses didn't load")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps the default error wording without errorThing", () => {
    render(
      <Harness data={[]} error={new Error("boom")} onRetry={() => undefined} />,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/didn't load/)).toBeNull();
  });
});

describe("CSV", () => {
  it("neutralises spreadsheet formula prefixes (SEC-LIC-9)", () => {
    const csv = toCsv(
      ["id"],
      [["=cmd|' /C calc'!A0"], ["+1"], ["-2"], ["@SUM(A1)"], ["ok"]],
    );
    expect(csv.split("\r\n")).toEqual([
      "id",
      "'=cmd|' /C calc'!A0",
      "'+1",
      "'-2",
      "'@SUM(A1)",
      "ok",
    ]);
  });

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

describe("the workbench (ST-48, B4)", () => {
  it("is ONE bordered band holding the toolbar and the table, with 56 px rows", () => {
    render(<Harness />);
    const band = document.querySelector("[data-workbench]")!;
    expect(band.className).toContain("border");
    expect(band.className).toContain("rounded-xl");
    expect(band.querySelector("[data-workbench-toolbar]")).not.toBeNull();
    expect(band.querySelector("table")).not.toBeNull();
    // The toolbar sits inside the band, above the table, not beside it as a page-level row.
    expect(
      band
        .querySelector("[data-workbench-toolbar]")!
        .compareDocumentPosition(band.querySelector("table")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(band.querySelector("tbody tr")!.className).toContain("h-14");
    // Sentence-case heads: no transform on a header cell.
    expect(band.querySelector("thead")!.innerHTML).not.toMatch(/uppercase/);
  });

  it("draws an applied filter as a solid-outline chip in the service's accent", async () => {
    render(<Harness initial={{ filters: { status: ["active"] } }} />);
    const chip = document.querySelector("[data-workbench] .rounded-full.h-7");
    expect(chip).not.toBeNull();
    expect(chip!.className).toContain("border-accent-fg");
    expect(chip!.className).not.toContain("border-dashed");
  });
});
