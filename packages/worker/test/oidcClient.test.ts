// I-30 (plans/I-27.md §2.3 "One relying-party client", §10): the one OIDC relying-party client's
// checks, against a fake IdP, and the grep that keeps it the only one.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import {
  checkAuthorizationIss,
  connectionHosts,
  discover,
  exchangeCode,
  gatedFetch,
  OidcNetworkError,
  OidcVerifyError,
  oidcUrlProblem,
  redeemAuthorizationCode,
  resetOidcClientCaches,
  verifyIdToken,
  type RelyingParty,
} from "../src/core/oidc/client.js";
import { issuerDiscovery } from "./oidcIssuerFake.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ISSUER = "https://idp.example";
const CLIENT = "client-1";

const rp = (over: Partial<RelyingParty> = {}): RelyingParty => ({
  label: "connection:test",
  issuer: ISSUER,
  clientId: CLIENT,
  clientSecret: "s3cret",
  allowedHosts: connectionHosts(ISSUER),
  ...over,
});

interface FakeIdp {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; init?: RequestInit }>;
  sign: (
    claims: Record<string, unknown>,
    opts?: { kid?: string },
  ) => Promise<string>;
}

async function fakeIdp(
  opts: {
    discovery?: Record<string, unknown>;
    idToken?: () => Promise<string>;
    tokenStatus?: number;
    redirect?: string;
  } = {},
): Promise<FakeIdp> {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  const calls: FakeIdp["calls"] = [];
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), {
      status,
      headers: { "content-type": "application/json" },
    });
  const sign = (claims: Record<string, unknown>, o: { kid?: string } = {}) =>
    new SignJWT({ nonce: "n-1", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: o.kid ?? "k1" })
      .setIssuer((claims.iss as string) ?? ISSUER)
      .setAudience((claims.aud as string | string[]) ?? CLIENT)
      .setSubject((claims.sub as string) ?? "user-1")
      .setIssuedAt((claims.iat as number) ?? Math.floor(Date.now() / 1000))
      .setExpirationTime("1h")
      .sign(privateKey as KeyLike);
  return {
    calls,
    sign,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (opts.redirect) {
        return new Response(null, {
          status: 302,
          headers: { location: opts.redirect },
        });
      }
      if (url.endsWith("/.well-known/openid-configuration")) {
        return json(issuerDiscovery(ISSUER, opts.discovery));
      }
      if (url.endsWith("/.well-known/jwks.json")) return json({ keys: [jwk] });
      if (url.endsWith("/api/oidc/token")) {
        if (opts.tokenStatus && opts.tokenStatus !== 200) {
          return json({ error: "invalid_grant" }, opts.tokenStatus);
        }
        return json({ id_token: await (opts.idToken ?? (() => sign({})))() });
      }
      return json({}, 404);
    },
  };
}

const grant = {
  code: "c",
  iss: null as string | null,
  redirectUri: "https://key.plrs.im/callback",
  codeVerifier: "v",
  nonce: "n-1",
};

describe("the gated fetch (SSRF)", () => {
  const hosts = ["idp.example"];
  it("refuses http, credentials, ports, private and reserved addresses, and other hosts", () => {
    expect(oidcUrlProblem("http://idp.example/x", hosts)).toBe("not https");
    expect(oidcUrlProblem("https://u:p@idp.example/x", hosts)).toBe(
      "embeds credentials",
    );
    expect(oidcUrlProblem("https://idp.example:8443/x", hosts)).toBe(
      "names a port",
    );
    for (const host of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "[::1]",
      "localhost",
    ]) {
      expect(oidcUrlProblem(`https://${host}/x`, [host])).not.toBeNull();
    }
    expect(oidcUrlProblem("https://evil.example/x", hosts)).toBe(
      "host not on the allowlist",
    );
    // Suffix and subdomain confusion: exact hosts only.
    expect(oidcUrlProblem("https://idp.example.evil.net/x", hosts)).not.toBe(
      null,
    );
    expect(oidcUrlProblem("https://sub.idp.example/x", hosts)).not.toBe(null);
    expect(oidcUrlProblem("https://idp.example/x", hosts)).toBeNull();
    expect(oidcUrlProblem("https://IDP.example./x", hosts)).toBeNull();
  });

  it("never follows a redirect, so a gated URL cannot hand the request on", async () => {
    const idp = await fakeIdp({ redirect: "http://169.254.169.254/latest" });
    await expect(
      gatedFetch("t", `${ISSUER}/x`, {}, ["idp.example"], idp.fetch),
    ).rejects.toBeInstanceOf(OidcNetworkError);
    expect(idp.calls.map((c) => c.url)).toEqual([`${ISSUER}/x`]);
    expect(idp.calls[0]!.init?.redirect).toBe("manual");
  });

  it("a connection's allowlist is its issuer host and its jwks_uri host only", () => {
    expect(
      connectionHosts(
        "https://Idp.Example/tenant",
        "https://keys.idp.example/j",
      ),
    ).toEqual(["idp.example", "keys.idp.example"]);
    expect(connectionHosts("not a url")).toEqual([]);
  });
});

describe("discovery", () => {
  it("refuses a document whose issuer is not the configured one", async () => {
    const idp = await fakeIdp({
      discovery: { issuer: "https://other.example" },
    });
    await expect(discover(rp(), { fetch: idp.fetch })).rejects.toThrow(
      /issuer mismatch/,
    );
  });

  it("refuses a document that aims the token POST or the keys at another host", async () => {
    for (const field of [
      "token_endpoint",
      "jwks_uri",
      "authorization_endpoint",
    ]) {
      const idp = await fakeIdp({
        discovery: { [field]: "https://exfil.example/x" },
      });
      await expect(discover(rp(), { fetch: idp.fetch })).rejects.toThrow(
        /refused: host not on the allowlist/,
      );
    }
    const internal = await fakeIdp({
      discovery: { token_endpoint: "https://127.0.0.1/token" },
    });
    await expect(
      discover(rp({ allowedHosts: ["idp.example", "127.0.0.1"] }), {
        fetch: internal.fetch,
      }),
    ).rejects.toThrow(/reserved or private address/);
  });

  it("refuses an issuer without the code flow", async () => {
    const idp = await fakeIdp({
      discovery: { response_types_supported: ["id_token"] },
    });
    await expect(discover(rp(), { fetch: idp.fetch })).rejects.toThrow(
      /code flow/,
    );
  });
});

describe("RFC 9207 iss on the authorization response", () => {
  const d = { issuer: ISSUER, issParameterSupported: true };
  it("is required where advertised, and must equal the issuer whenever present", () => {
    expect(() => checkAuthorizationIss(d, null)).toThrow(/lacks iss/);
    expect(() => checkAuthorizationIss(d, "https://mixup.example")).toThrow(
      /iss mismatch/,
    );
    expect(() =>
      checkAuthorizationIss(
        { ...d, issParameterSupported: false },
        "https://mixup.example",
      ),
    ).toThrow(/iss mismatch/);
    expect(() => checkAuthorizationIss(d, ISSUER)).not.toThrow();
  });
});

describe("the ID token", () => {
  async function redeem(
    claims: Record<string, unknown>,
    opts: { kid?: string; nonce?: string } = {},
  ) {
    // Each call is a fresh IdP with its own key: start from empty caches, as a new isolate would.
    resetOidcClientCaches();
    const idp: FakeIdp = await fakeIdp({
      idToken: () => idp.sign(claims, { kid: opts.kid }),
    });
    return redeemAuthorizationCode(
      rp(),
      { ...grant, nonce: opts.nonce ?? grant.nonce },
      { fetch: idp.fetch },
    );
  }

  it("control: a fresh, nonce-bound token for this client verifies", async () => {
    const { claims } = await redeem({});
    expect(claims.sub).toBe("user-1");
  });

  it("refuses another audience, a foreign azp, a multi-audience token without azp, and a nonce mismatch", async () => {
    await expect(redeem({ aud: "someone-else" })).rejects.toBeInstanceOf(
      OidcVerifyError,
    );
    await expect(redeem({ azp: "someone-else" })).rejects.toThrow(/azp/);
    await expect(redeem({ aud: [CLIENT, "other"] })).rejects.toThrow(
      /multi-audience/,
    );
    await expect(redeem({}, { nonce: "another-flow" })).rejects.toThrow(
      /nonce/,
    );
    await expect(redeem({ nonce: undefined })).rejects.toThrow(/nonce/);
  });

  it("refuses another issuer, and a stale iat even with a valid exp", async () => {
    await expect(
      redeem({ iss: "https://rogue.example" }),
    ).rejects.toBeInstanceOf(OidcVerifyError);
    await expect(
      redeem({ iat: Math.floor(Date.now() / 1000) - 3600 }),
    ).rejects.toBeInstanceOf(OidcVerifyError);
  });

  it("refuses a token signed by a key the issuer's JWKS does not hold", async () => {
    await expect(redeem({}, { kid: "rogue" })).rejects.toBeInstanceOf(
      OidcVerifyError,
    );
  });

  it("refuses an empty audience outright: there is no any-audience mode", async () => {
    const idp = await fakeIdp();
    const discovered = await discover(rp(), { fetch: idp.fetch });
    await expect(
      verifyIdToken(discovered, rp(), await idp.sign({}), {
        audience: "",
        fetch: idp.fetch,
      }),
    ).rejects.toThrow(/no audience/);
  });

  it("an invalid_grant is a refusal, not an outage", async () => {
    const idp = await fakeIdp({ tokenStatus: 400 });
    const discovered = await discover(rp(), { fetch: idp.fetch });
    await expect(
      exchangeCode(discovered, rp(), grant, { fetch: idp.fetch }),
    ).rejects.toThrow(/refused the grant/);
  });
});

describe("one relying-party client (grep)", () => {
  it("packages/worker/src names no remote JWKS helper and no hard-coded Pocket ID path", () => {
    const src = join(HERE, "..", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.name.endsWith(".ts")
            ? [join(dir, e.name)]
            : [],
      );
    const offenders = walk(src).filter((f) => {
      const s = readFileSync(f, "utf8");
      return s.includes("createRemoteJWKSet") || s.includes("/api/oidc/token");
    });
    expect(offenders).toEqual([]);
  });
});
