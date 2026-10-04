/**
 * F-10 automation — deploy.yml's registration step (scripts/register-platform.mjs): it sends the
 * root `.pkey/` to the deploy hook with the job's OIDC token for the hook's audience, masks the
 * token, and fails loudly with the Worker's reason on a refusal.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readManifestFiles,
  registerPlatform,
} from "../scripts/register-platform.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL:
    "https://oidc.example.test/token?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-bearer",
  GITHUB_ACTIONS: "true",
};

function fakeFetch(answer: { status: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("https://oidc.example.test/"))
      return new Response(JSON.stringify({ value: "the.oidc.jwt" }), {
        status: 200,
      });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("register-platform.mjs", () => {
  it("reads the root .pkey/ documents", () => {
    const files = readManifestFiles(ROOT);
    expect(Object.keys(files).sort()).toEqual(["product", "release", "schema"]);
    expect(files.product).toContain('slug: "polaris-key"');
  });

  it("asks for the hook's audience, posts the manifest with the token, and masks it", async () => {
    const { impl, calls } = fakeFetch({
      status: 200,
      body: { ok: true, slug: "polaris-key", packages: ["npm.node"] },
    });
    const out: string[] = [];
    const r = await registerPlatform({
      origin: "https://key.example.test/",
      root: ROOT,
      env: ENV,
      fetchImpl: impl,
      out: { write: (s: string) => out.push(s) },
    });
    expect(r.slug).toBe("polaris-key");
    expect(calls[0]!.url).toBe(
      "https://oidc.example.test/token?api-version=2.0&audience=https%3A%2F%2Fkey.example.test%2Fwebhooks%2Fdeploy",
    );
    expect(
      (calls[0]!.init?.headers as Record<string, string>).authorization,
    ).toBe("Bearer request-bearer");
    expect(calls[1]!.url).toBe("https://key.example.test/webhooks/deploy");
    expect(
      (calls[1]!.init?.headers as Record<string, string>).authorization,
    ).toBe("Bearer the.oidc.jwt");
    const sent = JSON.parse(String(calls[1]!.init?.body)) as {
      files: Record<string, string>;
    };
    expect(Object.keys(sent.files).sort()).toEqual([
      "product",
      "release",
      "schema",
    ]);
    // The only line that names the token is the mask itself.
    expect(out.filter((l) => l.includes("the.oidc.jwt"))).toEqual([
      "::add-mask::the.oidc.jwt\n",
    ]);
  });

  it("fails with the Worker's reason on a refusal", async () => {
    const { impl } = fakeFetch({
      status: 403,
      body: {
        error: "forbidden",
        reason: "policy_mismatch",
        message: "the job must run in the production environment",
      },
    });
    await expect(
      registerPlatform({
        origin: "https://key.example.test",
        root: ROOT,
        env: ENV,
        fetchImpl: impl,
        out: { write: () => undefined },
      }),
    ).rejects.toThrow(
      "the deploy hook refused the registration (403): policy_mismatch: the job must run in the production environment",
    );
  });

  it("needs id-token: write", async () => {
    await expect(
      registerPlatform({
        origin: "https://key.example.test",
        root: ROOT,
        env: {},
        out: { write: () => undefined },
      }),
    ).rejects.toThrow(/id-token: write/);
  });
});
