/**
 * The Config pages' harness: the whole console (`App`) against a scripted backend that answers by
 * method and path and records every write with its body, so a page test can assert the exact
 * request a mutation sent and the refetch that followed it.
 */

import { vi } from "vitest";
import { render } from "@testing-library/react";
import { App } from "../src/App.js";
import { ALL_ON, ME, productRow, type Enablement } from "./consoleHarness.js";

export type Reply =
  | unknown
  | Response
  | ((body: unknown) => unknown | Response | Promise<unknown>);

export interface Call {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

export interface Backend {
  calls: Call[];
  /** Replace or add a route while the page is open (`"PUT /path"` or `"/path"`). */
  set: (key: string, reply: Reply) => void;
  writes: () => Call[];
  reads: (path: string) => number;
}

const P = "/manage/api/products/djdl";

export const BASE_ROUTES: Record<string, Reply> = {
  [`${P}/license/tiers`]: { tiers: [] },
  [`${P}/config/profiles`]: { profiles: [] },
  [`${P}/devices/summary`]: {
    total: 0,
    byStatus: [],
    licensed: { licensed: 0, licenseFree: 0 },
    byPlatform: [],
    byArch: [],
    bySdkName: [],
    byAppVersion: [],
  },
  [`${P}/activity`]: { items: [], nextCursor: null },
};

/** Mount the console at `hash` with routes keyed `"METHOD /path"` or `"/path"` (any method). */
export function bootConfig(
  hash: string,
  routes: Record<string, Reply> = {},
  opts: { services?: Enablement; product?: Record<string, unknown> } = {},
): Backend {
  window.location.hash = hash;
  const table: Record<string, Reply> = {
    "/manage/api/me": ME,
    "/manage/api/products": {
      products: ME.products.map((p) => ({
        ...productRow(p.slug, p.name, opts.services ?? ALL_ON),
        ...(p.slug === "djdl" ? opts.product : {}),
      })),
    },
    ...Object.fromEntries(
      ME.products.map((p) => [
        `/manage/api/products/${p.slug}`,
        {
          product: {
            ...productRow(p.slug, p.name, opts.services ?? ALL_ON),
            ...(p.slug === "djdl" ? opts.product : {}),
          },
        },
      ]),
    ),
    ...BASE_ROUTES,
    ...routes,
  };
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const full = url.replace("http://localhost", "");
      const [path, query = ""] = full.split("?") as [string, string?];
      const method = init?.method ?? "GET";
      let body: unknown = undefined;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ method, path, query, body });
      const reply =
        `${method} ${path}` in table
          ? table[`${method} ${path}`]
          : path in table
            ? table[path]
            : {};
      const value: unknown = await (typeof reply === "function"
        ? reply(body)
        : reply);
      if (value instanceof Response) return value.clone();
      return new Response(JSON.stringify(value ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  render(<App />);
  return {
    calls,
    set: (key, reply) => {
      table[key] = reply;
    },
    writes: () => calls.filter((c) => c.method !== "GET"),
    reads: (path) =>
      calls.filter((c) => c.method === "GET" && c.path === path).length,
  };
}

/** A JSON error response, in the admin API's flat shape. */
export function apiError(
  status: number,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({ error: { code: "bad_request", ...extra }, ...extra }),
    { status, headers: { "content-type": "application/json" } },
  );
}
