// @vitest-environment node
//
// Offline bundle import in both React transports (P1b-07, wire contract v3 §7).
//
// @pkey-feature core.bundle
//
// Runs in the NODE environment: under jsdom, `TextEncoder` output is a typed array from another
// realm and WebCrypto's Ed25519 `verify` rejects every signature, which would test jsdom rather
// than the verifier. Nothing here renders; the hook is covered in useImportBundle.test.tsx.
//
// The verifier is `@polaris-key/client-core`'s `inspectBundle`, and the corpus's `bundleCases`
// (conformance/corpus/v2/cases.json) pin which step refuses for every vector in every SDK. This
// file runs EVERY vector through the browser adapter — a random-device-id store in a fake
// IndexedDB (`fake-indexeddb`), seeded with the vector's device id — and asserts the same
// verdict, then what only React can get wrong: the gate reads `activation: "bundle"`, the bundle
// survives a reload by RE-VERIFYING the stored artifacts, a session supersedes it, a refusal
// writes nothing, and the desktop adapter reaches the host's `importBundle` (bridge protocol v3).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { inspectBundle } from "@polaris-key/client-core";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import {
  indexedDbOfflineStore,
  type OfflineStore,
} from "../src/browser/offline.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { PolarisAdapter } from "../src/core/index.js";
import type { PolarisBridge } from "../src/desktop/bridge.js";
import {
  emptyBridgeState,
  makeFakeBridge,
  makeFakeFetch,
  services,
} from "./fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_PATH = join(
  HERE,
  "..",
  "..",
  "..",
  "conformance",
  "corpus",
  "v2",
  "cases.json",
);

interface BundleCase {
  id: string;
  pinned: Record<string, string>;
  expectedAud: string;
  deviceId: string;
  now: number;
  bundleJws: string;
  expect:
    | { imports: true; docs: ("license" | "config")[] }
    | { imports: false; reason: string };
}

const BUNDLE_CASES = (
  JSON.parse(readFileSync(CASES_PATH, "utf8")) as { bundleCases: BundleCase[] }
)["bundleCases"];

const VALID = BUNDLE_CASES.find((c) => c.id === "bundle-valid-full")!;

/** A fresh fake IndexedDB, with the vector's device id already minted. */
async function seededStore(c: BundleCase): Promise<OfflineStore> {
  const store = indexedDbOfflineStore(new IDBFactory())!;
  await store.write(c.expectedAud, { deviceId: c.deviceId });
  return store;
}

/** The browser adapter for a vector: no session (or the given one), the vector's pins and clock. */
function browserFor(
  c: BundleCase,
  store: OfflineStore,
  opts: { session?: boolean; offline?: boolean } = {},
): PolarisAdapter {
  const fixture = makeFakeFetch(null, {
    product: c.expectedAud,
    capabilities: services("license", "config"),
  });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (opts.offline) throw new TypeError("Failed to fetch");
    const url = String(input);
    if (opts.session && url.endsWith("/identity/session"))
      return new Response(
        JSON.stringify({ authenticated: true, doc: null, csrfToken: "c" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    return fixture(input, init);
  }) as typeof fetch;
  return browserAdapter({
    productSlug: c.expectedAud,
    fetchImpl,
    now: () => c.now,
    trust: { pinnedKeys: c.pinned },
    offlineStore: store,
    expectServices: services("license", "config"),
  });
}

async function settled(adapter: PolarisAdapter): Promise<void> {
  for (let i = 0; i < 100 && adapter.snapshot().phase === "loading"; i++)
    await new Promise((r) => setTimeout(r, 0));
}

describe("browser importBundle() over every corpus bundleCases vector", () => {
  for (const c of BUNDLE_CASES) {
    it(`${c.id}`, async () => {
      const store = await seededStore(c);
      const adapter = browserFor(c, store);
      await settled(adapter);
      if (c.expect.imports) {
        await expect(adapter.importBundle(c.bundleJws)).resolves.toEqual({
          bundleId: expect.any(String),
          imported: c.expect.docs,
        });
        const record = await store.read(c.expectedAud);
        expect(record?.cache?.importedBundle?.importedAt).toBe(c.now);
        // §7: a bundle carrying a licence activates; the gate reads "bundle".
        if (c.expect.docs.includes("license")) {
          expect(adapter.snapshot().activation).toBe("bundle");
          expect(adapter.snapshot().status).toBe("ok");
        }
      } else {
        await expect(adapter.importBundle(c.bundleJws)).rejects.toMatchObject({
          code: "bundle-rejected",
          wireCode: c.expect.reason,
        });
        // All-or-nothing: the refusal wrote nothing, and the gate did not move.
        expect(await store.read(c.expectedAud)).toEqual({
          deviceId: c.deviceId,
        });
        expect(adapter.snapshot().activation).toBeNull();
        expect(adapter.snapshot().error.license?.code).toBe("bundle-rejected");
      }
    });
  }
});

describe("the imported bundle across a reload", () => {
  it("re-verifies the stored artifacts and stays bundle-activated", async () => {
    const store = await seededStore(VALID);
    const first = browserFor(VALID, store);
    await settled(first);
    await first.importBundle(VALID.bundleJws);

    const second = browserFor(VALID, store);
    await settled(second);
    expect(second.snapshot().activation).toBe("bundle");
    expect(second.snapshot().status).toBe("ok");
    expect(second.snapshot().licenseId).not.toBeNull();
    expect(second.snapshot().highWaterMark).toBeGreaterThan(0);
  });

  it("a hand-edited stored document is dropped, never trusted", async () => {
    const store = await seededStore(VALID);
    const first = browserFor(VALID, store);
    await settled(first);
    await first.importBundle(VALID.bundleJws);
    const record = (await store.read(VALID.expectedAud))!;
    const license = record.cache!.docs!.license!;
    const [h, p, sig] = license.split(".");
    await store.write(VALID.expectedAud, {
      ...record,
      cache: {
        ...record.cache!,
        docs: { ...record.cache!.docs, license: `${h}.${p}x.${sig}` },
      },
    });
    const second = browserFor(VALID, store);
    await settled(second);
    expect(second.snapshot().activation).toBeNull();
    expect(second.snapshot().status).toBe("needs-activation");
  });

  it("keeps the page activated while offline", async () => {
    const store = await seededStore(VALID);
    const first = browserFor(VALID, store);
    await settled(first);
    await first.importBundle(VALID.bundleJws);
    const offline = browserFor(VALID, store, { offline: true });
    await settled(offline);
    expect(offline.snapshot().activation).toBe("bundle");
  });

  it("an authenticated session supersedes the bundle (§7)", async () => {
    const store = await seededStore(VALID);
    const first = browserFor(VALID, store);
    await settled(first);
    await first.importBundle(VALID.bundleJws);
    const signedIn = browserFor(VALID, store, { session: true });
    await settled(signedIn);
    expect(signedIn.snapshot().activation).toBe("token");
  });

  it("sign-out wipes the bundle but keeps the device id", async () => {
    const store = await seededStore(VALID);
    const adapter = browserFor(VALID, store);
    await settled(adapter);
    await adapter.importBundle(VALID.bundleJws);
    await adapter.signOut();
    expect(adapter.snapshot().activation).toBeNull();
    expect(await store.read(VALID.expectedAud)).toEqual({
      deviceId: VALID.deviceId,
    });
  });
});

describe("browser bundle import prerequisites", () => {
  it("mints and keeps a random 32-character device id", async () => {
    const store = indexedDbOfflineStore(new IDBFactory())!;
    const adapter = browserAdapter({
      productSlug: "djdl",
      fetchImpl: makeFakeFetch(null, { product: "djdl" }),
      offlineStore: store,
      trust: { pinnedKeys: VALID.pinned },
    });
    const id = await (
      adapter as unknown as { offlineDeviceId(): Promise<string> }
    ).offlineDeviceId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await store.read("djdl"))?.deviceId).toBe(id);
  });

  it("without pinned keys, or without IndexedDB, import is unsupported — not a silent no-op", async () => {
    const noTrust = browserAdapter({
      productSlug: "djdl",
      fetchImpl: makeFakeFetch(null, { product: "djdl" }),
      offlineStore: indexedDbOfflineStore(new IDBFactory()),
    });
    await expect(noTrust.importBundle(VALID.bundleJws)).rejects.toMatchObject({
      code: "bundle-import-unsupported",
    });
    const noStore = browserAdapter({
      productSlug: "djdl",
      fetchImpl: makeFakeFetch(null, { product: "djdl" }),
      offlineStore: null,
      trust: { pinnedKeys: VALID.pinned },
    });
    await expect(noStore.importBundle(VALID.bundleJws)).rejects.toMatchObject({
      code: "bundle-import-unsupported",
    });
  });
});

describe("desktop importBundle() through the host bridge (protocol v3)", () => {
  /** A v3 host: its `importBundle` runs the same verifier `@polaris-key/node` runs, then reports
   *  the bundle-activated state the Node client would. */
  function v3Bridge(c: BundleCase): PolarisBridge {
    const base = makeFakeBridge(
      emptyBridgeState({ capabilities: services("license", "config") }),
    );
    return {
      ...base,
      version: 3,
      async importBundle(jws: string) {
        const r = await inspectBundle(jws, {
          pinned: c.pinned,
          product: c.expectedAud,
          deviceId: c.deviceId,
          now: c.now,
        });
        if (!r.ok)
          throw Object.assign(new Error("refused"), { code: r.reason });
        base.push(
          emptyBridgeState({
            capabilities: services("license", "config"),
            activation: "bundle",
            doc: r.bundle.docs.license?.doc ?? null,
            config: r.bundle.docs.config?.doc.config ?? {},
          }),
        );
        return {
          bundleId: r.bundle.bundleId,
          imported: [
            ...(r.bundle.docs.license ? (["license"] as const) : []),
            ...(r.bundle.docs.config ? (["config"] as const) : []),
          ],
        };
      },
    };
  }

  it("imports the corpus vector and the gate reports activation: bundle", async () => {
    const adapter = desktopAdapter({
      bridge: v3Bridge(VALID),
      now: () => VALID.now,
    });
    await settled(adapter);
    await expect(adapter.importBundle(VALID.bundleJws)).resolves.toMatchObject({
      imported: ["license", "config"],
    });
    expect(adapter.snapshot().activation).toBe("bundle");
    expect(adapter.snapshot().status).toBe("ok");
    adapter.dispose();
  });

  it("a host refusal is bundle-rejected with the §7 step as wireCode", async () => {
    const wrongDevice = BUNDLE_CASES.find(
      (c) => c.id === "bundle-deviceId-mismatches-local",
    )!;
    const adapter = desktopAdapter({
      bridge: v3Bridge(wrongDevice),
      now: () => wrongDevice.now,
    });
    await settled(adapter);
    await expect(
      adapter.importBundle(wrongDevice.bundleJws),
    ).rejects.toMatchObject({
      code: "bundle-rejected",
      wireCode: "bundle-claims-rejected",
    });
    expect(adapter.snapshot().activation).toBeNull();
    adapter.dispose();
  });

  it("a v2 host reports bundle import unsupported", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(emptyBridgeState()),
    });
    await expect(adapter.importBundle(VALID.bundleJws)).rejects.toMatchObject({
      code: "bundle-import-unsupported",
    });
    adapter.dispose();
  });
});
