import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import * as React from "react";
import { Grid } from "../../src/ui/Grid.js";
import {
  DataTable,
  EMPTY_TABLE_STATE,
  type DataColumn,
} from "../../src/ui/data-table/index.js";

/**
 * Every table cell in the console and the portal is vertically centred in its row: a one-line
 * cell (a rollout's "Live", a pill) sits on the middle of a row a two-line cell made taller, not
 * on its top. The base layer sets `vertical-align: middle` on every th/td (styles.css), the shared
 * DataTable and Grid say so on each cell, and no cell, row or table overrides it.
 */

afterEach(cleanup);

const SRC =
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src") + "/";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [p] : [];
  });
}

const OFF_CENTRE =
  /\balign-(top|bottom|baseline|text-top|text-bottom|sub|super)\b/;

describe("table cells are vertically centred", () => {
  it("the base layer centres every th and td", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    expect(css).toMatch(
      /@layer base\s*{[\s\S]*?th,\s*td\s*{\s*vertical-align:\s*middle;\s*}/,
    );
  });

  it("no table, row or cell in the console or portal sets another vertical alignment", () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const code = readFileSync(file, "utf8");
      // An element's attributes run from its tag to the next "<" (class strings hold none).
      for (const m of code.matchAll(
        /<(table|thead|tbody|tfoot|tr|th|td)\b[^<]*/g,
      )) {
        const hit = OFF_CENTRE.exec(m[0]);
        if (hit)
          offenders.push(`${file.slice(SRC.length)}: <${m[1]}> ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the Grid centres its row headers and cells", () => {
    render(
      <Grid
        label="Matrix"
        cornerLabel="Release"
        rows={["2.4.0", "2.3.9"]}
        columns={["direct", "play"]}
        getRowId={(r) => r}
        getColumnId={(c) => c}
        rowHeader={(r) => r}
        columnHeader={(c) => c}
        cell={(r, c) => `${r}/${c}`}
        cellLabel={(r, c) => `${r} on ${c}`}
      />,
    );
    const body = screen.getByRole("grid").querySelector("tbody")!;
    const cells = [...body.querySelectorAll("th, td")];
    expect(cells.length).toBe(6);
    for (const c of cells) expect(c.className).toMatch(/\balign-middle\b/);
  });

  it("the DataTable centres every body cell, selection and row menu included", () => {
    interface Row {
      id: string;
      name: string;
      state: string;
    }
    const columns: DataColumn<Row>[] = [
      { id: "name", header: "Name", accessorKey: "name" },
      {
        id: "state",
        header: "State",
        accessorKey: "state",
        meta: { align: "end" },
      },
    ];
    render(
      <DataTable<Row>
        id="cells"
        caption="Rollouts"
        data={[
          { id: "a", name: "2.4.0", state: "Live" },
          { id: "b", name: "2.3.9", state: "Halted" },
        ]}
        columns={columns}
        getRowId={(r) => r.id}
        rowLabel={(r) => r.name}
        state={EMPTY_TABLE_STATE}
        onStateChange={() => {}}
        selection={{ mode: "multi", bulkActions: [] }}
        rowActions={() => [{ label: "Open", onSelect: () => {} }]}
        exportCsv={false}
      />,
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const tds = [...row.querySelectorAll("td")];
      expect(tds).toHaveLength(4);
      for (const td of tds) expect(td.className).toMatch(/\balign-middle\b/);
    }
  });
});
