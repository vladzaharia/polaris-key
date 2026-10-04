/**
 * A harness for driving the whole console (`App`) against a scripted fetch: the shell, router,
 * palette and data-layer suites share it.
 */

import { vi } from "vitest";
import { render } from "@testing-library/react";
import { App } from "../src/App.js";
import { resetCache } from "../src/context.js";
import { setLoginRedirectForTests, type Me } from "../src/api.js";
import { resetRouterForTests } from "../src/console/router.js";

export type Enablement = Record<string, { enabled: boolean }>;

export const ALL_ON: Enablement = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: true },
  identity: { enabled: true },
};

export const NONE: Enablement = Object.fromEntries(
  Object.keys(ALL_ON).map((k) => [k, { enabled: false }]),
);

export const ME: Me = {
  sub: "u1",
  name: "Ada Lovelace",
  email: "ada@x.io",
  csrf: "csrf-token",
  platformAdmin: true,
  products: [
    { slug: "djdl", name: "DJDL", schemaVersion: 1 },
    { slug: "acme", name: "Acme", schemaVersion: 1 },
  ],
};

/** The product row the shell reads enablement off (worker `admin/lib/shape.ts`). */
export function productRow(
  slug: string,
  name: string,
  services: Enablement | undefined,
): Record<string, unknown> {
  return {
    slug,
    name,
    signingKid: "kid-1",
    compatMin: "1.0.0",
    compatMax: "2.0.0",
    defaultMaxOfflineDays: 14,
    defaultDeviceLimit: 3,
    adminGroup: null,
    createdAt: 0,
    modifiedAt: 0,
    setup: { status: "ok", healthy: true, nextActions: [] },
    ...(services
      ? {
          services,
          registration: null,
          effectiveRegistration: "requires-license",
          servicesSource: "manifest",
        }
      : {}),
  };
}

export interface FetchLog {
  calls: { path: string; method: string; query: string; body?: string }[];
}

/** A route body that never answers: the page stays in its loading state. */
export const PENDING = Symbol("pending");

/**
 * A scripted fetch: exact path first, then the longest matching prefix; `{}` otherwise. A body
 * may be a `Response` (status, error shapes), `PENDING`, or a function of the request's query
 * (keyset pages).
 */
export function mockFetch(routes: Record<string, unknown>): FetchLog {
  const log: FetchLog = { calls: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const [path = "", query = ""] = url
        .replace("http://localhost", "")
        .split("?");
      log.calls.push({
        path,
        method: init?.method ?? "GET",
        query,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      const key =
        path in routes
          ? path
          : (Object.keys(routes)
              .filter((k) => path.startsWith(k))
              .sort((a, b) => b.length - a.length)[0] ?? "");
      const raw = routes[key];
      if (raw === PENDING) return new Promise<Response>(() => undefined);
      const body =
        typeof raw === "function"
          ? (raw as (q: URLSearchParams) => unknown)(new URLSearchParams(query))
          : raw;
      if (body instanceof Response) return body.clone();
      return new Response(JSON.stringify(body ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return log;
}

export interface BootOptions {
  services?: Enablement;
  /** Per-product enablement, overriding `services` for that slug. */
  perProduct?: Record<string, Enablement | undefined>;
  me?: Partial<Me>;
  extra?: Record<string, unknown>;
}

/** Mount the console at `hash` with a scripted backend. */
export function boot(hash: string, opts: BootOptions = {}): FetchLog {
  window.location.hash = hash;
  const me = { ...ME, ...opts.me };
  const routes: Record<string, unknown> = {
    "/manage/api/me": me,
    "/manage/api/products": {
      products: me.products.map((p) =>
        productRow(
          p.slug,
          p.name,
          opts.perProduct?.[p.slug] ?? opts.services ?? ALL_ON,
        ),
      ),
    },
    "/manage/api/products/djdl/devices": { devices: [], nextCursor: null },
    "/manage/api/products/djdl/devices/summary": {
      total: 0,
      byStatus: [],
      licensed: { licensed: 0, licenseFree: 0 },
      byPlatform: [],
      byArch: [],
      bySdkName: [],
      byAppVersion: [],
    },
    "/manage/api/products/djdl/license/tiers": { tiers: [] },
    "/manage/api/products/djdl/config/profiles": { profiles: [] },
    "/manage/api/products/djdl/activity": { items: [], nextCursor: null },
    ...opts.extra,
  };
  for (const p of me.products) {
    // A test's own route for the product wins (an error response, say).
    if (opts.extra && `/manage/api/products/${p.slug}` in opts.extra) continue;
    routes[`/manage/api/products/${p.slug}`] = {
      product: productRow(
        p.slug,
        p.name,
        p.slug in (opts.perProduct ?? {})
          ? opts.perProduct![p.slug]
          : (opts.services ?? ALL_ON),
      ),
    };
  }
  const log = mockFetch(routes);
  render(<App />);
  return log;
}

/** Reset everything a console render leaves behind. Call in `beforeEach`. */
export function resetConsole(): void {
  window.location.hash = "";
  window.localStorage.clear();
  resetCache();
  resetRouterForTests();
  setLoginRedirectForTests(() => undefined);
  document.title = "";
  // jsdom's window is 1024 px wide, where the desktop sidebar starts as an icon rail; the suites
  // drive the full sidebar, as at 1440 px.
  Object.defineProperty(window, "innerWidth", {
    value: 1440,
    configurable: true,
    writable: true,
  });
  // jsdom lacks these APIs that Radix and cmdk reach for.
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => undefined;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
}
