// examples/server-* and examples/node-express install @polaris-key/server from the feed, so CI does
// not build them. This boots each app against a test kit and sends it the §5.2 verdicts, so a rename
// or a changed signature fails here instead of in a sample (plan §11: a real minimal app per
// framework). vitest.config.ts resolves the examples' imports to this package.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestKit, type TestKit } from "../src/testing.js";

const examples = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "examples",
);
const SUBJECT = "ps_" + "B".repeat(22);

// Real time: server-next's lib/polaris.ts reads the system clock.
let kit: TestKit;
beforeAll(async () => {
  kit = await createTestKit({
    product: "djdl",
    now: Math.floor(Date.now() / 1000),
  });
});

// server-next builds its core at import with the app's own config; give it the kit's pins and keep
// its trust refresh off the network.
const { kitConfig } = vi.hoisted(() => ({
  kitConfig: { current: null as unknown },
}));
vi.mock("../../../examples/server-next/polaris.config.ts", () => ({
  get default() {
    return kitConfig.current;
  },
}));

type Send = (
  method: string,
  path: string,
  headers?: Record<string, string>,
) => Promise<Response>;

function probes(name: string, send: () => Promise<Send>, prefix = "") {
  describe(name, () => {
    it("serves the open route and refuses the gated ones", async () => {
      const s = await send();
      expect((await s("GET", `${prefix}/health`)).status).toBe(200);
      expect((await s("GET", `${prefix}/api/export`)).status).toBe(401);
      expect((await s("POST", `${prefix}/api/saves`)).status).toBe(401);
      const refused = await s("GET", `${prefix}/whoami`);
      expect(refused.headers.get("www-authenticate")).toBe(
        'PKey-License realm="djdl", error="license_required"',
      );
    });

    it("lets a licensed, signed-in device through", async () => {
      const s = await send();
      const jws = await kit.sign({
        tier: "pro",
        entitlements: { "export.pdf": true },
        user: { subject: SUBJECT },
      });
      const h = kit.headers(jws);
      expect(await (await s("GET", `${prefix}/api/export`, h)).json()).toEqual({
        tier: "pro",
      });
      expect(await (await s("POST", `${prefix}/api/saves`, h)).json()).toEqual({
        owner: SUBJECT,
      });
      expect(
        await (await s("GET", `${prefix}/whoami`, h)).json(),
      ).toMatchObject({
        licenseId: "lic_test",
        tier: "pro",
        signedIn: true,
      });
      const keyOnly = kit.headers(
        await kit.sign({ entitlements: { "export.pdf": true } }),
      );
      expect((await s("POST", `${prefix}/api/saves`, keyOnly)).status).toBe(
        403,
      );
    });
  });
}

const options = () => ({ now: kit.clock.now, trustRefresh: false });

probes("examples/server-express", async () => {
  const { createApp } = await import(
    join(examples, "server-express", "app.ts")
  );
  const server = createApp(kit.config, options()).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (method, path, headers) => fetch(base + path, { method, headers });
});

probes("examples/server-hono", async () => {
  const { createApp } = await import(join(examples, "server-hono", "app.ts"));
  const app = createApp(kit.config, options());
  return async (method, path, headers) =>
    app.request(path, { method, headers });
});

describe("examples/server-next", () => {
  it("gates its route handlers", async () => {
    kitConfig.current = kit.config;
    // Its trust refresh must not reach Polaris Key.
    vi.stubGlobal("fetch", () =>
      Promise.reject(new Error("no network in tests")),
    );
    const route = (name: string) =>
      import(join(examples, "server-next", "app", "api", name, "route.ts"));
    const call = (
      h: (r: Request, c: unknown) => Promise<Response> | Response,
      method: string,
      headers?: Record<string, string>,
    ) => h(new Request("http://localhost/x", { method, headers }), {});
    const jws = await kit.sign({
      tier: "pro",
      entitlements: { "export.pdf": true },
      user: { subject: SUBJECT },
    });
    const h = kit.headers(jws);
    expect((await call((await route("health")).GET, "GET")).status).toBe(200);
    const exp = (await route("export")).GET;
    expect((await call(exp, "GET")).status).toBe(401);
    expect(await (await call(exp, "GET", h)).json()).toEqual({ tier: "pro" });
    const saves = (await route("saves")).POST;
    expect(await (await call(saves, "POST", h)).json()).toEqual({
      owner: SUBJECT,
    });
    const keyOnly = kit.headers(await kit.sign({}));
    expect((await call(saves, "POST", keyOnly)).status).toBe(403);
    const who = (await route("whoami")).GET;
    expect(await (await call(who, "GET", h)).json()).toMatchObject({
      licenseId: "lic_test",
      signedIn: true,
    });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});
