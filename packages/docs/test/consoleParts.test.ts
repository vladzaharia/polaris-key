import { describe, expect, it } from "vitest";
import { convertAsides, wrapTables } from "../scripts/console-parts";

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
    expect(out).not.toMatch(
      /<th class="[^"]*text-left[^"]*" scope="col" align="right"/,
    );
  });
  it("is idempotent", () => {
    expect(wrapTables(out)).toBe(out);
  });
});

describe("convertAsides", () => {
  const aside =
    '<aside aria-label="Important" class="starlight-aside starlight-aside--caution"><p class="starlight-aside__title" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M0"/></svg>Important</p><div class="starlight-aside__content"><p>Read <a href="/x/">this</a></p><div class="expressive-code">x</div></div></aside>';
  it("renders the console callout with the right tone, title and body", () => {
    const out = convertAsides(`<p>a</p>${aside}<p>b</p>`);
    expect(out).not.toContain("starlight-aside");
    expect(out).toContain('data-tone="warning"');
    expect(out).toContain("Important");
    expect(out).toContain('<a href="/x/">this</a>');
    expect(out).toContain('<div class="expressive-code">x</div>');
    expect(out.startsWith("<p>a</p>")).toBe(true);
    expect(out.endsWith("<p>b</p>")).toBe(true);
  });
  it("maps every type to a console tone", () => {
    for (const [type, tone] of [
      ["note", "info"],
      ["tip", "success"],
      ["danger", "danger"],
    ] as const) {
      const html = aside
        .replace(/caution/g, type)
        .replace('aria-label="Important"', `aria-label="T"`);
      expect(convertAsides(html)).toContain(`data-tone="${tone}"`);
    }
  });
});

describe("running-text columns", () => {
  const long =
    "A long description that runs past a label and needs room to read.";
  const html = `<h2>T</h2><table><thead><tr><th>Key</th><th>Setting</th></tr></thead><tbody><tr><td>k</td><td>${long}</td></tr></tbody></table>`;
  it("give a column of running text a readable minimum, header and cells alike", () => {
    const out = wrapTables(html);
    expect(out.match(/min-w-72/g)).toHaveLength(2);
    expect(out).toMatch(/<th class="[^"]*min-w-72[^"]*" scope="col">Setting/);
    expect(out).not.toMatch(/<th class="[^"]*min-w-72[^"]*" scope="col">Key/);
  });
});
