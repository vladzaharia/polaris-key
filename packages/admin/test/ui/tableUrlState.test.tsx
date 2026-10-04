import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import {
  readTableState,
  useTableUrlState,
  writeTableState,
} from "../../src/console/useTableUrlState.js";
import { navigate } from "../../src/console/router.js";
import { DataTable, type DataColumn } from "../../src/ui/data-table/index.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const query = () => {
  const h = window.location.hash;
  const i = h.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : h.slice(i + 1));
};

describe("readTableState / writeTableState", () => {
  it("round-trips search, multi-sort, facets and pagination; drops defaults", () => {
    const q = new URLSearchParams(
      "q=lab&sort=expires,-name&status=active,expired&offset=50&other=1",
    );
    const state = readTableState(q, "lic", { facets: ["status", "tier"] });
    expect(state).toEqual({
      q: "lab",
      sort: [
        { id: "expires", desc: false },
        { id: "name", desc: true },
      ],
      filters: { status: ["active", "expired"] },
      cursor: null,
      offset: 50,
    });
    const written = writeTableState(
      q,
      "lic",
      { ...state, q: "  ", offset: 0 },
      { facets: ["status", "tier"] },
    );
    expect(written.toString()).toBe(
      "sort=expires%2C-name&status=active%2Cexpired&other=1",
    );
  });

  it("namespaces keys when a page holds two tables", () => {
    const a = writeTableState(
      new URLSearchParams(),
      "devices",
      {
        q: "mac",
        sort: [],
        filters: { status: ["authorized"] },
        cursor: "c1",
        offset: 0,
      },
      { facets: ["status"], namespace: true },
    );
    expect(Object.fromEntries(a)).toEqual({
      "devices.q": "mac",
      "devices.status": "authorized",
      "devices.cursor": "c1",
    });
    const b = readTableState(a, "keys", {
      facets: ["status"],
      namespace: true,
    });
    expect(b.q).toBe("");
    expect(b.filters).toEqual({});
  });

  it("ignores a malformed offset", () => {
    expect(readTableState(new URLSearchParams("offset=-3"), "t").offset).toBe(
      0,
    );
  });
});

interface Row {
  id: string;
  name: string;
  status: "active" | "expired";
}
const ROWS: Row[] = [
  { id: "1", name: "Studio Pro", status: "active" },
  { id: "2", name: "Lab 3", status: "expired" },
  { id: "3", name: "Booth A", status: "active" },
];
const COLUMNS: DataColumn<Row>[] = [
  { id: "name", header: "Holder", accessorKey: "name" },
  { id: "status", header: "Status", accessorKey: "status" },
];

function UrlTable(): React.ReactElement {
  const [state, setState] = useTableUrlState("licenses", {
    facets: ["status"],
  });
  return (
    <DataTable<Row>
      id="licenses"
      caption="Licenses"
      data={ROWS}
      columns={COLUMNS}
      getRowId={(r) => r.id}
      facets={[
        {
          id: "status",
          label: "Status",
          options: [
            { value: "active", label: "Active" },
            { value: "expired", label: "Expired" },
          ],
        },
      ]}
      search={{ placeholder: "Search holders", columns: ["name"] }}
      state={state}
      onStateChange={setState}
    />
  );
}

describe("useTableUrlState with a DataTable", () => {
  it("reads filters from the hash on load", () => {
    window.location.hash = "#/products?status=expired";
    render(<UrlTable />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Lab 3");
  });

  it("writes sort to the hash, replacing the history entry, and keeps other keys", async () => {
    window.location.hash = "#/products?keep=1";
    const before = window.history.length;
    render(<UrlTable />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Holder/ }));
    expect(query().get("sort")).toBe("name");
    expect(query().get("keep")).toBe("1");
    expect(window.location.hash.startsWith("#/products?")).toBe(true);
    expect(window.history.length).toBe(before);
  });

  it("follows the hash when it changes (Back restores the filters)", async () => {
    window.location.hash = "#/products";
    render(<UrlTable />);
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(3);
    act(() => {
      navigate("#/products?q=booth");
    });
    await waitFor(() =>
      expect(screen.getAllByRole("row").slice(1)).toHaveLength(1),
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]!.textContent).toContain("Booth A");
    expect(
      (screen.getByPlaceholderText("Search holders") as HTMLInputElement).value,
    ).toBe("booth");
  });
});
