// Recurrence lint: an unauthenticated per-client rate-limit bucket must be
// keyed on `clientNetwork(req)` (IPv4, or the IPv6 /64), never on `clientIp(req)` — one routed
// /64 is 2^64 source addresses and would otherwise get a fresh budget per address.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
// Files allowed to read `clientIp`: its definition, the email limiter (which pairs the exact
// address with a /24 and /48 network bucket), and Turnstile (the remote IP is sent to Cloudflare).
const ALLOWED = new Set([
  join("core", "rateLimit.ts"),
  join("core", "notify", "emailLimits.ts"),
  join("services", "identity", "card", "turnstile.ts"),
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("rate-limit bucket keys", () => {
  it("no caller outside the allowlist uses clientIp", () => {
    const offenders = walk(SRC)
      .filter((f) => !ALLOWED.has(f.slice(SRC.length + 1)))
      .filter((f) => /\bclientIp\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});
