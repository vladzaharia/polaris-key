import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  LicenseTerm,
  termPlot,
} from "../src/portal/components/product/LicenseTerm.js";

/** The License card's term (PX-28a): words first, a chart only when there is a span to plot. */
const DAY = 86_400;
const NOW = Date.UTC(2026, 9, 20, 12) / 1000;

afterEach(cleanup);

describe("LicenseTerm", () => {
  it("a lifetime license is the word and no chart", () => {
    render(<LicenseTerm activatedAt={NOW - DAY} expiresAt={null} now={NOW} />);
    expect(screen.getByText("Lifetime")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("a running term reads Until <date> over a chart with today on it", () => {
    render(
      <LicenseTerm
        activatedAt={NOW - 100 * DAY}
        expiresAt={NOW + 100 * DAY}
        now={NOW}
      />,
    );
    expect(screen.getByText(/^Until /)).toBeTruthy();
    const chart = screen.getByRole("img");
    expect(chart.getAttribute("aria-label")).toMatch(
      /^From .+ to .+\. Today is .+\.$/,
    );
    // Halfway: today's label sits at 50 % of the track.
    expect(
      chart.querySelector<HTMLElement>("[style*='inset-inline-start: 50%']"),
    ).toBeTruthy();
  });

  it("an ended term reads Ended <date> with the marker at the end", () => {
    render(
      <LicenseTerm
        activatedAt={NOW - 400 * DAY}
        expiresAt={NOW - 3 * DAY}
        now={NOW}
      />,
    );
    expect(screen.getByText(/^Ended /)).toBeTruthy();
    expect(
      screen
        .getByRole("img")
        .querySelector<HTMLElement>("[style*='inset-inline-start: 100%']"),
    ).toBeTruthy();
  });

  it("no start day, no chart: the end is still said", () => {
    render(<LicenseTerm activatedAt={null} expiresAt={NOW + DAY} now={NOW} />);
    expect(screen.getByText(/^Until /)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("holds its action under the term", () => {
    render(
      <LicenseTerm activatedAt={null} expiresAt={NOW - DAY} now={NOW}>
        <a href="https://dev.example">Renew with Dev</a>
      </LicenseTerm>,
    );
    const link = screen.getByRole("link", { name: "Renew with Dev" });
    expect(link.closest("[data-license-term]")).toBeTruthy();
  });

  it("a word on its own is not boxed, and the axis never starts at 1970", () => {
    render(<LicenseTerm activatedAt={0} expiresAt={null} now={NOW} />);
    expect(
      screen.getByText("Lifetime").closest("[data-license-term]")!.className,
    ).not.toContain("bg-surface-sunken");
    expect(termPlot(0, NOW + DAY)).toBeNull();
    expect(termPlot(null, NOW + DAY)).toBeNull();
    expect(termPlot(NOW - DAY, NOW + DAY)).not.toBeNull();
  });

  it("past its end the axis runs on to today with the stretch after the end dashed", () => {
    render(
      <LicenseTerm
        activatedAt={NOW - 400 * DAY}
        expiresAt={NOW - 100 * DAY}
        now={NOW}
      />,
    );
    const chart = screen.getByRole("img");
    expect(chart.querySelector("[class*='end-0']")).toBeTruthy();
    expect(
      chart.querySelector("[style*='inset-inline-start: 100%']"),
    ).toBeTruthy();
  });
});
