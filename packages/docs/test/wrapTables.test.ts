import { describe, expect, it } from "vitest";
import { wrapTables } from "../scripts/wrap-tables";

const page = `<h2 id="a">Options</h2><table><thead><tr><th>Name</th><th align="right">Value</th></tr></thead><tbody><tr><td>x</td><td>1</td></tr></tbody></table><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table><h2 id="b">Other</h2><table><thead><tr><th>C</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>`;

describe("wrapTables", () => {
  const out = wrapTables(page);
  it("puts each table in a labelled, focusable region", () => {
    expect(out.match(/role="region"/g)).toHaveLength(3);
    expect(out).toContain('aria-label="Options table"');
    expect(out).toContain('aria-label="Options table 2"');
    expect(out).toContain('aria-label="Other table"');
    expect(out.match(/tabindex="0"/g)).toHaveLength(3);
  });
  it("names the table for screen readers with the same text", () => {
    expect(out).toContain('<caption class="sr-only">Options table</caption>');
  });
  it("gives header cells a scope and keeps their attributes", () => {
    expect(out).toMatch(/<th class="[^"]*" scope="col" align="right">Value/);
    expect(out).not.toMatch(/<th class="[^"]*text-left[^"]*" scope="col" align="right"/);
  });
  it("is idempotent", () => {
    expect(wrapTables(out)).toBe(out);
  });
});
