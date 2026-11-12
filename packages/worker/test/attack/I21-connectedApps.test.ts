/**
 * I-21.15, IS-2 and IS-5 (a client's grant and tokens, ended by the person): the Connected apps API
 * cannot be driven by anyone but the account that holds the grant, cannot widen a grant, and ends
 * it atomically. One 404 shape for every client id that is not the caller's; CSRF on both writes;
 * Change fails closed and Disconnect fails open, each on its own budget.
 */
import { describe, expect, it } from "vitest";
import { getClientGrant } from "../../src/services/identity/issuer/grantsRepo.js";
import { NOW } from "../seed.js";
import { SLUG } from "../services/connect/connectFixture.js";
import {
  connectedAppsCall,
  portalSessionFor,
} from "../services/identity/issuer/connectedAppsKit.js";
import { issuerSuite } from "../services/identity/issuer/issuerFlow.js";

const { s, signIn } = issuerSuite("attack-apps-pepper");

const path = (clientId: string, product = SLUG) =>
  `/api/me/connected-apps/${product}/${clientId}`;
const mallory = async () => {
  await s.w.db.run(
    "INSERT INTO accounts (id, status, created_at, modified_at) VALUES ('acct_mallory', 'active', ?, ?)",
    NOW,
    NOW,
  );
  return portalSessionFor(s.w, "acct_mallory", "mallory@example.com");
};
const me = () => portalSessionFor(s.w, s.accountId);
const grantOf = () => getClientGrant(s.w.db, SLUG, s.accountId, s.spa.clientId);

describe("tenancy", () => {
  it("another person's, an unknown, a malformed and another product's client id are one 404", async () => {
    await signIn();
    const eve = await mallory();
    const probes = [
      path(s.spa.clientId), // exists, but not Eve's
      path(`cl_${"A".repeat(22)}`), // well-formed, unknown
      path("nope"), // malformed
      path(s.spa.clientId, "other-product"),
      path(s.spa.clientId, "..%2F..%2Fme"),
    ];
    for (const method of ["PATCH", "DELETE"]) {
      const bodies: string[] = [];
      for (const p of probes) {
        const res = await connectedAppsCall(s.w, eve, method, p, {
          body: method === "PATCH" ? { claims: { email: false } } : undefined,
        });
        expect(res.status, `${method} ${p}`).toBe(404);
        bodies.push(await res.text());
      }
      expect(new Set(bodies).size).toBe(1);
    }
    // Nothing of the owner's changed.
    expect(await grantOf()).toMatchObject({ claimsGranted: ["name", "email"] });
    expect(
      await s.w.db.first(
        "SELECT 1 FROM identity_refresh_tokens WHERE revoked_at IS NOT NULL",
      ),
    ).toBeNull();
  });
});

describe("the session and CSRF", () => {
  it("both writes need the session and the CSRF header, and a refused try changes nothing", async () => {
    await signIn();
    const who = await me();
    for (const [method, body] of [
      ["PATCH", { claims: { email: false } }],
      ["DELETE", undefined],
    ] as const) {
      const noCsrf = await connectedAppsCall(
        s.w,
        who,
        method,
        path(s.spa.clientId),
        {
          csrf: false,
          body,
        },
      );
      expect(noCsrf.status).toBe(403);
      const noSession = await connectedAppsCall(
        s.w,
        who,
        method,
        path(s.spa.clientId),
        {
          cookie: false,
          body,
        },
      );
      expect(noSession.status).toBe(401);
    }
    expect(await grantOf()).toMatchObject({ claimsGranted: ["name", "email"] });
    expect(
      await s.w.db.first(
        "SELECT 1 FROM identity_refresh_tokens WHERE revoked_at IS NOT NULL",
      ),
    ).toBeNull();
    expect(
      (
        await connectedAppsCall(s.w, who, "GET", "/api/me/connected-apps", {
          cookie: false,
        })
      ).status,
    ).toBe(401);
  });

  it("other methods are 405", async () => {
    await signIn();
    for (const method of ["POST", "PUT"])
      expect(
        (
          await connectedAppsCall(
            s.w,
            await me(),
            method,
            path(s.spa.clientId),
            { body: {} },
          )
        ).status,
      ).toBe(405);
  });
});

describe("Change never widens", () => {
  it("a required claim, a line, an undecided claim, an unknown item, a wrong type and extra members are 400", async () => {
    await signIn();
    // The client widened its scopes after the grant: `picture` is decided (declined) but a claim
    // the person was never asked about is not. Forget one decision to make it undecided.
    await s.w.db.run(
      "UPDATE identity_client_grants SET claims_declined_json = '[]' WHERE client_id = ?",
      s.spa.clientId,
    );
    const before = await grantOf();
    const bad: unknown[] = [
      { claims: { name: false } }, // required
      { claims: { picture: true } }, // never decided
      { claims: { entitlements: false } }, // a line
      { claims: { offline: false } },
      { claims: { offline_access: false } },
      { claims: { admin: true } },
      { claims: { email: "no" } },
      { claims: { email: 0 } },
      { claims: {} },
      { claims: [] },
      { claims: { email: false }, scopes: ["openid", "admin"] },
      { scopes: ["openid"] },
      { claims: null },
      {},
    ];
    for (const body of bad) {
      const res = await connectedAppsCall(
        s.w,
        await me(),
        "PATCH",
        path(s.spa.clientId),
        { body },
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // Not an object body.
    const raw = await connectedAppsCall(
      s.w,
      await me(),
      "PATCH",
      path(s.spa.clientId),
      {
        body: [1],
      },
    );
    expect(raw.status).toBe(400);
    expect(await grantOf()).toEqual(before);
  });

  it("never touches the scopes or the scope hash", async () => {
    await signIn();
    const before = (await grantOf())!;
    await connectedAppsCall(s.w, await me(), "PATCH", path(s.spa.clientId), {
      body: { claims: { email: false } },
    });
    const after = (await grantOf())!;
    expect(after.scopes).toEqual(before.scopes);
    expect(after.scopeHash).toBe(before.scopeHash);
    expect(after.grantedAt).toBe(before.grantedAt);
  });

  it("does not bring back a grant that a Disconnect just deleted", async () => {
    await signIn();
    await connectedAppsCall(s.w, await me(), "DELETE", path(s.spa.clientId));
    const res = await connectedAppsCall(
      s.w,
      await me(),
      "PATCH",
      path(s.spa.clientId),
      {
        body: { claims: { email: false } },
      },
    );
    expect(res.status).toBe(404);
    expect(await grantOf()).toBeNull();
  });
});

describe("Disconnect is atomic", () => {
  it("ends every family of the account and client with the grant, and a second one is 404", async () => {
    await signIn();
    await signIn();
    expect(
      (await connectedAppsCall(s.w, await me(), "DELETE", path(s.spa.clientId)))
        .status,
    ).toBe(204);
    expect(await grantOf()).toBeNull();
    expect(
      await s.w.db.first(
        "SELECT 1 FROM identity_refresh_tokens WHERE account_id = ? AND client_id = ? AND revoked_at IS NULL",
        s.accountId,
        s.spa.clientId,
      ),
    ).toBeNull();
    expect(
      (await connectedAppsCall(s.w, await me(), "DELETE", path(s.spa.clientId)))
        .status,
    ).toBe(404);
    // One audit row, naming the client and no secret.
    const rows = await s.w.db.all<{ summary: string; target_id: string }>(
      "SELECT summary, target_id FROM audit WHERE action = 'identity.client.disconnect'",
    );
    expect(rows).toEqual([
      { summary: expect.any(String), target_id: s.spa.clientId },
    ]);
    expect(rows[0]!.summary).not.toMatch(/pkeyo_|Bearer/);
  });
});

describe("the budget (IS-14)", () => {
  it("is 20 a minute per account for Change, apart from Disconnect's, and one account cannot spend another's", async () => {
    await signIn();
    const who = await me();
    for (let i = 0; i < 20; i++)
      expect(
        (
          await connectedAppsCall(s.w, who, "PATCH", path(s.spa.clientId), {
            body: { claims: { email: i % 2 === 0 } },
          })
        ).status,
      ).toBe(200);
    const limited = await connectedAppsCall(
      s.w,
      who,
      "PATCH",
      path(s.spa.clientId),
      {
        body: { claims: { email: true } },
      },
    );
    expect(limited.status).toBe(429);
    expect(await grantOf()).not.toBeNull();
    // A stranger's 404s do not spend the owner's budget, and Disconnect has its own: a spent
    // Change budget never blocks it.
    const eve = await mallory();
    expect(
      (await connectedAppsCall(s.w, eve, "DELETE", path(s.spa.clientId)))
        .status,
    ).toBe(404);
    expect(
      (await connectedAppsCall(s.w, who, "DELETE", path(s.spa.clientId)))
        .status,
    ).toBe(204);
  });

  it("Disconnect is 20 a minute on its own budget", async () => {
    const who = await me();
    for (let i = 0; i < 20; i++) {
      await signIn();
      expect(
        (await connectedAppsCall(s.w, who, "DELETE", path(s.spa.clientId)))
          .status,
      ).toBe(204);
    }
    await signIn();
    expect(
      (await connectedAppsCall(s.w, who, "DELETE", path(s.spa.clientId)))
        .status,
    ).toBe(429);
    expect(await grantOf()).not.toBeNull();
  });

  it("when the limiter cannot be read, Change fails closed and Disconnect fails open", async () => {
    await signIn();
    const who = await me();
    (s.w.env as unknown as Record<string, unknown>).RL = {
      idFromName: () => {
        throw new Error("limiter down");
      },
      get: () => {
        throw new Error("limiter down");
      },
    };
    expect(
      (
        await connectedAppsCall(s.w, who, "PATCH", path(s.spa.clientId), {
          body: { claims: { email: false } },
        })
      ).status,
    ).toBe(429);
    expect(await grantOf()).not.toBeNull();
    expect(
      (await connectedAppsCall(s.w, who, "DELETE", path(s.spa.clientId)))
        .status,
    ).toBe(204);
    expect(await grantOf()).toBeNull();
  });
});
