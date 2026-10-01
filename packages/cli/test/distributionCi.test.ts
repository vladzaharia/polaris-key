/**
 * P2b-03 — `pkey distribution report|rollout|pause|resume|halt|complete` against a fake Worker:
 * the request each command sends (path, bearer, body), the local checks that refuse before any
 * request, and how the Worker's answers become exit codes. The end-to-end run against the real
 * Worker is `packages/worker/test/distributionReportE2e.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { normalizeFingerprint, runPkey } from "../src/index.js";

const BASE = "https://key.example.test";
const CI_TOKEN = `pkeyci_${"A".repeat(43)}`;
const FP = "ab".repeat(32);

interface Seen {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

function fakeWorker(answer: (seen: Seen) => [number, unknown]) {
  const seen: Seen[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const s: Seen = {
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    seen.push(s);
    const [status, body] = answer(s);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

function capture() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (c: string) => ((out += c), true) },
    stderr: { write: (c: string) => ((err += c), true) },
    out: () => out,
    err: () => err,
  };
}

async function run(
  argv: string[],
  worker: ReturnType<typeof fakeWorker>,
  env: Record<string, string | undefined> = { PKEY_CI_TOKEN: CI_TOKEN },
) {
  const io = capture();
  const code = await runPkey(argv, {
    ...io,
    env,
    fetchImpl: worker.fetchImpl,
    sleep: async () => {},
  });
  return { code, ...io };
}

const P = ["--product", "dice", "--base-url", BASE];

describe("pkey distribution report", () => {
  it("availability posts the report with the CI token", async () => {
    const w = fakeWorker(() => [
      200,
      {
        ok: true,
        type: "availability",
        availability: {
          releaseId: "v1.1.0",
          buildId: "ios",
          outletId: "app-store",
          state: "in-review",
        },
      },
    ]);
    const r = await run(
      [
        "distribution",
        "report",
        "availability",
        ...P,
        "--outlet",
        "app-store",
        "--release",
        "v1.1.0",
        "--build",
        "ios",
        "--state",
        "in-review",
        "--since",
        "1700000000",
        "--platform-ref",
        '{"ascBuildId":"abc"}',
      ],
      w,
    );
    expect(r.err()).toBe("");
    expect(r.code).toBe(0);
    expect(w.seen).toEqual([
      {
        url: `${BASE}/dice/distribution/report`,
        auth: `Bearer ${CI_TOKEN}`,
        body: {
          type: "availability",
          outlet: "app-store",
          releaseId: "v1.1.0",
          buildId: "ios",
          state: "in-review",
          since: 1700000000,
          platformRef: { ascBuildId: "abc" },
        },
      },
    ]);
    expect(r.out()).toContain(
      "Reported availability of v1.1.0/ios on app-store: in-review",
    );
  });

  it("submission names the release by version and deliverable", async () => {
    const w = fakeWorker(() => [
      200,
      {
        ok: true,
        type: "submission",
        submission: {
          releaseId: "pack-1",
          outletId: "play",
          state: "submitted",
        },
      },
    ]);
    const r = await run(
      [
        "distribution",
        "report",
        "submission",
        ...P,
        "--outlet",
        "play",
        "--version",
        "1.0.0",
        "--deliverable",
        "levels",
        "--state",
        "submitted",
      ],
      w,
    );
    expect(r.code).toBe(0);
    expect(w.seen[0]!.body).toEqual({
      type: "submission",
      outlet: "play",
      version: "1.0.0",
      deliverable: "levels",
      state: "submitted",
    });
  });

  it("key normalises a keytool fingerprint; a match exits 0", async () => {
    const w = fakeWorker((s) => [
      200,
      {
        ok: true,
        type: "key",
        key: { ...s.body, match: true, flagged: false },
      },
    ]);
    const colons = FP.toUpperCase().match(/../g)!.join(":");
    const r = await run(
      [
        "distribution",
        "report",
        "key",
        ...P,
        "--purpose",
        "android-app-signing",
        "--sha256",
        colons,
        "--outlet",
        "play",
      ],
      w,
    );
    expect(r.code).toBe(0);
    expect(w.seen[0]!.body).toEqual({
      type: "key",
      purpose: "android-app-signing",
      sha256: FP,
      outlet: "play",
    });
    expect(r.out()).toContain("is in the key inventory");
  });

  it("a key the inventory does not hold is flagged and exits 1", async () => {
    const w = fakeWorker((s) => [
      200,
      {
        ok: true,
        type: "key",
        key: { ...s.body, match: false, flagged: true },
      },
    ]);
    const r = await run(
      [
        "distribution",
        "report",
        "key",
        ...P,
        "--purpose",
        "release",
        "--sha256",
        FP,
      ],
      w,
    );
    expect(r.code).toBe(1);
    expect(r.err()).toContain("NOT in the product's key inventory");
  });

  it("refuses locally, before any request, what the Worker would refuse anyway", async () => {
    const w = fakeWorker(() => [500, {}]);
    const base = ["distribution", "report"];
    for (const argv of [
      [...base, "availability", ...P, "--outlet", "x", "--state", "live"],
      [
        ...base,
        "availability",
        ...P,
        "--outlet",
        "x",
        "--state",
        "live",
        "--release",
        "v1",
        "--version",
        "1",
      ],
      [
        ...base,
        "submission",
        ...P,
        "--outlet",
        "x",
        "--state",
        "submitted",
        "--release",
        "v1",
        "--build",
        "ios",
      ],
      [
        ...base,
        "availability",
        ...P,
        "--outlet",
        "x",
        "--state",
        "live",
        "--release",
        "v1",
        "--platform-ref",
        "[1]",
      ],
      [
        ...base,
        "availability",
        ...P,
        "--outlet",
        "x",
        "--state",
        "live",
        "--release",
        "v1",
        "--since",
        "yesterday",
      ],
      [...base, "key", ...P, "--purpose", "release", "--sha256", "abc"],
      [...base, "key", ...P, "--purpose", "release"],
      [...base, "rumour", ...P],
      [...base, "availability", "--outlet", "x"],
    ]) {
      const r = await run(argv, w);
      expect(r.code, argv.join(" ")).toBe(1);
    }
    expect(w.seen).toEqual([]);
  });

  it("renders a refusal with its reason", async () => {
    const w = fakeWorker(() => [
      404,
      {
        error: "not_found",
        message: "no outlet steam on dice",
        reason: "unknown_outlet",
      },
    ]);
    const r = await run(
      [
        "distribution",
        "report",
        "availability",
        ...P,
        "--outlet",
        "steam",
        "--release",
        "v1",
        "--state",
        "live",
      ],
      w,
    );
    expect(r.code).toBe(1);
    expect(r.err()).toContain("404 unknown_outlet");
    expect(r.err()).toContain("no outlet steam on dice");
  });

  it("normalizeFingerprint accepts colons, spaces and upper case only around 64 hex digits", () => {
    expect(normalizeFingerprint(` ${FP.toUpperCase()} `)).toBe(FP);
    expect(() => normalizeFingerprint(FP.slice(2))).toThrow(/64 hex/);
    expect(() => normalizeFingerprint(`${FP.slice(2)}zz`)).toThrow(/64 hex/);
  });
});

describe("pkey distribution rollout|pause|resume|halt|complete", () => {
  const rollout = (state: string, bp = 2500) => ({
    ok: true,
    rollout: {
      deliverableId: "app",
      releaseId: "v1.1.0",
      outletId: "direct",
      channel: "stable",
      state,
      rolloutBp: bp,
    },
  });

  it("rollout posts {releaseId, bp} to the outlet's channel", async () => {
    const w = fakeWorker(() => [200, rollout("active")]);
    const r = await run(
      [
        "distribution",
        "rollout",
        ...P,
        "--outlet",
        "direct",
        "--channel",
        "stable",
        "--release",
        "v1.1.0",
        "--bp",
        "2500",
      ],
      w,
    );
    expect(r.code).toBe(0);
    expect(w.seen).toEqual([
      {
        url: `${BASE}/dice/distribution/rollouts/direct/stable`,
        auth: `Bearer ${CI_TOKEN}`,
        body: { releaseId: "v1.1.0", bp: 2500 },
      },
    ]);
    expect(r.out()).toContain("app v1.1.0 on direct/stable: active at 25%");
  });

  it("each verb posts to its own route, with the optional release pin", async () => {
    for (const verb of ["pause", "resume", "halt", "complete"]) {
      const w = fakeWorker(() => [200, rollout("halted")]);
      const r = await run(
        [
          "distribution",
          verb,
          ...P,
          "--outlet",
          "play",
          "--channel",
          "beta",
          "--release",
          "v1.1.0",
          "--deliverable",
          "app",
        ],
        w,
      );
      expect(r.code, verb).toBe(0);
      expect(w.seen[0]!.url).toBe(
        `${BASE}/dice/distribution/rollouts/play/beta/${verb}`,
      );
      expect(w.seen[0]!.body).toEqual({
        releaseId: "v1.1.0",
        deliverable: "app",
      });
      if (verb === "halt") expect(r.err()).toContain("legacy feeds");
    }
  });

  it("refuses a bad percentage or a missing channel before any request", async () => {
    const w = fakeWorker(() => [500, {}]);
    for (const argv of [
      ["--outlet", "d", "--channel", "s", "--release", "v1", "--bp", "25%"],
      ["--outlet", "d", "--channel", "s", "--release", "v1", "--bp", "10001"],
      ["--outlet", "d", "--channel", "s", "--bp", "100"],
      ["--outlet", "d", "--release", "v1", "--bp", "100"],
    ]) {
      const r = await run(["distribution", "rollout", ...P, ...argv], w);
      expect(r.code, argv.join(" ")).toBe(1);
    }
    expect(w.seen).toEqual([]);
  });

  it("a token without distribution:rollout is refused with the scope hint", async () => {
    const w = fakeWorker(() => [
      403,
      {
        error: "forbidden",
        message: "this token lacks the distribution:rollout scope",
        reason: "missing_scope",
        scope: "distribution:rollout",
      },
    ]);
    const r = await run(
      [
        "distribution",
        "halt",
        ...P,
        "--outlet",
        "direct",
        "--channel",
        "stable",
      ],
      w,
    );
    expect(r.code).toBe(1);
    expect(r.err()).toContain("403 missing_scope");
    expect(r.err()).toContain("an operator grants scopes");
  });

  it("needs a CI credential", async () => {
    const w = fakeWorker(() => [200, rollout("halted")]);
    const r = await run(
      ["distribution", "halt", ...P, "--outlet", "d", "--channel", "s"],
      w,
      {},
    );
    expect(r.code).toBe(1);
    expect(r.err()).toContain("No CI credential");
    expect(w.seen).toEqual([]);
  });
});
