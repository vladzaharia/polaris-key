import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDay, formatDayTime } from "../src/portal/date.js";

/** Lead decision 2026-10-21: one customer-facing date format, "Sep 14, 2026". */
const SEP_14 = Date.UTC(2026, 8, 14, 15, 5) / 1000;

describe("the portal date format", () => {
  it("writes the US short form", () => {
    expect(formatDay(SEP_14, true, { utc: true })).toBe("Sep 14, 2026");
    expect(formatDay(SEP_14, false, { utc: true })).toBe("Sep 14");
    expect(formatDayTime(SEP_14, { utc: true })).toBe("Sep 14, 2026, 3:05 PM");
  });

  it("never writes September as Sept", () => {
    expect(formatDay(Date.UTC(2026, 8, 3) / 1000, true, { utc: true })).toBe(
      "Sep 3, 2026",
    );
  });

  it("follows a catalog locale when one is given", () => {
    expect(formatDay(SEP_14, true, { utc: true, locale: "ja" })).toBe(
      "2026年9月14日",
    );
    expect(formatDay(SEP_14, true, { utc: true, locale: "de" })).toMatch(
      /14\.\s?Sept?\.? 2026/,
    );
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

describe("no other date format in the portal", () => {
  const SRC = join(__dirname, "..", "src", "portal");
  it("builds every date through portal/date.ts", () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith(join("portal", "date.ts")))
      .filter((f) =>
        /dateStyle|toLocaleDateString|toLocaleString\(|Intl\.DateTimeFormat|lib\/format\.js"[^;]*formatDate|formatDate(Time)?\b.*lib\/format/s.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});
