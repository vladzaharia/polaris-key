/// <reference types="@cloudflare/workers-types" />
// ── The registry host on workerd (F-02, plans/F-01.md §6.1 and §6.3) ─────────────────────────
//
// Two runtime truths Node cannot prove: `crypto.DigestStream` supports the three algorithms
// F-03's ingest needs (SHA-1 and SHA-512 for npm, plus MD5 for Maven; SHA-256 is the blob key
// already), and the dispatcher's isolation holds on the real runtime with the production
// `wrangler.toml` (the brand module for the landing page included).

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { inertDocumentPolicy } from "../src/core/assets/bytesHost.js";
import { landingCsp } from "../src/core/assets/bytesLanding.js";
import { REGISTRY_CSP } from "../src/core/registry/registryHost.js";

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Stream `parts` through a DigestStream for `algorithm`, as ingest streams a tarball. */
async function streamed(algorithm: string, parts: string[]): Promise<string> {
  const stream = new crypto.DigestStream(algorithm);
  const writer = stream.getWriter();
  for (const p of parts) await writer.write(new TextEncoder().encode(p));
  await writer.close();
  return hex(await stream.digest);
}

describe("crypto.DigestStream on workerd (F-03's ingest hashes)", () => {
  // FIPS 180-4 / RFC 1321 test vectors for "abc", fed in three chunks.
  const parts = ["a", "b", "c"];

  it("supports SHA-1", async () => {
    expect(await streamed("SHA-1", parts)).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });

  it("supports SHA-512", async () => {
    expect(await streamed("SHA-512", parts)).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
        "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
  });

  it("supports MD5", async () => {
    expect(await streamed("MD5", parts)).toBe(
      "900150983cd24fb0d6963f7d28e17f72",
    );
  });

  it("hashes a large body streamed in many chunks the same as in one", async () => {
    const chunk = "x".repeat(65_536);
    const many = await streamed("SHA-512", Array(16).fill(chunk));
    const one = hex(
      await crypto.subtle.digest(
        "SHA-512",
        new TextEncoder().encode(chunk.repeat(16)),
      ),
    );
    expect(many).toBe(one);
  });
});

describe("registry host isolation on workerd", () => {
  const hosts = ["pkg.workerd.test", "pkg.workerd.test."];

  it("console, docs, product and byte paths answer the hardened not-found", async () => {
    for (const path of [
      "/manage",
      "/docs",
      "/favicon.ico",
      "/djdl/.well-known/polaris.json",
      "/djdl/distribution/download",
      "/npm/djdl/@djdl%2fsdk",
    ]) {
      for (const host of hosts) {
        const res = await SELF.fetch(`https://${host}${path}`, {
          headers: { cookie: "__Host-pkey_admin=x" },
        });
        const at = host + path;
        expect(res.status, at).toBe(404);
        expect(await res.json(), at).toEqual({ error: "not_found" });
        expect(res.headers.get("content-security-policy"), at).toBe(
          REGISTRY_CSP,
        );
        expect(res.headers.get("x-content-type-options"), at).toBe("nosniff");
        expect(res.headers.get("cross-origin-resource-policy"), at).toBe(
          "same-origin",
        );
        expect(res.headers.get("set-cookie"), at).toBeNull();
      }
    }
  });

  it("GET /v2/ is OCI's base answer; OPTIONS and POST are 405", async () => {
    for (const host of hosts) {
      const res = await SELF.fetch(`https://${host}/v2/`);
      expect(res.status, host).toBe(200);
      expect(res.headers.get("docker-distribution-api-version"), host).toBe(
        "registry/2.0",
      );
      expect(await res.json(), host).toEqual({});
    }
    for (const method of ["OPTIONS", "POST"]) {
      const res = await SELF.fetch(
        "https://pkg.workerd.test/v2/x/blobs/uploads/",
        {
          method,
        },
      );
      expect(res.status, method).toBe(405);
      expect(res.headers.get("access-control-allow-origin"), method).toBeNull();
    }
  });

  it("GET / is the inert landing page; the brand module loads in workerd", async () => {
    const res = await SELF.fetch("https://pkg.workerd.test/");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toBe(await landingCsp());
    expect(inertDocumentPolicy(csp)).toBe(true);
    const html = await res.text();
    expect(html).toContain('aria-label="Polaris Key Delivery"');
    expect(html).toContain("The package registry for libraries and tools");
    expect(html).not.toMatch(/<script/i);
  });
});
