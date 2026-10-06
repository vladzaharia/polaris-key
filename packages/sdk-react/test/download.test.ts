// @vitest-environment node
//
// @pkey-feature release.fetch release.distribution crash.tags
// SP-12's download surface beyond the transcripts (test/transcripts.test.ts replays
// release-fetch-gated.json and distribution-download-model.json):
//
//   release.fetch         the adapter's verified download: resume after an interrupted body,
//                         a size/SHA-256 mismatch, the refusal's code, no bearer to another
//                         origin, the product N/A, the desktop forwarding and its v3 refusal
//                         (the replayer failing on a doctored recording is in transcripts.test.ts);
//   release.distribution  `thisPlatform()`, the platform the page reports, the desktop
//                         forwarding;
//   crash.tags            the Sentry vectors of packages/worker/test/sentry.test.ts (the ones the
//                         Node SDK's hostConveniences.test.ts asserts), and both adapters.

import { describe, expect, it } from "vitest";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { memoryStore } from "../src/browser/bearer/store.js";
import {
  browserPlatform,
  pickPlatform,
  type DownloadModel,
} from "../src/browser/distribution.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { UnsupportedError } from "../src/core/caps.js";
import { PolarisError } from "../src/core/types.js";
import { crashTagsFor } from "../src/core/crash.js";
import { emptyBridgeState, makeFakeBridge, newTestKey } from "./fixtures.js";

const BASE = "https://key.plrs.im";
const PRODUCT = "djdl";
const PAYLOAD = new TextEncoder().encode(
  "polaris-key payload: djdl-1.0.0-linux-x86_64.tar.gz, sixty-four bytes long.",
);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function discovery(opts: { builds?: string; distribution?: boolean } = {}) {
  const on = opts.distribution !== false;
  return {
    version: 2,
    product: PRODUCT,
    core: { registration: "requires-license" },
    services: {
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: true },
      distribution: on
        ? {
            enabled: true,
            endpoints: {
              builds:
                opts.builds ??
                `${BASE}/${PRODUCT}/distribution/builds/{selector}/{buildId}`,
            },
          }
        : { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    },
  };
}

async function record(bytes = PAYLOAD): Promise<ReleaseRecordDoc> {
  return {
    version: "1.0.0",
    builds: [
      {
        id: "linux-x64",
        platform: "linux",
        arch: "x86_64",
        artifacts: [
          {
            role: "payload",
            sha256: await sha256Hex(bytes),
            size: bytes.length,
          },
        ],
      },
    ],
  } as unknown as ReleaseRecordDoc;
}

interface Seen {
  url: string;
  headers: Record<string, string>;
}

/** A bearer-mode page holding a device token, over `answer` for the build route. */
async function bearerPage(
  answer: (seen: Seen) => Response | Promise<Response>,
  disco = discovery(),
) {
  const product = await newTestKey("pkey-test-dl");
  const seen: Seen[] = [];
  const store = memoryStore(PRODUCT);
  await store.setToken("pkeyt_test_token");
  const adapter = browserAdapter({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.0.0",
    auth: "bearer",
    trust: { pinnedKeys: { [product.kid]: product.raw } },
    store,
    offlineStore: null,
    autoStart: false,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/polaris.json"))
        return new Response(JSON.stringify(disco));
      const s: Seen = {
        url,
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(
            ([k, v]) => [k.toLowerCase(), v],
          ),
        ),
      };
      seen.push(s);
      return answer(s);
    }) as typeof fetch,
  });
  return { adapter, seen };
}

/** A 200 body that delivers `n` bytes, then fails mid-stream. */
function brokenBody(bytes: Uint8Array, n: number): Response {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(bytes.subarray(0, n));
          return;
        }
        c.error(new Error("connection reset"));
      },
    }),
    { status: 200 },
  );
}

describe("release.fetch through the browser adapter", () => {
  it("resumes an interrupted download with Range and If-Range, then verifies the whole", async () => {
    const rec = await record();
    const sha = (rec.builds![0]!.artifacts![0] as { sha256: string }).sha256;
    let calls = 0;
    const { adapter, seen } = await bearerPage((s) => {
      calls += 1;
      if (calls === 1) return brokenBody(PAYLOAD, 20);
      expect(s.headers.range).toBe("bytes=20-");
      return new Response(PAYLOAD.subarray(20) as BodyInit, {
        status: 206,
        headers: {
          "content-range": `bytes 20-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
        },
      });
    });
    const err = await adapter
      .releaseFetch({ record: rec, buildId: "linux-x64" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolarisError);
    expect((err as PolarisError).code).toBe("network");
    const progress: number[] = [];
    const r = await adapter.releaseFetch(
      { record: rec },
      { onProgress: (done) => progress.push(done) },
    );
    expect(r.size).toBe(PAYLOAD.length);
    expect(r.sha256).toBe(sha);
    expect(r.blob!.size).toBe(PAYLOAD.length);
    expect(new Uint8Array(await r.blob!.arrayBuffer())).toEqual(PAYLOAD);
    expect(progress[0]).toBe(20);
    expect(progress.at(-1)).toBe(PAYLOAD.length);
    expect(seen[0]!.url).toBe(
      `${BASE}/${PRODUCT}/distribution/builds/1.0.0/linux-x64`,
    );
    expect(seen[0]!.headers.authorization).toBe("Bearer pkeyt_test_token");
    expect(seen[0]!.headers["x-pkey-device"]).toBeTruthy();
    expect(seen[0]!.headers.range).toBeUndefined();
    expect(seen[1]!.headers["if-range"]).toBe(`"${sha}"`);
    adapter.dispose();
  });

  it("refuses bytes that do not match the record, and starts over next time", async () => {
    const rec = await record();
    const wrong = PAYLOAD.slice();
    wrong[0] = wrong[0]! ^ 1;
    let calls = 0;
    const { adapter, seen } = await bearerPage(() => {
      calls += 1;
      return new Response((calls === 1 ? wrong : PAYLOAD) as BodyInit, {
        status: 200,
      });
    });
    const err = await adapter
      .releaseFetch({ record: rec })
      .catch((e: unknown) => e);
    expect((err as PolarisError).code).toBe("payload-mismatch");
    expect((await adapter.releaseFetch({ record: rec })).size).toBe(
      PAYLOAD.length,
    );
    expect(seen[1]!.headers.range).toBeUndefined();
    adapter.dispose();
  });

  it("a licensed-delivery refusal is release-refused with the server's code", async () => {
    const { adapter } = await bearerPage(
      () =>
        new Response(JSON.stringify({ error: "download_auth_required" }), {
          status: 401,
        }),
    );
    const err = await adapter
      .releaseFetch({ record: await record() })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "release-refused",
      wireCode: "download_auth_required",
    });
    expect(adapter.snapshot().error.release).toBe(err);
    adapter.dispose();
  });

  it("never sends the device bearer to another origin", async () => {
    const { adapter, seen } = await bearerPage(
      () => new Response(PAYLOAD as BodyInit, { status: 200 }),
      discovery({
        builds: "https://dl.example.com/djdl/builds/{selector}/{buildId}",
      }),
    );
    await adapter.releaseFetch({ record: await record() });
    expect(seen[0]!.url).toBe(
      "https://dl.example.com/djdl/builds/1.0.0/linux-x64",
    );
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers["x-pkey-device"]).toBeUndefined();
    adapter.dispose();
  });

  it("names a build when the record carries several, and refuses a missing one", async () => {
    const { adapter } = await bearerPage(
      () => new Response(PAYLOAD as BodyInit, { status: 200 }),
    );
    const rec = await record();
    const two = {
      ...rec,
      builds: [...rec.builds!, { ...rec.builds![0]!, id: "linux-arm64" }],
    } as ReleaseRecordDoc;
    await expect(adapter.releaseFetch({ record: two })).rejects.toMatchObject({
      code: "invalid-options",
    });
    await expect(
      adapter.releaseFetch({ record: rec, buildId: "nope" }),
    ).rejects.toMatchObject({ code: "invalid-options" });
    adapter.dispose();
  });

  it("is the typed product N/A when the product runs no Distribution", async () => {
    const { adapter, seen } = await bearerPage(
      () => new Response("", { status: 500 }),
      discovery({ distribution: false }),
    );
    const err = await adapter
      .releaseFetch({ record: await record() })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
    expect(err).toMatchObject({ feature: "release.fetch", reason: "product" });
    expect(seen).toEqual([]);
    adapter.dispose();
  });
});

describe("release.fetch through the desktop adapter", () => {
  it("forwards {target, to} to the host's client.release.fetch() and maps its refusal", async () => {
    const calls: unknown[] = [];
    let refuse = false;
    const bridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 4,
      invoke: async (service: string, method: string, args?: unknown) => {
        calls.push({ service, method, args });
        if (refuse)
          throw Object.assign(new Error("a valid license is required"), {
            code: "download_auth_required",
          });
        return {
          path: "/tmp/app.tar.gz",
          size: 64,
          sha256: "a".repeat(64),
          version: "1.0.0",
          buildId: "linux-x64",
        };
      },
    };
    const adapter = desktopAdapter({ bridge });
    const target = { sha256: "b".repeat(64), buildId: "linux-x64" };
    const r = await adapter.releaseFetch(target, { to: "/tmp/app.tar.gz" });
    expect(r).toMatchObject({ path: "/tmp/app.tar.gz", size: 64 });
    expect(calls).toEqual([
      {
        service: "release",
        method: "fetch",
        args: { target, to: "/tmp/app.tar.gz" },
      },
    ]);
    refuse = true;
    await expect(
      adapter.releaseFetch(target, { to: "/tmp/app.tar.gz" }),
    ).rejects.toMatchObject({
      code: "release-refused",
      wireCode: "download_auth_required",
    });
    await expect(adapter.releaseFetch(target)).rejects.toMatchObject({
      code: "invalid-options",
    });
    adapter.dispose();
  });

  it("a v3 host gets the typed version N/A", async () => {
    const bridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 3,
      invoke: async () => null,
    };
    const adapter = desktopAdapter({ bridge });
    await expect(
      adapter.releaseFetch({ sha256: "b".repeat(64) }, { to: "/tmp/x" }),
    ).rejects.toMatchObject({ feature: "release.fetch", reason: "version" });
    await expect(adapter.downloadModel()).rejects.toMatchObject({
      feature: "release.distribution",
      reason: "version",
    });
    await expect(adapter.crashTags()).rejects.toMatchObject({
      feature: "crash.tags",
      reason: "version",
    });
    adapter.dispose();
  });
});

const MODEL: DownloadModel = {
  schemaVersion: 1,
  product: { slug: PRODUCT, name: PRODUCT },
  channel: "stable",
  pageUrl: null,
  listing: {
    name: PRODUCT,
    subtitle: null,
    description: null,
    developerName: null,
    website: null,
  },
  release: null,
  platforms: [
    {
      platform: "macos",
      label: "macOS",
      primary: "dl:mac",
      actions: ["dl:mac", "brew"],
      builds: [],
    },
    {
      platform: "windows",
      label: "Windows",
      primary: null,
      actions: ["scoop"],
      builds: [],
    },
  ],
  actions: ["dl:mac", "brew", "scoop"].map((id) => ({
    id,
    kind: id,
    outletId: "direct",
    platforms: [],
    label: id,
    url: null,
    deepLink: null,
    qr: null,
    command: null,
    fingerprint: null,
    version: null,
    build: null,
  })),
  keys: [],
};

describe("release.distribution", () => {
  it("thisPlatform resolves the group's actions, the primary first, and the others as alsoOn", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const adapter = browserAdapter({
      productSlug: PRODUCT,
      baseUrl: BASE,
      autoStart: false,
      offlineStore: null,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/.well-known/polaris.json"))
          return new Response(JSON.stringify(discovery()));
        seen.push({ url, ...(init ? { init } : {}) });
        return new Response(JSON.stringify(MODEL));
      }) as typeof fetch,
    });
    const mac = await adapter.thisPlatform({
      platform: "macos",
      channel: "beta",
    });
    expect(mac.primary?.id).toBe("dl:mac");
    expect(mac.actions.map((a) => a.id)).toEqual(["dl:mac", "brew"]);
    expect(mac.alsoOn).toEqual([{ platform: "windows", label: "Windows" }]);
    expect(seen[0]!.url).toBe(
      `${BASE}/${PRODUCT}/distribution/download.json?channel=beta`,
    );
    // Public: no credential of any kind.
    expect(seen[0]!.init?.credentials).toBe("omit");
    expect(
      (seen[0]!.init?.headers as Record<string, string>).authorization,
    ).toBeUndefined();
    expect(pickPlatform(MODEL, "linux")).toMatchObject({
      platform: "linux",
      primary: null,
      actions: [],
    });
    adapter.dispose();
  });

  it("the visitor's platform comes from the coarse OS family the page reports", () => {
    const ua = (userAgent: string) =>
      browserPlatform({ navigator: { userAgent } });
    expect(ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("macos");
    expect(ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(ua("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(ua("Mozilla/5.0 (Linux; Android 14)")).toBe("android");
    expect(ua("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("ios");
    expect(ua("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)")).toBeNull();
    expect(
      browserPlatform({
        navigator: { userAgentData: { platform: "Windows" } },
      }),
    ).toBe("windows");
    expect(browserPlatform({})).toBeNull();
  });

  it("the desktop adapter forwards to the host's client.distribution", async () => {
    const calls: unknown[] = [];
    const bridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 4,
      invoke: async (service: string, method: string, args?: unknown) => {
        calls.push({ service, method, args });
        return method === "downloadModel"
          ? MODEL
          : pickPlatform(MODEL, "macos");
      },
    };
    const adapter = desktopAdapter({ bridge });
    expect(await adapter.downloadModel({ channel: "beta" })).toEqual(MODEL);
    expect((await adapter.thisPlatform()).platform).toBe("macos");
    expect(calls).toEqual([
      {
        service: "distribution",
        method: "downloadModel",
        args: { channel: "beta" },
      },
      { service: "distribution", method: "thisPlatform", args: {} },
    ]);
    adapter.dispose();
  });
});

describe("crash.tags", () => {
  it("crashTagsFor writes the release the Worker's Sentry hook parses back", () => {
    // packages/worker/test/sentry.test.ts (parseSentryRelease): `<deliverable>@<version>[+<build>]`,
    // the channel as `environment`, the outlet as `pkey.outlet`.
    expect(
      crashTagsFor({
        version: "1.4.0",
        build: "12",
        channel: "stable",
        outlet: "itch",
      }),
    ).toEqual({
      release: "app@1.4.0+12",
      environment: "stable",
      "pkey.outlet": "itch",
    });
    expect(
      crashTagsFor({
        version: "2.0.0",
        deliverable: "levels.a",
        channel: "beta",
        outlet: "steam",
      }),
    ).toEqual({
      release: "levels.a@2.0.0",
      environment: "beta",
      "pkey.outlet": "steam",
    });
    expect(crashTagsFor({ version: "1.0.0", channel: "stable" })).toEqual({
      release: "app@1.0.0",
      environment: "stable",
      "pkey.outlet": "unknown",
    });
  });

  it("the browser adapter tags its version, the version's channel and the resolved outlet", async () => {
    const product = await newTestKey("pkey-test-crash");
    const release = await newTestKey("pkey-test-crash-release");
    const plain = browserAdapter({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.2.3",
      autoStart: false,
      offlineStore: null,
      fetchImpl: (async () => new Response("{}")) as typeof fetch,
    });
    expect(await plain.crashTags({ build: "77" })).toEqual({
      release: "app@1.2.3+77",
      environment: "stable",
      "pkey.outlet": "unknown",
    });
    const web = browserAdapter({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "0.0.0-beta.4",
      autoStart: false,
      offlineStore: null,
      trust: { pinnedKeys: { [product.kid]: product.raw } },
      update: {
        pinnedReleaseKeys: { [release.kid]: release.raw },
        outlet: "web",
      },
      fetchImpl: (async () => new Response("{}")) as typeof fetch,
    });
    expect(await web.crashTags()).toEqual({
      release: "app@0.0.0-beta.4",
      environment: "beta",
      "pkey.outlet": "web",
    });
    plain.dispose();
    web.dispose();
  });

  it("the desktop adapter answers the host's client.crashTags()", async () => {
    const calls: unknown[] = [];
    const tags = {
      release: "app@1.0.0+5",
      environment: "stable",
      "pkey.outlet": "steam",
    };
    const bridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 4,
      invoke: async (service: string, method: string, args?: unknown) => {
        calls.push({ service, method, args });
        return tags;
      },
    };
    const adapter = desktopAdapter({ bridge });
    expect(await adapter.crashTags({ build: "5" })).toEqual(tags);
    expect(calls).toEqual([
      { service: "core", method: "crashTags", args: { build: "5" } },
    ]);
    adapter.dispose();
  });
});
