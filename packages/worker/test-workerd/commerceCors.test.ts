/// <reference types="@cloudflare/workers-types" />
// ── The commerce bridge's CORS surface on workerd (SP-16) ──────────────────────────────────
//
// `distribution/commerce/binding` and `distribution/commerce/claim` joined `core/cors.ts`'s
// covered paths so a bearer-mode page on one of the product's own `web.origins` can call them.
// This drives the real `src/index.ts` over HTTP: a listed origin gets the preflight's allow set
// and the response's allow-origin; an unlisted origin gets a bare 204 and no `Access-Control-*`
// at all; the store hook beside them stays uncovered. The product here has no commerce settings
// and the requests carry no device bearer, so every answer is a refusal (a commerce route on a
// product without commerce is the service not-found) — the headers are what is under test, and
// they are decided from the path shape, never from whether the service behind it answers.

import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import djdlCatalog from "../../../products/djdl/catalog.json";
import { D1Db } from "../src/db/d1.js";
import {
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  CORS_EXPOSE_HEADERS,
  CORS_MAX_AGE,
  serializeWebOrigins,
} from "../src/core/cors.js";
import { seedProduct } from "./seed.js";

const SLUG = "djdlcors";
const LISTED = "https://play.djdl.example";
const UNLISTED = "https://evil.example";
const BASE = `https://key.plrs.im/${SLUG}/distribution/commerce`;

/** Every Access-Control-* header on a response, lower-cased names. */
function acHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("access-control-"))
      out[key.toLowerCase()] = value;
  });
  return out;
}

beforeAll(async () => {
  const db = new D1Db(env.DB);
  await seedProduct(env, db, SLUG, djdlCatalog);
  await db.run(
    "UPDATE products SET web_origins_json = ? WHERE slug = ?",
    serializeWebOrigins([LISTED]),
    SLUG,
  );
});

const ROUTES: [string, "GET" | "POST"][] = [
  ["binding", "GET"],
  ["claim", "POST"],
];

describe("workerd: CORS on the commerce binding and claim routes", () => {
  for (const [route, method] of ROUTES) {
    it(`${route}: the preflight answers a listed origin with the allow set`, async () => {
      const res = await SELF.fetch(`${BASE}/${route}`, {
        method: "OPTIONS",
        headers: {
          origin: LISTED,
          "access-control-request-method": method,
          "access-control-request-headers": "authorization, content-type",
        },
      });
      expect(res.status).toBe(204);
      expect(acHeaders(res)).toEqual({
        "access-control-allow-origin": LISTED,
        "access-control-allow-methods": CORS_ALLOW_METHODS,
        "access-control-allow-headers": CORS_ALLOW_HEADERS,
        "access-control-max-age": CORS_MAX_AGE,
      });
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      expect(res.headers.get("vary")).toContain("Origin");
    });

    it(`${route}: the preflight gives an unlisted origin a bare 204`, async () => {
      const res = await SELF.fetch(`${BASE}/${route}`, {
        method: "OPTIONS",
        headers: {
          origin: UNLISTED,
          "access-control-request-method": method,
        },
      });
      expect(res.status).toBe(204);
      expect(acHeaders(res)).toEqual({});
    });

    it(`${route}: the response carries the allow-origin for a listed origin only`, async () => {
      const init = (origin: string): RequestInit => ({
        method,
        headers: {
          origin,
          "x-pkey-device": "workerd-cors-1",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST"
          ? { body: JSON.stringify({ store: "steam" }) }
          : {}),
      });
      // Refused (no commerce settings, no device bearer), and still decorated for the page.
      const listed = await SELF.fetch(`${BASE}/${route}`, init(LISTED));
      expect(listed.ok).toBe(false);
      expect(acHeaders(listed)).toEqual({
        "access-control-allow-origin": LISTED,
        "access-control-expose-headers": CORS_EXPOSE_HEADERS,
      });
      expect(listed.headers.get("vary")).toContain("Origin");
      await listed.body?.cancel();

      const other = await SELF.fetch(`${BASE}/${route}`, init(UNLISTED));
      expect(other.status).toBe(listed.status);
      expect(acHeaders(other)).toEqual({});
      expect(other.headers.get("vary")).toContain("Origin");
      await other.body?.cancel();
    });
  }

  it("the store hooks beside them stay uncovered", async () => {
    const res = await SELF.fetch(
      `https://key.plrs.im/${SLUG}/distribution/hooks/app-store`,
      {
        method: "OPTIONS",
        headers: { origin: LISTED, "access-control-request-method": "POST" },
      },
    );
    expect(acHeaders(res)).toEqual({});
  });
});
