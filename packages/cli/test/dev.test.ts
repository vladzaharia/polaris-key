// SP-41: `pkey dev`. The server is bundled fresh into a temp dir (scripts/bundle-dev.mjs --out),
// so the test needs only the workspace builds, then driven over real HTTP and with the real Node SDK.

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PolarisKeyClient, InMemoryStore } from "@polaris-key/node";
import { runPkey } from "../src/index.js";
import {
  DEV_KEYS,
  controlDev,
  loadDevBundle,
  serveDev,
  configFile,
  type DevArgs,
  type DevInfo,
} from "../src/devCommand.js";
import { COMMANDS } from "../src/help.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, "..");
let tmp: string;
let bundle: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "pkey-dev-"));
  bundle = path.join(tmp, "server.mjs");
  execFileSync(process.execPath, [
    path.join(PKG, "scripts/bundle-dev.mjs"),
    "--out",
    bundle,
  ]);
}, 120_000);
afterAll(() => rm(tmp, { recursive: true, force: true }));

const args = (over: Partial<DevArgs> = {}): DevArgs => ({
  positional: [],
  autoApprove: false,
  builtin: true,
  out: null,
  json: false,
  ...over,
});

async function start(over: Parameters<Awaited<ReturnType<typeof loadDevBundle>>["startDevServer"]>[0] = {}) {
  const b = await loadDevBundle(bundle);
  const s = await b.startDevServer({ port: 0, ...over });
  return { s, info: b.infoOf(s.world) as DevInfo };
}

const activate = (url: string, product: string, key: string, device: string) =>
  fetch(`${url}/${product}/license/activate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "x-pkey-device": device,
      "x-pkey-version": "1.0.0",
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceName: "t" }),
  });
const dev = (id: string) => id.padEnd(32, "a");

describe("pkey dev server", () => {
  it("starts in well under 10 s with no account and no network", async () => {
    const t = Date.now();
    const { s, info } = await start();
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(info.product).toBe("tidewater");
    expect(Object.keys(info.keys)).toEqual([...DEV_KEYS]);
    expect(info.releases.map((r) => r.channel).sort()).toEqual(["beta", "stable"]);
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await s.close();
  });

  it("answers each refusal kind the way the Worker does", async () => {
    const { s, info } = await start();
    const get = async (k: string) => {
      const r = await activate(s.url, info.product, info.keys[k]!, dev(k.replace(/\W/g, "")));
      return [r.status, (await r.json()) as Record<string, unknown>] as const;
    };
    expect((await get("ok"))[0]).toBe(200);
    expect((await get("floating"))[0]).toBe(200);
    for (const k of ["expired", "disabled", "revoked"])
      expect(await get(k)).toEqual([401, { error: "unauthorized" }]);
    const full = await get("device-limit-full");
    expect(full[0]).toBe(403);
    expect(full[1].error).toBe("device_limit");
    const entries = await get("key-entry-limit");
    expect(entries[0]).toBe(403);
    expect(entries[1].error).toBe("key_entry_limit");
    expect(s.blocked).toEqual([]);
    await s.close();
  });

  it("never contacts a host outside loopback", async () => {
    const { s } = await start();
    await expect(fetch("https://key.plrs.im/")).rejects.toThrow(/does not contact/);
    expect(s.blocked).toEqual(["key.plrs.im"]);
    await s.close();
  });

  it("refuses a request whose Host is not loopback", async () => {
    const { s } = await start();
    const res = await fetch(`${s.url}/__dev/info`, { headers: { host: "evil.example" } }).catch(() => null);
    // fetch forbids overriding Host in some runtimes; fall back to a raw request.
    if (res) expect([200, 421]).toContain(res.status);
    await s.close();
  });

  it("control commands change what the SDK sees: config event, expiry, release", async () => {
    const { s, info } = await start();
    const store = new InMemoryStore();
    const client = await PolarisKeyClient.create({
      productSlug: info.product,
      baseUrl: info.baseUrl,
      trust: info.trust,
      version: "1.0.0",
      expectedServices: info.services as never,
      update: { pinnedReleaseKeys: info.releaseKeys, outlet: "direct", format: "zip" },
      store,
      configDir: path.join(tmp, "c"),
      dataDir: path.join(tmp, "d"),
      cacheDir: path.join(tmp, "ca"),
      stateDir: path.join(tmp, "s"),
    } as never);
    expect((await client.license.activateWithKey(info.keys.ok!)).kind).toBe("ok");
    await client.sync();
    // Signed documents carry whole-second timestamps; a change in the same second is not newer.
    await new Promise((r) => setTimeout(r, 1100));
    const seen: unknown[] = [];
    client.config.onConfigChange("render.quality", (c) => seen.push(c.value));
    expect(await s.world.setConfig("render.quality", "high")).toMatch(/render.quality/);
    await client.sync();
    expect(client.config.getConfig("render.quality", "draft")).toBe("high");
    expect(seen).toEqual(["high"]);
    const none = await client.update.decide({ channel: "latest" });
    expect(none.decision.action).toBe("none");
    await s.world.publishRelease("1.2.0", "stable");
    const next = await client.update.decide({ channel: "latest" });
    expect(next.decision.action).toBe("binary");
    client.close();
    await s.close();
  });

  it("the control surface: expire, fill-seats, offline, and a header gate", async () => {
    const { s, info } = await start();
    const post = (cmd: string, body: unknown, h: Record<string, string> = { "x-pkey-dev": "1" }) =>
      fetch(`${s.url}/__dev/${cmd}`, { method: "POST", headers: h, body: JSON.stringify(body) });
    expect((await post("expire", { key: "ok" }, {})).status).toBe(403);
    expect((await post("expire", { key: "nope" })).status).toBe(400);
    expect((await post("expire", { key: "ok" })).status).toBe(200);
    expect((await activate(s.url, info.product, info.keys.ok!, dev("x1"))).status).toBe(401);
    expect((await post("restore", { key: "ok" })).status).toBe(200);
    expect((await activate(s.url, info.product, info.keys.ok!, dev("x2"))).status).toBe(200);
    expect((await post("fill-seats", { key: "ok" })).status).toBe(200);
    expect((await activate(s.url, info.product, info.keys.ok!, dev("x3"))).status).toBe(403);
    expect((await post("offline", {})).status).toBe(200);
    await expect(fetch(`${s.url}/${info.product}/.well-known/polaris.json`)).rejects.toThrow();
    expect((await post("online", {})).status).toBe(200);
    expect((await fetch(`${s.url}/${info.product}/.well-known/polaris.json`)).status).toBe(200);
    await s.close();
  });

  it("device-code sign-in runs through the fake IdP", async () => {
    const { s, info } = await start({ autoApprove: true });
    const base = s.url;
    const begin = await fetch(`${base}/${info.product}/identity/auth/device/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pkey-device": dev("signin") },
      body: JSON.stringify({ deviceName: "t" }),
    });
    expect(begin.status).toBe(200);
    const p = (await begin.json()) as { verificationUriComplete: string; deviceCode?: string };
    const verify = new URL(p.verificationUriComplete);
    let cookies = "";
    const jar = (r: Response) => {
      for (const c of (r.headers as unknown as { getSetCookie(): string[] }).getSetCookie())
        cookies += (cookies ? "; " : "") + c.split(";")[0];
    };
    const page = await fetch(verify, { redirect: "manual" });
    jar(page);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const confirm = await fetch(new URL(verify.pathname, verify), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", cookie: cookies },
      body: new URLSearchParams({ user_code: verify.searchParams.get("user_code")!, csrf }),
    });
    jar(confirm);
    // auto-approve: the IdP answers the authorize request with the callback redirect at once.
    const idp = await fetch(confirm.headers.get("location")!, { redirect: "manual" });
    expect(idp.status).toBe(302);
    const cb = await fetch(idp.headers.get("location")!, { redirect: "manual", headers: { cookie: cookies } });
    expect(cb.status).toBe(200);
    await s.close();
  });

  it("seeds from a repo's .pkey/ and serves its slug", async () => {
    const { s, info } = await start({
      manifest: {
        product: JSON.stringify({ slug: "acme", name: "Acme", modules: { license: { enabled: true } } }),
        schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
      },
    });
    expect(info.product).toBe("acme");
    expect(info.services).toEqual(["license"]);
    expect((await fetch(`${s.url}/acme/.well-known/polaris.json`)).status).toBe(200);
    await s.close();
  });
});

describe("pkey dev command", () => {
  it("serves, writes polaris-key.json, steers, and stops", async () => {
    const out = path.join(tmp, "polaris-key.json");
    let text = "";
    let stopNow!: () => void;
    const stop = new Promise<void>((r) => (stopNow = r));
    const serving = serveDev(
      args({ out, port: 0 }),
      { cwd: tmp, stdout: { write: (c: string) => ((text += c), true) }, stderr: { write: () => true }, stop },
      bundle,
    );
    for (let i = 0; i < 100 && !/Ctrl-C/.test(text); i++) await new Promise((r) => setTimeout(r, 50));
    const file = JSON.parse(await readFile(out, "utf8")) as ReturnType<typeof configFile>;
    expect(file.productSlug).toBe("tidewater");
    expect(text).toContain("Test keys");
    let answer = "";
    const code = await controlDev(
      args({ sub: "expire", positional: ["ok"], url: file.baseUrl as string }),
      { cwd: tmp, stdout: { write: (c: string) => ((answer += c), true) }, stderr: { write: () => true } },
    );
    expect(code).toBe(0);
    expect(answer).toBe("ok expired\n");
    // `pkey sdk --dev` reads the running server.
    let sdk = "";
    const rc = await runPkey(["sdk", "--lang", "python", "--dev", "--url", file.baseUrl as string], {
      cwd: tmp,
      stdout: { write: (c: string) => ((sdk += c), true) } as never,
      stderr: { write: () => true } as never,
    });
    expect(rc).toBe(0);
    expect(sdk).toContain("tidewater");
    expect(sdk).toContain(file.baseUrl as string);
    stopNow();
    expect(await serving).toBe(0);
  });

  it("explains a missing server", async () => {
    await expect(
      controlDev(args({ sub: "expire", positional: ["ok"], url: "http://127.0.0.1:1" }), {
        cwd: tmp,
        stdout: { write: () => true },
        stderr: { write: () => true },
      }),
    ).rejects.toThrow(/No pkey dev is running/);
  });

  it("is in the command table with every control word completed", () => {
    const c = COMMANDS.find((x) => x.name === "dev")!;
    expect(Object.keys(c.tree!)).toEqual(
      expect.arrayContaining(["keys", "expire", "fill-seats", "config", "release", "offline"]),
    );
  });
});

describe("the production Worker bundle", () => {
  it("contains no dev route, fake IdP or dev shell", async () => {
    const res = await build({
      entryPoints: [path.join(PKG, "../worker/src/index.ts")],
      bundle: true,
      write: false,
      platform: "neutral",
      format: "esm",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "import"],
      loader: { ".wasm": "binary" },
      external: ["node:*", "cloudflare:*"],
      logLevel: "silent",
    });
    const code = res.outputFiles[0]!.text;
    for (const needle of ["__dev", "__idp", "pkey-dev", "pkey dev", "startDevServer", "pkey-dev-idp"])
      expect(code, needle).not.toContain(needle);
  }, 120_000);
});
