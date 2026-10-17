// @pkey-feature server.license server.signin
// The server core through `conformance/corpus/v2/backend-matrix.json` (WIRE-CONTRACT-V4 §14): every
// `verdict` and `problem` row, decided by `createPolarisKey().authenticate()` the way a framework
// adapter calls it. The corpus is read in place and never written.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createPolarisKey,
  type PolarisServerConfig,
  type Requirement,
} from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MATRIX = JSON.parse(
  readFileSync(
    join(ROOT, "conformance", "corpus", "v2", "backend-matrix.json"),
    "utf8",
  ),
) as {
  verdict: {
    id: string;
    input: {
      headers: [string, string][];
      now: number;
      options: {
        products: string[];
        maxAgeSeconds?: number | null;
        require?: (
          | { kind: "entitlement"; name: string }
          | { kind: "signIn" }
        )[];
      };
      trust: Record<string, Record<string, string>>;
    };
    expect: {
      status: number;
      code: string | null;
      context: {
        license: Record<string, unknown>;
        user: { subject: string } | null;
      } | null;
    };
  }[];
  problem: {
    id: string;
    input: { code: never; acceptLanguage: string | null; realm: string };
    expect: {
      status: number;
      locale: string;
      challenge: string | null;
      type: string;
      title: string;
      detail: string;
    };
  }[];
};

function coreFor(row: (typeof MATRIX.verdict)[number]) {
  const { options, trust, now } = row.input;
  const configs: PolarisServerConfig[] = options.products.map((p) => ({
    productSlug: p,
    trust: { pinnedKeys: trust[p] ?? {} },
  }));
  return createPolarisKey({
    config: configs,
    maxAgeSeconds: options.maxAgeSeconds ?? null,
    trustRefresh: false,
    now: () => now,
  });
}

describe("backend-matrix.json verdict rows through the Fetch core", () => {
  for (const row of MATRIX.verdict)
    it(row.id, async () => {
      const core = coreFor(row);
      const require: Requirement[] = (row.input.options.require ?? []).map(
        (r) => r,
      );
      const auth = await core.authenticate(row.input.headers, { require });
      const status = auth.problem ? auth.problem.status : 200;
      expect({ status, code: auth.problem?.code ?? null }).toEqual({
        status: row.expect.status,
        code: row.expect.code,
      });
      const want = row.expect.context;
      if (want === null) {
        expect(auth.license).toBeNull();
        expect(auth.user).toBeNull();
      } else {
        const { holder, ...rest } = want.license;
        expect(auth.license).not.toBeNull();
        expect({
          product: auth.license!.product,
          id: auth.license!.id,
          deviceId: auth.license!.deviceId,
          tier: auth.license!.tier,
          issuedAt: auth.license!.issuedAt,
          ageSeconds: auth.license!.ageSeconds,
        }).toEqual(rest);
        expect(auth.license!.holder).toEqual(holder);
        expect(auth.user).toEqual(want.user);
      }
      // The same request twice: the second answer comes from the cache and says the same.
      const again = await core.authenticate(row.input.headers, { require });
      expect(again.problem?.code ?? null).toBe(row.expect.code);
      expect(again.license?.ageSeconds).toBe(auth.license?.ageSeconds);
    });
});

describe("backend-matrix.json problem rows through refuse()", () => {
  for (const row of MATRIX.problem)
    it(row.id, async () => {
      const headers: [string, string][] =
        row.input.acceptLanguage === null
          ? []
          : [["Accept-Language", row.input.acceptLanguage]];
      const realmCore = createPolarisKey({
        config: { productSlug: row.input.realm, trust: { pinnedKeys: {} } },
        trustRefresh: false,
      });
      const res = realmCore.refuse(row.input.code, headers);
      expect(res.status).toBe(row.expect.status);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("www-authenticate")).toBe(row.expect.challenge);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        type: row.expect.type,
        title: row.expect.title,
        status: row.expect.status,
        detail: row.expect.detail,
        code: row.input.code,
      });
    });
});
