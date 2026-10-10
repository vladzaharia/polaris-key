import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW } from "./seed.js";
import type { Db } from "../src/db/types.js";
import {
  addConnectionDomain,
  challengeName,
  challengeValue,
  DOH_HOSTS,
  DOMAIN_LAPSE_SECONDS,
  lookupDomainProof,
  recheckConnectionDomains,
  removeConnectionDomain,
  setDomainEnforce,
  txtValue,
  verifyConnectionDomain,
} from "../src/services/identity/connections/domains.js";
import {
  domainEnforced,
  normalizeDomain,
  routeForDomain,
  verifiedDomains,
} from "../src/core/oidc/connections.js";
import { runScheduledMaintenance } from "../src/scheduled.js";
import {
  fakeDoh,
  insertConnection,
  type DohAnswer,
} from "./connectionFixtures.js";

// I-30 (plans/I-27.md §2.3 "Domains", §10): a connection's email domains are proved by a TXT
// record read over DNS-over-HTTPS through the one gated fetch. Exact domains, one verified owner
// per scope, a daily re-check that fails closed.

async function claimed(db: Db, id: string, domain: string): Promise<string> {
  const r = await addConnectionDomain(db, { connectionId: id, domain }, NOW);
  if (!r.ok) throw new Error(`claim refused: ${r.reason}`);
  return r.token;
}

async function domainRow(db: Db, id: string, domain: string) {
  return db.first<{
    verified_at: number | null;
    checked_at: number | null;
    enforce: number;
  }>(
    "SELECT verified_at, checked_at, enforce FROM identity_connection_domains WHERE connection_id = ? AND domain = ?",
    id,
    domain,
  );
}

describe("domain claims", () => {
  it("a claim mints one token per connection and domain and is idempotent", async () => {
    const db = makeTestDb();
    await insertConnection(db, { id: "acme" });
    await insertConnection(db, { id: "other" });
    const a = await addConnectionDomain(
      db,
      { connectionId: "acme", domain: "Example.COM" },
      NOW,
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.domain).toBe("example.com");
    expect(a.record).toBe("_pkey-challenge.example.com");
    expect(a.value).toBe(`pkey-domain-verification=${a.token}`);
    const again = await addConnectionDomain(
      db,
      { connectionId: "acme", domain: "example.com" },
      NOW,
    );
    expect(again.ok && again.token).toBe(a.token);
    const b = await addConnectionDomain(
      db,
      { connectionId: "other", domain: "example.com" },
      NOW,
    );
    expect(b.ok && b.token).not.toBe(a.token);
  });

  it("refuses malformed, wildcard, IP, trailing-dot and non-ASCII domains", async () => {
    const db = makeTestDb();
    await insertConnection(db, { id: "acme" });
    for (const bad of [
      "*.example.com",
      "example.com.",
      "localhost",
      "10.0.0.1",
      "exa mple.com",
      "\u212Aey.com", // Kelvin sign: lower-cases to "key.com"
      "ex\u0430mple.com", // Cyrillic a
      "-bad.example.com",
      "",
    ]) {
      const r = await addConnectionDomain(
        db,
        { connectionId: "acme", domain: bad },
        NOW,
      );
      expect(r, bad).toEqual({ ok: false, reason: "invalid_domain" });
    }
    expect(normalizeDomain("\u212Aey.com")).toBeNull();
    expect(
      await addConnectionDomain(
        db,
        { connectionId: "nobody", domain: "example.com" },
        NOW,
      ),
    ).toEqual({ ok: false, reason: "no_connection" });
  });

  it("remove and enforce act only on an existing claim", async () => {
    const db = makeTestDb();
    await insertConnection(db, { id: "acme" });
    await claimed(db, "acme", "example.com");
    expect(await setDomainEnforce(db, "acme", "example.com", true)).toBe(true);
    expect((await domainRow(db, "acme", "example.com"))?.enforce).toBe(1);
    expect(await setDomainEnforce(db, "acme", "nope.com", true)).toBe(false);
    expect(await removeConnectionDomain(db, "acme", "example.com")).toBe(true);
    expect(await removeConnectionDomain(db, "acme", "example.com")).toBe(false);
  });
});

describe("the DNS-over-HTTPS proof", () => {
  it("joins multi-string TXT data", () => {
    expect(txtValue('"pkey-domain-" "verification=abc"')).toBe(
      "pkey-domain-verification=abc",
    );
    expect(txtValue("plain")).toBe("plain");
  });

  it("verified, absent and erroring answers", async () => {
    const tok = "t0ken";
    const name = challengeName("example.com");
    const cases: Array<[DohAnswer, string]> = [
      [{ kind: "txt", values: [challengeValue(tok)] }, "present"],
      [
        { kind: "txt", values: ["v=spf1 -all", challengeValue(tok)] },
        "present",
      ],
      [{ kind: "txt", values: [challengeValue("other")] }, "absent"],
      [{ kind: "txt", values: [`${challengeValue(tok)}x`] }, "absent"],
      [{ kind: "txt", values: [] }, "absent"],
      [{ kind: "nxdomain" }, "absent"],
      [{ kind: "servfail" }, "error"],
      [{ kind: "throw" }, "error"],
      [{ kind: "raw", status: 200, body: "not json" }, "error"],
      [{ kind: "raw", status: 500, body: "{}" }, "error"],
    ];
    for (const [answer, expected] of cases) {
      const doh = fakeDoh(new Map([[name, answer]]));
      expect(
        await lookupDomainProof("example.com", tok, { fetch: doh.fetch }),
        JSON.stringify(answer),
      ).toBe(expected);
      expect(doh.calls).toHaveLength(1);
      const u = new URL(doh.calls[0]!);
      expect(u.origin).toBe("https://cloudflare-dns.com");
      expect(u.searchParams.get("type")).toBe("TXT");
    }
  });

  it("never follows a redirect off the resolver (negative control)", async () => {
    const name = challengeName("example.com");
    const doh = fakeDoh(
      new Map([[name, { kind: "redirect", to: "https://evil.example/x" }]]),
    );
    expect(
      await lookupDomainProof("example.com", "t", { fetch: doh.fetch }),
    ).toBe("error");
    // The redirect target was never dialled.
    expect(doh.calls).toEqual([
      expect.stringMatching(/^https:\/\/cloudflare-dns\.com\//),
    ]);
  });

  it("the resolver allowlist is exactly cloudflare-dns.com", () => {
    expect(DOH_HOSTS).toEqual(["cloudflare-dns.com"]);
  });
});

describe("verification", () => {
  it("verifies on the connection's own token and keeps the first verified_at", async () => {
    const db = makeTestDb();
    await insertConnection(db, { id: "acme" });
    const tok = await claimed(db, "acme", "example.com");
    const doh = fakeDoh(
      new Map([
        [
          challengeName("example.com"),
          { kind: "txt", values: [challengeValue(tok)] },
        ],
      ]),
    );
    expect(
      await verifyConnectionDomain(db, "acme", "example.com", NOW, {
        fetch: doh.fetch,
      }),
    ).toEqual({ status: "verified", verifiedAt: NOW });
    expect(
      await verifyConnectionDomain(db, "acme", "example.com", NOW + 100, {
        fetch: doh.fetch,
      }),
    ).toEqual({ status: "verified", verifiedAt: NOW });
    expect(await domainRow(db, "acme", "example.com")).toMatchObject({
      verified_at: NOW,
      checked_at: NOW + 100,
    });
    expect(await verifiedDomains(db, "acme")).toEqual(["example.com"]);
  });

  it("a resolver error changes nothing; an absent answer unverifies", async () => {
    const db = makeTestDb();
    await insertConnection(db, { id: "acme" });
    const tok = await claimed(db, "acme", "example.com");
    const records = new Map<string, DohAnswer>([
      [
        challengeName("example.com"),
        { kind: "txt", values: [challengeValue(tok)] },
      ],
    ]);
    const doh = fakeDoh(records);
    await verifyConnectionDomain(db, "acme", "example.com", NOW, {
      fetch: doh.fetch,
    });
    records.set(challengeName("example.com"), { kind: "servfail" });
    expect(
      await verifyConnectionDomain(db, "acme", "example.com", NOW + 10, {
        fetch: doh.fetch,
      }),
    ).toEqual({ status: "error" });
    expect((await domainRow(db, "acme", "example.com"))?.verified_at).toBe(NOW);
    records.set(challengeName("example.com"), { kind: "nxdomain" });
    expect(
      await verifyConnectionDomain(db, "acme", "example.com", NOW + 20, {
        fetch: doh.fetch,
      }),
    ).toEqual({ status: "absent" });
    expect(
      (await domainRow(db, "acme", "example.com"))?.verified_at,
    ).toBeNull();
  });

  it("takeover: B cannot verify A's domain, with A's record or with its own", async () => {
    const db = makeTestDb();
    await insertConnection(db, { id: "a" });
    await insertConnection(db, { id: "b" });
    const ta = await claimed(db, "a", "example.com");
    const tb = await claimed(db, "b", "example.com");
    const records = new Map<string, DohAnswer>([
      [
        challengeName("example.com"),
        { kind: "txt", values: [challengeValue(ta)] },
      ],
    ]);
    const doh = fakeDoh(records);
    expect(
      (
        await verifyConnectionDomain(db, "a", "example.com", NOW, {
          fetch: doh.fetch,
        })
      ).status,
    ).toBe("verified");
    // A's record proves nothing for B: B's token differs.
    expect(
      (
        await verifyConnectionDomain(db, "b", "example.com", NOW, {
          fetch: doh.fetch,
        })
      ).status,
    ).toBe("absent");
    // B publishes its own token too: refused, one verified owner per scope and domain.
    records.set(challengeName("example.com"), {
      kind: "txt",
      values: [challengeValue(ta), challengeValue(tb)],
    });
    expect(
      (
        await verifyConnectionDomain(db, "b", "example.com", NOW, {
          fetch: doh.fetch,
        })
      ).status,
    ).toBe("taken");
    const route = await routeForDomain(
      db,
      "example.com",
      ["platform"],
      "customers",
    );
    expect(route?.connection.id).toBe("a");
    // The partial unique index backs the rule even past the code's check.
    await expect(
      db.run(
        "UPDATE identity_connection_domains SET verified_at = ? WHERE connection_id = 'b'",
        NOW,
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("an unknown claim answers unknown_domain without dialling", async () => {
    const db = makeTestDb();
    await insertConnection(db, { id: "acme" });
    const doh = fakeDoh(new Map());
    expect(
      await verifyConnectionDomain(db, "acme", "example.com", NOW, {
        fetch: doh.fetch,
      }),
    ).toEqual({ status: "unknown_domain" });
    expect(doh.calls).toEqual([]);
  });
});

describe("routing reads only verified, exact domains", () => {
  it("an unverified domain never routes or enforces; subdomains are not covered", async () => {
    const db = makeTestDb();
    await insertConnection(db, { id: "acme" });
    const tok = await claimed(db, "acme", "example.com");
    await setDomainEnforce(db, "acme", "example.com", true);
    expect(
      await routeForDomain(db, "example.com", ["platform"], "customers"),
    ).toBeNull();
    expect(
      await domainEnforced(db, "example.com", ["platform"], "customers"),
    ).toBe(false);
    const doh = fakeDoh(
      new Map([
        [
          challengeName("example.com"),
          { kind: "txt", values: [challengeValue(tok)] },
        ],
      ]),
    );
    await verifyConnectionDomain(db, "acme", "example.com", NOW, {
      fetch: doh.fetch,
    });
    expect(
      (await routeForDomain(db, "example.com", ["platform"], "customers"))
        ?.enforced,
    ).toBe(true);
    for (const other of [
      "sub.example.com",
      "evil-example.com",
      "example.com.evil.net",
      "xn--exmple-cua.com",
      "ex\u0430mple.com", // Cyrillic a
      "EXAMPLE.COM.",
    ]) {
      expect(
        await routeForDomain(db, other, ["platform"], "customers"),
        other,
      ).toBeNull();
    }
  });

  it("disabled connections, other audiences and other scopes do not route", async () => {
    const db = makeTestDb();
    await insertConnection(db, { id: "ops", audience: "operators" });
    await insertConnection(db, { id: "off", status: "disabled" });
    for (const [id, domain] of [
      ["ops", "ops.example"],
      ["off", "off.example"],
    ] as const) {
      const tok = await claimed(db, id, domain);
      const doh = fakeDoh(
        new Map([
          [
            challengeName(domain),
            { kind: "txt", values: [challengeValue(tok)] },
          ],
        ]),
      );
      await verifyConnectionDomain(db, id, domain, NOW, { fetch: doh.fetch });
    }
    expect(
      await routeForDomain(db, "ops.example", ["platform"], "customers"),
    ).toBeNull();
    expect(
      (await routeForDomain(db, "ops.example", ["platform"], "operators"))
        ?.connection.id,
    ).toBe("ops");
    expect(
      await routeForDomain(db, "off.example", ["platform"], "customers"),
    ).toBeNull();
    expect(
      await routeForDomain(db, "ops.example", ["product:acme"], "operators"),
    ).toBeNull();
  });
});

describe("the daily re-check", () => {
  async function verifiedWorld() {
    const db = makeTestDb();
    await insertConnection(db, { id: "acme" });
    const tok = await claimed(db, "acme", "example.com");
    const records = new Map<string, DohAnswer>([
      [
        challengeName("example.com"),
        { kind: "txt", values: [challengeValue(tok)] },
      ],
    ]);
    const doh = fakeDoh(records);
    await verifyConnectionDomain(db, "acme", "example.com", NOW, {
      fetch: doh.fetch,
    });
    return { db, records, doh };
  }

  it("keeps a present proof and refreshes checked_at", async () => {
    const { db, doh } = await verifiedWorld();
    const r = await recheckConnectionDomains(db, NOW + 86_400, {
      fetch: doh.fetch,
    });
    expect(r).toEqual({ checked: 1, kept: 1, unverified: 0, errors: 0 });
    expect(await domainRow(db, "acme", "example.com")).toMatchObject({
      verified_at: NOW,
      checked_at: NOW + 86_400,
    });
  });

  it("an answer without the token unverifies at once (lapse or takeover)", async () => {
    const { db, records, doh } = await verifiedWorld();
    records.set(challengeName("example.com"), {
      kind: "txt",
      values: ["someone-else"],
    });
    const r = await recheckConnectionDomains(db, NOW + 86_400, {
      fetch: doh.fetch,
    });
    expect(r.unverified).toBe(1);
    expect(
      await routeForDomain(db, "example.com", ["platform"], "customers"),
    ).toBeNull();
  });

  it("resolver errors keep the state for 72 h, then unverify", async () => {
    const { db, records, doh } = await verifiedWorld();
    records.set(challengeName("example.com"), { kind: "servfail" });
    const kept = await recheckConnectionDomains(
      db,
      NOW + DOMAIN_LAPSE_SECONDS - 1,
      {
        fetch: doh.fetch,
      },
    );
    expect(kept).toEqual({ checked: 1, kept: 1, unverified: 0, errors: 1 });
    expect((await domainRow(db, "acme", "example.com"))?.verified_at).toBe(NOW);
    const lapsed = await recheckConnectionDomains(
      db,
      NOW + DOMAIN_LAPSE_SECONDS,
      {
        fetch: doh.fetch,
      },
    );
    expect(lapsed).toEqual({ checked: 1, kept: 0, unverified: 1, errors: 1 });
    expect(
      (await domainRow(db, "acme", "example.com"))?.verified_at,
    ).toBeNull();
  });

  it("runs as the maintenance cron's connectionDomains step", async () => {
    const db = makeTestDb();
    const report = await runScheduledMaintenance(db, NOW);
    expect(report.counts.connectionDomains).toBe(0);
    expect(report.failures.connectionDomains).toBeUndefined();
  });
});
