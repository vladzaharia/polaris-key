// A link is keyed by (issuer, subject): the connection that wrote its groups is not recorded. The
// console's root rule reads those groups, so on an issuer that may sign operators in a connection
// sign-in must not write them (or `asserted_at`); a customer connection elsewhere is unaffected.
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
  EMAIL_ISSUER,
  insertAccount,
  insertLink,
} from "../../../src/services/identity/accounts/repo.js";
import {
  portalIdentityIssuerKey,
  recordLinkAssertion,
  recordLinkGroups,
} from "../../../src/services/identity/portal/repo.js";
import { rootRuleHolds } from "../../../src/core/rbac/principal.js";
import { ADMIN_SESSION_TTL_SECONDS } from "../../../src/core/console/session.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";
const CONN = "conn_second";

let priv: CryptoKey;
let pubJwk: Record<string, unknown>;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256");
  priv = pair.privateKey;
  pubJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "k-1",
    alg: "ES256",
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function installIdp(claims: Record<string, unknown>, nonce: string): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u = String(input instanceof Request ? input.url : input);
    const meta = await issuerMetadataResponse(u, pubJwk);
    if (meta) return meta;
    if (u.endsWith("/api/oidc/token")) {
      const idToken = await new SignJWT({ nonce, ...claims })
        .setProtectedHeader({ alg: "ES256", kid: "k-1" })
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

/** A second connection at ISSUER whose claim map reads a claim the person controls as groups. */
async function secondConnection(w: CardWorld): Promise<void> {
  await insertConnection(w.db, { id: CONN, issuer: ISSUER });
  await w.db.run(
    "UPDATE identity_connections SET claim_map_json = ? WHERE id = ?",
    JSON.stringify({ groups: "nicknames", claims: ["department"] }),
    CONN,
  );
}

async function strongLink(w: CardWorld, strong: boolean): Promise<string> {
  const a = await insertAccount(
    w.db,
    {
      primaryEmail: "ada@corp.example",
      primaryEmailVerified: true,
      displayName: null,
    },
    NOW,
  );
  await insertLink(
    w.db,
    a.id,
    {
      issuerKey: EMAIL_ISSUER,
      tenantScope: "",
      subject: "ada@corp.example",
      kind: "email",
      email: "ada@corp.example",
      emailVerified: true,
      displayName: null,
      amr: null,
    },
    NOW,
  );
  await insertLink(
    w.db,
    a.id,
    {
      issuerKey: portalIdentityIssuerKey(ISSUER),
      tenantScope: "",
      subject: "sub-1",
      kind: "oidc",
      email: null,
      emailVerified: false,
      displayName: null,
      amr: null,
    },
    NOW,
  );
  if (strong)
    await w.db.run(
      "UPDATE account_links SET strong_at = ? WHERE subject = 'sub-1'",
      NOW,
    );
  return a.id;
}

async function signInThrough(w: CardWorld): Promise<void> {
  installIdp({}, "unused");
  const d = new Device(w);
  const login = await d.send("GET", `/login/sso/${CONN}`);
  expect(login.status).toBe(302);
  const authorize = new URL(login.headers.get("location")!);
  installIdp(
    { sub: "sub-1", nicknames: [GROUP], department: "ops" },
    authorize.searchParams.get("nonce")!,
  );
  const cb = await d.send(
    "GET",
    `/callback?code=c&state=${authorize.searchParams.get("state")}`,
  );
  expect(cb.status).toBe(302);
}

interface Row {
  groups_json: string | null;
  claims_json: string | null;
  asserted_at: number | null;
  strong_at: number | null;
}
const row = (w: CardWorld) =>
  w.db.first<Row>(
    "SELECT groups_json, claims_json, asserted_at, strong_at FROM account_links WHERE subject = 'sub-1'",
  );
const roots = (w: CardWorld, r: Row, now: number) =>
  rootRuleHolds(
    w.env,
    {
      strongAt: r.strong_at,
      assertedAt: r.asserted_at,
      groups: r.groups_json ? (JSON.parse(r.groups_json) as string[]) : [],
    },
    now,
    ADMIN_SESSION_TTL_SECONDS,
  );

describe("a connection sign-in on an issuer that may sign operators in", () => {
  it("never writes groups or asserted_at: a member who maps a claim they control gets no root", async () => {
    const w = await seededWorld();
    w.env.ADMIN_OIDC_ISSUER = ISSUER;
    w.env.ADMIN_OIDC_CLIENT_ID = "console";
    w.env.PLATFORM_ADMIN_GROUP = GROUP;
    await secondConnection(w);
    await strongLink(w, true);
    await signInThrough(w);
    const r = (await row(w))!;
    expect(r.groups_json).toBeNull();
    expect(r.asserted_at).toBeNull();
    expect(r.claims_json).toBe(JSON.stringify({ department: "ops" }));
    expect(roots(w, r, NOW + 1)).toBe(false);
  });

  it("leaves what the console sign-in asserted alone, so a genuine root keeps root", async () => {
    const w = await seededWorld();
    w.env.ADMIN_OIDC_ISSUER = ISSUER;
    w.env.ADMIN_OIDC_CLIENT_ID = "console";
    w.env.PLATFORM_ADMIN_GROUP = GROUP;
    await secondConnection(w);
    await strongLink(w, true);
    const id = (await w.db.first<{ id: string }>(
      "SELECT id FROM account_links WHERE subject = 'sub-1'",
    ))!.id;
    await recordLinkGroups(w.db, id, [GROUP], NOW);
    expect(roots(w, (await row(w))!, NOW + 1)).toBe(true);
    await signInThrough(w);
    const r = (await row(w))!;
    expect(r.groups_json).toBe(JSON.stringify([GROUP]));
    expect(r.asserted_at).toBe(NOW);
    expect(roots(w, r, NOW + 1)).toBe(true);
  });
});

describe("a console issuer configured with a double trailing slash", () => {
  it("is still guarded: the root rule reads the link keyed by the configured spelling", async () => {
    const w = await seededWorld();
    w.env.ADMIN_OIDC_ISSUER = `${ISSUER}//`;
    w.env.ADMIN_OIDC_CLIENT_ID = "console";
    w.env.PLATFORM_ADMIN_GROUP = GROUP;
    const a = await insertAccount(
      w.db,
      { primaryEmail: null, primaryEmailVerified: false, displayName: null },
      NOW,
    );
    await insertLink(
      w.db,
      a.id,
      {
        issuerKey: portalIdentityIssuerKey(`${ISSUER}//`),
        tenantScope: "",
        subject: "sub-1",
        kind: "oidc",
        email: null,
        emailVerified: false,
        displayName: null,
        amr: null,
      },
      NOW,
    );
    const id = (await w.db.first<{ id: string }>(
      "SELECT id FROM account_links WHERE subject = 'sub-1'",
    ))!.id;
    await recordLinkAssertion(
      w.env,
      w.db,
      id,
      { groups: [GROUP], claims: { department: "ops" } },
      NOW,
    );
    const r = (await row(w))!;
    expect(r.groups_json).toBeNull();
    expect(r.asserted_at).toBeNull();
    expect(r.claims_json).toBe(JSON.stringify({ department: "ops" }));
  });
});

describe("a console issuer configured with a trailing slash", () => {
  it("is still guarded: the link key is the slash-trimmed issuer", async () => {
    const w = await seededWorld();
    w.env.ADMIN_OIDC_ISSUER = `${ISSUER}//`;
    w.env.ADMIN_OIDC_CLIENT_ID = "console";
    w.env.PLATFORM_ADMIN_GROUP = GROUP;
    await secondConnection(w);
    await strongLink(w, true);
    await signInThrough(w);
    const r = (await row(w))!;
    expect(r.groups_json).toBeNull();
    expect(r.asserted_at).toBeNull();
  });
});

describe("a connection on an unrelated issuer", () => {
  it("still records groups, claims and asserted_at", async () => {
    const w = await seededWorld();
    w.env.ADMIN_OIDC_ISSUER = "https://console.other.example";
    w.env.ADMIN_OIDC_CLIENT_ID = "console";
    await secondConnection(w);
    await strongLink(w, false);
    await signInThrough(w);
    const r = (await row(w))!;
    expect(JSON.parse(r.groups_json!)).toEqual([GROUP]);
    expect(r.asserted_at).not.toBeNull();
    expect(JSON.parse(r.claims_json!)).toEqual({ department: "ops" });
  });
});
