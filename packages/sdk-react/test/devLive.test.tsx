// SP-41 acceptance, React lane: "in CI, each SDK's quickstart reaches first activation, every
// refusal kind exactly as the deployed Worker answers it, a config change event, device-code
// sign-in and an update decision", here against a live `pkey dev` (the real Worker router) with no
// mock of the wire: the provider, the browser adapter and the public hooks, wired the way the
// quickstart wires them.
//
// It needs a fresh server and three variables. CI's js job starts the server after `pnpm build`
// (the CLI's dev bundle must exist; Node 22.13 or later) and exports them:
//
//   PKEY_DEV_BASE_URL  the server's origin, http://127.0.0.1:<port>
//   PKEY_DEV_CONFIG    the module `pkey sdk --lang react --dev --url … --write` wrote
//   PKEY_DEV_APPROVE   packages/cli/scripts/dev-approve.mjs, the person's side of a device-code
//                      sign-in: `node $PKEY_DEV_APPROVE <verification address> <user code>`
//
// By hand, from the repository root:
//
//   eval "$(node packages/cli/scripts/start-dev-ci.mjs start --lang react)"
//   pnpm --filter @polaris-key/react test devLive
//   node packages/cli/scripts/start-dev-ci.mjs stop --lang react
//
// With none of the variables set the suite is skipped (a developer's machine, and the workflows
// that run every test without a server); with only some set it fails. The steps run in order on
// one server and take devices the seeded licences have few of, so run it once per server.
//
// jsdom stands in for the browser. Its page is http://localhost:3000, one of the origins the dev
// product lists under `web.origins`, so the page runs the bearer transport against the server on
// another origin, and every request goes through `pageFetch`, which enforces CORS as a browser does.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { promisify } from "node:util";
import type { ReactNode } from "react";
import { IDBFactory } from "fake-indexeddb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, configure, renderHook, waitFor } from "@testing-library/react";
import {
  Feature,
  PolarisError,
  PolarisKeyProvider,
  browserAdapter,
  servicesFromList,
  useConfigSetting,
  useEntitlement,
  useLicense,
  useLicenseGate,
  usePolarisAuth,
  useUpdateDecision,
  type ConfigChange,
  type OidcSignInHandle,
  type PolarisAdapter,
  type PolarisKeyConfig,
  type UseConfigSetting,
  type UseLicense,
  type UseLicenseGate,
  type UsePolarisAuth,
  type UseUpdateDecision,
} from "../src/index.js";

// The shared pages below outlive a test, so testing-library must not unmount them between tests.
// (Vitest runs this before the imports, which is when testing-library reads the variable.)
vi.hoisted(() => {
  process.env.RTL_SKIP_AUTO_CLEANUP = "true";
});

const run = promisify(execFile);

const ENV = {
  PKEY_DEV_BASE_URL: process.env.PKEY_DEV_BASE_URL,
  PKEY_DEV_CONFIG: process.env.PKEY_DEV_CONFIG,
  PKEY_DEV_APPROVE: process.env.PKEY_DEV_APPROVE,
};
const unset = Object.entries(ENV)
  .filter(([, value]) => !value)
  .map(([name]) => name);

/** `GET /__dev/info`: the server's account of itself, what `pkey dev keys` prints. */
interface DevInfo {
  baseUrl: string;
  product: string;
  services: string[];
  trust: { pinnedKeys: Record<string, string> };
  releaseKeys: Record<string, string>;
  webOrigins: string[];
  keys: Record<string, string>;
  idp: { person: { name: string; email: string } };
  releases: { version: string; channel: string }[];
}

/** The module `pkey sdk --lang react --dev --write` writes, as the quickstart imports it. */
interface GeneratedConfig {
  polarisKey: Required<
    Pick<
      PolarisKeyConfig,
      "productSlug" | "baseUrl" | "trust" | "expectedServices"
    >
  >;
  pinnedKeys: Record<string, string>;
  pinnedReleaseKeys: Record<string, string>;
}

/** What one page's hooks answer, read together. */
interface PageHooks {
  auth: UsePolarisAuth;
  license: UseLicense;
  gate: UseLicenseGate;
  pro: boolean;
  quality: UseConfigSetting<string>;
  update: UseUpdateDecision;
}

/** One browser tab: its own IndexedDB (so its own device), the provider, and every hook. */
interface Page {
  adapter: PolarisAdapter;
  hooks: { current: PageHooks };
  unmount(): void;
}

// A job that exports some of the variables and not the rest is broken: it must not skip.
it.runIf(unset.length > 0 && unset.length < 3)(
  "has all three pkey dev variables or none",
  () => {
    expect(unset).toEqual([]);
  },
);

// The five test keys the Worker refuses, by the documented `activation.kind` (the React "Your own
// UI" page). An expired, a disabled and a revoked licence answer alike with a 401 `unauthorized`;
// a full licence answers `device_limit`; `key_entry_limit` has its own kind, `keyEntryLimit`. The rest of a refusal (the counters, the portal
// link) is checked for its shape, never its values.
const REFUSED = [
  { key: "expired", kind: "unauthorized", code: "unauthorized", status: 401 },
  { key: "disabled", kind: "unauthorized", code: "unauthorized", status: 401 },
  { key: "revoked", kind: "unauthorized", code: "unauthorized", status: 401 },
  {
    key: "device-limit-full",
    kind: "deviceLimit",
    code: "device_limit",
    status: 403,
  },
  {
    key: "key-entry-limit",
    kind: "keyEntryLimit",
    code: "key_entry_limit",
    status: 403,
  },
] as const;

const SIMPLE_METHODS = ["GET", "HEAD", "POST"];
const SIMPLE_HEADERS: Record<string, true> = {
  accept: true,
  "accept-language": true,
  "content-language": true,
};
const SIMPLE_CONTENT_TYPE =
  /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)/i;

/** What a browser answers a page that the server did not allow to read. */
function blocked(): never {
  throw new TypeError("Failed to fetch");
}

/**
 * A page's `fetch` for requests to the dev server, which is another origin: it names the page in
 * `Origin`, asks permission first (a preflight) when the request is outside CORS's simple set, and
 * hands the page the answer only when `Access-Control-Allow-Origin` names the page. The product's
 * `web.origins` are what answer, so a page the allowlist leaves out reads nothing. A request to
 * any other host is refused and recorded in `strays`: a dev run never contacts production.
 */
function pageFetch(
  pageOrigin: string,
  serverOrigin: string,
  strays: string[],
): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== serverOrigin) {
      strays.push(url.origin);
      throw new Error(`the page reached ${url.origin}, not ${serverOrigin}`);
    }
    // Credentials never ride a cross-origin read: the Worker sends no Allow-Credentials.
    if (init.credentials === "include") blocked();
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const unsafe = [...headers.keys()]
      .filter(
        (name) =>
          !(name in SIMPLE_HEADERS) &&
          !(
            name === "content-type" &&
            SIMPLE_CONTENT_TYPE.test(headers.get(name) ?? "")
          ),
      )
      .sort();
    if (!SIMPLE_METHODS.includes(method) || unsafe.length > 0) {
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          origin: pageOrigin,
          "access-control-request-method": method,
          ...(unsafe.length > 0
            ? { "access-control-request-headers": unsafe.join(",") }
            : {}),
        },
      });
      const allowedMethods = (
        preflight.headers.get("access-control-allow-methods") ?? ""
      )
        .toLowerCase()
        .split(/\s*,\s*/);
      const allowedHeaders = (
        preflight.headers.get("access-control-allow-headers") ?? ""
      )
        .toLowerCase()
        .split(/\s*,\s*/);
      if (
        !preflight.ok ||
        preflight.headers.get("access-control-allow-origin") !== pageOrigin ||
        !(
          SIMPLE_METHODS.includes(method) ||
          allowedMethods.includes(method.toLowerCase())
        ) ||
        unsafe.some((name) => !allowedHeaders.includes(name))
      )
        blocked();
    }
    headers.set("origin", pageOrigin);
    const res = await fetch(url, { ...init, headers });
    if (res.headers.get("access-control-allow-origin") !== pageOrigin)
      blocked();
    return res;
  };
}

describe.skipIf(unset.length > 0)("the React SDK on a live pkey dev", () => {
  // Read whether or not the suite runs: a skipped suite's body is still collected.
  const base = (ENV.PKEY_DEV_BASE_URL ?? "").replace(/\/+$/, "");
  const strays: string[] = [];
  const pages: Page[] = [];
  let info: DevInfo;
  let generated: GeneratedConfig;

  // Vitest's jsdom environment swaps the typed-array globals for jsdom's realm, and Node's WebCrypto
  // Ed25519 verify refuses what a page of that realm hands it, so no signed document would verify.
  // The `Uint8Array` Node's own APIs return goes back for this file, so the pins are checked for real.
  const jsdomUint8Array = globalThis.Uint8Array;
  beforeAll(async () => {
    // Sized for a loaded CI runner, as the package's own timeouts are.
    configure({ asyncUtilTimeout: 15_000 });
    globalThis.Uint8Array = new TextEncoder().encode("")
      .constructor as Uint8ArrayConstructor;
    info = (await (await fetch(`${base}/__dev/info`)).json()) as DevInfo;
    // The generated file is TypeScript outside this package, which the test runner will not load
    // by path. Its types come off and what is left is imported as the module it is; the file's
    // text is the environment's, so no static import can name it.
    const source = stripTypeScriptTypes(
      readFileSync(ENV.PKEY_DEV_CONFIG!, "utf8"),
    );
    generated = (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    )) as GeneratedConfig;
  });
  afterAll(() => {
    for (const page of pages) page.unmount();
    globalThis.Uint8Array = jsdomUint8Array;
    vi.unstubAllGlobals();
  });

  /** `pkey dev <command>`: the control routes the CLI's steering commands call. */
  async function control(command: string, body: unknown): Promise<string> {
    const res = await fetch(`${base}/__dev/${command}`, {
      method: "POST",
      headers: { "x-pkey-dev": "1", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer = (await res.json()) as { message?: string };
    if (!res.ok) throw new Error(`pkey dev ${command}: ${answer.message}`);
    return answer.message ?? "";
  }

  /** The newest stable release the server lists: what an app that is up to date runs. */
  async function newestStable(): Promise<string> {
    const { releases } = (await (
      await fetch(`${base}/__dev/info`)
    ).json()) as DevInfo;
    return releases
      .filter((release) => release.channel === "stable")
      .map((release) => release.version)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1)!;
  }

  async function openPage(version: string): Promise<Page> {
    // A new IndexedDB is a new browser profile: the adapter mints its own device id in it.
    vi.stubGlobal("indexedDB", new IDBFactory());
    const { polarisKey, pinnedReleaseKeys } = generated;
    const adapter = browserAdapter({
      productSlug: polarisKey.productSlug,
      baseUrl: polarisKey.baseUrl,
      trust: polarisKey.trust,
      expectedServices: polarisKey.expectedServices,
      version,
      // Tidewater ships one build, a macOS zip from its direct outlet, so a page that asks for
      // updates says it is the shell running it. As a plain web page it would be told there is
      // no build for it, before a release and after.
      update: {
        pinnedReleaseKeys,
        outlet: { id: "direct", kind: "direct" },
        installed: { platform: "macos", arch: "arm64", format: "zip" },
      },
      fetchImpl: pageFetch(window.location.origin, base, strays),
      configStorage: null,
    });
    const { result, unmount } = renderHook(
      (): PageHooks => ({
        auth: usePolarisAuth(),
        license: useLicense(),
        gate: useLicenseGate(),
        pro: useEntitlement("exportPro"),
        quality: useConfigSetting("render.quality", "draft"),
        update: useUpdateDecision({ channel: "latest", immediate: false }),
      }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <PolarisKeyProvider
            config={{ productSlug: polarisKey.productSlug, adapter }}
          >
            {children}
          </PolarisKeyProvider>
        ),
      },
    );
    const page: Page = { adapter, hooks: result, unmount };
    pages.push(page);
    await waitFor(() => expect(result.current.license.loading).toBe(false));
    return page;
  }

  /** Type a key into a page's sign-in: what a refusal throws, or `null` once it activated. */
  async function submitKey(page: Page, key: string): Promise<unknown> {
    let failure: unknown = null;
    await act(async () => {
      try {
        await page.hooks.current.auth.submitKey(key);
      } catch (e) {
        failure = e;
      }
    });
    return failure;
  }

  /**
   * The person's half of a device-code sign-in, in another process: the host-side approver opens
   * the address, types the code and presses Approve. A failure there stops the wait it serves.
   */
  async function approve(
    address: string,
    userCode: string,
    stop: () => void,
  ): Promise<void> {
    try {
      await run(process.execPath, [ENV.PKEY_DEV_APPROVE!, address, userCode], {
        timeout: 30_000,
      });
    } catch (e) {
      stop();
      throw e;
    }
  }

  // The one device the `ok` key activates, shared by the first activation, the config change and
  // the update decision. It runs the newest stable release, so it is up to date.
  let activated: Promise<Page> | undefined;
  const activatedPage = () =>
    (activated ??= (async () => {
      const page = await openPage(await newestStable());
      expect(await submitKey(page, info.keys["ok"]!)).toBeNull();
      return page;
    })());

  it("the generated config names this server, and the page's origin is one it allows", () => {
    const { polarisKey, pinnedKeys, pinnedReleaseKeys } = generated;
    expect(polarisKey.baseUrl.replace(/\/+$/, "")).toBe(base);
    expect(info.baseUrl).toBe(base);
    expect(polarisKey.productSlug).toBe(info.product);
    expect(polarisKey.trust.pinnedKeys).toEqual(pinnedKeys);
    expect(pinnedKeys).toEqual(info.trust.pinnedKeys);
    expect(pinnedReleaseKeys).toEqual(info.releaseKeys);
    expect([...polarisKey.expectedServices].sort()).toEqual(
      [...info.services].sort(),
    );
    // jsdom's origin is the page's: it must be one the product lists under `web.origins`.
    expect(info.webOrigins).toContain(window.location.origin);
  });

  it("lets a page on a listed origin read the server and blocks one the product does not list", async () => {
    const discovery = `${base}/${info.product}/.well-known/polaris.json`;
    const listed = await pageFetch(
      window.location.origin,
      base,
      strays,
    )(discovery);
    expect(listed.status).toBe(200);
    await expect(
      pageFetch("http://localhost:9999", base, strays)(discovery),
    ).rejects.toThrow("Failed to fetch");
  });

  it("seeds exactly seven keys", () => {
    expect(Object.keys(info.keys).sort()).toEqual([
      "device-limit-full",
      "disabled",
      "expired",
      "floating",
      "key-entry-limit",
      "ok",
      "revoked",
    ]);
  });

  it("B1: the first activation: the ok key opens the gate and grants exportPro", async () => {
    const page = await activatedPage();
    await waitFor(() => expect(page.hooks.current.license.status).toBe("ok"));
    const { license, gate, pro, auth } = page.hooks.current;
    expect(license.usable).toBe(true);
    expect(license.activation).toBe("token");
    expect(gate.screen).toBe("ok");
    expect(pro).toBe(true);
    expect(auth.needsAuth).toBe(false);
    // A page on another origin runs the bearer transport: its device token waits in IndexedDB.
    expect(page.adapter.supports(Feature.identityDevicecode).supported).toBe(
      true,
    );
    expect(await page.adapter.storeStatus()).toMatchObject({
      backend: "indexeddb",
    });
  }, 30_000);

  // One sign-in card taking key after key, as a person does: a refusal leaves it asking, and the
  // floating key at the end still works.
  let signedOut: Promise<Page> | undefined;
  const signedOutPage = () => (signedOut ??= openPage("1.0.0"));

  it.each(REFUSED)(
    "B2: the $key key is refused as the $kind kind, code $code",
    async ({ key, ...expected }) => {
      const page = await signedOutPage();
      const error = await submitKey(page, info.keys[key]!);
      expect(error).toBeInstanceOf(PolarisError);
      expect(error).toMatchObject({
        code: "sign-in-failed",
        wireCode: expected.code,
        status: expected.status,
        activation: expected,
      });
      if (expected.kind === "deviceLimit")
        expect((error as PolarisError).activation).toMatchObject({
          limit: expect.any(Number),
          deviceCount: expect.any(Number),
          // The link that frees a seat is the dev server's own, never production's.
          manageUrl: expect.stringContaining(`${base}/`),
        });
      // The gate stays on the sign-in card, which shows the refusal: it is not an error screen.
      await waitFor(() =>
        expect(page.hooks.current.auth.error?.activation?.kind).toBe(
          expected.kind,
        ),
      );
      expect(page.hooks.current.gate.screen).toBe("login");
      expect(page.hooks.current.license.status).toBe("needs-activation");
    },
    30_000,
  );

  it("B2: the floating key, in no account, activates after the refusals", async () => {
    const page = await signedOutPage();
    expect(await submitKey(page, info.keys["floating"]!)).toBeNull();
    await waitFor(() => expect(page.hooks.current.license.status).toBe("ok"));
    expect(page.hooks.current.gate.screen).toBe("ok");
    expect(page.hooks.current.auth.error).toBeNull();
  }, 30_000);

  it("B3: a config change on the server reaches the page as a change event", async () => {
    const page = await activatedPage();
    // A value the page does not hold yet, whatever an earlier run left behind.
    const next =
      page.hooks.current.quality.value === "high" ? "standard" : "high";
    const changes: ConfigChange[] = [];
    const off = page.adapter.config.onConfigChange("render.quality", (change) =>
      changes.push(change),
    );
    expect(
      await control("config", { name: "render.quality", value: next }),
    ).toContain("render.quality");
    // Signed documents carry whole-second times, so a change made in the second of the last sync
    // shows on a later one: the page syncs until the event lands.
    await vi.waitFor(
      async () => {
        await act(async () => {
          await page.hooks.current.license.refresh();
        });
        expect(changes).toHaveLength(1);
      },
      { timeout: 20_000, interval: 500 },
    );
    off();
    expect(changes[0]).toMatchObject({ key: "render.quality", value: next });
    expect(changes[0]!.previous).not.toBe(next);
    await waitFor(() => expect(page.hooks.current.quality.value).toBe(next));
    expect(page.hooks.current.quality).toMatchObject({
      source: "enforced",
      locked: true,
    });
  }, 40_000);

  it("B4: device-code sign-in: begin, approve out of band, wait", async () => {
    const page = await openPage("1.0.0");
    const signIn = await page.adapter.signIn.start({
      channel: "device-code",
      deviceName: "React live test",
    });
    expect(new URL(signIn.verificationUri).origin).toBe(base);
    expect(signIn.verificationUriComplete).toContain(signIn.userCode);
    expect(signIn.interval).toBeGreaterThanOrEqual(1);
    expect(signIn.expiresAt).toBeGreaterThan(Date.now() / 1000);
    const stop = new AbortController();
    const waiting = signIn.wait({ signal: stop.signal });
    await approve(signIn.verificationUri, signIn.userCode, () => {
      stop.abort();
      waiting.catch(() => undefined);
    });
    expect(await waiting).toMatchObject({
      kind: "signedIn",
      identity: info.idp.person,
    });
    await waitFor(() => expect(page.hooks.current.license.status).toBe("ok"));
    expect(page.hooks.current.auth.profile).toMatchObject(info.idp.person);
    expect(page.hooks.current.auth.error).toBeNull();
  }, 60_000);

  it("B4: the hook form: signInWithOidc hands back the code and address, then the profile follows", async () => {
    const page = await openPage("1.0.0");
    let handle = undefined as OidcSignInHandle | undefined;
    await act(async () => {
      handle = (await page.hooks.current.auth.signInWithOidc()) as
        | OidcSignInHandle
        | undefined;
    });
    if (!handle) throw new Error("bearer sign-in returned no handle");
    const { verificationUrl, userCode, cancel } = handle;
    expect(new URL(verificationUrl!).origin).toBe(base);
    await approve(verificationUrl!, userCode!, () => cancel?.());
    await waitFor(() => expect(page.hooks.current.license.status).toBe("ok"));
    expect(page.hooks.current.auth.profile).toMatchObject(info.idp.person);
  }, 60_000);

  it("B5: the update decision: up to date before a release, a download offer after it", async () => {
    const page = await activatedPage();
    const decide = async () => {
      let check: UseUpdateDecision["check"] = null;
      await act(async () => {
        check = await page.hooks.current.update.decide();
      });
      return check;
    };
    // `latest` is the channel's alias; the feed's own claim names it.
    expect(await decide()).toMatchObject({
      channel: "stable",
      decision: { action: "none", reason: "up-to-date", behind: false },
      errors: [],
    });
    const [major, minor] = (await newestStable()).split(".").map(Number);
    const version = `${major}.${minor! + 1}.0`;
    expect(await control("release", { version, channel: "stable" })).toContain(
      version,
    );
    expect(await decide()).toMatchObject({
      channel: "stable",
      decision: {
        action: "binary",
        release: { version },
        build: "macos",
        mandatory: false,
      },
      feed: "network",
      record: "network",
      errors: [],
    });
    await waitFor(() =>
      expect(page.hooks.current.update.decision).toMatchObject({
        action: "binary",
      }),
    );
    expect(page.hooks.current.update.undismissable).toBe(false);
  }, 60_000);

  it("never reached a host other than the dev server", () => {
    expect(strays).toEqual([]);
  });
});
