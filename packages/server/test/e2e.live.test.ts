// SP-65, the Node lane: a real Node client -> an example backend -> a live `pkey dev`.
//
// `client.backend.fetch()` sends the licence the client holds to examples/server-express,
// examples/server-hono and examples/server-next (route handlers), each built on the dev server's
// own pins and trust manifest. Nothing is mocked on the wire: the Worker's router signs the
// document, the backend verifies it offline, the client reads the answer.
//
// Per framework: activate, a valid gated call, a call the licence is not entitled to
// (`not_entitled`, typed), no credential (`license_required` and its challenge), a stale document
// that the client refreshes and then succeeds, a re-sync that fails (`pkey dev offline`), and the
// client's own gate state after each.
//
// "Stale" here is the backend's clock running past the document (`now` is the example's option);
// the document is old to it until the device syncs, which is what the test's transport notices to
// put the backend's clock back. The kit's own cases (the verdict matrix) live in matrix.test.ts.
//
// Environment (CI job `e2e-backend`, or by hand from the repository root):
//
//   eval "$(node packages/cli/scripts/start-dev-ci.mjs start --lang node)"
//   pnpm --filter @polaris-key/server exec vitest run test/e2e.live.test.ts
//   node packages/cli/scripts/start-dev-ci.mjs stop --lang node
//
// With PKEY_DEV_BASE_URL unset the suite skips; the CI job fails when it is unset (it runs this
// file by name and `start-dev-ci check` has already verified the variable).
//
// Named slots for the clients SP-59 adds (Swift, Kotlin, Godot) and the React client: they join
// by reusing `scenario()` against their own runner; see docs in the e2e job of ci.yml.
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  InMemoryStore,
  PolarisError,
  PolarisKeyClient,
} from "@polaris-key/node";

const BASE = process.env.PKEY_DEV_BASE_URL?.replace(/\/$/, "");
const examples = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "examples",
);

interface DevInfo {
  product: string;
  keys: Record<string, string>;
  trust: { pinnedKeys: Record<string, string> };
  services: string[];
}

// server-next builds its core at import from its own config module; hand it the dev server's.
const { nextConfig } = vi.hoisted(() => ({
  nextConfig: { current: null as unknown },
}));
vi.mock("../../../examples/server-next/polaris.config.ts", () => ({
  get default() {
    return nextConfig.current;
  },
}));

/** The backend's clock: `skew` seconds ahead until the device syncs with the Worker. */
const clock = { skew: 0 };
const backendNow = () => Math.floor(Date.now() / 1000) + clock.skew;
/** Past any document's `expiresAt` plus the server's 300 s allowance. */
const AHEAD = 30 * 24 * 3600;

type Handle = (req: Request) => Promise<Response> | Response;

/** A Fetch handler on a loopback socket, so the client's `fetch` crosses a real connection. */
async function listen(handle: Handle): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(",") : v);
      const url = `http://${req.headers.host}${req.url}`;
      const out = await handle(
        new Request(url, { method: req.method, headers }),
      );
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

const originOf = (s: Server) =>
  `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

async function dev(path: string, body: unknown = {}): Promise<void> {
  const res = await fetch(`${BASE}/__dev/${path}`, {
    method: "POST",
    headers: { "x-pkey-dev": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, `pkey dev ${path}`).toBe(200);
}

interface Backend {
  name: string;
  origin: string;
}

const backends: Backend[] = [];
const servers: Server[] = [];
const clients: PolarisKeyClient[] = [];
let info: DevInfo;
let tmp: string;
let deviceCount = 0;

/** A device of its own that activates the `ok` key, with a transport that notices a sync. */
async function activatedClient(origins: string[]): Promise<PolarisKeyClient> {
  const dir = await mkdtemp(join(tmp, "client-"));
  const client = await PolarisKeyClient.create({
    productSlug: info.product,
    baseUrl: BASE!,
    trust: { pinnedKeys: info.trust.pinnedKeys },
    expectedServices: ["license"],
    version: "1.0.0",
    deviceName: `e2e-${++deviceCount}`,
    store: new InMemoryStore(),
    configDir: join(dir, "config"),
    dataDir: join(dir, "data"),
    cacheDir: join(dir, "cache"),
    stateDir: join(dir, "state"),
    backend: { origins },
    fetchImpl: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const res = await fetch(input, init);
      // The device reached the Worker for a document: it is current again.
      if (url.startsWith(BASE!) && /\/license\//.test(url) && res.ok)
        clock.skew = 0;
      return res;
    },
  });
  clients.push(client);
  const result = await client.license.activateWithKey(info.keys.ok!);
  expect(result, JSON.stringify(result)).toMatchObject({ kind: "ok" });
  return client;
}

const text = async (res: Response) => (await res.json()) as Record<string, any>;

/** The least time between two forced syncs of one client (`FORCED_SYNC_MIN_INTERVAL_MS`). */
const FORCED_SYNC_GAP_MS = 10_500;

function scenario(b: () => Backend, clocked: boolean) {
  // The `ok` key has three key entries and a deactivation does not return one: a client per
  // framework, shared by its cases, which run in order.
  let client: PolarisKeyClient;
  beforeAll(async () => {
    client = await activatedClient([b().origin]);
  });
  const gate = () => client.license.status().status;

  it("a valid gated call, the client's gate state ok", async () => {
    const res = await client.backend.fetch(`${b().origin}/whoami`);
    expect(res.status).toBe(200);
    expect(await text(res)).toMatchObject({ signedIn: false });
    expect(gate()).toBe("ok");
  });

  it("no credential: license_required with its challenge", async () => {
    const res = await fetch(`${b().origin}/whoami`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(
      /^PKey-License realm="[^"]+", error="license_required"$/,
    );
    expect((await text(res)).code).toBe("license_required");
  });

  it("not_entitled is typed, with the response status", async () => {
    const err = await client.backend
      .fetch(`${b().origin}/api/export`)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolarisError);
    expect(err).toMatchObject({ code: "not_entitled", status: 403 });
    // The licence itself is fine: the gate does not move.
    expect(gate()).toBe("ok");
  });

  it.runIf(clocked)(
    "a failed re-sync hands back the backend's license_stale",
    async () => {
      clock.skew = AHEAD;
      await dev("offline");
      try {
        const res = await client.backend.fetch(`${b().origin}/whoami`);
        expect([res.status, (await text(res)).code]).toEqual([
          401,
          "license_stale",
        ]);
        expect(clock.skew).toBe(AHEAD); // the Worker was never reached
      } finally {
        await dev("online");
        clock.skew = 0;
      }
      // A backend that could not be satisfied does not move the client's own gate.
      expect(gate()).toBe("ok");
    },
  );

  it.runIf(clocked)(
    "a stale document refreshes, then the call succeeds",
    async () => {
      await new Promise((r) => setTimeout(r, FORCED_SYNC_GAP_MS));
      clock.skew = AHEAD;
      // Sent as it is, the backend refuses: the document is old to it.
      const raw = await fetch(`${b().origin}/whoami`, {
        headers: await client.backend.headers(),
      });
      expect([raw.status, (await text(raw)).code]).toEqual([
        401,
        "license_stale",
      ]);
      // Through the client: one forced sync, one retry.
      const res = await client.backend.fetch(`${b().origin}/whoami`);
      expect(res.status).toBe(200);
      expect(clock.skew).toBe(0);
      expect(gate()).toBe("ok");
    },
    30_000,
  );
}

// CI sets PKEY_E2E_REQUIRED: a leg whose variables were lost must fail, not skip.
it.runIf(!BASE && process.env.PKEY_E2E_REQUIRED)(
  "has a live pkey dev (PKEY_DEV_BASE_URL)",
  () => {
    expect(BASE).toBeTruthy();
  },
);

describe.runIf(BASE)("client -> example backend -> pkey dev (Node)", () => {
  beforeAll(async () => {
    tmp = await mkdtemp(join(os.tmpdir(), "pkey-e2e-"));
    info = (await (await fetch(`${BASE}/__dev/info`)).json()) as DevInfo;
    const config = {
      productSlug: info.product,
      baseUrl: BASE!,
      trust: { pinnedKeys: info.trust.pinnedKeys },
      expectedServices: ["license"],
    };
    const options = { now: backendNow, trustRefresh: false };

    const express = await import(join(examples, "server-express", "app.ts"));
    const exp = express.createApp(config, options).listen(0, "127.0.0.1");
    await new Promise((r) => exp.once("listening", r));
    servers.push(exp);
    backends.push({ name: "express", origin: originOf(exp) });

    const hono = await import(join(examples, "server-hono", "app.ts"));
    const honoApp = hono.createApp(config, options);
    const hs = await listen((r) => honoApp.fetch(r));
    servers.push(hs);
    backends.push({ name: "hono", origin: originOf(hs) });

    // Next's route handlers read the system clock (createNextPolarisKey is built at import with the
    // app's config only), so the stale cases do not apply: a slot until the example takes options.
    nextConfig.current = config;
    const routes: Record<string, [string, string]> = {
      "/api/health": ["health", "GET"],
      "/api/export": ["export", "GET"],
      "/api/saves": ["saves", "POST"],
      "/whoami": ["whoami", "GET"],
    };
    const ns = await listen(async (req) => {
      const path = new URL(req.url).pathname;
      const hit = routes[path];
      if (!hit || hit[1] !== req.method)
        return new Response("", { status: 404 });
      const mod = await import(
        join(examples, "server-next", "app", "api", hit[0], "route.ts")
      );
      return mod[hit[1]](req, {});
    });
    servers.push(ns);
    backends.push({ name: "next", origin: originOf(ns) });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(
      servers.map((s) => new Promise((r) => s.close(() => r(null)))),
    );
    await rm(tmp, { recursive: true, force: true });
  });

  describe("express", () => scenario(() => backends[0]!, true));
  describe("hono", () => scenario(() => backends[1]!, true));
  describe("next (route handlers)", () => scenario(() => backends[2]!, false));
});
