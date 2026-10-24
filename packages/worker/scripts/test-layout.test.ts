/**
 * `scripts/test-layout.mjs apply` on a fixture repo (P0-30.5): a move rewrites specifiers, `HERE`
 * and carries its snapshot; a guard stays; references to the old path follow.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apply, classify, parseTsv, plan, tsv } from "./test-layout.mjs";

const T = "packages/worker/test";
let root: string;

function put(rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "test-layout-"));
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  put(
    "tools/services.json",
    JSON.stringify({ services: [{ slug: "sync" }, { slug: "release" }] }),
  );
  put("packages/worker/src/services/sync/store.ts", "export const x = 1;\n");
  put("packages/worker/migrations/0001_a.sql", "select 1;\n");
  put(`${T}/seed.ts`, "export const seed = 1;\n");
  put(`${T}/helpers/legacy.ts`, "export const legacy = 1;\n");
  put(`${T}/fixtures/a.json`, "{}\n");
  put(`${T}/paths.ts`, "export const TEST_ROOT = '';\n");
  put(
    `${T}/syncThing.test.ts`,
    [
      'import { readFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'import { expect, it, vi } from "vitest";',
      'import { x } from "../src/services/sync/store.js";',
      'import { seed } from "./seed.js";',
      'import { legacy } from "./helpers/legacy.js";',
      'vi.mock("../src/services/sync/store.js", () => ({}));',
      "const HERE = dirname(fileURLToPath(import.meta.url));",
      'it("reads", () => {',
      '  readFileSync(join(HERE, "fixtures", "a.json"));',
      '  readFileSync(join(HERE, "..", "migrations", "0001_a.sql"));',
      '  readFileSync(new URL("../migrations/0001_a.sql", import.meta.url));',
      "  expect([x, seed, legacy]).toBeTruthy();",
      "});",
      "",
    ].join("\n"),
  );
  put(`${T}/__snapshots__/syncThing.test.ts.snap`, "// snap\n");
  put(
    `${T}/boundaries.test.ts`,
    'import { seed } from "./seed.js";\nexport const b = seed;\n',
  );
  put(
    "docs/page.md",
    `See packages/worker/test/syncThing.test.ts and test/boundaries.test.ts.\n`,
  );
  put("docs/superpowers/old.md", "test/syncThing.test.ts\n");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("test-layout", () => {
  it("plans a prefix move and keeps the guard", () => {
    const rows = plan(root);
    const byOld = Object.fromEntries(
      rows.map((r) => [r.old.split("/").pop(), r.new]),
    );
    expect(byOld["syncThing.test.ts"]).toBe(
      `${T}/services/sync/syncThing.test.ts`,
    );
    expect(byOld["boundaries.test.ts"]).toBe(`${T}/boundaries.test.ts`);
    expect(tsv(rows)).toContain("\tguard: ");
  });

  it("classifies by direct imports", () => {
    const slugs = ["sync", "release"];
    const c = (src: string): string => classify("x.test.ts", src, slugs).dir;
    expect(c('import a from "../src/core/a.js";')).toBe("core");
    expect(c("export {}")).toBe("core");
    expect(c('import a from "../src/services/release/a.js";')).toBe(
      "services/release",
    );
    expect(
      c(
        'import "../src/services/release/a.js"; import "../src/services/sync/b.js";',
      ),
    ).toBe("surfaces");
    expect(
      c('import "../src/console/a.js"; import "../src/services/sync/b.js";'),
    ).toBe("surfaces/console");
    expect(c('import "../src/console/a.js"; import "../src/router.js";')).toBe(
      "surfaces",
    );
    expect(classify("accountsMigration.test.ts", "", slugs).dir).toBe(
      "core/migrations",
    );
    expect(classify("cloudSyncMigration.test.ts", "", slugs).dir).toBe(
      "services/sync",
    );
  });

  it("apply moves, rewrites specifiers, HERE, the snapshot and references", () => {
    const res = apply(root, parseTsv(tsv(plan(root))), { format: false });
    expect(res.moved).toEqual([`${T}/services/sync/syncThing.test.ts`]);
    const moved = read(`${T}/services/sync/syncThing.test.ts`);
    expect(moved).toContain('from "../../../src/services/sync/store.js"');
    expect(moved).toContain('vi.mock("../../../src/services/sync/store.js"');
    expect(moved).toContain('from "../../seed.js"');
    expect(moved).toContain('from "../../helpers/legacy.js"');
    expect(moved).toContain(
      'import { TEST_ROOT as HERE } from "../../paths.js";',
    );
    expect(moved).not.toContain("const HERE");
    expect(moved).not.toMatch(/node:url|dirname/);
    expect(moved).toContain(
      'new URL("../../../migrations/0001_a.sql", import.meta.url)',
    );
    expect(existsSync(join(root, `${T}/syncThing.test.ts`))).toBe(false);
    expect(
      existsSync(
        join(root, `${T}/services/sync/__snapshots__/syncThing.test.ts.snap`),
      ),
    ).toBe(true);
    expect(
      existsSync(join(root, `${T}/__snapshots__/syncThing.test.ts.snap`)),
    ).toBe(false);
    // the guard stays, untouched
    expect(read(`${T}/boundaries.test.ts`)).toContain('from "./seed.js"');
    // references: followed in live docs, left in the historical ones
    expect(read("docs/page.md")).toContain(
      "packages/worker/test/services/sync/syncThing.test.ts",
    );
    expect(read("docs/page.md")).toContain("test/boundaries.test.ts");
    expect(read("docs/superpowers/old.md")).toBe("test/syncThing.test.ts\n");
  });
});
