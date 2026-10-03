// @vitest-environment node
// No ambient credentials on cross-origin reads (P4-18 review). The Worker never sends
// `Access-Control-Allow-Credentials` (`packages/worker/src/core/cors.ts`), so a page that fetches a
// CORS-covered route with `credentials: "include"` from another origin fails CORS outright. Every
// such read here is bearer-only (or public) and fetches with `credentials: "omit"`; only the
// first-party, cookie-bearing identity session routes (never CORS-covered) keep `include`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fetchCatalog } from "../src/browser/catalog.js";
import { fetchChangelog } from "../src/browser/release.js";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

function recorder() {
  const modes: (RequestCredentials | undefined)[] = [];
  const impl = (async (_u: string | URL | Request, init?: RequestInit) => {
    modes.push(init?.credentials);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { impl, modes };
}

describe("credential modes (P4-18 review)", () => {
  it("keeps `include` only on the identity session routes", () => {
    const hits: string[] = [];
    for (const f of files(src)) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (
          /^\s*(\/\/|\*)/.test(line) ||
          !/credentials:\s*"include"/.test(line)
        )
          return;
        const context = lines.slice(Math.max(0, i - 3), i).join("\n");
        hits.push(
          `${relative(src, f)}:${/\/identity\//.test(context) ? "identity" : "OTHER"}`,
        );
      });
    }
    expect(hits).toEqual([
      "browser/browserAdapter.ts:identity",
      "browser/browserAdapter.ts:identity",
      "browser/browserAdapter.ts:identity",
    ]);
  });

  it("reads the catalog and the changelog with no ambient credential", async () => {
    const r = recorder();
    await fetchCatalog({
      baseUrl: "https://key.example.test",
      product: "acme",
      fetchImpl: r.impl,
    });
    await fetchChangelog({
      baseUrl: "https://key.example.test",
      product: "acme",
      fetchImpl: r.impl,
    }).catch(() => undefined);
    expect(r.modes).toEqual(["omit", "omit"]);
  });
});
