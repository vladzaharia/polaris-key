// Web deltas in a real browser (P4-18; notes/A7 §9.3; RFC 9842): `@polaris-key/react`'s pack
// facet over the real OPFS (its staging worker included), against `dcz.setup.ts`'s server, which
// answers the payload URL with the Worker's own header logic, cross-origin under CORS.
//
//   - A7's v1 → v2: v1 over the payload URL (`Content-Encoding: zstd`, kept as a dictionary), then
//     v2 over dcz, downloading the artifact plus 40 bytes, producing v2's SHA-256;
//   - the dictionary cleared (`Clear-Site-Data: "cache"`): the WASM delta over the blob route;
//   - the artifact corrupt at the source: dcz fails, the WASM delta refuses it, the failure is
//     reported and v1 stays;
//   - a gated pack: never a dictionary, so dcz is never asked for.
//
// Compression Dictionary Transport is Chromium's alone: in Firefox and WebKit the browser offers
// no dictionary, the guard answers 409, and the same updates take the WASM delta (S-04: those
// engines pass the content corpus with the vendored decoder). Each case asserts its engine's path.
//
// @pkey-feature packs.apply.delta packs.apply.full

import { beforeAll, describe, expect, inject, it } from "vitest";
import { commands } from "vitest/browser";
import { loadZstdWasm } from "@polaris-key/zstd-wasm/browser";
import {
  createBrowserPacks,
  type NativePayloadEvent,
  type PackHandler,
  type PackProgress,
} from "@polaris-key/react/packs";

declare module "vitest/browser" {
  interface BrowserCommands {
    /** `vitest.config.ts`: drop Chromium's dictionaries (false: this engine keeps none). */
    clearDictionaries(): Promise<boolean>;
    /** `vitest.config.ts`: set a cookie for `url`'s origin in this browser context. */
    seedCookie(url: string): Promise<void>;
  }
}

const fx = inject("dcz");
const CHROMIUM = /Chrome\//.test(navigator.userAgent);

interface LogEntry {
  product: string;
  path: string;
  query: string;
  availableDictionary: string | null;
  acceptEncoding: string | null;
  status: number;
  sent: string;
  bytes: number;
  cookie: boolean;
}

async function serverLog(product: string): Promise<LogEntry[]> {
  const all = (await (
    await fetch(`${fx.origin}/log`, { cache: "no-store" })
  ).json()) as LogEntry[];
  return all.filter((e) => e.product === product);
}

const LEVEL: PackHandler = {
  type: "custom.level",
  layout: "container",
  activation: "hot",
  supports: (v) => v === 1,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether this page has OPFS: Playwright's WebKit contexts are ephemeral, and WebKit refuses
 *  OPFS there (`UnknownError`), so that engine runs the same updates over the in-memory store. */
let opfs = false;

async function freshOpfs(product: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root
    .getDirectoryHandle("polaris-key")
    .then((d) => d.removeEntry(product, { recursive: true }))
    .catch(() => undefined);
}

function facet(product: string) {
  const p = fx.products[product]!;
  const events: PackProgress[] = [];
  const native: NativePayloadEvent[] = [];
  const packs = createBrowserPacks({
    baseUrl: fx.origin,
    product,
    discovery: {
      version: 2,
      protocolVersion: 4,
      product,
      baseUrl: fx.origin,
      services: {
        release: {
          enabled: true,
          endpoints: {
            record: `${fx.origin}/${product}/release/records/{sha256}`,
          },
        },
        distribution: {
          enabled: true,
          endpoints: {
            blobs: `${fx.origin}/${product}/distribution/blobs/sha256/{sha256}`,
          },
        },
      },
    } as never,
    releaseKeys: { [fx.releaseKid]: fx.releaseKeyRaw },
    productTrust: { [fx.productKid]: fx.productKeyRaw },
    contentStamp: {
      contentApi: 1,
      pins: [
        {
          pack: fx.pack,
          release: {
            sha256: p.v1.sha256,
            seq: p.v1.seq,
            version: p.v1.version,
          },
        },
      ],
      expects: [{ pack: fx.pack, required: true, delivery: "essential" }],
    } as never,
    handlers: [LEVEL],
    storage: opfs ? "opfs" : "memory",
    // A gated pack's bytes need a licence on the real Worker; this server only marks the record.
    entitlements: () => new Set(["vault"]),
    onNativePayload: (e) => native.push(e),
  });
  packs.on((e) => events.push(e));
  const v2 = {
    pack: fx.pack,
    release: { sha256: p.v2.sha256, seq: p.v2.seq, version: p.v2.version },
  };
  return { packs, events, native, p, v2 };
}

beforeAll(async () => {
  console.log(`[dcz] ${navigator.userAgent}; server ${fx.origin}`);
  await loadZstdWasm();
  // An ambient credential exists for the payload server: a credentialed fetch would carry it,
  // and the server refuses any request that does.
  await commands.seedCookie(`${fx.origin}/`);
  try {
    for (const product of Object.keys(fx.products)) await freshOpfs(product);
    opfs = true;
  } catch (e) {
    console.log(
      `[dcz] no OPFS here (${(e as Error).name}): the in-memory store`,
    );
  }
  // Chromium, the CI job this package's acceptance names, always has it.
  if (CHROMIUM) expect(opfs).toBe(true);
});

describe("web deltas over Compression Dictionary Transport (P4-18)", () => {
  it("fetches cross-origin, under CORS", () => {
    expect(new URL(fx.origin).origin).not.toBe(location.origin);
  });

  it("the harness would see an ambient credential: a credentialed fetch carries the cookie and fails CORS", async () => {
    // The Worker's CORS sends no `Access-Control-Allow-Credentials`: the page cannot read it.
    await expect(
      fetch(`${fx.origin}/log`, { credentials: "include" }),
    ).rejects.toThrow();
    const ok = await fetch(`${fx.origin}/log`, { credentials: "omit" });
    expect(ok.status).toBe(200);
  });

  it("updates A7's v1 → v2 by dcz: the artifact plus 40 bytes, v2's SHA-256", async () => {
    const { packs, events, native, p, v2 } = facet("dcz-a");
    const [i1] = await packs.ensure([fx.pack]);
    expect(i1!.payloadSha256).toBe(p.v1.payloadSha256);
    // Chromium registers a dictionary once the response is complete; give it a moment.
    await sleep(1500);
    const [i2] = await packs.ensureReleases([v2]);
    expect(i2!.payloadSha256).toBe(p.v2.payloadSha256);

    const log = await serverLog("dcz-a");
    const v1Req = log.find((e) => e.path.endsWith(p.v1.payloadSha256))!;
    const v2Req = log.filter((e) => e.path.endsWith(p.v2.payloadSha256));
    const blobs = log.filter((e) => e.sent === "blob");
    if (CHROMIUM) {
      expect(v1Req.sent).toBe("zstd");
      expect(v2Req).toHaveLength(1);
      expect(v2Req[0]!.query).toBe("?via=dcz");
      expect(v2Req[0]!.availableDictionary).not.toBeNull();
      expect(v2Req[0]!.sent).toBe("dcz");
      expect(v2Req[0]!.bytes).toBe(p.artifactBytes + 40);
      // Nothing else moved: no blob, no WASM.
      expect(blobs).toEqual([]);
      // Both transfers ran in the OPFS store's worker, straight into the plan's output.
      expect(native.map((e) => `${e.kind} ${e.outcome} ${e.via}`)).toEqual([
        "zstd used worker",
        "dcz used worker",
      ]);
    } else {
      // No CDT: the guard's 409, then the WASM delta's artifact from the blob route.
      expect(v2Req.map((e) => e.status)).toEqual([409]);
      expect(blobs.map((e) => e.path)).toContain(
        `/dcz-a/distribution/blobs/sha256/${p.artifactSha256}`,
      );
    }
    expect(events.some((e) => e.phase === "fallback")).toBe(false);
  });

  it("with the dictionary cleared, falls back to the WASM delta", async () => {
    const { packs, events, native, p, v2 } = facet("dcz-b");
    await packs.ensure([fx.pack]);
    await sleep(1500);
    // Cache eviction, forced: the browser's HTTP cache and its dictionaries are dropped.
    await commands.clearDictionaries();
    await sleep(500);
    const [i2] = await packs.ensureReleases([v2]);
    expect(i2!.payloadSha256).toBe(p.v2.payloadSha256);
    const log = await serverLog("dcz-b");
    const v2Req = log.filter((e) => e.path.endsWith(p.v2.payloadSha256));
    expect(v2Req).toHaveLength(1);
    expect(v2Req[0]!.query).toBe("?via=dcz");
    expect(v2Req[0]!.availableDictionary).toBeNull();
    expect(v2Req[0]!.status).toBe(409);
    expect(log.filter((e) => e.sent === "blob").map((e) => e.path)).toContain(
      `/dcz-b/distribution/blobs/sha256/${p.artifactSha256}`,
    );
    expect(native.map((e) => `${e.kind} ${e.outcome}`).slice(-1)).toEqual([
      "dcz declined",
    ]);
    // A decline is not a failure.
    expect(events.some((e) => e.phase === "fallback")).toBe(false);
  });

  it("with a corrupted artifact, falls back further and reports the failure", async () => {
    const { packs, events, p, v2 } = facet("dcz-c");
    await packs.ensure([fx.pack]);
    await sleep(1500);
    // P4-06's rule: an object whose bytes miss its hash is never applied; the attempt ends
    // with `network-error`, and the next ensure retries it.
    await expect(packs.ensureReleases([v2])).rejects.toMatchObject({
      code: "network-error",
    });
    expect((await packs.state()).active[fx.pack]!.payloadSha256).toBe(
      p.v1.payloadSha256,
    );
    const log = await serverLog("dcz-c");
    const fallbacks = events.filter((e) => e.phase === "fallback");
    if (CHROMIUM) {
      expect(log.find((e) => e.path.endsWith(p.v2.payloadSha256))!.sent).toBe(
        "dcz",
      );
      // The browser could not decode the corrupt dcz body, or its output missed v2's hash.
      expect(fallbacks).toEqual([
        expect.objectContaining({ strategy: "delta", via: "native" }),
      ]);
    } else expect(fallbacks).toEqual([]);
    // Then the WASM delta fetched the artifact, and refused it.
    expect(
      log.some(
        (e) =>
          e.sent === "blob" &&
          e.path === `/dcz-c/distribution/blobs/sha256/${p.artifactSha256}`,
      ),
    ).toBe(true);
  });

  it("never asks a gated pack for dcz: no dictionary is ever offered for one", async () => {
    const { packs, native, p, v2 } = facet("dcz-g");
    await packs.ensure([fx.pack]);
    await sleep(500);
    const [i2] = await packs.ensureReleases([v2]);
    expect(i2!.payloadSha256).toBe(p.v2.payloadSha256);
    const log = await serverLog("dcz-g");
    expect(log.some((e) => e.query === "?via=dcz")).toBe(false);
    expect(log.every((e) => e.availableDictionary === null)).toBe(true);
    // The whole payload still came over the payload URL; the delta took the WASM path.
    expect(native.map((e) => e.kind)).toEqual(["zstd"]);
    expect(log.filter((e) => e.sent === "blob").map((e) => e.path)).toContain(
      `/dcz-g/distribution/blobs/sha256/${p.artifactSha256}`,
    );
  });

  it("sent no pack request with an ambient credential, in any case above", async () => {
    const all = (await (
      await fetch(`${fx.origin}/log`, { cache: "no-store" })
    ).json()) as LogEntry[];
    const packs = all.filter((e) => e.product.startsWith("dcz-"));
    expect(packs.length).toBeGreaterThan(0);
    expect(packs.filter((e) => e.cookie)).toEqual([]);
  });
});
