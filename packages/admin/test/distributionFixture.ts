/**
 * The unit suites' driver for the Distribution and Update pages (admin chunk 9): `bootWith` mounts
 * the whole console against the fixtures in `distributionData.ts` and records every request with
 * its method and body.
 */

import { vi } from "vitest";
import { render } from "@testing-library/react";
import * as React from "react";
import { App } from "../src/App.js";
import { ALL_ON, ME, productRow, type Enablement } from "./consoleHarness.js";
import { DISTRIBUTION_ROUTES } from "./distributionData.js";

export * from "./distributionData.js";

export interface Call {
  path: string;
  query: string;
  method: string;
  body: unknown;
}

/** A route answer: a body, a `Response`, or a function of the call. */
export type Answer = unknown | Response | ((call: Call) => unknown | Response);

/**
 * Mount the whole console at `hash` against the fixtures. `routes` keys are a path (any method)
 * or `"METHOD path"`; exact paths win, then the longest prefix. Every call is recorded.
 */
export function bootWith(
  hash: string,
  routes: Record<string, Answer> = {},
  opts: { services?: Enablement } = {},
): { calls: Call[] } {
  const calls: Call[] = [];
  window.location.hash = hash;
  const services = opts.services ?? ALL_ON;
  const table: Record<string, Answer> = {
    "/manage/api/me": ME,
    "/manage/api/products": {
      products: ME.products.map((p) => productRow(p.slug, p.name, services)),
    },
    "/manage/api/products/djdl": {
      product: productRow("djdl", "DJDL", services),
    },
    "/manage/api/products/acme": {
      product: productRow("acme", "Acme", services),
    },
    ...DISTRIBUTION_ROUTES,
    ...routes,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
        "http://localhost",
      );
      const method = init?.method ?? "GET";
      const raw = typeof init?.body === "string" ? init.body : undefined;
      const call: Call = {
        path: url.pathname,
        query: url.search,
        method,
        body: raw ? JSON.parse(raw) : undefined,
      };
      calls.push(call);
      const keyed = (k: string) => (k in table ? k : null);
      const prefix = (m: string | null) =>
        Object.keys(table)
          .filter((k) => {
            const [km, kp] = k.includes(" ") ? k.split(" ") : [null, k];
            return (km === null || km === m) && call.path.startsWith(kp!);
          })
          .sort((a, b) => b.length - a.length)[0] ?? null;
      const key =
        keyed(`${method} ${call.path}`) ??
        (method === "GET" ? keyed(call.path) : null) ??
        prefix(method);
      let answer: Answer = key ? table[key] : {};
      if (method !== "GET" && key && !key.includes(" ")) answer = { ok: true };
      if (typeof answer === "function")
        answer = (answer as (c: Call) => unknown)(call);
      if (answer instanceof Response) return answer.clone();
      return new Response(JSON.stringify(answer ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  render(React.createElement(App));
  return { calls };
}

/** A JSON error response, in the admin API's shape. */
export function apiError(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  message?: string,
): Response {
  return new Response(
    JSON.stringify({
      error: { code, ...(message ? { message } : {}), ...extra },
      code,
      ...extra,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** The writes a run made (everything but GET). */
export function writes(calls: Call[]): Call[] {
  return calls.filter((c) => c.method !== "GET");
}
