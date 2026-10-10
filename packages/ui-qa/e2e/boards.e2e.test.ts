// The acceptance of UK-15: `pnpm ui:lint` passes on the committed mockup boards, the string lint
// fails on a seeded copy drift between two boards, and the RTL-safe rule fails on a seeded
// margin-left in kit CSS.
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { BOARDS_DIR, REPO_ROOT } from "../src/config.ts";
import { format, runLint } from "../src/lint.ts";

let browser: Browser;
let seeded: string;

beforeAll(async () => {
  browser = await chromium.launch();
  // A root that is the repository except for its boards: symlinks to the real packages and
  // conformance (the tokens, fonts, catalogs and ledgers), and a copy of docs/design/ui-kits at
  // the same depth so the boards' relative imports still resolve.
  seeded = mkdtempSync(join(tmpdir(), "ui-qa-seeded-"));
  for (const d of ["packages", "conformance"])
    symlinkSync(resolve(REPO_ROOT, d), join(seeded, d));
  mkdirSync(join(seeded, "docs/design"), { recursive: true });
  cpSync(resolve(REPO_ROOT, BOARDS_DIR), join(seeded, BOARDS_DIR), {
    recursive: true,
    filter: (src) => !src.includes("/shots"),
  });
});

afterAll(async () => {
  await browser.close();
  rmSync(seeded, { recursive: true, force: true });
});

const seed = (file: string, from: string, to: string) => {
  const p = join(seeded, BOARDS_DIR, file);
  const s = readFileSync(p, "utf8");
  expect(s).toContain(from);
  writeFileSync(p, s.replace(from, to));
};

describe("pnpm ui:lint on the mockup boards", () => {
  it("passes on every committed board, in both themes, with the kit source lints", async () => {
    const run = await runLint({}, browser);
    expect(format(run)).toBe("");
  });

  it("fails on a seeded copy drift between two boards", async () => {
    // Both boards show the gate's secondary action; one drifts from the catalog ("Use a license
    // key", kit-copy welcome.useKey) to a variant no platform documents.
    seed("windows.html", "Use a license key", "Enter a license key");
    const run = await runLint(
      {
        root: seeded,
        boards: ["web", "windows"],
        themes: ["dark"],
        kits: false,
      },
      browser,
    );
    // The Windows board draws the gate's actions from one template, so the drift shows once in
    // each state that renders them.
    const drift = run.strings.filter((s) => s.text === "Enter a license key");
    expect(drift.length).toBeGreaterThan(0);
    for (const d of drift) {
      expect(d.board).toBe("windows");
      expect(d.detail).toMatch(/Use a license key/);
    }
    expect(run.violations).toEqual([]);
  });

  it("fails on a seeded margin-left in the kits' shared CSS", async () => {
    seed(
      "shared.css",
      ".k-btn {\n  appearance: none;",
      ".k-btn {\n  appearance: none;\n  margin-left: 4px;",
    );
    const run = await runLint(
      {
        root: seeded,
        boards: ["web"],
        themes: ["dark"],
        kits: false,
        strings: false,
      },
      browser,
    );
    const rtl = run.violations.filter((v) => v.rule === "rtl-physical");
    expect(rtl.length).toBeGreaterThan(0);
    expect(rtl[0]!.target).toMatch(/shared\.css \.k-btn/);
    expect(rtl[0]!.detail).toMatch(/margin-inline-start/);
  });

  it("fails on a seeded margin-left in a kit stylesheet linted on its own (--css)", async () => {
    const css = join(seeded, "kit.css");
    writeFileSync(
      css,
      ".pk-row { display: flex; margin-left: 12px; padding-inline: 16px; }\n",
    );
    const run = await runLint(
      { root: seeded, boards: [], css: ["kit.css"], kits: false },
      browser,
    );
    expect(run.violations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([
      "rtl-physical: margin-left (use margin-inline-start)",
    ]);
  });
});
