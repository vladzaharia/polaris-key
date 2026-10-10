// @pkey-feature core.presentation
// Discovery's `core.presentation` in the React SDK (plans/HA-13.md §3): both adapters'
// `presentationSource()`, the browser's icon fetch rules and cache, the desktop bridge's reuse of
// the Node host, and the kit's defaults (name, accent, icon), with the integrator's theme winning.
// The parse, pick and verify rules are client-core's, run against presentation-matrix.json by
// conformance/runners/node and conformance/runners/browser.

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("the adapters hand out the seam", () => {
  it("the browser adapter feeds it from its own discovery", async () => {
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/.well-known/polaris.json")) {
        const d = JSON.parse(discoveryBody()) as Record<string, unknown>;
        d.core = { ...(d.core as object), presentation: member() };
        return new Response(JSON.stringify(d), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/identity/session"))
        return new Response(
          JSON.stringify({ authenticated: false, doc: null, csrfToken: "c" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      return new Response("nf", { status: 404 });
    }) as typeof fetch;
    const adapter = browserAdapter({
      auth: "cookie",
      productSlug: PRODUCT,
      fetchImpl: f,
      presentationCache: memoryPresentationCache(),
    });
    await waitFor(() =>
      expect(adapter.presentationSource().current()?.name).toBe("Drift Kart"),
    );
    adapter.dispose();
  });
});

describe("snapshot: the screen's identity with and without presentation", () => {
  function Logo(): React.JSX.Element {
    const theme = usePolarisTheme();
    const { presentation } = usePresentation();
    return (
      <div data-testid="logo" data-name={presentation?.name ?? ""}>
        {screenLogo(theme)}
      </div>
    );
  }

  function adapterWith(m: unknown) {
    const bridge = {
      ...makeFakeBridge(okBridgeState({ presentation: m })),
      version: 4,
      async invoke(_s: string, method: string) {
        if (method === "presentationIcon") return W64.slice();
        throw new Error("no");
      },
    };
    return new DesktopAdapter({ bridge });
  }

  it("shows the product icon for a fixture with presentation", async () => {
    const adapter = adapterWith(member());
    const { getByTestId } = render(
      <PolarisKeyProvider
        productSlug={PRODUCT}
        adapter={adapter}
        colorScheme="light"
      >
        <Logo />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(getByTestId("logo").querySelector("img")).not.toBeNull(),
    );
    const img = getByTestId("logo").querySelector("img")!;
    expect(img.getAttribute("data-polaris-identity")).toBe("icon");
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(img.getAttribute("alt")).toBe("");
    expect(getByTestId("logo").getAttribute("data-name")).toBe("Drift Kart");
    adapter.dispose();
  });

  it("falls back to the monogram when the icon does not load (a CSP without img-src blob:)", async () => {
    const adapter = adapterWith(member());
    const { getByTestId } = render(
      <PolarisKeyProvider
        productSlug={PRODUCT}
        adapter={adapter}
        colorScheme="light"
      >
        <Logo />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(getByTestId("logo").querySelector("img")).not.toBeNull(),
    );
    getByTestId("logo").querySelector("img")!.dispatchEvent(new Event("error"));
    await waitFor(() =>
      expect(
        getByTestId("logo").querySelector('[data-polaris-identity="monogram"]')
          ?.textContent,
      ).toBe("D"),
    );
    adapter.dispose();
  });

  it("today's output without it: nothing, and the integrator's logo always wins", async () => {
    const none = adapterWith(null);
    const { getByTestId, unmount } = render(
      <PolarisKeyProvider
        productSlug={PRODUCT}
        adapter={none}
        colorScheme="light"
      >
        <Logo />
      </PolarisKeyProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(getByTestId("logo").innerHTML).toBe("");
    unmount();
    none.dispose();

    const withIcon = adapterWith(member());
    const r = render(
      <PolarisKeyProvider
        productSlug={PRODUCT}
        adapter={withIcon}
        colorScheme="light"
        theme={{ logo: <span data-mine="1" /> }}
      >
        <Logo />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(r.getByTestId("logo").getAttribute("data-name")).toBe(
        "Drift Kart",
      ),
    );
    expect(r.getByTestId("logo").querySelector("[data-mine]")).not.toBeNull();
    expect(r.getByTestId("logo").querySelector("img")).toBeNull();
    withIcon.dispose();
  });
});
