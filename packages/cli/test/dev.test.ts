// SP-41: `pkey dev`. The server is bundled fresh into a temp dir (scripts/bundle-dev.mjs --out),
// so the test needs only the workspace builds, then driven over real HTTP and with the real Node SDK,
// which is configured by the module `pkey sdk --lang node --dev --write` generates.

import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  PolarisKeyClient,
  InMemoryStore,
  type ActivationResult,
  type PolarisKeyClientOptions,
} from "@polaris-key/node";
import { runPkey } from "../src/index.js";
import {
  DEV_KEYS,
  controlDev,
  loadDevBundle,
  serveDev,
  configFile,
  type DevArgs,
  type DevInfo,
  type DevServerHandle,
  type DevServerStartOptions,
} from "../src/devCommand.js";
import { COMMANDS } from "../src/help.js";
// @ts-expect-error plain .mjs script, no types
import { readApprovalForm } from "../scripts/dev-approve.mjs";

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

// Whatever a test starts is closed after it, so a failed assertion cannot leave a server (and the
// process-wide fetch guard it holds) running under the next test.
const servers: StartedDevServer[] = [];
const clients: PolarisKeyClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(servers.splice(0).map(({ s }) => s.close()));
});

const args = (over: Partial<DevArgs> = {}): DevArgs => ({
  positional: [],
  autoApprove: false,
  builtin: true,
  out: null,
  json: false,
  ...over,
});

interface StartedDevServer {
  s: DevServerHandle;
  info: DevInfo;
}

type TestFetchInput = string | URL | Request;

/** A fresh server and world: no test sees another's seats, config or releases. */
async function start(
  over: DevServerStartOptions = {},
): Promise<StartedDevServer> {
  const b = await loadDevBundle(bundle);
  const s = await b.startDevServer({ port: 0, ...over });
  const running = { s, info: b.infoOf(s.world) };
  servers.push(running);
  return running;
}

function verificationUri(body: unknown): string {
  if (
    !body ||
    typeof body !== "object" ||
    !("verificationUriComplete" in body) ||
    typeof body.verificationUriComplete !== "string"
  )
    throw new Error("device-code start did not return verificationUriComplete");
  return body.verificationUriComplete;
}

function setCookies(response: Response): string[] {
  const headers: unknown = response.headers;
  if (
    headers &&
    typeof headers === "object" &&
    "getSetCookie" in headers &&
    typeof headers.getSetCookie === "function"
  ) {
    const cookies = headers.getSetCookie();
    if (
      Array.isArray(cookies) &&
      cookies.every((cookie) => typeof cookie === "string")
    )
      return cookies;
  }
  throw new Error("response headers do not expose Set-Cookie");
}

/**
 * The person's half of a device-code sign-in, played by the harness: open the verification page,
 * confirm the code, and let the fake IdP approve it. Answers the callback the IdP redirects to.
 */
async function approveDeviceCode(
  verificationUriComplete: string,
): Promise<Response> {
  const verify = new URL(verificationUriComplete);
  let cookies = "";
  const jar = (r: Response) => {
    for (const c of setCookies(r))
      cookies += (cookies ? "; " : "") + c.split(";")[0];
  };
  const page = await fetch(verify, { redirect: "manual" });
  expect(page.status).toBe(200);
  jar(page);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const confirm = await fetch(new URL(verify.pathname, verify), {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
      cookie: cookies,
    },
    body: new URLSearchParams({
      user_code: verify.searchParams.get("user_code")!,
      csrf,
    }),
  });
  jar(confirm);
  const authorize = confirm.headers.get("location");
  expect(authorize, "the confirmation redirects to the IdP").toBeTruthy();
  // Auto-approve: the IdP answers the authorize request with the callback redirect at once.
  const idp = await fetch(authorize!, { redirect: "manual" });
  expect(idp.status).toBe(302);
  const callback = await fetch(idp.headers.get("location")!, {
    redirect: "manual",
    headers: { cookie: cookies },
  });
  if (callback.status !== 303) return callback;
  // I-37: the callback hands over to the explicit approval page; the person presses Sign in.
  jar(callback);
  const toApprove = new URL(callback.headers.get("location")!, verify);
  const approvalPage = await fetch(toApprove, {
    redirect: "manual",
    headers: { cookie: cookies },
  });
  expect(approvalPage.status).toBe(200);
  jar(approvalPage);
  const form = readApprovalForm(await approvalPage.text());
  expect(form, "the approval page has a Sign in form").toBeTruthy();
  return fetch(new URL(form!.action || toApprove.pathname, toApprove), {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
      cookie: cookies,
    },
    body: new URLSearchParams([...form!.fields, ["decision", "approve"]]),
  });
}

async function completeDeviceCodeSignIn(
  { s, info }: StartedDevServer,
  device: string,
): Promise<Response> {
  const base = s.url;
  const begin = await fetch(
    `${base}/${info.product}/identity/auth/device/start`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pkey-device": dev(device),
      },
      body: JSON.stringify({ deviceName: "t" }),
    },
  );
  expect(begin.status).toBe(200);
  return approveDeviceCode(verificationUri(await begin.json()));
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

/** `POST /__dev/<command>`: the control surface `pkey dev <command>` steers a running server by. */
const post = (
  url: string,
  cmd: string,
  body: unknown,
  headers: Record<string, string> = { "x-pkey-dev": "1" },
) =>
  fetch(`${url}/__dev/${cmd}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

/**
 * One HTTP request with a Host of the caller's choosing. `fetch` will not send one, which is why a
 * test of the Host check has to come here.
 */
async function rawRequest(
  base: string,
  host: string,
  init: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  const req = http.request({
    hostname,
    port,
    method: init.method ?? "GET",
    path: init.path ?? "/__dev/info",
    headers: { host, ...init.headers },
  });
  const response = once(req, "response");
  req.end(init.body);
  const res: http.IncomingMessage = (await response)[0];
  res.setEncoding("utf8");
  let body = "";
  for await (const chunk of res) body += chunk;
  return { status: res.statusCode ?? 0, body };
}

/** What `pkey sdk --lang node` writes: everything `PolarisKeyClient.create()` takes but `version`. */
type NodeQuickstart = Omit<PolarisKeyClientOptions, "version">;

/**
 * The Node quickstart, as a developer runs it: `pkey sdk --lang node --dev --url <server> --write`
 * in a project directory, then the module it wrote. It must name this server, not production.
 */
async function nodeQuickstart({
  s,
  info,
}: StartedDevServer): Promise<NodeQuickstart> {
  const cwd = await mkdtemp(path.join(tmp, "quickstart-"));
  let stdout = "";
  let stderr = "";
  const rc = await runPkey(
    ["sdk", "--lang", "node", "--dev", "--url", s.url, "--write"],
    {
      cwd,
      stdout: { write: (c: string) => ((stdout += c), true) },
      stderr: { write: (c: string) => ((stderr += c), true) },
    },
  );
  expect([rc, stderr]).toEqual([0, ""]);
  const file = path.join(cwd, "polaris.config.ts");
  expect(stdout).toContain(`Wrote ${file}`);
  // A static import cannot name it: the command above wrote the module, at run time.
  const written: { polarisConfig: NodeQuickstart } = await import(
    pathToFileURL(file).href
  );
  const { polarisConfig } = written;
  expect(polarisConfig.productSlug).toBe(info.product);
  expect(polarisConfig.baseUrl).toBe(s.url);
  expect(polarisConfig.trust.pinnedKeys).toEqual(info.trust.pinnedKeys);
  expect(polarisConfig.update?.pinnedReleaseKeys).toEqual(info.releaseKeys);
  expect([...(polarisConfig.expectedServices ?? [])].sort()).toEqual(
    [...info.services].sort(),
  );
  return polarisConfig;
}

/**
 * A Node SDK client built from the quickstart config the way the quickstart builds it, on a device
 * of its own: a fresh store and fresh directories, so no two clients share a token or a seat.
 */
async function nodeClient(config: NodeQuickstart): Promise<PolarisKeyClient> {
  const dir = await mkdtemp(path.join(tmp, "node-sdk-"));
  const client = await PolarisKeyClient.create({
    ...config,
    version: "1.0.0",
    // The generated file pins the release keys; where this build came from is the app's to say.
    // No platform or arch pin: the install is the runner's own, as an integrator's is.
    update: { ...config.update, outlet: "direct", format: "zip" },
    deviceName: "pkey dev test",
    store: new InMemoryStore(),
    configDir: path.join(dir, "config"),
    dataDir: path.join(dir, "data"),
    cacheDir: path.join(dir, "cache"),
    stateDir: path.join(dir, "state"),
  });
  clients.push(client);
  return client;
}

/** The seeded keys that activate, and whether each is entitled to `exportPro`. */
const ACTIVATES = {
  ok: { exportPro: true },
  floating: { exportPro: false },
};

interface Refusal {
  /** What the Worker answers on the wire, the oracle: its HTTP status and error code. */
  status: number;
  code: string;
  /** What the Node SDK reports. It passes the server's code through. */
  sdk: {
    kind: Exclude<ActivationResult["kind"], "ok" | "error">;
    status?: number;
  };
}

/**
 * The seeded keys the Worker refuses. Node has no kind of its own for `key_entry_limit`, like
 * every other SDK: it reports `refused`, with the code and the status.
 */
const REFUSALS = {
  expired: { status: 401, code: "unauthorized", sdk: { kind: "unauthorized" } },
  disabled: {
    status: 401,
    code: "unauthorized",
    sdk: { kind: "unauthorized" },
  },
  revoked: { status: 401, code: "unauthorized", sdk: { kind: "unauthorized" } },
  "device-limit-full": {
    status: 403,
    code: "device_limit",
    sdk: { kind: "device-limit" },
  },
  "key-entry-limit": {
    status: 403,
    code: "key_entry_limit",
    sdk: { kind: "refused", status: 403 },
  },
} satisfies Record<string, Refusal>;

describe("pkey dev server", () => {
  it("starts in under 45 s with no account and no network", async () => {
    const t = Date.now();
    const { s, info } = await start();
    expect(Date.now() - t).toBeLessThan(45_000);
    expect(info.product).toBe("tidewater");
    expect(Object.keys(info.keys)).toEqual([...DEV_KEYS]);
    expect(info.releases.map((r) => r.channel).sort()).toEqual([
      "beta",
      "stable",
    ]);
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await s.close();
  }, 60_000);

  it("answers each refusal kind the way the Worker does", async () => {
    const { s, info } = await start();
    const get = async (k: string) => {
      const r = await activate(
        s.url,
        info.product,
        info.keys[k]!,
        dev(k.replace(/\W/g, "")),
      );
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
    await expect(fetch("https://key.plrs.im/")).rejects.toThrow(
      /does not contact/,
    );
    expect(s.blocked).toEqual(["key.plrs.im"]);
    await s.close();
  });

  it("keeps the fetch guard when servers close out of order", async () => {
    const nativeFetch = globalThis.fetch;
    const upstream = (async (input: TestFetchInput, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!["127.0.0.1", "localhost", "::1"].includes(new URL(raw).hostname))
        throw new Error(`test prevented unexpected network access to ${raw}`);
      return nativeFetch(input, init);
    }) as typeof fetch;
    globalThis.fetch = upstream;
    let first: StartedDevServer | undefined;
    let second: StartedDevServer | undefined;
    try {
      first = await start();
      const guard = globalThis.fetch;
      expect(guard).not.toBe(upstream);
      second = await start();
      expect(globalThis.fetch).toBe(guard);

      await first.s.close();
      first = undefined;
      expect(globalThis.fetch).toBe(guard);
      await expect(fetch("https://key.plrs.im/")).rejects.toThrow(
        /does not contact/,
      );
      expect(second.s.blocked).toEqual(["key.plrs.im"]);
      expect(
        (
          await activate(
            second.s.url,
            second.info.product,
            second.info.keys.ok!,
            dev("second"),
          )
        ).status,
      ).toBe(200);

      const closing = second.s.close();
      await second.s.close();
      await closing;
      second = undefined;
      expect(globalThis.fetch).toBe(upstream);
    } finally {
      if (first) await first.s.close();
      if (second) await second.s.close();
      globalThis.fetch = nativeFetch;
    }
  });

  it("refuses a request whose Host is not loopback", async () => {
    const { s, info } = await start();
    const port = new URL(s.url).port;
    // The control: this server's own names get through, so a 421 below is the Host check and not
    // the helper or the path.
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const answered = await rawRequest(s.url, host);
      expect(answered.status, host).toBe(200);
      expect(JSON.parse(answered.body), host).toMatchObject({
        product: info.product,
      });
    }
    // A page rebound to this address sends its own domain as Host, or a lookalike of a loopback name.
    for (const host of [
      "evil.example",
      `evil.example:${port}`,
      "127.0.0.1.evil.example",
      `localhost.evil.example:${port}`,
    ]) {
      const refused = await rawRequest(s.url, host);
      expect(refused.status, host).toBe(421);
      expect(refused.body, host).toMatch(/loopback only/);
      // The info it would have answered lists every test key.
      expect(refused.body, host).not.toContain(info.keys.ok!);
    }
    // The Polaris Key routes and the control surface sit behind the same check.
    const discovery = await rawRequest(s.url, "evil.example", {
      path: `/${info.product}/.well-known/polaris.json`,
    });
    expect(discovery.status).toBe(421);
    const expire = await rawRequest(s.url, "evil.example", {
      method: "POST",
      path: "/__dev/expire",
      headers: { "x-pkey-dev": "1", "content-type": "application/json" },
      body: JSON.stringify({ key: "ok" }),
    });
    expect(expire.status).toBe(421);
    // And the command did not run: the key it named still activates.
    expect(
      (await activate(s.url, info.product, info.keys.ok!, dev("rebind")))
        .status,
    ).toBe(200);
  });

  it("the control surface: expire, fill-seats, offline, and a header gate", async () => {
    const { s, info } = await start();
    expect((await post(s.url, "expire", { key: "ok" }, {})).status).toBe(403);
    expect((await post(s.url, "expire", { key: "nope" })).status).toBe(400);
    expect((await post(s.url, "expire", { key: "ok" })).status).toBe(200);
    expect(
      (await activate(s.url, info.product, info.keys.ok!, dev("x1"))).status,
    ).toBe(401);
    expect((await post(s.url, "restore", { key: "ok" })).status).toBe(200);
    expect(
      (await activate(s.url, info.product, info.keys.ok!, dev("x2"))).status,
    ).toBe(200);
    expect((await post(s.url, "fill-seats", { key: "ok" })).status).toBe(200);
    expect(
      (await activate(s.url, info.product, info.keys.ok!, dev("x3"))).status,
    ).toBe(403);
    expect((await post(s.url, "offline", {})).status).toBe(200);
    await expect(
      fetch(`${s.url}/${info.product}/.well-known/polaris.json`),
    ).rejects.toThrow();
    expect((await post(s.url, "online", {})).status).toBe(200);
    expect(
      (await fetch(`${s.url}/${info.product}/.well-known/polaris.json`)).status,
    ).toBe(200);
    await s.close();
  });

  it("device-code sign-in runs through the fake IdP", async () => {
    const running = await start({ autoApprove: true });
    try {
      expect((await completeDeviceCodeSignIn(running, "signin")).status).toBe(
        200,
      );
    } finally {
      await running.s.close();
    }
  });

  it("isolates fake IdP JWKS between live dev servers", async () => {
    const first = await start({ autoApprove: true });
    const second = await start({ autoApprove: true });
    try {
      expect((await completeDeviceCodeSignIn(first, "first-idp")).status).toBe(
        200,
      );
      expect(
        (await completeDeviceCodeSignIn(second, "second-idp")).status,
      ).toBe(200);
    } finally {
      await first.s.close();
      await second.s.close();
    }
  });

  it("seeds from a repo's .pkey/ and serves its slug", async () => {
    const { s, info } = await start({
      manifest: {
        product: JSON.stringify({
          slug: "acme",
          name: "Acme",
          modules: { license: { enabled: true } },
        }),
        schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
      },
    });
    expect(info.product).toBe("acme");
    expect(info.services).toEqual(["license"]);
    expect((await fetch(`${s.url}/acme/.well-known/polaris.json`)).status).toBe(
      200,
    );
    await s.close();
  });
});

// The Node lane of SP-41's quickstart checkpoints (B1 to B5), against a fresh in-process server
// each, the way CI runs every SDK against a fresh `pkey dev`. The server is the oracle: the
// refusals are compared with its own HTTP answers, and the config and release changes are made
// through the same `/__dev/*` endpoints `pkey dev config` and `pkey dev release` call.
describe("the Node SDK against a live pkey dev server", () => {
  it("covers every seeded key exactly once", () => {
    expect(Object.keys({ ...ACTIVATES, ...REFUSALS }).sort()).toEqual(
      [...DEV_KEYS].sort(),
    );
  });

  it("B1: the ok and floating keys activate, and only ok is entitled to exportPro", async () => {
    const running = await start();
    const { s, info } = running;
    const config = await nodeQuickstart(running);
    for (const [key, want] of Object.entries(ACTIVATES)) {
      const wire = await activate(
        s.url,
        info.product,
        info.keys[key]!,
        dev(`wire-${key}`),
      );
      expect(wire.status, key).toBe(200);
      expect(await wire.json(), key).toMatchObject({
        token: expect.stringMatching(/^pkeyt_/),
      });

      const client = await nodeClient(config);
      const result = await client.license.activateWithKey(info.keys[key]!);
      if (result.kind !== "ok")
        throw new Error(`${key} did not activate: ${JSON.stringify(result)}`);
      expect(result.token, key).toMatch(/^pkeyt_/);
      expect(client.hasToken, key).toBe(true);
      expect(client.isLicensed(), key).toBe(true);
      expect(client.entitlements.has("exportPro"), key).toBe(want.exportPro);
    }
  });

  it("B2: every other seeded key is refused, with the code the Worker sends", async () => {
    const running = await start();
    const { s, info } = running;
    const config = await nodeQuickstart(running);
    for (const [key, want] of Object.entries(REFUSALS)) {
      const wire = await activate(
        s.url,
        info.product,
        info.keys[key]!,
        dev(`wire-${key}`),
      );
      expect(wire.status, key).toBe(want.status);
      expect(await wire.json(), key).toMatchObject({ error: want.code });

      const client = await nodeClient(config);
      const result = await client.license.activateWithKey(info.keys[key]!);
      expect(result, key).toMatchObject({ ...want.sdk, code: want.code });
      // A refusal mints nothing: no token, and so no licence.
      expect(client.hasToken, key).toBe(false);
      expect(client.isLicensed(), key).toBe(false);
    }
  });

  it("B3: POST /__dev/config reaches the SDK as a config change event", async () => {
    const running = await start();
    const { s, info } = running;
    const client = await nodeClient(await nodeQuickstart(running));
    expect((await client.license.activateWithKey(info.keys.ok!)).kind).toBe(
      "ok",
    );
    await client.sync();
    expect(client.config.get("render.quality", "draft")).toBe("draft");
    // Signed documents carry whole-second timestamps; a change in the same second is not newer.
    await sleep(1100);
    const seen: unknown[] = [];
    client.config.onConfigChange("render.quality", (c) => seen.push(c.value));
    const changed = await post(s.url, "config", {
      name: "render.quality",
      value: "high",
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      ok: true,
      message: expect.stringMatching(/render\.quality/),
    });
    await client.sync();
    expect(client.config.get("render.quality", "draft")).toBe("high");
    expect(seen).toEqual(["high"]);
  });

  it("B4: device-code sign-in through the SDK's signIn.start session", async () => {
    const running = await start({ autoApprove: true });
    const { s, info } = running;
    // The fake IdP signs in one made-up person; the Worker keeps the email because the IdP says
    // it is verified, so the SDK shows both.
    const person = { name: info.idp.person.name, email: info.idp.person.email };
    expect(person.email).toContain("@");
    const client = await nodeClient(await nodeQuickstart(running));
    const prompt = await client.identity.signIn.start({
      channel: "device-code",
      deviceName: "pkey dev test",
    });
    // What a person is shown: a code to type, and a page on this server to type it into.
    expect(prompt.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(new URL(prompt.verificationUri).origin).toBe(s.url);
    expect(prompt.verificationUriComplete).toBe(
      `${prompt.verificationUri}?user_code=${prompt.userCode}`,
    );
    expect(prompt.deviceName).toBe("pkey dev test");
    // Nobody has approved it, so a poll is pending and the device holds nothing.
    expect(await prompt.wait({ once: true })).toMatchObject({
      kind: "pending",
    });
    expect(client.hasToken).toBe(false);

    // The person approves at the verification page, through the fake IdP.
    expect(
      (await approveDeviceCode(prompt.verificationUriComplete)).status,
    ).toBe(200);

    // wait() paces itself by the advertised interval, then the sign-in settles. The signal
    // bounds a sign-in that never settles, which would otherwise poll on after the test is over.
    const done = await prompt.wait({ signal: AbortSignal.timeout(10_000) });
    expect(done).toMatchObject({ kind: "signedIn", identity: person });
    // The poll's token is the device's now: stored, usable, and read back as the identity.
    expect(client.hasToken).toBe(true);
    expect(client.license.activation()).toBe("token");
    expect(client.isLicensed()).toBe(true);
    expect(await client.identity.current()).toMatchObject(person);
  });

  it("B5: POST /__dev/release turns the SDK's update decision into a binary update", async () => {
    const running = await start();
    const { s, info } = running;
    const client = await nodeClient(await nodeQuickstart(running));
    expect((await client.license.activateWithKey(info.keys.ok!)).kind).toBe(
      "ok",
    );
    const current = await client.update.decide({ channel: "latest" });
    expect(current.decision).toMatchObject({
      action: "none",
      reason: "up-to-date",
    });
    const published = await post(s.url, "release", {
      version: "1.2.0",
      channel: "stable",
    });
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({
      ok: true,
      message: expect.stringMatching(/1\.2\.0 on stable/),
    });
    // The server's own account of it, apart from the SDK's.
    expect(await (await fetch(`${s.url}/__dev/info`)).json()).toMatchObject({
      releases: expect.arrayContaining([
        { version: "1.2.0", channel: "stable" },
      ]),
    });
    const next = await client.update.decide({ channel: "latest" });
    expect(next.errors).toEqual([]);
    expect(next.decision).toMatchObject({
      action: "binary",
      method: "download",
      release: { version: "1.2.0" },
    });
  });

  it("B6: the seeded release has a build for this host's platform, with no platform pin", async () => {
    const running = await start();
    const { s } = running;
    // `os.platform()` is what the Node SDK canonicalises: `darwin` is `macos`, `win32` is `windows`.
    const host = { darwin: "macos", win32: "windows", linux: "linux" }[
      os.platform() as "darwin" | "win32" | "linux"
    ];
    expect(host).toBeDefined();
    const client = await nodeClient(await nodeQuickstart(running));
    expect(
      (await client.license.activateWithKey(running.info.keys.ok!)).kind,
    ).toBe("ok");
    expect(
      (await post(s.url, "release", { version: "1.2.0", channel: "stable" }))
        .status,
    ).toBe(200);
    const next = await client.update.decide({ channel: "latest" });
    expect(next.errors).toEqual([]);
    expect(next.decision).toMatchObject({
      action: "binary",
      release: { version: "1.2.0" },
      // The build id is its platform (TIDEWATER_BUILDS).
      build: host,
    });
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
      {
        cwd: tmp,
        stdout: { write: (c: string) => ((text += c), true) },
        stderr: { write: () => true },
        stop,
      },
      bundle,
    );
    for (let i = 0; i < 100 && !/Ctrl-C/.test(text); i++)
      await new Promise((r) => setTimeout(r, 50));
    const file = JSON.parse(await readFile(out, "utf8")) as ReturnType<
      typeof configFile
    >;
    expect(file.productSlug).toBe("tidewater");
    expect(text).toContain("Test keys");
    let answer = "";
    const code = await controlDev(
      args({ sub: "expire", positional: ["ok"], url: file.baseUrl as string }),
      {
        cwd: tmp,
        stdout: { write: (c: string) => ((answer += c), true) },
        stderr: { write: () => true },
      },
    );
    expect(code).toBe(0);
    expect(answer).toBe("ok expired\n");
    // `pkey sdk --dev` reads the running server.
    let sdk = "";
    const rc = await runPkey(
      ["sdk", "--lang", "python", "--dev", "--url", file.baseUrl as string],
      {
        cwd: tmp,
        stdout: { write: (c: string) => ((sdk += c), true) },
        stderr: { write: () => true },
      },
    );
    expect(rc).toBe(0);
    expect(sdk).toContain("tidewater");
    expect(sdk).toContain(file.baseUrl as string);
    stopNow();
    expect(await serving).toBe(0);
  });

  it("explains a missing server", async () => {
    await expect(
      controlDev(
        args({ sub: "expire", positional: ["ok"], url: "http://127.0.0.1:1" }),
        {
          cwd: tmp,
          stdout: { write: () => true },
          stderr: { write: () => true },
        },
      ),
    ).rejects.toThrow(/No pkey dev is running/);
  });

  it("is in the command table with every control word completed", () => {
    const c = COMMANDS.find((x) => x.name === "dev")!;
    expect(Object.keys(c.tree!)).toEqual(
      expect.arrayContaining([
        "keys",
        "expire",
        "fill-seats",
        "config",
        "release",
        "offline",
      ]),
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
    for (const needle of [
      "__dev",
      "__idp",
      "pkey-dev",
      "pkey dev",
      "startDevServer",
      "pkey-dev-idp",
    ])
      expect(code, needle).not.toContain(needle);
  }, 120_000);
});
