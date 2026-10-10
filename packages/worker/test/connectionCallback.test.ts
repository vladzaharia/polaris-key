// I-30 (plans/I-27.md §2.3 "The rewritten /callback", "Links", "Pocket ID"; Owner decisions Q1;
// §10): sign-in through a connection, from /login/sso/<id> to /callback, and the
// seed-platform-connection job.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { NOW } from "./seed.js";
import { Device, seededWorld, type CardWorld } from "./identityCardHarness.js";
import { insertConnection } from "./connectionFixtures.js";
import { issuerMetadataResponse } from "./oidcIssuerFake.js";
import {
  ACCOUNT_SESSION_COOKIE,
  EMAIL_GATE_COOKIE,
} from "../src/core/accounts/accountCookies.js";
import {
  EMAIL_ISSUER,
  insertAccount,
  insertLink,
} from "../src/services/identity/accounts/repo.js";
import {
  applyPlatformConnectionSeed,
  downPlatformConnectionSeed,
  planPlatformConnectionSeed,
  PLATFORM_ENV_CONNECTION_ID,
} from "../src/services/identity/connections/seed.js";
import {
  connectionSecretContext,
  openConnectionSecret,
  resolveConnection,
} from "../src/core/oidc/connections.js";
import { open } from "../src/platform/keyvault.js";
import type { Db } from "../src/db/types.js";

const ISSUER = "https://work.idp.example";
const CONN = "conn_work";

let priv: KeyLike;
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
  w: CardWorld,
  d: Device,
  claims: Record<string, unknown>,
): Promise<{ login: Response; callback: Response }> {
  installIdp({}, "unused");
  const login = await d.send(
    "GET",
    `/login/sso/${CONN}?login_hint=ada%40corp.example`,
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
