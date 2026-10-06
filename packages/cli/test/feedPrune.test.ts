/**
 * `pkey feeds prune` (feed retention) against a fake Worker: the request it sends (dry run by
 * default, `apply` only with `--apply`), the report it prints (skipped and failed versions
 * included), the exit code of an apply with failures, and a refusal. The real Worker route is
 * exercised by `packages/worker/test/feedPruneRoutes.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { runPkey } from "../src/index.js";
import {
  formatBytes,
  renderPruneReport,
  type PruneReport,
} from "../src/feedPrune.js";

const BASE = "https://key.example.test";
const CI_TOKEN = `pkeyci_${"A".repeat(43)}`;

function report(dryRun: boolean): PruneReport {
  return {
    ok: true,
    product: "polaris-key",
    dryRun,
    prunePrereleases: true,
    packages: [
      {
        deliverableId: "npm.node",
        ecosystem: "npm",
        name: "@polaris-key/node",
        stable: "0.9.1",
        prune: [
          {
            releaseId: "npm.node@0.9.1-main.3",
            version: "0.9.1-main.3",
            files: 1,
            bytes: 2_500_000,
            freedBytes: 2_500_000,
          },
        ],
        kept: [{ releaseId: "x", version: "0.9.1-main.4", reason: "pinned" }],
        bytes: 2_500_000,
        freedBytes: 2_500_000,
      },
    ],
    skipped: [{ deliverableId: "godot.sdk", reason: "no-stable" }],
    totals: {
      versions: 1,
      bytes: 2_500_000,
      freedBytes: 2_500_000,
      failed: 0,
      skipped: 0,
    },
  };
}

/** An applied report where one version became held (skipped) and one failed. */
function partial(): PruneReport {
  const r = report(false);
  return {
    ...r,
    packages: [
      {
        ...r.packages[0]!,
        skipped: [
          {
            releaseId: "npm.node@0.9.1-main.5",
            version: "0.9.1-main.5",
            reason: "pinned",
          },
        ],
        failed: [{ version: "0.9.1-main.6", error: "D1 hiccup" }],
      },
    ],
    totals: { ...r.totals, failed: 1, skipped: 1 },
  };
}

function fake(answer: (body: Record<string, unknown>) => [number, unknown]) {
  const seen: {
    url: string;
    auth: string | null;
    body: Record<string, unknown>;
  }[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    seen.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body,
    });
    const [status, out] = answer(body);
    return new Response(JSON.stringify(out), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

async function run(argv: string[], w: ReturnType<typeof fake>) {
  let out = "";
  let err = "";
  const code = await runPkey(argv, {
    stdout: { write: (c: string) => ((out += c), true) },
    stderr: { write: (c: string) => ((err += c), true) },
    env: { PKEY_CI_TOKEN: CI_TOKEN },
    fetchImpl: w.fetchImpl,
    sleep: async () => {},
  });
  return { code, out, err };
}

describe("pkey feeds prune", () => {
  it("dry-runs by default and prints counts and bytes per package", async () => {
    const w = fake(() => [200, report(true)]);
    const r = await run(
      ["feeds", "prune", "--product", "polaris-key", "--base-url", BASE],
      w,
    );
    expect(r.code, r.err).toBe(0);
    expect(w.seen).toEqual([
      {
        url: `${BASE}/polaris-key/release/packages/prune`,
        auth: `Bearer ${CI_TOKEN}`,
        body: { apply: false },
      },
    ]);
    expect(r.out).toContain("Dry run: nothing was deleted.");
    expect(r.out).toContain(
      "npm @polaris-key/node: newest stable 0.9.1; would prune 1 build of main, 2.5 MB (2.5 MB freed)",
    );
    expect(r.out).toContain("  - 0.9.1-main.3  1 file, 2.5 MB (2.5 MB freed)");
    expect(r.out).toContain("  = 0.9.1-main.4  kept (pinned)");
    expect(r.out).toContain("godot.sdk: skipped (no stable release yet)");
    expect(r.out).toContain("Run again with --apply to delete them.");
  });

  it("--apply asks the Worker to delete, for one deliverable with --deliverable", async () => {
    const w = fake(() => [200, report(false)]);
    const r = await run(
      [
        "feeds",
        "prune",
        "--product",
        "polaris-key",
        "--deliverable",
        "npm.node",
        "--apply",
        "--base-url",
        BASE,
      ],
      w,
    );
    expect(r.code, r.err).toBe(0);
    expect(w.seen[0]!.body).toEqual({ apply: true, deliverable: "npm.node" });
    expect(r.out).toContain("Applied.");
    expect(r.out).not.toContain("--apply to delete");
  });

  it("--apply repeats while the Worker reports more, and folds the rounds into one report", async () => {
    let n = 0;
    const w = fake(() => {
      n++;
      return [200, { ...report(false), more: n === 1 }];
    });
    const r = await run(
      [
        "feeds",
        "prune",
        "--product",
        "polaris-key",
        "--apply",
        "--base-url",
        BASE,
      ],
      w,
    );
    expect(r.code, r.err).toBe(0);
    expect(w.seen).toHaveLength(2);
    expect(r.out).toContain("Total: pruned 2 versions");
  });

  it("a dry run asks once even when more would be left", async () => {
    const w = fake(() => [200, { ...report(true), more: true }]);
    await run(
      ["feeds", "prune", "--product", "polaris-key", "--base-url", BASE],
      w,
    );
    expect(w.seen).toHaveLength(1);
  });

  it("--json prints the Worker's report", async () => {
    const w = fake(() => [200, report(true)]);
    const r = await run(
      [
        "feeds",
        "prune",
        "--product",
        "polaris-key",
        "--json",
        "--base-url",
        BASE,
      ],
      w,
    );
    expect(JSON.parse(r.out)).toMatchObject({
      dryRun: true,
      totals: { versions: 1 },
    });
  });

  it("a refusal (the token lacks release:yank) fails the command", async () => {
    const w = fake(() => [
      403,
      {
        error: "forbidden",
        reason: "scope_missing",
        message: "needs release:yank",
      },
    ]);
    const r = await run(
      ["feeds", "prune", "--product", "polaris-key", "--base-url", BASE],
      w,
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("403");
  });

  it("--apply lists skipped and failed versions, and exits non-zero when any failed", async () => {
    const w = fake(() => [200, partial()]);
    const r = await run(
      [
        "feeds",
        "prune",
        "--product",
        "polaris-key",
        "--apply",
        "--base-url",
        BASE,
      ],
      w,
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "  ~ 0.9.1-main.5  skipped (pinned since the plan; kept)",
    );
    expect(r.out).toContain("  ! 0.9.1-main.6  failed: D1 hiccup");
    expect(r.out).toContain("1 skipped: held since the plan, kept.");
    expect(r.out).toContain("1 failed: run it again.");
  });

  it("--apply with skipped versions but no failure exits 0; --json carries skipped", async () => {
    const ok = partial();
    ok.packages[0]!.failed = [];
    ok.totals.failed = 0;
    const w = fake(() => [200, ok]);
    const r = await run(
      [
        "feeds",
        "prune",
        "--product",
        "polaris-key",
        "--apply",
        "--json",
        "--base-url",
        BASE,
      ],
      w,
    );
    expect(r.code, r.err).toBe(0);
    const out = JSON.parse(r.out) as PruneReport;
    expect(out.packages[0]!.skipped).toEqual([
      {
        releaseId: "npm.node@0.9.1-main.5",
        version: "0.9.1-main.5",
        reason: "pinned",
      },
    ]);
    expect(out.totals.skipped).toBe(1);
  });

  it("folds skipped versions across --apply rounds", async () => {
    let n = 0;
    const w = fake(() => {
      n++;
      const r = partial();
      r.packages[0]!.failed = [];
      return [200, { ...r, totals: { ...r.totals, failed: 0 }, more: n === 1 }];
    });
    const r = await run(
      [
        "feeds",
        "prune",
        "--product",
        "polaris-key",
        "--apply",
        "--json",
        "--base-url",
        BASE,
      ],
      w,
    );
    expect(r.code, r.err).toBe(0);
    expect((JSON.parse(r.out) as PruneReport).totals.skipped).toBe(2);
  });

  it("formats bytes in decimal units", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1500)).toBe("1.5 kB");
    expect(formatBytes(3_200_000_000)).toBe("3.2 GB");
    expect(
      renderPruneReport({
        ...report(true),
        packages: [],
        skipped: [],
        totals: {
          versions: 0,
          bytes: 0,
          freedBytes: 0,
          failed: 0,
          skipped: 0,
        },
      }),
    ).not.toContain("--apply");
  });
});
