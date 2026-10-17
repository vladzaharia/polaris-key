// @vitest-environment node
//
// @pkey-feature core.backend
//
// `usePolarisFetch()`'s engine (WIRE-CONTRACT-V4 §14.5, framework drop-ins §6): the origin
// allowlist, the one retry, the typed refusals, and every `client` row of `backend-matrix.json`
// driven through `createPolarisFetch`; then the desktop adapter's bridge v4 verb.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPolarisFetch,
  normalizeBackendOrigin,
} from "../src/core/backend.js";
import { PolarisError } from "../src/core/types.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { Feature } from "../src/constants.generated.js";
import { emptyBridgeState, makeFakeBridge } from "./fixtures.js";

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
      response: { status: number; code: string | null } | null;
      retried: boolean;
    };
    expect: { action: string };
  }[];
};

const ORIGIN = "https://api.test";
const HEADERS = { "X-PKey-License": "a.b.c", "X-PKey-Device": "dev-1" };

function problem(status: number, code: string): Response {
  return new Response(JSON.stringify({ code, status }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

function rig(answers: Response[], opts: { refreshFails?: boolean } = {}) {
  const calls: { force: boolean | undefined }[] = [];
  const sent: { url: string; init: RequestInit }[] = [];
  const queue = [...answers];
  const adapter = {
    async backendHeaders(o?: { force?: boolean }) {
      calls.push({ force: o?.force });
      if (o?.force && opts.refreshFails)
        throw new PolarisError("refresh-failed");
      return HEADERS;
    },
  };
  const transport = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return next.clone();
  }) as unknown as typeof fetch;
  return {
    fetch: createPolarisFetch(adapter, { origins: [ORIGIN] }, () => transport),
    calls,
    sent,
  };
}

describe("backend-matrix client rows (the response phase), through usePolarisFetch's engine", () => {
  for (const row of matrix.client.filter(
    (r) => r.input.response && !r.input.retried,
  )) {
    it(row.id, async () => {
      const { status, code } = row.input.response!;
      const first =
        code === null ? new Response("", { status }) : problem(status, code);
      const ok = new Response("ok");
      const r = rig(
        row.expect.action === "refresh-and-retry" ? [first, ok] : [first],
      );
      const out = await r.fetch(`${ORIGIN}/export`).catch((e: unknown) => e);
      if (row.expect.action === "refresh-and-retry") {
        expect(r.calls.map((c) => c.force)).toEqual([false, true, true]);
        expect(r.sent).toHaveLength(2);
        expect((out as Response).status).toBe(200);
      } else {
        expect(r.calls.map((c) => c.force)).toEqual([false]);
        expect(r.sent).toHaveLength(1);
        if (
          status === 403 &&
          (code === "not_entitled" || code === "sign_in_required")
        ) {
          expect(out).toBeInstanceOf(PolarisError);
          expect(out).toMatchObject({ code, status: 403 });
        } else expect((out as Response).status).toBe(status);
      }
    });
  }

  it("surface-after-one-retry: a second license_stale is returned, not retried", async () => {
    const r = rig([problem(401, "license_stale")]);
    const res = await r.fetch(`${ORIGIN}/export`);
    expect(res.status).toBe(401);
    expect(r.sent).toHaveLength(2);
  });
});

describe("usePolarisFetch's engine", () => {
  it("attaches the two headers and leaves the developer's own untouched", async () => {
    const r = rig([new Response("ok")]);
    await r.fetch(`${ORIGIN}/export`, {
      headers: { authorization: "Bearer dev", "x-pkey-license": "forged" },
    });
    const h = new Headers(r.sent[0]!.init.headers);
    expect(h.get("authorization")).toBe("Bearer dev");
    expect(h.get("x-pkey-license")).toBe("a.b.c");
    expect(h.get("x-pkey-device")).toBe("dev-1");
    expect([...h.keys()].sort()).toEqual([
      "authorization",
      "x-pkey-device",
      "x-pkey-license",
    ]);
  });

  it("refuses any other origin before asking for headers or sending", async () => {
    const r = rig([new Response("ok")]);
    for (const url of [
      "https://evil.test/export",
      "http://api.test/export",
      "https://api.test:8443/export",
    ])
      await expect(r.fetch(url)).rejects.toMatchObject({
        code: "backend-origin-not-allowed",
      });
    expect(r.calls).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it("allows the page's own origin by default when it is HTTPS", async () => {
    const g = globalThis as { location?: unknown };
    g.location = {
      origin: "https://app.test",
      href: "https://app.test/page",
    };
    try {
      const r = rig([new Response("ok")]);
      const own = createPolarisFetch(
        { backendHeaders: async () => HEADERS },
        {},
        () =>
          (async (url: string) => {
            r.sent.push({ url, init: {} });
            return new Response("ok");
          }) as unknown as typeof fetch,
      );
      await own("/api/export");
      expect(r.sent[0]!.url).toBe("https://app.test/api/export");
      await expect(own("https://other.test/x")).rejects.toMatchObject({
        code: "backend-origin-not-allowed",
      });
      g.location = { origin: "http://app.lan", href: "http://app.lan/" };
      await expect(own("/api/export")).rejects.toMatchObject({
        code: "backend-origin-not-allowed",
      });
    } finally {
      delete g.location;
    }
  });

  it("a failed refresh hands back the backend's own response", async () => {
    const r = rig([problem(401, "license_invalid")], { refreshFails: true });
    const res = await r.fetch(`${ORIGIN}/export`);
    expect(res.status).toBe(401);
    expect(r.sent).toHaveLength(1);
  });

  it("does not follow a redirect unless asked", async () => {
    const r = rig([new Response("ok")]);
    await r.fetch(`${ORIGIN}/export`);
    await r.fetch(`${ORIGIN}/export`, { redirect: "follow" });
    expect(r.sent.map((s) => s.init.redirect)).toEqual(["error", "follow"]);
  });

  it("validates backend.origins", () => {
    expect(normalizeBackendOrigin("http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
    for (const bad of [
      "http://api.example.com",
      "https://api.example.com/v1",
      "https://*.example.com",
      "api.example.com",
    ])
      expect(() => normalizeBackendOrigin(bad)).toThrow(PolarisError);
    expect(() =>
      createPolarisFetch(
        { backendHeaders: async () => ({}) },
        { origins: ["nope"] },
      ),
    ).toThrow(/backend\.origins/);
  });
});

describe("desktop: bridge v4 backendHeaders", () => {
  it("asks the host, and a force first refreshes it", async () => {
    const calls: string[] = [];
    const bridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 4,
      async refresh() {
        calls.push("refresh");
        return emptyBridgeState();
      },
      async invoke(service: string, method: string) {
        calls.push(`${service}.${method}`);
        return HEADERS;
      },
    };
    const adapter = desktopAdapter({ bridge });
    expect(adapter.supports(Feature.coreBackend)).toMatchObject({
      supported: true,
    });
    expect(await adapter.backendHeaders()).toEqual(HEADERS);
    await adapter.backendHeaders({ force: true });
    expect(calls).toEqual([
      "core.backendHeaders",
      "refresh",
      "core.backendHeaders",
    ]);
  });

  it("a v3 host is the typed version N/A, without crossing the bridge", async () => {
    let crossed = false;
    const bridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 3,
      async invoke() {
        crossed = true;
        return HEADERS;
      },
    };
    const adapter = desktopAdapter({ bridge });
    expect(adapter.supports(Feature.coreBackend)).toMatchObject({
      supported: false,
      reason: "version",
    });
    await expect(adapter.backendHeaders()).rejects.toMatchObject({
      code: "unsupported",
      reason: "version",
    });
    expect(crossed).toBe(false);
  });
});
