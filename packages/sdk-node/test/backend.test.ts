// @pkey-feature core.backend
// `client.backend` (WIRE-CONTRACT-V4 §14.5, framework drop-ins §6): the headers, the origin
// allowlist, the freshness pre-sync and the one retry, driven row by row from
// `backend-matrix.json`'s `client` section and then through a real client.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolarisError } from "@polaris-key/client-core";
import {
  BackendClient,
  normalizeBackendOrigin,
  type BackendDeps,
} from "../src/backend/client.js";
import type { SyncResult } from "../src/core/sync.js";
import {
  DEVICE,
  json,
  seededClient,
  signedLicense,
  type Handler,
} from "./parityFixtures.js";

const matrix = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "backend-matrix.json",
    ),
    "utf8",
  ),
) as {
  client: {
    id: string;
    input: {
      document: { issuedAt: number; expiresAt: number } | null;
      now: number;
      response: { status: number; code: string | null } | null;
      retried: boolean;
    };
    expect: { action: string };
  }[];
};

const ORIGIN = "https://api.test";
const APPLIED: SyncResult = {
  applied: true,
  documents: { license: { kind: "applied" } },
};
const FAILED: SyncResult = {
  applied: false,
  documents: { license: { kind: "error", code: "network-error" } },
};

function problem(status: number, code: string): Response {
  return new Response(JSON.stringify({ code, status }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

/** A BackendClient over scripted answers; records every sync and request. */
function rig(
  opts: {
    document?: { issuedAt: number; expiresAt: number } | null;
    now?: number;
    answers?: (Response | (() => Response))[];
    sync?: SyncResult;
    origins?: string[];
  } = {},
) {
  const syncs: boolean[] = [];
  const sent: { url: string; init: RequestInit }[] = [];
  const answers = [...(opts.answers ?? [])];
  const doc = opts.document === undefined ? null : opts.document;
  const deps: BackendDeps = {
    held: () => (doc ? { jws: "a.b.c", ...doc } : null),
    deviceId: () => DEVICE,
    now: () => opts.now ?? 1_700_001_000,
    sync: async ({ force }) => {
      syncs.push(force);
      await Promise.resolve();
      return opts.sync ?? APPLIED;
    },
    fetcher: () =>
      (async (url: string, init: RequestInit) => {
        sent.push({ url, init });
        const next = answers.length > 1 ? answers.shift()! : answers[0]!;
        return typeof next === "function" ? next() : next.clone();
      }) as unknown as typeof fetch,
  };
  return {
    backend: new BackendClient(deps, { origins: opts.origins ?? [ORIGIN] }),
    syncs,
    sent,
  };
}

describe("backend-matrix client rows, through client.backend.fetch", () => {
  // A row with `retried: true` is a request's second answer; the last test below replays it
  // from the start.
  for (const row of matrix.client.filter(
    (r) => !(r.input.retried && r.input.response),
  )) {
    it(row.id, async () => {
      const { input } = row;
      const ok = new Response("ok", { status: 200 });
      const answers: Response[] = input.response
        ? [
            input.response.code
              ? problem(input.response.status, input.response.code)
              : new Response("", { status: input.response.status }),
          ]
        : [ok];
      const surfaced =
        input.response?.status === 403 &&
        (input.response.code === "not_entitled" ||
          input.response.code === "sign_in_required");
      const r = rig({
        document: input.document,
        now: input.now,
        answers:
          row.expect.action === "refresh-and-retry"
            ? [...answers, ok]
            : answers,
      });
      let result: Response | PolarisError | null = null;
      try {
        result = await r.backend.fetch(`${ORIGIN}/export`);
      } catch (e) {
        result = e as PolarisError;
      }
      switch (row.expect.action) {
        case "send":
          expect(r.syncs).toEqual([]);
          expect(r.sent).toHaveLength(1);
          break;
        case "refresh-then-send":
          expect(r.syncs).toEqual([false]);
          expect(r.sent).toHaveLength(1);
          break;
        case "refresh-and-retry":
          expect(r.syncs).toEqual([true]);
          expect(r.sent).toHaveLength(2);
          expect((result as Response).status).toBe(200);
          break;
        case "surface":
          expect(r.syncs).toEqual([]);
          expect(r.sent).toHaveLength(1);
          if (surfaced) {
            expect(result).toBeInstanceOf(PolarisError);
            expect((result as PolarisError).code).toBe(input.response!.code);
          } else {
            expect(result).toBeInstanceOf(Response);
          }
          break;
      }
    });
  }

  it("a retried request stops after its one retry (surface-after-one-retry)", async () => {
    const r = rig({
      document: { issuedAt: 1_700_000_000, expiresAt: 1_700_003_600 },
      answers: [problem(401, "license_stale")],
    });
    const res = await r.backend.fetch(`${ORIGIN}/export`);
    expect(res.status).toBe(401);
    expect(r.syncs).toEqual([true]);
    expect(r.sent).toHaveLength(2);
  });
});

describe("headers", () => {
  it("sends X-PKey-License and X-PKey-Device, never the token or the config document", async () => {
    const r = rig({
      document: { issuedAt: 1_700_000_000, expiresAt: 1_700_003_600 },
      answers: [new Response("ok")],
    });
    expect(await r.backend.headers()).toEqual({
      "X-PKey-License": "a.b.c",
      "X-PKey-Device": DEVICE,
    });
    await r.backend.fetch(`${ORIGIN}/export`, {
      headers: { authorization: "Bearer dev-token" },
    });
    const sent = new Headers(r.sent[0]!.init.headers);
    expect([...sent.keys()].sort()).toEqual([
      "authorization",
      "x-pkey-device",
      "x-pkey-license",
    ]);
    expect(sent.get("authorization")).toBe("Bearer dev-token");
  });

  it("without a licence only the device id goes", async () => {
    const r = rig({ answers: [new Response("ok")] });
    expect(await r.backend.headers()).toEqual({ "X-PKey-Device": DEVICE });
  });

  it("concurrent callers share one sync", async () => {
    const r = rig({
      document: { issuedAt: 1_700_000_000, expiresAt: 1_700_003_600 },
      now: 1_700_003_000,
      answers: [new Response("ok")],
    });
    await Promise.all([
      r.backend.headers(),
      r.backend.headers(),
      r.backend.fetch(`${ORIGIN}/a`),
    ]);
    expect(r.syncs).toEqual([false]);
  });
});

describe("origins", () => {
  it("refuses an origin outside backend.origins before sending anything", async () => {
    const r = rig({ answers: [new Response("ok")] });
    for (const url of [
      "https://evil.test/export",
      "http://api.test/export",
      "https://api.test:8443/export",
      "https://sub.api.test/export",
    ]) {
      await expect(r.backend.fetch(url)).rejects.toMatchObject({
        code: "backend-origin-not-allowed",
      });
    }
    expect(r.sent).toEqual([]);
  });

  it("refuses a redirect to another origin, so the licence never rides it", async () => {
    const r = rig({
      answers: [
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/steal" },
        }),
      ],
    });
    await expect(r.backend.fetch(`${ORIGIN}/export`)).rejects.toMatchObject({
      code: "backend-origin-not-allowed",
    });
    expect(r.sent).toHaveLength(1);
  });

  it("follows a redirect inside the allowlist, with the headers", async () => {
    const r = rig({
      document: { issuedAt: 1_700_000_000, expiresAt: 1_700_003_600 },
      answers: [
        new Response(null, {
          status: 307,
          headers: { location: "/v2/export" },
        }),
        new Response("done"),
      ],
    });
    const res = await r.backend.fetch(`${ORIGIN}/export`, {
      method: "POST",
      body: "x",
    });
    expect(await res.text()).toBe("done");
    expect(r.sent.map((s) => s.url)).toEqual([
      `${ORIGIN}/export`,
      `${ORIGIN}/v2/export`,
    ]);
    expect(new Headers(r.sent[1]!.init.headers).get("x-pkey-license")).toBe(
      "a.b.c",
    );
  });

  it("validates backend.origins", () => {
    expect(normalizeBackendOrigin("https://api.example.com")).toBe(
      "https://api.example.com",
    );
    expect(normalizeBackendOrigin("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(normalizeBackendOrigin("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );
    for (const bad of [
      "http://api.example.com",
      "https://api.example.com/v1",
      "https://*.example.com",
      "https://user:pw@api.example.com",
      "api.example.com",
      "https://api.example.com?x=1",
    ])
      expect(() => normalizeBackendOrigin(bad)).toThrow(PolarisError);
  });

  it("an empty list allows nothing", async () => {
    const r = rig({ origins: [], answers: [new Response("ok")] });
    await expect(r.backend.fetch(`${ORIGIN}/x`)).rejects.toMatchObject({
      code: "backend-origin-not-allowed",
    });
  });
});

describe("refusals", () => {
  const held = { issuedAt: 1_700_000_000, expiresAt: 1_700_003_600 };

  it("not_entitled and sign_in_required throw typed, with the copy, and never retry", async () => {
    for (const code of ["not_entitled", "sign_in_required"]) {
      const r = rig({ document: held, answers: [problem(403, code)] });
      const e = (await r.backend
        .fetch(`${ORIGIN}/export`)
        .catch((x: unknown) => x)) as PolarisError;
      expect(e).toBeInstanceOf(PolarisError);
      expect(e.code).toBe(code);
      expect(e.status).toBe(403);
      expect(e.message.length).toBeGreaterThan(0);
      expect(r.syncs).toEqual([]);
      expect(r.sent).toHaveLength(1);
    }
  });

  it("a failed sync returns the backend's own response", async () => {
    const r = rig({
      document: held,
      answers: [problem(401, "license_invalid")],
      sync: FAILED,
    });
    const res = await r.backend.fetch(`${ORIGIN}/export`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      "license_invalid",
    );
    expect(r.sent).toHaveLength(1);
  });
});

describe("through a real client", () => {
  it("sends the cached licence document and the device id", async () => {
    const license = await signedLicense({ pro: true });
    const routes: Record<string, Handler> = {
      "GET /export": (req) => json({ jws: req.headers.get("x-pkey-license") }),
    };
    const { client, seen } = await seededClient({
      license,
      routes,
      extra: { backend: { origins: [ORIGIN] } },
    });
    const res = await client.backend.fetch(`${ORIGIN}/export`);
    expect(((await res.json()) as { jws: string }).jws).toBe(license);
    const request = seen.find((s) => s.path === "/export")!;
    expect(request.headers.get("x-pkey-device")).toBe(DEVICE);
    expect(request.headers.get("authorization")).toBeNull();
    expect(Object.fromEntries(request.headers)).not.toHaveProperty(
      "x-pkey-token",
    );
  });

  it("throws invalid-options from the constructor for a bad origin", async () => {
    await expect(
      seededClient({ extra: { backend: { origins: ["http://api.test"] } } }),
    ).rejects.toMatchObject({ code: "invalid-options" });
  });

  it("an expiring document is synced before it is sent", async () => {
    const { signedLicense: _unused } = await import("./parityFixtures.js");
    void _unused;
    const old = Math.floor(Date.now() / 1000) - 3500; // expires in 100 s: inside the margin
    const license = await signedLicense({ pro: true }, old);
    const fresh = await signedLicense({ pro: true });
    const routes: Record<string, Handler> = {
      "GET /djdl/license/document": () => new Response(fresh, { status: 200 }),
      "GET /export": (req) => json({ jws: req.headers.get("x-pkey-license") }),
    };
    const { client } = await seededClient({
      license,
      routes,
      extra: { backend: { origins: [ORIGIN] } },
    });
    const res = await client.backend.fetch(`${ORIGIN}/export`);
    expect(((await res.json()) as { jws: string }).jws).toBe(fresh);
  });
});
