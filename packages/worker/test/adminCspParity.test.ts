/**
 * The admin/portal SPA shells' inline scripts must be exactly the ones the CSP allows.
 *
 * `adminCsp.ts` lists the SHA-256 of every inline <script> in `packages/admin/index.html` and
 * `manage.html` (today one: the pre-paint theme script). A shell that gains an inline script
 * the list lacks would have it blocked in production with no test noticing; a hash left behind
 * after the script changes is a stale allowance. This suite sweeps the BUILT shells, so it also
 * catches a build step that rewrites the inline script. It skips cleanly when the admin dist
 * does not exist (worker-only iteration); `packages/admin/test/theme.test.tsx` checks the
 * sources on every run regardless.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADMIN_SCRIPT_HASHES } from "../src/adminCsp.js";
import { appSecurityHeaders } from "../src/securityHeaders.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "admin", "dist");
const SHELLS = ["index.html", "manage.html"];

const SCRIPT_RE = /<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/gi;

function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = m.groups?.attrs ?? "";
    const body = m.groups?.body ?? "";
    if (/\ssrc\s*=/i.test(attrs) || body.length === 0) continue;
    out.push(
      `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`,
    );
  }
  return out;
}

describe("the SPA CSP allows the shells' inline scripts by hash", () => {
  it("script-src is 'self' plus exactly the listed hashes, never 'unsafe-inline'", () => {
    const csp = appSecurityHeaders().get("content-security-policy") ?? "";
    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toBe(
      ["script-src", "'self'", ...ADMIN_SCRIPT_HASHES].join(" "),
    );
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("style-src 'self'");
  });
});

describe.skipIf(!existsSync(join(dist, "manage.html")))(
  "adminCsp.ts ↔ admin dist parity",
  () => {
    it("the inline-script hashes of the built shells equal ADMIN_SCRIPT_HASHES", () => {
      const found = new Set<string>();
      for (const shell of SHELLS) {
        for (const h of inlineScriptHashes(
          readFileSync(join(dist, shell), "utf8"),
        ))
          found.add(h);
      }
      expect([...found].sort()).toEqual([...ADMIN_SCRIPT_HASHES].sort());
    });
  },
);
