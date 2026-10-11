import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  cellsOf,
  checkUxRows,
  parseUxRow,
  PROGRAM_PATH,
  SPECS,
  tableRows,
  UX_ROWS_PATH,
  uxIds,
} from "./ux-rows-check.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the repository", () => {
  it("maps every UX id and marks every row", () => {
    const { violations, rows } = checkUxRows({ root: repo });
    expect(violations).toEqual([]);
    expect(rows).toBeGreaterThan(70);
  });
});

describe("parseUxRow", () => {
  it.each([
    ["ST-30", "package", ["ST-30"]],
    ["SP-33a", "package", ["SP-33a"]],
    ["built 191543162", "built", []],
    ["built 5ad447feb (ST-36)", "built", []],
    ["built by MO-11", "built", ["MO-11"]],
    ["built by I-07 and I-18", "built", ["I-07", "I-18"]],
    ["built by PX-13 and PX-22", "built", ["PX-13", "PX-22"]],
    ["parked: entity search; revive when a third product lands", "parked", []],
    ["parked: person drawer; revive after UX-06b", "parked", []],
    ["dropped: merged into LX-14", "dropped", []],
  ])("accepts %s", (value, kind, ids) => {
    expect(parseUxRow(value)).toEqual({ kind, ids });
  });

  it.each([
    "",
    "todo",
    "built",
    "built xyz",
    "parked: no condition",
    "dropped",
    "ST-30 and ST-31",
    "built by",
  ])("rejects %j", (value) => {
    expect(parseUxRow(value)).toBeNull();
  });
});

describe("uxIds", () => {
  it("finds plain, lettered and slashed ids once each, and ignores the wildcard", () => {
    expect(
      uxIds(
        "UX-01, UX-06a/06b and UX-06a again; UX-* packages; UX-50 to UX-71",
      ).sort(),
    ).toEqual(["UX-01", "UX-06a", "UX-06b", "UX-50", "UX-71"]);
  });
});

describe("cellsOf", () => {
  it("splits on pipes and keeps an escaped one", () => {
    expect(cellsOf("| a | b \\| c | d |")).toEqual(["a", "b | c", "d"]);
  });
});

describe("tableRows", () => {
  const text = [
    "### 1 Work",
    "",
    "| Id | Package | Status |",
    "| -- | ------- | ------ |",
    "| UX-01 | **One** | built abc1234 |",
    "| UX-02 | Two | ST-30 |",
    "",
    "| Id | Package |",
    "| -- | ------- |",
    "| UX-03 | Three |",
    "| PX-21 | Four | |",
    "",
    "### 2 Next",
    "| UX-04 | out of range | x |",
  ].join("\n");

  it("reads the Status cell of each table's own header, within the headings", () => {
    expect(tableRows(text, "### 1 ", "### 2 ")).toEqual([
      { line: 5, id: "UX-01", status: "built abc1234" },
      { line: 6, id: "UX-02", status: "ST-30" },
      { line: 10, id: "UX-03", status: null },
      { line: 11, id: "PX-21", status: null },
    ]);
  });

  it("throws when the opening heading is gone", () => {
    expect(() => tableRows(text, "### 9 ", "### 2 ")).toThrow(/no heading/);
  });
});

// ── A miniature repository ─────────────────────────────────────────────────────────────────

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const TABLE_HEAD = "| Id | Package | Status |\n| -- | -- | -- |\n";

interface Fixture {
  uxRows?: Record<string, string>;
  graph?: string[];
  experience?: string;
  setup?: string;
  flows?: string;
  other?: string;
}

function build(f: Fixture = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ux-rows-"));
  roots.push(root);
  const put = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  put(
    UX_ROWS_PATH,
    JSON.stringify({
      uxRows: f.uxRows ?? {
        "UX-01": "built 1234567",
        "UX-02": "ST-30",
        "UX-03": "parked: x; revive when y",
        "UX-04": "dropped: z",
      },
    }),
  );
  put(
    PROGRAM_PATH,
    JSON.stringify({
      workPackages: (f.graph ?? ["ST-30"]).map((id) => ({ id })),
    }),
  );
  put(
    "docs/design/EXPERIENCE.md",
    f.experience ??
      `### 13.3 Work packages\n\n${TABLE_HEAD}| UX-01 | a | built 1234567 |\n| UX-02 | b | ST-30 |\n\n### 13.4 Next\n`,
  );
  put(
    "docs/design/SETUP.md",
    f.setup ??
      `### 8.2 Work packages\n\n${TABLE_HEAD}| UX-03 | c | parked: x; revive when y |\n\n### 8.3 Next\n`,
  );
  put(
    "docs/design/FLOWS.md",
    f.flows ??
      `### 4.2 Work packages\n\n${TABLE_HEAD}| UX-04 | d | dropped: z |\n\n### 4.3 Next\n`,
  );
  for (const spec of SPECS)
    if (!spec.match(/EXPERIENCE|SETUP|FLOWS/))
      put(spec, f.other ?? "Prose naming UX-01.\n");
  return root;
}

describe("checkUxRows on a miniature repository", () => {
  it("reports nothing when every row is mapped and marked", () => {
    expect(checkUxRows({ root: build() }).violations).toEqual([]);
  });

  it("fails an id a spec names that uxRows lacks", () => {
    const { violations } = checkUxRows({
      root: build({ other: "See UX-99.\n" }),
    });
    expect(violations).toEqual([
      "docs/design/SIGN-IN.md: UX-99 is not mapped in uxRows",
      "docs/design/ADMIN.md: UX-99 is not mapped in uxRows",
      "docs/design/PORTAL.md: UX-99 is not mapped in uxRows",
    ]);
  });

  it("fails a table row uxRows lacks", () => {
    const { violations } = checkUxRows({
      root: build({
        experience: `### 13.3 Work packages\n\n${TABLE_HEAD}| UX-01 | a | built 1234567 |\n| UX-02 | b | ST-30 |\n| UX-77 | e | ST-30 |\n\n### 13.4 Next\n`,
      }),
    });
    expect(violations).toContain(
      "docs/design/EXPERIENCE.md:7: UX-77 is not mapped in uxRows",
    );
  });

  it("fails a row whose Status disagrees with uxRows", () => {
    const { violations } = checkUxRows({
      root: build({
        experience: `### 13.3 Work packages\n\n${TABLE_HEAD}| UX-01 | a | todo |\n| UX-02 | b | ST-30 |\n\n### 13.4 Next\n`,
      }),
    });
    expect(violations).toEqual([
      'docs/design/EXPERIENCE.md:5: UX-01 says "todo" but uxRows says "built 1234567"',
    ]);
  });

  it("fails a table with no Status column", () => {
    const { violations } = checkUxRows({
      root: build({
        flows: `### 4.2 Work packages\n\n| Id | Package |\n| -- | -- |\n| UX-04 | d |\n\n### 4.3 Next\n`,
      }),
    });
    expect(violations).toEqual([
      "docs/design/FLOWS.md:5: UX-04 has no Status cell (its table needs a Status column)",
    ]);
  });

  it("fails a uxRows id no table row marks", () => {
    const { violations } = checkUxRows({
      root: build({
        flows: `### 4.2 Work packages\n\n${TABLE_HEAD}\n### 4.3 Next\n`,
      }),
    });
    expect(violations).toEqual([
      `${UX_ROWS_PATH}: uxRows UX-04 has no marked row in EXPERIENCE §13.3, SETUP §8.2 or FLOWS §4.2`,
    ]);
  });

  it("fails a value in none of the five forms", () => {
    const { violations } = checkUxRows({
      root: build({
        uxRows: {
          "UX-01": "soon",
          "UX-02": "ST-30",
          "UX-03": "parked: x; revive when y",
          "UX-04": "dropped: z",
        },
      }),
    });
    expect(violations[0]).toMatch(/uxRows UX-01 is "soon"/);
  });

  it("fails a graph id workpackages.json does not register", () => {
    const { violations } = checkUxRows({ root: build({ graph: ["ST-31"] }) });
    expect(violations).toContain(
      `${UX_ROWS_PATH}: uxRows UX-02 names ST-30, which ${PROGRAM_PATH} does not register`,
    );
  });
});
