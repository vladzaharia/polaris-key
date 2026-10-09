// @pkey-feature core.store
// @pkey-feature core.errors
// Node hardening: the §5 redirect rule, atomic 0600/0700 state, reads (no symlinks, keyring
// before file, a validated device id), a token never prints, an origin-only baseUrl and the
// slug shape, and the bridge's default sender.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { PolarisError } from "@polaris-key/client-core";
import { CoreContext, normalizeBaseUrl } from "../src/core/context.js";
import { withRedirectPolicy } from "../src/core/redirect.js";
import { FileStore, InMemoryStore, KeyringStore } from "../src/core/store.js";
import { redactOnPrint } from "../src/core/redact.js";
import {
  exposePolarisBridge,
  type IpcMainInvokeEventLike,
} from "../src/electron/main.js";

type Seen = { url: string; init: RequestInit };

function chain(steps: Array<{ status: number; location?: string }>) {
  const seen: Seen[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const step = steps[Math.min(seen.length - 1, steps.length - 1)]!;
    return new Response(step.status === 200 ? "{}" : null, {
      status: step.status,
      headers: step.location ? { location: step.location } : {},
    });
  }) as unknown as typeof fetch;
  return { seen, f: withRedirectPolicy(impl) };
}

const H = {
  authorization: "Bearer pkeyt_x",
  "X-PKey-Device": "dev",
  accept: "application/json",
};

describe("the §5 redirect rule", () => {
  it("asks the transport not to follow, and keeps the headers on a same-origin hop", async () => {
    const c = chain([{ status: 302, location: "/other" }, { status: 200 }]);
    const res = await c.f("https://k.test/p/a", { headers: H });
    expect(res.status).toBe(200);
    expect(c.seen[0]!.init.redirect).toBe("manual");
    expect(c.seen[1]!.url).toBe("https://k.test/other");
    expect(c.seen[1]!.init.headers).toEqual(H);
  });

  it("drops Authorization and X-PKey-* on a cross-origin hop and keeps the rest", async () => {
    const c = chain([
      { status: 302, location: "https://cdn.test/x" },
      { status: 200 },
    ]);
    await c.f("https://k.test/p/a", { headers: H });
    expect(c.seen[1]!.init.headers).toEqual({ accept: "application/json" });
  });

  it("never brings the credentials back after a cross-origin hop", async () => {
    const c = chain([
      { status: 302, location: "https://cdn.test/x" },
      { status: 302, location: "https://k.test/back" },
      { status: 200 },
    ]);
    await c.f("https://k.test/p/a", { headers: H });
    expect(c.seen[2]!.init.headers).toEqual({ accept: "application/json" });
  });

  it("refuses a 307 or 308 POST to another origin, and never replays the body there", async () => {
    for (const status of [307, 308]) {
      const c = chain([{ status, location: "https://evil.test/x" }]);
      await expect(
        c.f("https://k.test/p/a", { method: "POST", headers: H, body: "{}" }),
      ).rejects.toMatchObject({ code: "insecure-redirect" });
      expect(c.seen).toHaveLength(1);
    }
  });

  it("follows a same-origin 307 POST with its body, and a 303 as a bodiless GET", async () => {
    const same = chain([{ status: 307, location: "/n" }, { status: 200 }]);
    await same.f("https://k.test/p/a", { method: "POST", body: "{}" });
    expect(same.seen[1]!.init).toMatchObject({ method: "POST", body: "{}" });
    const see = chain([
      { status: 303, location: "https://cdn.test/n" },
      { status: 200 },
    ]);
    await see.f("https://k.test/p/a", {
      method: "POST",
      headers: { ...H, "content-type": "application/json" },
      body: "{}",
    });
    expect(see.seen[1]!.init.method).toBe("GET");
    expect(see.seen[1]!.init.body).toBeNull();
    expect(see.seen[1]!.init.headers).toEqual({ accept: "application/json" });
  });

  it("refuses https to http and a non-http target", async () => {
    for (const location of ["http://k.test/x", "file:///etc/passwd"]) {
      const c = chain([{ status: 302, location }]);
      await expect(c.f("https://k.test/p")).rejects.toMatchObject({
        code: "insecure-redirect",
      });
    }
  });

  it("allows 5 hops and refuses the 6th with too-many-redirects", async () => {
    const five = chain([
      ...Array.from({ length: 5 }, (_, i) => ({
        status: 302,
        location: `/h${i}`,
      })),
      { status: 200 },
    ]);
    expect((await five.f("https://k.test/p")).status).toBe(200);
    const six = chain([{ status: 302, location: "/loop" }]);
    await expect(six.f("https://k.test/p")).rejects.toMatchObject({
      code: "too-many-redirects",
    });
    expect(six.seen).toHaveLength(6);
  });

  it("a 3xx without Location is an answer, not a redirect", async () => {
    const c = chain([{ status: 304 }]);
    expect((await c.f("https://k.test/p")).status).toBe(304);
  });

  it("CoreContext.fetcher() applies it to every product-scoped call", async () => {
    const seen: Seen[] = [];
    const ctx = new CoreContext({
      productSlug: "djdl",
      baseUrl: "https://k.test",
      version: "1.0.0",
      trust: { pinnedKeys: {} },
      store: new InMemoryStore("djdl"),
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return seen.length === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "https://evil.test/steal" },
            })
          : new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await ctx.init();
    await ctx.request(
      ctx.url("license/activate"),
      { headers: ctx.headers({ authorization: "Bearer t" }) },
      "x",
    );
    expect(seen[1]!.url).toBe("https://evil.test/steal");
    expect(JSON.stringify(seen[1]!.init.headers).toLowerCase()).not.toMatch(
      /authorization|x-pkey/,
    );
  });
});

describe("baseUrl and slug", () => {
  it("normalizeBaseUrl keeps only the origin", () => {
    expect(normalizeBaseUrl("https://key.plrs.im/x/y?z=1#f")).toBe(
      "https://key.plrs.im",
    );
    expect(normalizeBaseUrl("https://u:p@key.plrs.im///")).toBe(
      "https://key.plrs.im",
    );
    expect(normalizeBaseUrl("http://localhost:8787/")).toBe(
      "http://localhost:8787",
    );
  });

  it("refuses a slug that is not a product slug (URL and path injection)", () => {
    for (const productSlug of ["../x", "a/b", "A", "a?b", "", "a b", "-a"]) {
      expect(
        () =>
          new CoreContext({
            productSlug,
            baseUrl: "https://k.test",
            version: "1.0.0",
            trust: { pinnedKeys: {} },
            store: new InMemoryStore("x"),
          }),
      ).toThrow(PolarisError);
      expect(() => new FileStore(productSlug, tmpdir())).toThrow(PolarisError);
    }
  });
});

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), "pkey-a2-")));
const mode = (p: string): number => statSync(p).mode & 0o777;

describe("state directory and files", () => {
  it("chmods an existing wide directory and its files on init", () => {
    const root = tmp();
    const dir = join(root, "djdl");
    mkdirSync(dir, { mode: 0o755 });
    for (const f of ["token", "device", "managed.json"])
      writeFileSync(join(dir, f), "x", { mode: 0o644 });
    chmodSync(dir, 0o755);
    new FileStore("djdl", root);
    expect(mode(dir)).toBe(0o700);
    for (const f of ["token", "device", "managed.json"])
      expect(mode(join(dir, f))).toBe(0o600);
  });

  it("writes atomically: no temp files remain, and the file is 0600", async () => {
    const root = tmp();
    const s = new FileStore("djdl", root);
    await s.setToken("pkeyt_a");
    await s.setToken("pkeyt_b");
    await s.writeCache({ v: 3 } as never);
    expect(readdirSync(join(root, "djdl")).sort()).toEqual([
      "managed.json",
      "token",
    ]);
    expect(mode(join(root, "djdl", "token"))).toBe(0o600);
    expect(await s.getToken()).toBe("pkeyt_b");
  });

  it("replaces a planted symlink at the target instead of writing through it", async () => {
    const root = tmp();
    const s = new FileStore("djdl", root);
    const victim = join(root, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, join(root, "djdl", "token"));
    await s.setToken("pkeyt_a");
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(await s.getToken()).toBe("pkeyt_a");
  });

  it("refuses a state directory that is a symlink", () => {
    const root = tmp();
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, "djdl"));
    expect(() => new FileStore("djdl", root)).toThrow();
  });
});

describe("reads: no symlinks, keyring first, a validated device id", () => {
  it("does not read a token through a symlink", async () => {
    const root = tmp();
    const s = new FileStore("djdl", root);
    const target = join(root, "other");
    writeFileSync(target, "pkeyt_secret_elsewhere");
    symlinkSync(target, join(root, "djdl", "token"));
    expect(await s.getToken()).toBeNull();
  });

  it("an invalid stored device id is replaced, not sent", async () => {
    const root = tmp();
    const s = new FileStore("djdl", root, { readAnchor: () => "anchor" });
    writeFileSync(join(root, "djdl", "device"), "bad id\r\nX-Evil: 1");
    const id = await s.getDeviceId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await s.getDeviceId()).toBe(id);
  });

  it("the keyring's token beats a file planted beside it", async () => {
    const root = tmp();
    await new FileStore("djdl", root).setToken("pkeyt_planted");
    const entry = {
      async getPassword() {
        return "pkeyt_real";
      },
      async setPassword() {},
      async deleteCredential() {
        return true;
      },
    };
    const store = new KeyringStore("djdl", root, {
      loadKeyring: async () =>
        ({
          AsyncEntry: class {
            constructor() {
              return entry as never;
            }
          },
        }) as never,
      platform: "darwin",
    });
    expect(await store.getToken()).toBe("pkeyt_real");
  });
});

describe("a token never prints", () => {
  it("console.log, util.inspect and JSON.stringify show no token", () => {
    const r = redactOnPrint(
      { kind: "ok", token: "pkeyt_live", schemaVersion: 1 },
      ["token"],
    );
    for (const out of [inspect(r), JSON.stringify(r), JSON.stringify([r])])
      expect(out).not.toContain("pkeyt_live");
    expect(r.token).toBe("pkeyt_live");
  });
});

describe("the bridge's default sender", () => {
  function bridge(opts: { appOrigin?: string | string[] } = {}) {
    const handlers = new Map<string, (e: IpcMainInvokeEventLike) => unknown>();
    exposePolarisBridge(
      {
        events: { on() {}, off() {} },
        getSyncState: () => ({}),
      } as never,
      {
        ipcMain: {
          handle: (c, l) => handlers.set(c, l as never),
          removeHandler() {},
        },
        ...opts,
      },
    );
    const ch = [...handlers.keys()].find((c) => c.endsWith("unsubscribe"))!;
    return async (frame: IpcMainInvokeEventLike["senderFrame"]) =>
      (await handlers.get(ch)!({
        sender: { id: 1 } as never,
        senderFrame: frame,
      })) as { ok: boolean; error?: { code?: string } };
  }

  it("answers the app's own top frame and refuses subframes, remote pages and no frame", async () => {
    const call = bridge();
    expect((await call({ url: "app://main/index.html" })).ok).toBe(true);
    expect((await call({ url: "file:///app/index.html" })).ok).toBe(true);
    expect((await call({ url: "http://localhost:5173/" })).ok).toBe(true);
    for (const frame of [
      { url: "app://main/", parent: {} },
      { url: "https://evil.test/" },
      null,
      undefined,
    ])
      expect((await call(frame)).ok).toBe(false);
  });

  it("appOrigin pins the origin", async () => {
    const call = bridge({ appOrigin: "https://app.example.com" });
    expect((await call({ url: "https://app.example.com/x" })).ok).toBe(true);
    expect((await call({ url: "https://evil.test/x" })).ok).toBe(false);
    expect((await call({ url: "app://main/" })).ok).toBe(false);
  });
});
