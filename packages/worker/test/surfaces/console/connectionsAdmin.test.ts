// I-31 (plans/I-27.md §2.3, brand transition admin-3-19): the operator's side of connections.
// Platform area and step-up on every change; https-only issuers with an SSRF-safe discovery;
// sealed secrets that are never shown back; an audit row per change; and the test sign-in's four
// rules (bound to the operator and the draft, claims shown and not stored, provider text plain,
// the same-tab return by a fixed path).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { NOW } from "../../seed.js";
import {
  Device,
  seededWorld,
  type CardWorld,
} from "../../identityCardHarness.js";
import { issuerMetadataResponse } from "../../oidcIssuerFake.js";
import { handleAdminApi } from "../../../src/console/api.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import {
  connectionSecretContext,
  resolveConnection,
} from "../../../src/core/oidc/connections.js";
import { open } from "../../../src/platform/keyvault.js";
import { plainProviderText } from "../../../src/services/identity/connections/testSignIn.js";
import { challengeName } from "../../../src/services/identity/connections/domains.js";
import { adminOidcConfig } from "../../../src/platform/platformOidc.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import {
  newBindingId,
  stmtInsertBinding,
} from "../../../src/core/rbac/bindings.js";
import { operatorRouteForEmail } from "../../../src/core/rbac/operatorConnections.js";
import { routeForDomain } from "../../../src/core/oidc/connections.js";

const ISSUER = "https://sso.corp.example";
const SECRET = "s3cr3t-value-that-must-never-come-back";

let priv: CryptoKey;
let pubJwk: Record<string, unknown>;
let fetched: string[];
let tokenClaims: Record<string, unknown> = {};
let tokenNonce = "";
let dns: "present" | "absent" = "absent";
let dnsToken = "";

beforeEach(async () => {
  const pair = await generateKeyPair("ES256");
  priv = pair.privateKey;
  pubJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };
  fetched = [];
  dns = "absent";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u = String(input instanceof Request ? input.url : input);
    fetched.push(u);
    if (u.startsWith("https://cloudflare-dns.com/dns-query")) {
      const name = new URL(u).searchParams.get("name");
      return new Response(
        JSON.stringify(
          dns === "present"
            ? {
                Status: 0,
                Answer: [
                  {
                    name,
                    type: 16,
                    TTL: 1,
                    data: `"pkey-domain-verification=${dnsToken}"`,
                  },
                ],
              }
            : { Status: 3 },
        ),
        { headers: { "content-type": "application/dns-json" } },
      );
    }
    const meta = await issuerMetadataResponse(u, pubJwk);
    if (meta) return meta;
    if (u.endsWith("/api/oidc/token")) {
      const id = await new SignJWT({ nonce: tokenNonce, ...tokenClaims })
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setIssuer(ISSUER)
        .setAudience("client-1")
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(priv);
      return new Response(JSON.stringify({ id_token: id }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("nope", { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function world(): Promise<CardWorld> {
  const w = await seededWorld();
  w.env.ADMIN_SESSION_SECRET = "admin-secret";
  w.env.PLATFORM_ADMIN_GROUP = "admins";
  return w;
}

interface As {
  sub?: string;
  groups?: string[];
  stepUp?: boolean;
}

async function api(
  w: CardWorld,
  method: string,
  path: string,
  body?: unknown,
  as: As = {},
): Promise<Response> {
  const { token, session } = await consoleTestSession(
    w.env,
    w.db,
    {
      sub: as.sub ?? "op1",
      name: "Ada",
      // One address per operator: a shared verified address joins one account (SM-3).
      email: as.sub ? `${as.sub}@x.io` : "ada@x.io",
      groups: as.groups ?? ["admins"],
      ...(as.stepUp ? { authTime: NOW, stepUp: true } : {}),
    },
    NOW,
  );
  return handleAdminApi(
    new Request(`https://key.plrs.im/manage/api${path}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    w.env,
    w.db,
    `/api${path}`,
    NOW,
  );
}

const STEP = { stepUp: true };
const draft = {
  label: "Work",
  issuer: ISSUER,
  clientId: "client-1",
  clientSecret: SECRET,
};

async function add(w: CardWorld, over: Record<string, unknown> = {}) {
  const res = await api(
    w,
    "POST",
    "/platform/connections",
    { ...draft, ...over },
    STEP,
  );
  return { res, body: (await res.json()) as Record<string, any> };
}

async function auditActions(w: CardWorld): Promise<string[]> {
  const rows = await w.db.all<{ action: string }>(
    "SELECT action FROM platform_audit WHERE action LIKE 'identity.connection.%' ORDER BY at, rowid",
  );
  return rows.map((r) => r.action);
}

describe("access", () => {
  it("needs the platform area, and a step-up for every change", async () => {
    const w = await world();
    expect(
      (await api(w, "GET", "/platform/connections", undefined, { groups: [] }))
        .status,
    ).toBe(403);
    expect(
      (await api(w, "POST", "/platform/connections", draft, { groups: [] }))
        .status,
    ).toBe(403);
    const res = await api(w, "POST", "/platform/connections", draft);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "step_up_required",
    );
    expect(await auditActions(w)).toEqual([]);
    expect((await api(w, "GET", "/platform/connections")).status).toBe(200);
  });
});

describe("add", () => {
  it("seals the secret, never shows it, audits the change", async () => {
    const w = await world();
    const { res, body } = await add(w);
    expect(res.status).toBe(201);
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET);
    expect(body.connection.hasSecret).toBe(true);
    expect(body.connection.audience).toBe("customers");
    expect(body.connection.source).toBe("console");
    const row = await w.db.first<{ client_secret_sealed: string }>(
      "SELECT client_secret_sealed FROM identity_connections WHERE id = ?",
      body.connection.id,
    );
    expect(row!.client_secret_sealed).not.toContain(SECRET);
    expect(
      await open(
        w.env,
        row!.client_secret_sealed,
        connectionSecretContext(body.connection.id),
      ),
    ).toBe(SECRET);
    // The page and the detail answer without it too.
    for (const path of [
      "/platform/connections",
      `/platform/connections/${body.connection.id}`,
    ]) {
      expect(await (await api(w, "GET", path)).text()).not.toContain(SECRET);
    }
    const audit = await w.db.all<{ summary: string; after_json: string }>(
      "SELECT summary, after_json FROM platform_audit WHERE action = 'identity.connection.create'",
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(audit[0]!.after_json).toContain('"hasSecret":true');
  });

  it("refuses an issuer that is not a public https address, before any request", async () => {
    const w = await world();
    for (const issuer of [
      "http://sso.corp.example",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://[::1]",
      "https://10.0.0.5",
      "https://sso.corp.example:8443",
      "https://user:pw@sso.corp.example",
      "https://sso.corp.example/?x=1",
      "ftp://sso.corp.example",
    ]) {
      const { res, body } = await add(w, { issuer });
      expect(res.status, issuer).toBe(422);
      expect(body.code, issuer).toBe("invalid_issuer");
    }
    expect(fetched).toEqual([]);
    expect(await auditActions(w)).toEqual([]);
  });

  it("refuses a discovery document that points off the issuer's host", async () => {
    const w = await world();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const u = String(input);
      fetched.push(u);
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: "https://evil.example/authorize",
          token_endpoint: `${ISSUER}/api/oidc/token`,
          jwks_uri: `${ISSUER}/.well-known/jwks.json`,
          response_types_supported: ["code"],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const { res, body } = await add(w);
    expect(res.status).toBe(422);
    expect(body.code).toBe("discovery_invalid");
    expect(fetched.every((u) => u.startsWith(ISSUER))).toBe(true);
    expect(await auditActions(w)).toEqual([]);
  });

  it("refuses an issuer that does not answer, and a redirecting one", async () => {
    const w = await world();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/" },
        }),
    );
    const { res, body } = await add(w);
    expect(res.status).toBe(502);
    expect(body.code).toBe("discovery_unreachable");
  });

  it("refuses a duplicate", async () => {
    const w = await world();
    expect((await add(w)).res.status).toBe(201);
    const dup = await add(w);
    expect(dup.res.status).toBe(409);
    expect(dup.body.code).toBe("exists");
  });

  it("validates the claim map", async () => {
    const w = await world();
    const { res, body } = await add(w, { claimMap: { groups: "a b" } });
    expect(res.status).toBe(422);
    expect(body.code).toBe("invalid_claim_name");
    const ok = await add(w, {
      claimMap: { groups: "groups", claims: ["department"] },
    });
    expect(ok.body.connection.claimMap).toEqual({
      groups: "groups",
      claims: ["department"],
    });
  });
});

describe("change", () => {
  it("rotates the secret, disables, and audits each; a no-op writes nothing", async () => {
    const w = await world();
    const id = (await add(w)).body.connection.id as string;
    const rotate = await api(
      w,
      "PATCH",
      `/platform/connections/${id}`,
      { clientSecret: "another-secret-value-1234" },
      STEP,
    );
    expect(rotate.status).toBe(200);
    expect(await rotate.text()).not.toContain("another-secret");
    const row = await w.db.first<{ client_secret_sealed: string }>(
      "SELECT client_secret_sealed FROM identity_connections WHERE id = ?",
      id,
    );
    expect(
      await open(w.env, row!.client_secret_sealed, connectionSecretContext(id)),
    ).toBe("another-secret-value-1234");
    await api(
      w,
      "PATCH",
      `/platform/connections/${id}`,
      { status: "disabled" },
      STEP,
    );
    expect((await resolveConnection(w.db, id))!.status).toBe("disabled");
    await api(
      w,
      "PATCH",
      `/platform/connections/${id}`,
      { label: "Work" },
      STEP,
    );
    expect(await auditActions(w)).toEqual([
      "identity.connection.create",
      "identity.connection.rotate_secret",
      "identity.connection.disable",
    ]);
    const log = JSON.stringify(await w.db.all("SELECT * FROM platform_audit"));
    expect(log).not.toContain("another-secret");
    expect(log).not.toContain(SECRET);
  });

  it("keeps a seeded audience, refuses to move its issuer, and refuses delete while people sign in", async () => {
    const w = await world();
    await w.db.run(
      `INSERT INTO identity_connections (id, scope, label, issuer, client_id, audience, status, source, created_at, modified_at)
       VALUES ('platform-sso', 'platform', 'Single sign-on', 'https://pid.example', 'pid', 'both', 'active', 'env', ?, ?)`,
      NOW,
      NOW,
    );
    const relabel = await api(
      w,
      "PATCH",
      "/platform/connections/platform-sso",
      { label: "Pocket ID", audience: "both" },
      STEP,
    );
    expect(relabel.status).toBe(200);
    expect((await resolveConnection(w.db, "platform-sso"))!.audience).toBe(
      "both",
    );
    const moved = await api(
      w,
      "PATCH",
      "/platform/connections/platform-sso",
      { issuer: "https://other.example" },
      STEP,
    );
    expect(moved.status).toBe(409);
    const del = await api(
      w,
      "DELETE",
      "/platform/connections/platform-sso",
      undefined,
      STEP,
    );
    expect(del.status).toBe(409);

    const id = (await add(w)).body.connection.id as string;
    const gone = await api(
      w,
      "DELETE",
      `/platform/connections/${id}`,
      undefined,
      STEP,
    );
    expect(gone.status).toBe(200);
    expect(await resolveConnection(w.db, id)).toBeNull();
    expect(await auditActions(w)).toContain("identity.connection.delete");
  });
});

describe("domains", () => {
  it("claims, verifies against the TXT record, enforces and releases, each audited", async () => {
    const w = await world();
    const id = (await add(w)).body.connection.id as string;
    const claim = await api(
      w,
      "POST",
      `/platform/connections/${id}/domains`,
      { domain: "Corp.Example" },
      STEP,
    );
    const claimed = (await claim.json()) as Record<string, any>;
    const d = claimed.connection.domains[0];
    expect(d.domain).toBe("corp.example");
    expect(d.record.name).toBe(challengeName("corp.example"));
    expect(d.verified).toBe(false);
    dnsToken = d.record.value.split("=")[1];
    const no = await api(
      w,
      "POST",
      `/platform/connections/${id}/domains/verify`,
      { domain: "corp.example" },
      STEP,
    );
    expect(((await no.json()) as any).verify).toBe("absent");
    dns = "present";
    const yes = await api(
      w,
      "POST",
      `/platform/connections/${id}/domains/verify`,
      { domain: "corp.example" },
      STEP,
    );
    const verified = (await yes.json()) as Record<string, any>;
    expect(verified.verify).toBe("verified");
    expect(verified.connection.domains[0].verified).toBe(true);
    const enf = await api(
      w,
      "PATCH",
      `/platform/connections/${id}/domains/corp.example`,
      { enforce: true },
      STEP,
    );
    expect(((await enf.json()) as any).connection.domains[0].enforce).toBe(
      true,
    );
    const rel = await api(
      w,
      "DELETE",
      `/platform/connections/${id}/domains/corp.example`,
      undefined,
      STEP,
    );
    expect(((await rel.json()) as any).connection.domains).toEqual([]);
    expect(await auditActions(w)).toEqual([
      "identity.connection.create",
      "identity.connection.domain_add",
      "identity.connection.domain_verify",
      "identity.connection.domain_enforce",
      "identity.connection.domain_remove",
    ]);
    // A domain that is not a plain domain is refused.
    const bad = await api(
      w,
      "POST",
      `/platform/connections/${id}/domains`,
      { domain: "*.corp.example" },
      STEP,
    );
    expect(bad.status).toBe(422);
  });
});

describe("test sign-in", () => {
  async function start(
    w: CardWorld,
    d: Device,
    over: Record<string, unknown> = {},
    as: As = {},
  ) {
    const res = await api(
      w,
      "POST",
      "/platform/connections/test/start",
      {
        draftId: "draft-12345678",
        ...draft,
        claimMap: { groups: "groups", claims: ["department"] },
        ...over,
      },
      as,
    );
    d.absorb(res);
    return res;
  }

  it("shows the mapped claims once, only to the operator and draft that started it, and stores nothing", async () => {
    const w = await world();
    const d = new Device(w);
    const res = await start(w, d);
    expect(res.status).toBe(200);
    const { url, state } = (await res.json()) as { url: string; state: string };
    const auth = new URL(url);
    expect(`${auth.origin}${auth.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(auth.searchParams.get("scope")).toContain("groups");
    tokenNonce = auth.searchParams.get("nonce")!;
    tokenClaims = {
      sub: "user-1",
      email: "ada@corp.example",
      email_verified: true,
      name: "Ada",
      groups: ["eng", "ops"],
      department: "Engineering",
      secret_claim: "should-not-be-shown",
    };
    const back = await d.send("GET", `/callback?code=c&state=${state}`);
    expect(back.status).toBe(302);
    // The same-tab return goes to the fixed console path and the same step.
    expect(back.headers.get("location")).toBe(
      `/manage/#/platform/connections/new?step=test&draft=draft-12345678&state=${state}`,
    );
    const q = `state=${state}&draft=draft-12345678`;
    // Another operator, or another draft, gets nothing and does not burn it.
    expect(
      (
        await api(
          w,
          "GET",
          `/platform/connections/test/result?${q}`,
          undefined,
          { sub: "op2" },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await api(
          w,
          "GET",
          `/platform/connections/test/result?state=${state}&draft=draft-other-111`,
        )
      ).status,
    ).toBe(404);
    const got = await api(w, "GET", `/platform/connections/test/result?${q}`);
    const result = ((await got.json()) as any).result;
    expect(result.ok).toBe(true);
    expect(result.preview.email).toBe("ada@corp.example");
    expect(result.preview.groups).toEqual(["eng", "ops"]);
    expect(result.preview.claims).toEqual({ department: "Engineering" });
    expect(JSON.stringify(result)).not.toContain("should-not-be-shown");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.preview.claimNames).toContain("secret_claim");
    // Read once.
    expect(
      (await api(w, "GET", `/platform/connections/test/result?${q}`)).status,
    ).toBe(404);
    // Nothing is persisted.
    expect(
      (await w.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM identity_connections",
      ))!.n,
    ).toBe(0);
    // The operators' own console links (their sign-ins) are the only ones: the tested IdP's
    // subject becomes no link.
    expect(
      (await w.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM account_links WHERE kind <> 'email' AND issuer_key <> ?",
        adminOidcConfig(w.env)!.issuer,
      ))!.n,
    ).toBe(0);
  });

  it("only the browser that started the flow can finish it", async () => {
    const w = await world();
    const d = new Device(w);
    const { state } = (await (await start(w, d)).json()) as { state: string };
    const other = new Device(w, "203.0.113.99");
    const res = await other.send("GET", `/callback?code=c&state=${state}`);
    expect(res.status).not.toBe(302);
    // The flow was not burned by the wrong browser.
    tokenNonce = "n";
    const ok = await d.send("GET", `/callback?code=c&state=${state}`);
    expect(ok.status).toBe(302);
  });

  it("shows a provider error as plain, capped, redacted text", async () => {
    const w = await world();
    const d = new Device(w);
    const { state } = (await (await start(w, d)).json()) as { state: string };
    const evil = `<script>alert(1)</script> access_denied ${"A".repeat(300)} ${SECRET}`;
    const back = await d.send(
      "GET",
      `/callback?error=access_denied&error_description=${encodeURIComponent(evil)}&state=${state}`,
    );
    expect(back.status).toBe(302);
    const got = await api(
      w,
      "GET",
      `/platform/connections/test/result?state=${state}&draft=draft-12345678`,
    );
    const result = ((await got.json()) as any).result;
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeLessThanOrEqual(260);
    expect(result.message).not.toContain(SECRET);
    expect(result.message).not.toMatch(/A{24}/);
  });

  it("starts nothing for an unsafe issuer or without a draft id", async () => {
    const w = await world();
    const d = new Device(w);
    expect(
      (await start(w, d, { issuer: "http://sso.corp.example" })).status,
    ).toBe(422);
    expect((await start(w, d, { draftId: "x" })).status).toBe(422);
    expect(fetched).toEqual([]);
  });

  it("plainProviderText strips control characters and secret-shaped runs", () => {
    const t = plainProviderText(
      "bad\u0000 thing\n eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk ok",
      ["hunter2hunter2"],
    );
    expect(t).toBe("bad thing [redacted] ok");
    expect(plainProviderText("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe("page", () => {
  it("lists the built-in providers, email and Turnstile by status, and the redirect URI", async () => {
    const w = await world();
    const body = (await (
      await api(w, "GET", "/platform/connections")
    ).json()) as Record<string, any>;
    expect(body.redirectUri).toBe("https://key.plrs.im/callback");
    expect(body.builtIns.map((b: any) => b.kind)).toEqual([
      "google",
      "apple",
      "steam",
    ]);
    expect(body.builtIns.every((b: any) => b.configured === false)).toBe(true);
    // One exact registration per provider; Steam registers a realm.
    expect(body.builtIns.map((b: any) => b.registration)).toEqual([
      {
        kind: "redirect-uri",
        value: "https://key.plrs.im/login/google/callback",
      },
      {
        kind: "redirect-uri",
        value: "https://key.plrs.im/login/apple/callback",
      },
      { kind: "realm", value: "https://key.plrs.im" },
    ]);
    expect(typeof body.email.configured).toBe("boolean");
    expect(typeof body.turnstile.enabled).toBe("boolean");
    // No customer origin: only the console's own address is listed.
    expect(body.redirectUris).toEqual([
      {
        site: "console",
        label: "Polaris Key Console",
        value: "https://key.plrs.im/callback",
      },
    ]);
  });

  it("lists the Polaris Locker address first once the customer origin is set", async () => {
    const w = await world();
    w.env.CONSOLE_ORIGIN = "https://key.plrs.im";
    w.env.CUSTOMER_ORIGIN = "https://polaris.locker";
    const body = (await (
      await api(w, "GET", "/platform/connections")
    ).json()) as Record<string, any>;
    expect(body.redirectUri).toBe("https://polaris.locker/callback");
    expect(body.redirectUris.map((u: any) => [u.label, u.value])).toEqual([
      ["Polaris Locker", "https://polaris.locker/callback"],
      ["Polaris Key Console", "https://key.plrs.im/callback"],
    ]);
    const [google, , steam] = body.builtIns;
    expect(google.registrations.map((x: any) => x.value)).toEqual([
      "https://polaris.locker/login/google/callback",
      "https://key.plrs.im/login/google/callback",
    ]);
    expect(steam.registrations.map((x: any) => [x.kind, x.value])).toEqual([
      ["realm", "https://polaris.locker"],
      ["realm", "https://key.plrs.im"],
    ]);
  });
});

describe("review fixes", () => {
  it("audits an unverify, and refuses an issuer move while people sign in", async () => {
    const w = await world();
    const id = (await add(w)).body.connection.id as string;
    const claim = await api(
      w,
      "POST",
      `/platform/connections/${id}/domains`,
      { domain: "corp.example" },
      STEP,
    );
    dnsToken = (
      (await claim.json()) as any
    ).connection.domains[0].record.value.split("=")[1];
    dns = "present";
    await api(
      w,
      "POST",
      `/platform/connections/${id}/domains/verify`,
      { domain: "corp.example" },
      STEP,
    );
    dns = "absent";
    const lost = await api(
      w,
      "POST",
      `/platform/connections/${id}/domains/verify`,
      { domain: "corp.example" },
      STEP,
    );
    expect(((await lost.json()) as any).connection.domains[0].verified).toBe(
      false,
    );
    expect(await auditActions(w)).toContain(
      "identity.connection.domain_unverify",
    );
    // A link keyed to the issuer pins it.
    const { portalIdentityIssuerKey } =
      await import("../../../src/services/identity/portal/repo.js");
    const { insertAccount, insertLink } =
      await import("../../../src/services/identity/accounts/repo.js");
    const acct = await insertAccount(
      w.db,
      {
        primaryEmail: "a@corp.example",
        primaryEmailVerified: true,
        displayName: null,
      },
      NOW,
    );
    await insertLink(
      w.db,
      acct.id,
      {
        issuerKey: portalIdentityIssuerKey(ISSUER),
        tenantScope: "",
        subject: "sub1",
        kind: "oidc",
        email: "a@corp.example",
        emailVerified: true,
        displayName: null,
        amr: null,
      },
      NOW,
    );
    const moved = await api(
      w,
      "PATCH",
      `/platform/connections/${id}`,
      { issuer: "https://other.corp.example" },
      STEP,
    );
    expect(moved.status).toBe(409);
    expect(((await moved.json()) as any).code).toBe("has_links");
  });

  it("test start validates the claim map like a save", async () => {
    const w = await world();
    const res = await api(w, "POST", "/platform/connections/test/start", {
      draftId: "draft-12345678",
      ...draft,
      claimMap: { groups: "a b" },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe("invalid_claim_map");
    expect(fetched).toEqual([]);
  });

  it("a seeded row that names a secret reference still says it has a secret", async () => {
    const w = await world();
    await w.db.run(
      `INSERT INTO identity_connections (id, scope, label, issuer, client_id, client_secret_ref, audience, status, source, created_at, modified_at)
       VALUES ('platform-sso', 'platform', 'SSO', 'https://pid.example', 'pid', 'SOME_SECRET', 'customers', 'active', 'env', ?, ?)`,
      NOW,
      NOW,
    );
    const v = (
      (await (
        await api(w, "GET", "/platform/connections/platform-sso")
      ).json()) as any
    ).connection;
    expect(v.hasSecret).toBe(true);
  });
});

// ST-32.4: an operator-audience connection is what console access rules trust, so only a
// Superadmin (with the step-up the routes already demand) writes one.
describe("operator audience", () => {
  /** A Platform admin who is not a Superadmin: a stored binding and no root group. */
  async function platformAdmin(w: CardWorld): Promise<As> {
    // Sign in once as an operator so the account and its strong link exist, then drop the group.
    await consoleTestSession(
      w.env,
      w.db,
      { sub: "pa1", name: "Pat", email: "pa1@x.io", groups: ["admins"] },
      NOW,
    );
    const acct = await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM account_links WHERE subject = 'pa1'",
    );
    const st = stmtInsertBinding({
      id: newBindingId(),
      accountId: acct!.account_id,
      emailNorm: null,
      role: "platform_admin",
      scope: "platform",
      areas: null,
      source: "grant",
      grantedBy: null,
      grantedAt: NOW - 10,
    });
    await w.db.run(st.sql, ...st.params);
    return { sub: "pa1", groups: [], stepUp: true };
  }

  const operatorActions = async (w: CardWorld) =>
    (
      await w.db.all<{ action: string }>(
        "SELECT action FROM platform_audit WHERE action = 'rbac.operator_connection'",
      )
    ).length;

  it("a Superadmin with step-up creates and widens one, audited", async () => {
    const w = await world();
    const { res, body } = await add(w, { audience: "operators" });
    expect(res.status).toBe(201);
    expect(body.connection.audience).toBe("operators");
    expect(await operatorActions(w)).toBe(1);
    const id = body.connection.id as string;
    const widen = await api(
      w,
      "PATCH",
      `/platform/connections/${id}`,
      { audience: "both" },
      STEP,
    );
    expect(widen.status).toBe(200);
    expect((await resolveConnection(w.db, id))!.audience).toBe("both");
    expect(await operatorActions(w)).toBe(2);
    const bad = await add(w, { audience: "everyone", clientId: "c2" });
    expect(bad.res.status).toBe(422);
  });

  it("refuses a Superadmin without step-up", async () => {
    const w = await world();
    const res = await api(w, "POST", "/platform/connections", {
      ...draft,
      audience: "operators",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "step_up_required",
    );
    expect(await operatorActions(w)).toBe(0);
  });

  it("refuses a Platform admin on create and on widening a customers connection", async () => {
    const w = await world();
    const { body } = await add(w);
    const id = body.connection.id as string;
    const pa = await platformAdmin(w);
    for (const audience of ["operators", "both"]) {
      const c = await api(
        w,
        "POST",
        "/platform/connections",
        { ...draft, clientId: "c9", audience },
        pa,
      );
      expect(c.status).toBe(403);
      expect(((await c.json()) as { code: string }).code).toBe(
        "audience_not_available",
      );
      const p = await api(
        w,
        "PATCH",
        `/platform/connections/${id}`,
        { audience },
        pa,
      );
      expect(p.status).toBe(403);
    }
    expect((await resolveConnection(w.db, id))!.audience).toBe("customers");
    expect(await operatorActions(w)).toBe(0);
    // An ordinary customers connection stays a Platform admin's.
    const ok = await api(
      w,
      "PATCH",
      `/platform/connections/${id}`,
      { label: "Renamed" },
      pa,
    );
    expect(ok.status).toBe(200);
  });

  it("the patch path: a Platform admin cannot move an operator connection's issuer, client, claims, secret or domains", async () => {
    const w = await world();
    const { body } = await add(w, { audience: "operators" });
    const id = body.connection.id as string;
    const pa = await platformAdmin(w);
    const attempts: Record<string, unknown>[] = [
      { issuer: "https://evil.example" },
      { clientId: "other" },
      { jwksUri: "https://sso.corp.example/other-keys" },
      { claimMap: { groups: "roles" } },
      { clientSecret: "another-secret" },
      { audience: "customers" },
    ];
    for (const patch of attempts) {
      const r = await api(w, "PATCH", `/platform/connections/${id}`, patch, pa);
      expect(r.status, JSON.stringify(patch)).toBe(403);
    }
    const dom = await api(
      w,
      "POST",
      `/platform/connections/${id}/domains`,
      { domain: "corp.example" },
      pa,
    );
    expect(dom.status).toBe(403);
    const before = await resolveConnection(w.db, id);
    expect(before!.issuer).toBe(ISSUER);
    expect(before!.audience).toBe("operators");
    // A Platform admin may still rename it and switch it off, but not back on.
    expect(
      (await api(w, "PATCH", `/platform/connections/${id}`, { label: "R" }, pa))
        .status,
    ).toBe(200);
    expect(
      (
        await api(
          w,
          "PATCH",
          `/platform/connections/${id}`,
          { status: "disabled" },
          pa,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await api(
          w,
          "PATCH",
          `/platform/connections/${id}`,
          { status: "active" },
          pa,
        )
      ).status,
    ).toBe(403);
    // The Superadmin can move the claim map, and it is audited as an operator change.
    const n = await operatorActions(w);
    const su = await api(
      w,
      "PATCH",
      `/platform/connections/${id}`,
      { claimMap: { groups: "roles" } },
      STEP,
    );
    expect(su.status).toBe(200);
    expect(await operatorActions(w)).toBeGreaterThan(n);
  });

  it("routes an operator email only to an allow-listed operator connection, the same for any address", async () => {
    const w = await world();
    const { body } = await add(w, { audience: "operators" });
    const id = body.connection.id as string;
    await w.db.run(
      `INSERT INTO identity_connection_domains (connection_id, scope, domain, token, verified_at, checked_at, enforce)
       VALUES (?, 'platform', 'corp.example', 't', ?, ?, 1)`,
      id,
      NOW,
      NOW,
    );
    // Not on the allowlist: fail closed.
    expect(
      await operatorRouteForEmail(w.env, w.db, "ada@corp.example"),
    ).toBeNull();
    w.env.OIDC_ISSUER_ALLOWLIST = "sso.corp.example";
    const known = await operatorRouteForEmail(w.env, w.db, "ada@corp.example");
    const other = await operatorRouteForEmail(
      w.env,
      w.db,
      "nobody@corp.example",
    );
    expect(known?.connection.id).toBe(id);
    expect(other?.connection.id).toBe(id);
    expect(
      await operatorRouteForEmail(w.env, w.db, "ada@elsewhere.example"),
    ).toBeNull();
    // The customer card's surface never sees it.
    expect(
      await routeForDomain(w.db, "corp.example", ["platform"], "customers"),
    ).toBeNull();
  });
});
