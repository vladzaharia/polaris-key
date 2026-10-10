// @vitest-environment node
// @pkey-feature core.presentation
// Discovery's `core.presentation` in the React SDK (plans/HA-13.md §3), the sources: the browser's
// icon fetch rules and cache, the desktop bridge's reuse of the Node host, and the kit's theme
// defaults (the integrator wins, then the product, then the icon, then ink). Node's environment:
// jsdom's typed arrays are another realm's, which Node's WebCrypto refuses. The screens are in
// presentation.test.tsx.
// The parse, pick and verify rules are client-core's, run against presentation-matrix.json by
// conformance/runners/node and conformance/runners/browser.

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import {
  BridgePresentationSource,
  BrowserPresentationSource,
  memoryPresentationCache,
  safeIconUrl,
  type PresentationCache,
} from "../src/core/presentation.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { DesktopAdapter } from "../src/desktop/desktopAdapter.js";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { usePolarisTheme } from "../src/react/hooks.js";
import { usePresentation } from "../src/react/usePresentation.js";
import { screenLogo } from "../src/components/brand.js";
import { mergeTheme } from "../src/components/theme.js";
import { isolate, withPresentation } from "../src/react/presentationTheme.js";
import {
  PRESENTATION_CACHE_MAX_FILES,
  PRESENTATION_ICON_MAX_BYTES,
} from "../src/constants.generated.js";
import { discoveryBody, makeFakeBridge, okBridgeState } from "./fixtures.js";

const PRODUCT = "acme";
const IMG = "https://img.plrs.im";
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

const PNG = bytes("png-original");
const W64 = bytes("webp-64");
const W128 = bytes("webp-128");
const ORIGINAL = `${IMG}/${PRODUCT}/a/${sha(PNG)}`;

function member(over: Record<string, unknown> = {}) {
  return {
    name: "Drift Kart",
    developerName: "Lanternworks",
    accent: "#FF6A3D",
    icon: {
      sha256: sha(PNG),
      contentType: "image/png",
      width: 1024,
      height: 1024,
      original: ORIGINAL,
      url: `${ORIGINAL}/{w}.webp`,
      sizes: [
        { w: 64, sha256: sha(W64) },
        { w: 128, sha256: sha(W128) },
      ],
    },
    ...over,
  };
}

const doc = (m: unknown) => ({
  product: PRODUCT,
  name: PRODUCT,
  core: m === undefined ? {} : { presentation: m },
});

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function iconServer(routes: Record<string, () => Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    return routes[url]?.() ?? new Response("missing", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}
const ok = (b: Uint8Array) => () => new Response(b.slice(), { status: 200 });
const allIcons = () => ({
  [ORIGINAL]: ok(PNG),
  [`${ORIGINAL}/64.webp`]: ok(W64),
  [`${ORIGINAL}/128.webp`]: ok(W128),
});

function source(
  f: typeof fetch,
  cache: PresentationCache = memoryPresentationCache(),
): BrowserPresentationSource {
  return new BrowserPresentationSource({
    product: PRODUCT,
    fetchImpl: () => f,
    cache,
  });
}

// jsdom has no object URLs: count what the source creates and revokes.
let created: string[] = [];
let revoked: string[] = [];
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
beforeEach(() => {
  created = [];
  revoked = [];
  URL.createObjectURL = ((b: Blob) => {
    const u = `blob:test/${created.length}-${b.type}`;
    created.push(u);
    return u;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((u: string) => {
    revoked.push(u);
  }) as typeof URL.revokeObjectURL;
});
afterEach(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

describe("BrowserPresentationSource: the member", () => {
  it("parses each discovery, notifies on change only, and clears on none", async () => {
    const s = source(iconServer({}).fetch);
    const heard: (string | null)[] = [];
    s.subscribe((p) => heard.push(p?.name ?? null));
    await s.accept(doc(member()));
    await s.accept(doc(member()));
    expect(s.current()?.accent).toBe("#ff6a3d");
    await s.accept(doc(undefined));
    expect(s.current()).toBeNull();
    expect(heard).toEqual(["Drift Kart", null]);
  });

  it("a cold start reads the stored member back; a doctored record is dropped", async () => {
    const cache = memoryPresentationCache();
    await source(iconServer({}).fetch, cache).accept(doc(member()));
    const cold = source(iconServer({}).fetch, cache);
    await cold.load();
    expect(cold.current()?.name).toBe("Drift Kart");

    const stored = (await cache.readMember(PRODUCT)) as Record<string, unknown>;
    for (const bad of [
      {
        ...stored,
        presentation: { ...(stored.presentation as object), accent: "#ABCDEF" },
      },
      { ...stored, product: "other" },
      { ...stored, v: 2 },
    ]) {
      await cache.writeMember(PRODUCT, bad);
      const again = source(iconServer({}).fetch, cache);
      await again.load();
      expect(again.current()).toBeNull();
      expect(await cache.readMember(PRODUCT)).toBeNull();
    }
  });
});

describe("BrowserPresentationSource: the fetch rules", () => {
  it("one plain GET: no headers, no credentials, no redirect, no referrer", async () => {
    const srv = iconServer(allIcons());
    const s = source(srv.fetch);
    await s.accept(doc(member()));
    expect(await s.icon(32, 2)).toEqual(W64);
    const [c] = srv.calls;
    expect(c!.url).toBe(`${ORIGINAL}/64.webp`);
    expect(c!.init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(new Headers(c!.init?.headers).entries().next().done).toBe(true);
    expect(c!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("a followed redirect, a non-200, a throw, oversize bytes and a hash mismatch are misses", async () => {
    const redirected = () => {
      const r = new Response(W64.slice(), { status: 200 });
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    };
    const big = () =>
      new Response(new Uint8Array(16), {
        status: 200,
        headers: { "content-length": String(PRESENTATION_ICON_MAX_BYTES + 1) },
      });
    for (const route of [
      redirected,
      () => new Response(null, { status: 302, headers: { location: "/x" } }),
      () => new Response(W64.slice(), { status: 203 }),
      () => {
        throw new TypeError("redirect mode is error");
      },
      big,
      ok(W128),
    ]) {
      const cache = memoryPresentationCache();
      const s = source(
        iconServer({ [`${ORIGINAL}/64.webp`]: route }).fetch,
        cache,
      );
      await s.accept(doc(member()));
      expect(await s.icon(32, 1)).toBeNull();
      expect(await cache.icons()).toEqual([]);
    }
  });

  it("refuses non-https and off-origin URLs before dialling", async () => {
    expect(safeIconUrl(`${ORIGINAL}/64.webp`, ORIGINAL)).toBe(true);
    expect(
      safeIconUrl("http://127.0.0.1:8787/a", "http://127.0.0.1:8787/b"),
    ).toBe(true);
    expect(safeIconUrl("http://img.plrs.im/a", "http://img.plrs.im/a")).toBe(
      false,
    );
    expect(safeIconUrl("https://evil.example/a", ORIGINAL)).toBe(false);
  });

  it("caches verified bytes by hash, re-hashes them, and keeps at most the cap", async () => {
    let t = 0;
    const cache = memoryPresentationCache(() => ++t);
    const srv = iconServer(allIcons());
    const s = source(srv.fetch, cache);
    await s.accept(doc(member()));
    await s.icon(32, 1);
    expect(await s.icon(32, 1)).toEqual(W64);
    expect(srv.calls).toHaveLength(1);
    // Tampered: deleted and fetched again.
    await cache.writeIcon(sha(W64), bytes("tampered"));
    expect(await s.icon(32, 1)).toEqual(W64);
    expect(srv.calls).toHaveLength(2);
    // The member moves on: what it no longer names goes.
    await s.accept(
      doc(member({ icon: { ...member().icon, url: undefined, sizes: [] } })),
    );
    expect((await cache.icons()).map((i) => i.sha256)).toEqual([]);

    const blobs = Array.from(
      { length: PRESENTATION_CACHE_MAX_FILES + 2 },
      (_, i) => bytes(`s${i}`),
    );
    const ladder = member({
      icon: {
        ...member().icon,
        sizes: blobs.map((b, i) => ({ w: (i + 1) * 10, sha256: sha(b) })),
      },
    });
    const routes: Record<string, () => Response> = {};
    blobs.forEach(
      (b, i) => (routes[`${ORIGINAL}/${(i + 1) * 10}.webp`] = ok(b)),
    );
    const many = source(iconServer(routes).fetch, cache);
    await many.accept(doc(ladder));
    for (let i = 0; i < blobs.length; i++) await many.icon((i + 1) * 10, 1);
    const left = (await cache.icons()).map((i) => i.sha256).sort();
    expect(left).toEqual(
      blobs
        .slice(-PRESENTATION_CACHE_MAX_FILES)
        .map((b) => sha(b))
        .sort(),
    );
  });

  it("iconUrl(): one blob: URL per verified bytes, typed, revoked when the member drops them", async () => {
    const s = source(iconServer(allIcons()).fetch);
    await s.accept(doc(member()));
    const a = await s.iconUrl(32, 1);
    const b = await s.iconUrl(48, 1);
    expect(a).toBe(b);
    expect(a).toMatch(/^blob:.*image\/webp$/);
    expect(await s.iconUrl(32, 8)).toMatch(/image\/png$/); // past the ladder: the original
    await s.accept(doc(undefined));
    expect(revoked.sort()).toEqual(created.sort());
    expect(await s.iconUrl(32, 1)).toBeNull();
  });
});

describe("the desktop adapter reuses the host's Node client", () => {
  it("takes the member from the host's state, the bytes over the bridge, and verifies them", async () => {
    const invoked: string[] = [];
    const bridge = {
      ...makeFakeBridge(okBridgeState({ presentation: member() })),
      version: 4,
      async invoke(service: string, method: string) {
        invoked.push(`${service}.${method}`);
        if (method === "presentationIcon") return W64.slice();
        throw Object.assign(new Error("no"), { code: "invoke-not-allowed" });
      },
    };
    const adapter = new DesktopAdapter({ bridge });
    const src = adapter.presentationSource();
    await vi.waitFor(() => expect(src.current()?.name).toBe("Drift Kart"));
    expect(src.current()?.accent).toBe("#ff6a3d");
    // The member crossed with the state: nothing was invoked until the icon was asked for.
    expect(invoked).toEqual([]);
    expect(await src.icon(32, 1)).toEqual(W64);
    expect(invoked).toEqual(["core.presentationIcon"]);
    // A push without a member clears it.
    bridge.push(okBridgeState({ presentation: null }));
    expect(src.current()).toBeNull();
    adapter.dispose();

    // Bytes that are not the pick's are refused in the renderer too.
    const liar = new BridgePresentationSource(async () => W128.slice());
    liar.adopt(member());
    expect(await liar.icon(32, 1)).toBeNull();

    // An older host sends no member and refuses the verb: no presentation, no error.
    const old = new DesktopAdapter({
      bridge: { ...makeFakeBridge(okBridgeState()), version: 3 },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(old.presentationSource().current()).toBeNull();
    expect(await old.presentationSource().icon(32, 1)).toBeNull();
    old.dispose();
  });
});

describe("the kit's defaults: the integrator wins, then the product, then ink", () => {
  const ink = mergeTheme(undefined, "light").tokens.accent;

  it("react: Drift Kart's light accent on a light ground and on a dark ground", () => {
    const p = { name: "Drift Kart", accent: "#ff6a3d" };
    for (const scheme of ["light", "dark"] as const) {
      const t = mergeTheme(withPresentation(undefined, p), scheme);
      const asIntegrator = mergeTheme(
        { tokens: { accent: "#ff6a3d" } },
        scheme,
      );
      expect(t.tokens.accent).toBe(asIntegrator.tokens.accent);
      expect(t.tokens.accent).not.toBe(
        mergeTheme(undefined, scheme).tokens.accent,
      );
      expect(t.copy.productName).toBe(isolate("Drift Kart"));
    }
  });

  it("accentDark in the dark scheme", () => {
    const p = { name: "P", accent: "#ff6a3d", accentDark: "#2ed6e6" };
    expect(
      mergeTheme(withPresentation(undefined, p), "dark").tokens.accent,
    ).toBe(mergeTheme({ tokens: { accent: "#2ed6e6" } }, "dark").tokens.accent);
  });

  it("react: the integrator's accent and name win over presentation", () => {
    const p = { name: "Drift Kart", accent: "#ff6a3d" };
    const t = mergeTheme(
      withPresentation(
        { tokens: { accent: "#2f6fde" }, copy: { productName: "Mine" } },
        p,
      ),
      "light",
    );
    expect(t.tokens.accent).toBe(
      mergeTheme({ tokens: { accent: "#2f6fde" } }, "light").tokens.accent,
    );
    expect(t.copy.productName).toBe("Mine");
  });

  it("the icon's accent when the product names none; either branding takes the product's", () => {
    const p = { name: "P" };
    expect(
      mergeTheme(withPresentation(undefined, p, "#2f6fde"), "light").tokens
        .accent,
    ).toBe(
      mergeTheme({ tokens: { accent: "#2f6fde" } }, "light").tokens.accent,
    );
    const branded = { branding: "polaris-key" as const };
    expect(
      mergeTheme(
        withPresentation(branded, { name: "P", accent: "#ff6a3d" }),
        "dark",
      ).tokens.accent,
    ).toBe(
      mergeTheme({ ...branded, tokens: { accent: "#ff6a3d" } }, "dark").tokens
        .accent,
    );
  });

  it("no presentation: ink, and today's output", () => {
    expect(withPresentation(undefined, null)).toBeUndefined();
    expect(
      mergeTheme(withPresentation(undefined, null), "light").tokens.accent,
    ).toBe(ink);
  });
});
