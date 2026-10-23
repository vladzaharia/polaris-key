/**
 * U-05.18: the one-object load script. Dry-run prints the plan and makes no network call; the
 * parsing and the summary are pure.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain ESM script with no type declarations.
import * as load from "../scripts/load/cloud-sync-one-do.mjs";

const ARGS = [
  "--base-url",
  "https://key.example",
  "--product",
  "acme",
  "--devices",
  "4",
  "--duration-s",
  "30",
];

describe("cloud-sync-one-do dry run", () => {
  it("prints the plan, makes no network call and never reads or prints a token", async () => {
    const lines: string[] = [];
    let calls = 0;
    const res = await load.main(
      [...ARGS, "--dry-run"],
      { PKEY_LOAD_DEVICES: '[{"deviceId":"d","token":"SECRET-TOKEN"}]' },
      {
        out: (l: string) => lines.push(l),
        fetch: () => {
          calls++;
          throw new Error("network");
        },
      },
    );
    expect(calls).toBe(0);
    expect(res.dryRun).toBe(true);
    // 60 a minute for 30 s is 30 pushes a device; a pull every 10 s is 3.
    expect(res.plan.totalPushes).toBe(120);
    expect(res.plan.totalPulls).toBe(12);
    expect(res.plan.totalMutations).toBe(12_000);
    const text = lines.join("\n");
    expect(text).toContain("dry run: no network call");
    expect(text).not.toContain("SECRET-TOKEN");
  });

  it("needs no devices env in dry-run and refuses bad options", async () => {
    await expect(
      load.main([...ARGS, "--dry-run"], {}, { out() {} }),
    ).resolves.toBeTruthy();
    expect(() => load.parseArgs(["--product", "x"])).toThrow(/base-url/);
    expect(() => load.parseArgs([...ARGS, "--batch", "101"])).toThrow(
      /at most 100/,
    );
    expect(() => load.parseArgs([...ARGS, "--bogus", "1"])).toThrow(
      /unknown option/,
    );
  });
});

describe("cloud-sync-one-do summary", () => {
  it("reads the meter header and nothing else", () => {
    expect(
      load.parseServerTiming(
        'sync;desc="push";dur=12.4, mut;desc="100", rr;desc="340", rw;desc="212"',
      ),
    ).toEqual({
      op: "push",
      durMs: 12.4,
      mutations: 100,
      rowsRead: 340,
      rowsWritten: 212,
    });
    expect(load.parseServerTiming("cfRequestDuration;dur=3")).toBeNull();
    expect(load.parseServerTiming(null)).toBeNull();
  });

  it("computes nearest-rank percentiles, rows per op and the 429 count", () => {
    const m = (rr: number, rw: number) => ({
      op: "push",
      durMs: 1,
      mutations: 100,
      rowsRead: rr,
      rowsWritten: rw,
    });
    const samples = [
      ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms) => ({
        op: "push",
        status: 200,
        ms,
        meter: m(100, 200),
      })),
      { op: "push", status: 429, ms: 5, meter: null },
      {
        op: "pull",
        status: 200,
        ms: 7,
        meter: {
          op: "pull",
          durMs: 1,
          mutations: 0,
          rowsRead: 9,
          rowsWritten: 0,
        },
      },
    ];
    const s = load.summarise(samples);
    expect(s.rateLimited).toBe(1);
    expect(s.ops.push.requests).toBe(11);
    expect(s.ops.push.rowsRead).toBe(1000);
    expect(s.ops.push.meanRowsWritten).toBe(200);
    expect(s.ops.push.p50Ms).toBe(50);
    expect(s.ops.push.p95Ms).toBe(100);
    expect(s.ops.pull.rowsRead).toBe(9);
    expect(load.percentile([], 50)).toBeNull();
  });

  it("reads billable duration from GraphQL without echoing the token", async () => {
    let auth = "";
    const r = await load.billableDuration(
      { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "SECRET-TOKEN" },
      "a",
      "b",
      async (_u: string, init: { headers: Record<string, string> }) => {
        auth = init.headers.authorization ?? "";
        return new Response(
          JSON.stringify({
            data: {
              viewer: {
                accounts: [
                  {
                    durableObjectsPeriodicGroups: [
                      { sum: { activeTime: 2_000_000 } },
                    ],
                  },
                ],
              },
            },
          }),
        );
      },
    );
    expect(auth).toBe("Bearer SECRET-TOKEN");
    expect(r.activeTimeMs).toBe(2000);
    expect(JSON.stringify(r)).not.toContain("SECRET-TOKEN");
    expect(
      (await load.billableDuration({}, "a", "b", async () => new Response("")))
        .skipped,
    ).toMatch(/not set/);
  });

  it("drives a device against a fake Worker and counts its 429s", async () => {
    let t = 0;
    const seen: string[] = [];
    let pushes = 0;
    const fetchFn = async (url: string, init: { method: string }) => {
      seen.push(`${init.method} ${url}`);
      const push = init.method === "POST";
      if (push) pushes++;
      const status = push && pushes % 2 === 0 ? 429 : 200;
      return new Response(JSON.stringify({ cursor: 1 }), {
        status,
        headers: {
          "server-timing":
            'sync;desc="' +
            (push ? "push" : "pull") +
            '";dur=1.0, mut;desc="2", rr;desc="3", rw;desc="4"',
        },
      });
    };
    const res = await load.main(
      [
        "--base-url",
        "https://k.example",
        "--product",
        "acme",
        "--devices",
        "1",
        "--duration-s",
        "5",
        "--batch",
        "2",
        "--pull-every-s",
        "2",
        "--analytics-delay-s",
        "1",
      ],
      { PKEY_LOAD_DEVICES: '[{"deviceId":"d1","token":"tok"}]' },
      {
        out() {},
        fetch: fetchFn,
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
      },
    );
    expect(res.summary.ops.push.requests).toBeGreaterThan(0);
    expect(res.summary.ops.pull.requests).toBeGreaterThan(0);
    expect(res.summary.rateLimited).toBeGreaterThan(0);
    expect(seen.every((s) => s.includes("https://k.example/acme/sync"))).toBe(
      true,
    );
  });
});
