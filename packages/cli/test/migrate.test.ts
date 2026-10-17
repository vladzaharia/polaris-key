import { describe, expect, it } from "vitest";
import { formatMigrate, runMigrate } from "../src/migrate.js";

const TOKEN = `pkeya_${"a".repeat(43)}`;
const run = {
  id: "mrun_1",
  job: "identity.seed-platform-connection",
  mode: "dry-run",
  status: "reported",
  changes: 2,
  remaining: 0,
  units: [
    {
      unit: "platform",
      status: "pending",
      planned: 2,
      changes: 0,
      error: null,
    },
  ],
};

function fake(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("pkey migrate", () => {
  it("dry-run posts the job with the bearer token and no cookie", async () => {
    const { calls, fetchImpl } = fake(200, { run });
    const r = await runMigrate({
      verb: "dry-run",
      target: run.job,
      token: TOKEN,
      baseUrl: "https://example.test/",
      fetchImpl,
    });
    expect(calls[0]!.url).toBe(
      "https://example.test/manage/api/platform/migrations/dry-run",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ job: run.job }));
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h.cookie).toBeUndefined();
    const text = formatMigrate(r, {});
    expect(text).toContain("mrun_1");
    expect(text).toContain("apply needs a step-up");
  });

  it("report and list are GETs", async () => {
    const a = fake(200, { run });
    await runMigrate({
      verb: "report",
      target: "mrun_1",
      token: TOKEN,
      fetchImpl: a.fetchImpl,
    });
    expect(a.calls[0]!.url).toBe(
      "https://key.plrs.im/manage/api/platform/migrations/runs/mrun_1",
    );
    expect(a.calls[0]!.init.method).toBe("GET");
    const b = fake(200, { jobs: [{ id: "j", summary: "s", runs: [] }] });
    const r = await runMigrate({
      verb: "list",
      token: TOKEN,
      fetchImpl: b.fetchImpl,
    });
    expect(formatMigrate(r, {})).toContain("never run");
  });

  it("needs a token, a target, and https", async () => {
    await expect(runMigrate({ verb: "list" })).rejects.toThrow(
      /PKEY_ADMIN_TOKEN/,
    );
    await expect(runMigrate({ verb: "dry-run", token: TOKEN })).rejects.toThrow(
      /job id/,
    );
    await expect(
      runMigrate({ verb: "list", token: TOKEN, baseUrl: "http://evil.test" }),
    ).rejects.toThrow(/https/);
  });

  it("a 403 says which scope is missing", async () => {
    const { fetchImpl } = fake(403, {
      code: "forbidden",
      message: "token is not scoped for this route",
    });
    await expect(
      runMigrate({ verb: "list", token: TOKEN, fetchImpl }),
    ).rejects.toThrow(/migrations:report/);
  });
});
