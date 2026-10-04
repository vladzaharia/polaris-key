import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { BarList } from "../../src/ui/charts/BarList.js";
import { Funnel, conversions } from "../../src/ui/charts/Funnel.js";
import { Meter } from "../../src/ui/charts/Meter.js";
import { StatTile } from "../../src/ui/charts/StatTile.js";

afterEach(cleanup);

describe("Meter", () => {
  it("exposes its numbers on role=meter", () => {
    render(<Meter label="Seats" value={3} max={5} />);
    const m = screen.getByRole("meter", { name: "Seats" });
    expect(m.getAttribute("aria-valuenow")).toBe("3");
    expect(m.getAttribute("aria-valuemin")).toBe("0");
    expect(m.getAttribute("aria-valuemax")).toBe("5");
    expect(m.getAttribute("aria-valuetext")).toBe("3 of 5");
    expect(screen.getByText("3 of 5")).toBeTruthy();
  });
  it("formats basis points", () => {
    render(<Meter label="Rollout" value={2500} max={10000} format="bp" />);
    expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toBe(
      "25 %",
    );
  });
});

const STEPS = [
  { label: "Offered", value: 1000 },
  { label: "Downloaded", value: 800 },
  { label: "Applied", value: 600 },
];

describe("Funnel", () => {
  it("computes step conversion", () => {
    expect(conversions(STEPS)).toEqual([null, 0.8, 0.75]);
    expect(
      conversions([
        { label: "a", value: 0 },
        { label: "b", value: 0 },
      ]),
    ).toEqual([null, null]);
  });
  it("shows conversion between steps and toggles to a table with the same numbers", async () => {
    render(
      <Funnel
        label="Health"
        steps={STEPS}
        failures={[{ label: "Reverted", value: 5 }]}
      />,
    );
    expect(screen.getByRole("figure")).toBeTruthy();
    expect(screen.getByText("80 % of the previous step")).toBeTruthy();
    expect(screen.getByText("75 % of the previous step")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Show as table" }),
    );
    const table = screen.getByRole("table", { name: "Health" });
    const rows = within(table).getAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "StepDevicesFrom previous step",
      "Offered1,000—",
      "Downloaded80080 %",
      "Applied60075 %",
      "Reverted5—",
    ]);
    expect(
      screen
        .getByRole("button", { name: "Show as chart" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
  it("says so when nothing was offered", () => {
    render(<Funnel label="Empty" steps={[{ label: "Offered", value: 0 }]} />);
    expect(screen.getByText(/No devices were offered/)).toBeTruthy();
  });
});

describe("BarList", () => {
  it("sorts largest first and its table matches", async () => {
    render(
      <BarList
        label="Platforms"
        items={[
          { label: "Linux", value: 5 },
          { label: "macOS", value: 20, href: "#/x" },
        ]}
      />,
    );
    expect(
      screen.getByRole("link", { name: "macOS" }).getAttribute("href"),
    ).toBe("#/x");
    await userEvent.click(
      screen.getByRole("button", { name: "Show as table" }),
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "ItemValue",
      "macOS20",
      "Linux5",
    ]);
  });
});

describe("StatTile", () => {
  it("shows the value, a linked label and the delta", () => {
    render(
      <StatTile
        label="Active"
        value="1,284"
        href="#/l"
        delta={{ value: "+12", tone: "success", label: "vs last week" }}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Active" }).getAttribute("href"),
    ).toBe("#/l");
    expect(screen.getByText("1,284")).toBeTruthy();
    expect(screen.getByText("+12")).toBeTruthy();
  });
  it("loading and error are per tile", async () => {
    const retry = vi.fn();
    render(
      <>
        <StatTile label="A" loading />
        <StatTile label="B" error onRetry={retry} />
      </>,
    );
    expect(screen.getByText("Loading A")).toBeTruthy();
    expect(screen.getByText("Couldn't load this figure.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
  });
});
