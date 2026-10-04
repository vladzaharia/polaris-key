import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { Grid } from "../../src/ui/Grid.js";

afterEach(cleanup);

const ROWS = ["2.4.0", "2.3.9", "2.3.8"];
const COLS = ["direct", "App Store", "Google Play"];

function renderGrid(onCellActivate = vi.fn()) {
  render(
    <>
      <button type="button">Before</button>
      <Grid
        label="Matrix"
        cornerLabel="Release"
        rows={ROWS}
        columns={COLS}
        getRowId={(r) => r}
        getColumnId={(c) => c}
        rowHeader={(r) => r}
        columnHeader={(c) => c}
        cell={(r, c) => `${r}/${c}`}
        cellLabel={(r, c) => `${r} on ${c}`}
        onCellActivate={onCellActivate}
      />
      <button type="button">After</button>
    </>,
  );
  return onCellActivate;
}

const cell = (name: string) => screen.getByRole("gridcell", { name });

describe("Grid", () => {
  it("is one tab stop: only the active cell is tabbable", async () => {
    renderGrid();
    const tabbable = screen
      .getAllByRole("gridcell")
      .filter((c) => c.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    const user = userEvent.setup();
    screen.getByRole("button", { name: "Before" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(cell("2.4.0 on direct"));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "After" }),
    );
  });

  it("moves with the arrow keys and stops at the edges", async () => {
    renderGrid();
    const user = userEvent.setup();
    cell("2.4.0 on direct").focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(cell("2.4.0 on App Store"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(cell("2.3.9 on App Store"));
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement).toBe(cell("2.3.9 on direct"));
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(cell("2.4.0 on direct"));
    expect(cell("2.4.0 on direct").getAttribute("tabindex")).toBe("0");
    expect(cell("2.3.9 on direct").getAttribute("tabindex")).toBe("-1");
  });

  it("Home/End go to the row ends, Ctrl+Home/End to the corners", async () => {
    renderGrid();
    const user = userEvent.setup();
    cell("2.4.0 on direct").focus();
    await user.keyboard("{ArrowDown}{ArrowRight}{End}");
    expect(document.activeElement).toBe(cell("2.3.9 on Google Play"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(cell("2.3.9 on direct"));
    await user.keyboard("{Control>}{End}{/Control}");
    expect(document.activeElement).toBe(cell("2.3.8 on Google Play"));
    await user.keyboard("{Control>}{Home}{/Control}");
    expect(document.activeElement).toBe(cell("2.4.0 on direct"));
  });

  it("Enter and Space activate the active cell", async () => {
    const onActivate = renderGrid();
    const user = userEvent.setup();
    cell("2.4.0 on direct").focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onActivate).toHaveBeenLastCalledWith("2.3.9", "direct");
    await user.keyboard("{ArrowRight} ");
    expect(onActivate).toHaveBeenLastCalledWith("2.3.9", "App Store");
  });

  it("returns to the last cell after leaving and coming back", async () => {
    renderGrid();
    const user = userEvent.setup();
    cell("2.4.0 on direct").focus();
    await user.keyboard("{ArrowDown}{ArrowRight}");
    await user.tab();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cell("2.3.9 on App Store"));
  });
});
