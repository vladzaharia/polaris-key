// I-30 (plans/I-27.md §2.3 "The rewritten /callback", "Links", "Pocket ID"; Owner decisions Q1;
// §10): sign-in through a connection, from /login/sso/<id> to /callback, and the
// seed-platform-connection job.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { NOW } from "../../seed.js";
import {
  Device,
  seededWorld,
  type CardWorld,
} from "../../identityCardHarness.js";
import { insertConnection } from "../../connectionFixtures.js";
import { issuerMetadataResponse } from "../../oidcIssuerFake.js";
import {
  ACCOUNT_SESSION_COOKIE,
  EMAIL_GATE_COOKIE,
} from "../../../src/core/accounts/accountCookies.js";
import {
  EMAIL_ISSUER,
  insertAccount,
  insertLink,
} from "../../../src/services/identity/accounts/repo.js";
import {
  applyPlatformConnectionSeed,
  downPlatformConnectionSeed,
  planPlatformConnectionSeed,
  PLATFORM_ENV_CONNECTION_ID,
} from "../../../src/services/identity/connections/seed.js";
import {
  connectionSecretContext,
  openConnectionSecret,
  resolveConnection,
} from "../../../src/core/oidc/connections.js";
import { open } from "../../../src/platform/keyvault.js";
import type { Db } from "../../../src/db/types.js";
import { setServices } from "../../../src/core/products/store.js";
import { SERVICE_SLUGS } from "../../../src/core/services.js";
import { seedProduct } from "../../seed.js";

const ISSUER = "https://work.idp.example";
const CONN = "conn_work";

let priv: CryptoKey;
let pubJwk: Record<string, unknown>;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256");
  priv = pair.privateKey;
  pubJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "work-1",
    alg: "ES256",
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The IdP: discovery, the JWKS, and a token endpoint that answers `claims` for the flow. */
function installIdp(claims: Record<string, unknown>, nonce: string): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u = String(input instanceof Request ? input.url : input);
    const meta = await issuerMetadataResponse(u, pubJwk);
    if (meta) return meta;
    if (u.endsWith("/api/oidc/token")) {
      const idToken = await new SignJWT({ nonce, ...claims })
        .setProtectedHeader({ alg: "ES256", kid: "work-1" })
        .setIssuer(ISSUER)
        .setAudience(`client-${CONN}`)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(priv);
      return new Response(JSON.stringify({ id_token: idToken }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

/** A platform connection for customers, with `domains` verified, mapping groups and a claim. */
async function workConnection(
  w: CardWorld,
  domains: string[] = [],
  claimMap: Record<string, unknown> = {
    groups: "groups",
    claims: ["department"],
    name: "name",
    birthdate: "birthdate",
  },
): Promise<void> {
  await insertConnection(w.db, {
    id: CONN,
    label: "Work",
    issuer: ISSUER,
    audience: "both",
  });
  await w.db.run(
    "UPDATE identity_connections SET claim_map_json = ? WHERE id = ?",
    JSON.stringify(claimMap),
    CONN,
  );
  for (const d of domains) {
    await w.db.run(
      `INSERT INTO identity_connection_domains
         (connection_id, scope, domain, token, verified_at, checked_at, enforce)
       VALUES (?, 'platform', ?, 'tok', ?, ?, 0)`,
      CONN,
      d,
      NOW,
      NOW,
    );
  }
}

async function emailAccount(db: Db, email: string): Promise<string> {
  const a = await insertAccount(
    db,
    { primaryEmail: email, primaryEmailVerified: true, displayName: null },
    NOW,
  );
  await insertLink(
    db,
    a.id,
    {
      issuerKey: EMAIL_ISSUER,
      tenantScope: "",
      subject: email,
      kind: "email",
      email,
      emailVerified: true,
      displayName: null,
      amr: null,
    },
    NOW,
  );
  return a.id;
}

/** `/login/sso/<id>`, the IdP, then `/callback`, in one browser. */
async function signInThrough(
  _w: CardWorld,
  d: Device,
  claims: Record<string, unknown>,
  query = "",
): Promise<{ login: Response; callback: Response }> {
  installIdp({}, "unused");
  const login = await d.send(
    "GET",
    `/login/sso/${CONN}?login_hint=ada%40corp.example${query}`,
  );
  expect(login.status).toBe(302);
  const authorize = new URL(login.headers.get("location")!);
  installIdp(claims, authorize.searchParams.get("nonce")!);
  const callback = await d.send(
    "GET",
    `/callback?code=c&state=${authorize.searchParams.get("state")}`,
  );
  return { login, callback };
}

describe("/login/sso/<id>", () => {
  it("starts the code flow at the discovered endpoint, with PKCE, state, nonce and the hint", async () => {
    const w = await seededWorld();
    await workConnection(w);
    installIdp({}, "unused");
    const res = await new Device(w).send(
      "GET",
      `/login/sso/${CONN}?login_hint=ada%40corp.example`,
    );
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get("location")!);
    expect(`${u.origin}${u.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(u.searchParams.get("client_id")).toBe(`client-${CONN}`);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toMatch(/\/callback$/);
    expect(u.searchParams.get("login_hint")).toBe("ada@corp.example");
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(u.searchParams.get("nonce")).toBeTruthy();
  });

  it("an unreachable connection is named; an enforced domain says there is no other way in", async () => {
    const w = await seededWorld();
    await workConnection(w, ["corp.example"]);
    await w.db.run("UPDATE identity_connection_domains SET enforce = 1");
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const path = `/login/sso/${CONN}?login_hint=ada%40corp.example`;
    const enforced = await new Device(w).send("GET", path);
    expect(enforced.status).toBe(502);
    const html = await enforced.text();
    expect(html).toContain("Can&#x27;t reach Work");
    expect(html).toContain("corp.example addresses sign in only through Work");
    expect(html).toContain("Try again");
    expect(html).toContain("login_hint=ada%40corp.example");
    await w.db.run("UPDATE identity_connection_domains SET enforce = 0");
    const open = await (await new Device(w).send("GET", path)).text();
    expect(open).toContain("Use a different email");
    expect(open).not.toContain("only through");
  });

  it("an unknown, disabled, operators-only or product connection is not offered", async () => {
    const w = await seededWorld();
    await insertConnection(w.db, { id: "c_off", status: "disabled" });
    await insertConnection(w.db, { id: "c_ops", audience: "operators" });
    await insertConnection(w.db, {
      id: "c_prod",
      scope: "product:acme",
      audience: "customers",
    });
    installIdp({}, "unused");
    for (const id of ["nope", "c_off", "c_ops", "c_prod", "..%2F"]) {
      const res = await new Device(w).send("GET", `/login/sso/${id}`);
      expect(res.status, id).toBe(404);
    }
  });
});

describe("/callback through a connection", () => {
  it("with no verified domain, the address is not vouched for: the gate opens and no account is made", async () => {
    const w = await seededWorld();
    await workConnection(w);
    const d = new Device(w);
    const { callback } = await signInThrough(w, d, {
      sub: "w-1",
      email: "ada@corp.example",
      email_verified: true,
    });
    expect(callback.status).toBe(302);
    expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(true);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(await w.db.all("SELECT id FROM accounts")).toEqual([]);
    expect(await w.db.all("SELECT id FROM account_links")).toEqual([]);
  });

  it("Q1: a verified domain and an address verified on exactly one account auto-links, mails and audits", async () => {
    const w = await seededWorld();
    await workConnection(w, ["corp.example"]);
    const ada = await emailAccount(w.db, "ada@corp.example");
    const d = new Device(w);
    const { callback } = await signInThrough(w, d, {
      sub: "w-1",
      email: "ada@corp.example",
      email_verified: true,
      name: "Ada",
      groups: ["eng", "eng", "ops", "bad\u0007name"],
      department: "games",
      birthdate: "1990-01-02",
    });
    expect(callback.status).toBe(302);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    const link = await w.db.first<{
      account_id: string;
      groups_json: string | null;
      claims_json: string | null;
      profile_json: string | null;
    }>(
      `SELECT account_id, groups_json, claims_json, profile_json FROM account_links
        WHERE issuer_key = ? AND subject = 'w-1'`,
      ISSUER,
    );
    expect(link?.account_id).toBe(ada);
    // Only mapped, well-formed values are kept: groups de-duplicated, a control character dropped.
    expect(JSON.parse(link!.groups_json!)).toEqual(["eng", "ops"]);
    expect(JSON.parse(link!.claims_json!)).toEqual({ department: "games" });
    // The birth date is never stored on a link.
    const row = await w.db.first<Record<string, unknown>>(
      "SELECT * FROM account_links WHERE subject = 'w-1'",
    );
    expect(JSON.stringify(row)).not.toContain("1990-01-02");
    expect(
      await w.db.first(
        "SELECT id FROM portal_audit WHERE action = 'account.link.auto'",
      ),
    ).not.toBeNull();
    expect(w.mail.some((m) => /Work was connected/.test(m.subject))).toBe(true);
    const session = await w.db.first<{ amr_json: string }>(
      "SELECT amr_json FROM account_sessions WHERE account_id = ?",
      ada,
    );
    expect(JSON.parse(session!.amr_json)).toEqual([`connection:${CONN}`]);
  });

  it("keys the link by one form of the subject: the lookup, Q1's link and the sign-in agree", async () => {
    const w = await seededWorld();
    await workConnection(w, ["corp.example"]);
    const ada = await emailAccount(w.db, "ada@corp.example");
    const claims = {
      sub: " w-9 ",
      email: "ada@corp.example",
      email_verified: true,
    };
    const first = new Device(w);
    await signInThrough(w, first, claims);
    expect(first.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    // Again from another browser: the same link signs the same account in.
    const second = new Device(w);
    await signInThrough(w, second, claims);
    expect(second.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    const links = await w.db.all<{ account_id: string; subject: string }>(
      "SELECT account_id, subject FROM account_links WHERE issuer_key = ?",
      ISSUER,
    );
    expect(links).toEqual([{ account_id: ada, subject: "w-9" }]);
  });

  it("keeps a claim named like an Object member as a plain key, never a prototype write", async () => {
    const w = await seededWorld();
    await workConnection(w, ["corp.example"], {
      claims: ["__proto__", "constructor", "department"],
    });
    await emailAccount(w.db, "ada@corp.example");
    const d = new Device(w);
    await signInThrough(w, d, {
      sub: "w-10",
      email: "ada@corp.example",
      email_verified: true,
      department: "games",
      // An own `__proto__` member, as JSON.parse makes it from a token.
      ...(JSON.parse('{"__proto__":"admins"}') as Record<string, unknown>),
    });
    const link = await w.db.first<{ claims_json: string | null }>(
      "SELECT claims_json FROM account_links WHERE subject = 'w-10'",
    );
    // `constructor` is not in the token, so an inherited value is never read for it.
    expect(link?.claims_json).toBe(
      '{"__proto__":"admins","department":"games"}',
    );
  });

  it("Q1 never links outside its conditions: an unverified email claim, a lookalike or a shared address", async () => {
    for (const claims of [
      { email: "ada@corp.example", email_verified: false },
      { email: "ada@sub.corp.example", email_verified: true },
      { email: "ada@corp.example.evil.net", email_verified: true },
    ]) {
      const w = await seededWorld();
      await workConnection(w, ["corp.example"]);
      await emailAccount(w.db, claims.email);
      const d = new Device(w);
      const { callback } = await signInThrough(w, d, { sub: "w-2", ...claims });
      expect(callback.status).toBe(302);
      expect(d.jar.has(ACCOUNT_SESSION_COOKIE), claims.email).toBe(false);
      expect(
        await w.db.first("SELECT id FROM account_links WHERE subject = 'w-2'"),
      ).toBeNull();
    }
    // The address verified on two accounts: the join offer, never a guess.
    const w = await seededWorld();
    await workConnection(w, ["corp.example"]);
    await emailAccount(w.db, "ada@corp.example");
    const second = await insertAccount(
      w.db,
      {
        primaryEmail: "ada@corp.example",
        primaryEmailVerified: true,
        displayName: null,
      },
      NOW,
    );
    expect(second.id).toBeTruthy();
    const d = new Device(w);
    await signInThrough(w, d, {
      sub: "w-3",
      email: "ada@corp.example",
      email_verified: true,
    });
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(
      await w.db.first("SELECT id FROM account_links WHERE subject = 'w-3'"),
    ).toBeNull();
  });
});

describe("seed-platform-connection", () => {
  it("dry-runs, applies with the secret sealed, is a no-op the second time, and goes down", async () => {
    const w = await seededWorld();
    w.env.PLATFORM_OIDC_ISSUER = "https://id.plrs.example";
    w.env.PLATFORM_OIDC_CLIENT_ID = "platform-client";
    w.env.PLATFORM_OIDC_CLIENT_SECRET = "platform-SENTINEL";
    const a = await insertAccount(
      w.db,
      { primaryEmail: null, primaryEmailVerified: false, displayName: null },
      NOW,
    );
    await w.db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind,
         created_at, last_used_at) VALUES ('lnk_old', ?, 'oidc', '', 's-1', 'oidc', ?, ?)`,
      a.id,
      NOW,
      NOW,
    );

    const plan = await planPlatformConnectionSeed(w.env, w.db, NOW);
    expect(plan.action).toBe("insert");
    expect(plan.row).toMatchObject({
      id: PLATFORM_ENV_CONNECTION_ID,
      issuer: "https://id.plrs.example",
      clientId: "platform-client",
      hasSecret: true,
      audience: "both",
      source: "env",
    });
    expect(JSON.stringify(plan)).not.toContain("SENTINEL");
    expect(plan.linksLegacyOidc).toBe(1);
    expect(
      await resolveConnection(w.db, PLATFORM_ENV_CONNECTION_ID),
    ).toBeNull();

    const first = await applyPlatformConnectionSeed(w.env, w.db, NOW);
    expect(first.inserted).toBe(true);
    const sealed = await w.db.first<{ client_secret_sealed: string }>(
      "SELECT client_secret_sealed FROM identity_connections WHERE id = ?",
      PLATFORM_ENV_CONNECTION_ID,
    );
    expect(sealed!.client_secret_sealed).not.toContain("SENTINEL");
    expect(
      await open(
        w.env,
        sealed!.client_secret_sealed,
        connectionSecretContext(PLATFORM_ENV_CONNECTION_ID),
      ),
    ).toBe("platform-SENTINEL");
    expect(
      await openConnectionSecret(w.env, w.db, PLATFORM_ENV_CONNECTION_ID),
    ).toBe("platform-SENTINEL");

    // The row is now the only source: a changed env does not rewrite it.
    w.env.PLATFORM_OIDC_CLIENT_ID = "changed";
    const second = await applyPlatformConnectionSeed(w.env, w.db, NOW + 1);
    expect(second.inserted).toBe(false);
    expect(second.connection?.clientId).toBe("platform-client");
    expect((await planPlatformConnectionSeed(w.env, w.db, NOW)).action).toBe(
      "exists",
    );

    expect(await downPlatformConnectionSeed(w.db)).toBe(1);
    expect(
      await resolveConnection(w.db, PLATFORM_ENV_CONNECTION_ID),
    ).toBeNull();
  });

  it("seeds nothing without the trio", async () => {
    const w = await seededWorld();
    expect((await planPlatformConnectionSeed(w.env, w.db, NOW)).action).toBe(
      "no-env",
    );
    expect(
      (await applyPlatformConnectionSeed(w.env, w.db, NOW)).connection,
    ).toBeNull();
  });
});

// B-063: a card opened for a product (`?product=<slug>`) signs in through its connection with that
// product's terms, as the providers do (I-09). The connection's start used to drop the product.
describe("a connection sign-in the card opened for a product (B-063)", () => {
  const TERMS = { version: "2026-10", url: "https://djdl.example/terms" };

  async function djdl(w: CardWorld, identity = true): Promise<void> {
    await seedProduct(w.db, "djdl");
    await setServices(
      w.db,
      "djdl",
      JSON.stringify(
        Object.fromEntries(
          SERVICE_SLUGS.map((s) => [
            s,
            { enabled: s === "license" || (identity && s === "identity") },
          ]),
        ),
      ),
      "manifest",
      NOW,
    );
    await w.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES ('djdl', 'identity.terms', ?, 'manifest', ?, 'resync')`,
      JSON.stringify(TERMS),
      NOW,
    );
  }

  async function gateView(
    d: Device,
  ): Promise<{ terms: unknown; product: { slug: string } | null }> {
    return (await (
      await d.send("GET", "/api/signin/confirm-email", undefined, {
        headers: { origin: "https://key.plrs.im" },
      })
    ).json()) as { terms: unknown; product: { slug: string } | null };
  }

  const CLAIMS = {
    sub: "w-1",
    email: "ada@corp.example",
    email_verified: true,
  };

  it("hands the email gate the product and its terms", async () => {
    const w = await seededWorld();
    await workConnection(w);
    await djdl(w);
    const d = new Device(w);
    const { callback } = await signInThrough(w, d, CLAIMS, "&product=djdl");
    expect(callback.status).toBe(302);
    const view = await gateView(d);
    expect(view.terms).toEqual(TERMS);
    expect(view.product?.slug).toBe("djdl");
  });

  it("a plain sign-in asks no product's terms", async () => {
    const w = await seededWorld();
    await workConnection(w);
    await djdl(w);
    const d = new Device(w);
    await signInThrough(w, d, CLAIMS);
    const view = await gateView(d);
    expect(view.terms).toBeNull();
    expect(view.product).toBeNull();
  });

  it("ignores a product that is not a slug, is unknown, or has Identity off", async () => {
    for (const product of ["..%2Fdjdl", "nope", "djdl"]) {
      const w = await seededWorld();
      await workConnection(w);
      await djdl(w, product !== "djdl");
      const d = new Device(w);
      await signInThrough(w, d, CLAIMS, `&product=${product}`);
      const view = await gateView(d);
      expect(view.product, product).toBeNull();
      expect(view.terms, product).toBeNull();
    }
  });
});

// B-074: signing in again with the same account in a browser that holds its session ends the
// session the new cookie replaces; another account's session is never touched.
describe("the session a connection sign-in replaces (B-074)", () => {
  const CLAIMS = {
    sub: "w-1",
    email: "ada@corp.example",
    email_verified: true,
  };

  it("ends this account's previous session, so the browser is listed once", async () => {
    const w = await seededWorld();
    await workConnection(w, ["corp.example"]);
    const ada = await emailAccount(w.db, "ada@corp.example");
    const d = new Device(w);
    await signInThrough(w, d, CLAIMS);
    await signInThrough(w, d, CLAIMS);
    const rows = await w.db.all<{ revoked_at: number | null }>(
      "SELECT revoked_at FROM account_sessions WHERE account_id = ? ORDER BY created_at, rowid",
      ada,
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.revoked_at === null)).toHaveLength(1);
    expect((await d.me()).status).toBe(200);
    // The ending is on the account's audit trail, once, and the first sign-in (nothing to
    // replace) left none.
    const audit = await w.db.all(
      "SELECT 1 FROM portal_audit WHERE account_id = ? AND action = 'account.session.replaced'",
      ada,
    );
    expect(audit).toHaveLength(1);
  });

  it("leaves another account's session alone", async () => {
    const w = await seededWorld();
    await workConnection(w, ["corp.example"]);
    await emailAccount(w.db, "ada@corp.example");
    const bob = await emailAccount(w.db, "bob@corp.example");
    const d = new Device(w);
    await signInThrough(w, d, {
      sub: "w-2",
      email: "bob@corp.example",
      email_verified: true,
    });
    await signInThrough(w, d, CLAIMS);
    const live = await w.db.all(
      "SELECT 1 FROM account_sessions WHERE account_id = ? AND revoked_at IS NULL",
      bob,
    );
    expect(live).toHaveLength(1);
    // Nothing of bob's ended, so nothing is audited on either account.
    expect(
      await w.db.all(
        "SELECT 1 FROM portal_audit WHERE action = 'account.session.replaced'",
      ),
    ).toHaveLength(0);
  });

  it("a forged or foreign cookie ends nothing", async () => {
    const w = await seededWorld();
    await workConnection(w, ["corp.example"]);
    const ada = await emailAccount(w.db, "ada@corp.example");
    const first = new Device(w);
    await signInThrough(w, first, CLAIMS);
    const second = new Device(w);
    second.jar.set(
      ACCOUNT_SESSION_COOKIE,
      `${first.jar.get(ACCOUNT_SESSION_COOKIE)!}x`,
    );
    await signInThrough(w, second, CLAIMS);
    const live = await w.db.all(
      "SELECT 1 FROM account_sessions WHERE account_id = ? AND revoked_at IS NULL",
      ada,
    );
    expect(live).toHaveLength(2);
  });
});
