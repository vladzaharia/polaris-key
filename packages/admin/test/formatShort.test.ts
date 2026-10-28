import { describe, expect, it } from "vitest";
import { formatShort } from "../src/lib/format.js";

const NOW = Date.UTC(2026, 9, 28, 12);
const opts = { locale: "en-US", timeZone: "UTC", now: NOW };

describe("formatShort", () => {
  it("drops the year in the current one", () => {
    expect(formatShort(Date.UTC(2026, 9, 7, 14, 5), opts)).toBe("Oct 7");
  });
  it("adds the year in another", () => {
    expect(formatShort(Date.UTC(2025, 8, 17, 15, 7), opts)).toBe(
      "Sep 17, 2025",
    );
  });
  it("adds the time of day on request", () => {
    expect(
      formatShort(Date.UTC(2026, 9, 7, 14, 5), { ...opts, time: true }),
    ).toBe("Oct 7, 2:05 PM");
  });
});
