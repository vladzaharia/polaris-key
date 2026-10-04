/// <reference types="@cloudflare/workers-types" />

// P6-02 — device attestation and trust levels, through the two Core routes and the enforcement
// points that consult the level.
//
//   1. THE CHALLENGE. Single use, five minutes, bound to the device that asked for it.
//   2. APP ATTEST. A valid object raises the device to `attested`; a wrong RP ID, a wrong nonce, a
//      broken chain or a non-zero counter does not (the verifier's own matrix is appAttest.test.ts;
//      here each defect is driven through the route).
//   3. PLAY INTEGRITY. Against a fake decode endpoint with a recorded verdict, the token from the
//      product's PINNED google-service-account credential through Distribution's real hook; a
//      verdict without MEETS_DEVICE_INTEGRITY or with a stale timestamp does not raise the level.
//   4. THE RATE LIMIT. Per device, fail-closed.
//   5. POLICY. Log-only by default (a basic device mints, and the would-be refusal is audited);
//      with `enforce: true` a typed refusal. Gated delivery the same.
//   6. RESETS. A keyless re-registration drops the level: the device id is client-chosen.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  approveEdgeMintRecipe,
  makeEnv,
  mkReq,
  NOW,
  seedProduct,
  seedLicenseWithKey,
  seedProductSecret,
} from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleRegister } from "../src/core/register.js";
import {
  attestRequestHash,
  handleAttest,
  handleAttestChallenge,
  type AttestDeps,
} from "../src/core/attestation.js";
import {
  accessRefusal,
  entitlementFlagRefusal,
} from "../src/core/entitledAccess.js";
import { buildHooks, type ServiceHooks } from "../src/core/hooks.js";
import { handleMintToken } from "../src/services/config/mint.js";
import {
  handleActivate,
  handleToken,
} from "../src/services/license/activation.js";
import { SERVICES } from "../src/mount.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import {
  getDevice,
  setServices,
  setTrustPolicy,
  upsertDevice,
} from "../src/repo.js";
import { hashKey } from "../src/crypto.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import {
  b64,
  makeAppAttestation,
  makeTestChain,
  type AttestKnobs,
} from "./attestFixtures.js";
import {
  CLIENT_EMAIL,
  playWorld,
  PLAY_PACKAGE,
  SLUG as PLAY_SLUG,
} from "./playWorld.js";
import { setPlatformPin } from "../src/core/platformCredentials.js";
import { NO_HOOKS } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const DEVICE_2 = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";
const TEAM = "ABCDE12345";
const BUNDLE = "gg.acme.djdl";

const CONFIG_ONLY: ServicesMap = {
  license: { enabled: false },
  config: { enabled: true },
  release: { enabled: false },
  distribution: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
};

const ES_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgav85fotyJ04AYsKF\nDojZziUJg9TuJamPiszlECztPLuhRANCAATgaZHNpIiLDSEQHY4H4BE5HnA9L8hR\n11WcM/ABvqCnO5CWZyHKWoEnKnKnmQwVibF2w5YwimX7Z1hIqJPHGCTB\n-----END PRIVATE KEY-----";

interface World {
  db: Db;
  env: Env;
  slug: string;
  product: Product;
  hooks: ServiceHooks;
  deps: AttestDeps;
}

/** Hooks whose delivery reader answers only the attestation targets. */
function targetHooks(bundleIds: string[]): ServiceHooks {
  return {
    ...NO_HOOKS,
    delivery: () =>
      ({
        attestationTargets: async () => ({
          appleBundleIds: bundleIds,
          play: { packageName: null, credentialId: null, inert: "no_outlet" },
        }),
      }) as unknown as ReturnType<ServiceHooks["delivery"]>,
  };
}

async function reload(w: World): Promise<void> {
  w.product = (await loadProduct(w.env, w.db, w.slug))!;
}

async function appleWorld(
  policy: Record<string, unknown> | null = {
    appAttest: { teamId: TEAM, environment: "production" },
  },
  services: ServicesMap = CONFIG_ONLY,
): Promise<World & { chain: Awaited<ReturnType<typeof makeTestChain>> }> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  await seedProduct(db, "djdl");
  await setServices(
    db,
    "djdl",
    serializeServices({ services }),
    "manifest",
    NOW,
  );
  if (policy) await setTrustPolicy(db, "djdl", JSON.stringify(policy), NOW);
  const product = (await loadProduct(env, db, "djdl"))!;
  const chain = await makeTestChain(NOW);
  return {
    db,
    env,
    slug: "djdl",
    product,
    hooks: targetHooks([BUNDLE]),
    deps: { appAttestRoots: [chain.root] },
    chain,
  };
}

async function register(w: World, deviceId = DEVICE): Promise<string> {
  const res = await handleRegister(
    mkReq("POST", { "x-pkey-device": deviceId }),
    w.env,
    w.db,
    w.product,
    NOW,
    SERVICES,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function challenge(
  w: World,
  token: string,
  now = NOW,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handleAttestChallenge(
    mkReq("POST", { authorization: `Bearer ${token}` }),
    w.env,
    w.db,
    w.product,
    now,
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function attest(
  w: World,
  token: string,
  body: unknown,
  now = NOW,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handleAttest(
    mkReq("POST", { authorization: `Bearer ${token}` }, body),
    w.env,
    w.db,
    w.product,
    now,
    w.hooks,
    w.deps,
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function appAttestBody(
  w: World & { chain: Awaited<ReturnType<typeof makeTestChain>> },
  token: string,
  knobs: Partial<AttestKnobs> = {},
): Promise<Record<string, unknown>> {
  const c = await challenge(w, token);
  expect(c.status).toBe(200);
  const requestHash = c.body.requestHash as string;
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(requestHash),
    ),
  );
  const { attestation, keyId } = await makeAppAttestation(w.chain, NOW, {
    appId: `${TEAM}.${BUNDLE}`,
    clientDataHash,
    ...knobs,
  });
  return {
    kind: "app-attest",
    keyId,
    attestation: b64(attestation),
    challenge: c.body.challenge,
  };
}

async function levelOf(
  w: World,
  deviceId = DEVICE,
): Promise<string | undefined> {
  return (await getDevice(w.db, w.slug, deviceId))?.trust_level;
}

async function auditActions(db: Db): Promise<string[]> {
  return (
    await db.all<{ action: string }>(
      "SELECT action FROM audit ORDER BY at, rowid",
    )
  ).map((r) => r.action);
}

// ── 1. the challenge ──────────────────────────────────────────────────────────────────────────

describe("POST /<p>/devices/attest/challenge", () => {
  it("issues a 43-char challenge with its device-bound request hash, for an authenticated device only", async () => {
    const w = await appleWorld();
    const token = await register(w);
    const c = await challenge(w, token);
    expect(c.status).toBe(200);
    expect(c.body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.body.expiresAt).toBe(NOW + 300);
    expect(c.body.requestHash).toBe(
      await attestRequestHash("djdl", DEVICE, c.body.challenge as string),
    );
    expect(c.body.play).toBeUndefined();
    expect((await challenge(w, `pkeyt_${"x".repeat(43)}`)).status).toBe(401);
  });

  it("hands out the operator's Play cloud project number when the policy names one", async () => {
    const w = await appleWorld({
      playIntegrity: { cloudProjectNumber: "123456789012" },
    });
    const c = await challenge(w, await register(w));
    expect(c.body.play).toEqual({ cloudProjectNumber: "123456789012" });
  });

  it("is single use", async () => {
    const w = await appleWorld();
    const token = await register(w);
    const body = await appAttestBody(w, token);
    expect((await attest(w, token, body)).status).toBe(200);
    const again = await attest(w, token, body);
    expect(again.status).toBe(422);
    expect(again.body.error).toEqual({ code: "attestation_rejected" });
  });

  it("expires after five minutes", async () => {
    const w = await appleWorld();
    const token = await register(w);
    const body = await appAttestBody(w, token);
    expect((await attest(w, token, body, NOW + 301)).status).toBe(422);
    expect(await levelOf(w)).toBe("basic");
  });

  it("is bound to the device that asked for it", async () => {
    const w = await appleWorld();
    const token = await register(w);
    const other = await register(w, DEVICE_2);
    const body = await appAttestBody(w, token);
    expect((await attest(w, other, body)).status).toBe(422);
    expect(await levelOf(w, DEVICE_2)).toBe("basic");
  });
});

// ── 2. App Attest through the route ───────────────────────────────────────────────────────────

describe("POST /<p>/devices/attest — app-attest", () => {
  it("a valid attestation raises the device to attested and records the verdict", async () => {
    const w = await appleWorld();
    const token = await register(w);
    expect(await levelOf(w)).toBe("basic");
    const r = await attest(w, token, await appAttestBody(w, token));
    expect(r).toEqual({
      status: 200,
      body: { trustLevel: "attested", kind: "app-attest", attestedAt: NOW },
    });
    const row = await getDevice(w.db, "djdl", DEVICE);
    expect(row?.trust_level).toBe("attested");
    expect(row?.attested_at).toBe(NOW);
    const verdict = JSON.parse(row!.attestation_json!) as Record<
      string,
      unknown
    >;
    expect(verdict).toMatchObject({
      kind: "app-attest",
      outcome: "attested",
      appId: `${TEAM}.${BUNDLE}`,
      environment: "production",
    });
    // The public key is kept for later assertions; nothing raw is.
    expect(verdict.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(row!.attestation_json).not.toContain("x5c");
    expect(await auditActions(w.db)).toContain("device.attest");
  });

  for (const [label, knobs] of [
    ["a wrong RP ID", { appId: `ZZZZZ99999.${BUNDLE}` }],
    ["a wrong nonce", { nonce: new Uint8Array(32) }],
    ["a broken chain", { foreignIssuer: true }],
    ["a non-zero counter", { counter: 3 }],
  ] as const) {
    it(`${label} does not raise the level`, async () => {
      const w = await appleWorld();
      const token = await register(w);
      const r = await attest(w, token, await appAttestBody(w, token, knobs));
      expect(r.status).toBe(422);
      expect(r.body.error).toEqual({ code: "attestation_rejected" });
      expect(await levelOf(w)).toBe("basic");
      expect(await auditActions(w.db)).toContain("device.attest.rejected");
    });
  }

  it("a failed attempt never lowers an attested device", async () => {
    const w = await appleWorld();
    const token = await register(w);
    expect((await attest(w, token, await appAttestBody(w, token))).status).toBe(
      200,
    );
    expect(
      (await attest(w, token, await appAttestBody(w, token, { counter: 1 })))
        .status,
    ).toBe(422);
    expect(await levelOf(w)).toBe("attested");
    const verdict = JSON.parse(
      (await getDevice(w.db, "djdl", DEVICE))!.attestation_json!,
    );
    expect(verdict).toMatchObject({ outcome: "rejected", reason: "counter" });
  });

  it("is unavailable (409) without a Team ID or an App Store/TestFlight bundle", async () => {
    const noTeam = await appleWorld(null);
    let token = await register(noTeam);
    const c = await challenge(noTeam, token);
    const r = await attest(noTeam, token, {
      kind: "app-attest",
      keyId: btoa("k".repeat(32)),
      attestation: "AA==",
      challenge: c.body.challenge,
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({ code: "attestation_unavailable" });

    const noBundle = await appleWorld();
    noBundle.hooks = targetHooks([]);
    token = await register(noBundle);
    expect(
      (await attest(noBundle, token, await appAttestBody(noBundle, token)))
        .status,
    ).toBe(409);
    // …and without Distribution at all (the hook answers null).
    noBundle.hooks = NO_HOOKS;
    expect(
      (await attest(noBundle, token, await appAttestBody(noBundle, token)))
        .status,
    ).toBe(409);
  });

  it("refuses malformed bodies with 400 and unauthenticated callers with 401", async () => {
    const w = await appleWorld();
    const token = await register(w);
    expect(
      (await attest(w, token, { kind: "safetynet", challenge: "x".repeat(43) }))
        .status,
    ).toBe(400);
    expect((await attest(w, token, { kind: "app-attest" })).status).toBe(400);
    expect((await attest(w, `pkeyt_${"x".repeat(43)}`, {})).status).toBe(401);
  });

  it("a keyless re-registration of the same device id drops it back to basic", async () => {
    const w = await appleWorld();
    const token = await register(w);
    expect((await attest(w, token, await appAttestBody(w, token))).status).toBe(
      200,
    );
    await register(w); // anyone can present the client-chosen id again
    expect(await levelOf(w)).toBe("basic");
  });
});

// ── 6b. a licence (re)bind resets, a token rotation keeps ────────────────────────────────────

describe("the trust level across licence activation and token rotation", () => {
  const LICENSED: ServicesMap = { ...CONFIG_ONLY, license: { enabled: true } };

  async function activate(w: World, key: string): Promise<string> {
    const res = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": DEVICE,
      }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  it("re-activating the same device id with a licence key drops it back to basic", async () => {
    const w = await appleWorld(undefined, LICENSED);
    const { key } = await seedLicenseWithKey(w.db, "djdl");
    const token = await activate(w, key);
    expect((await attest(w, token, await appAttestBody(w, token))).status).toBe(
      200,
    );
    expect(await levelOf(w)).toBe("attested");
    // POST /license/activate again for the same device id: a new token minted without the old one.
    await activate(w, key);
    const row = (await getDevice(w.db, "djdl", DEVICE))!;
    expect(row.trust_level).toBe("basic");
    expect(row.attested_at).toBeNull();
  });

  it("POST /license/token rotation, which presents the old token, keeps attested", async () => {
    const w = await appleWorld(undefined, LICENSED);
    const { key } = await seedLicenseWithKey(w.db, "djdl");
    const token = await activate(w, key);
    expect((await attest(w, token, await appAttestBody(w, token))).status).toBe(
      200,
    );
    const res = await handleToken(
      mkReq("POST", {
        authorization: `Bearer ${token}`,
        "x-pkey-device": DEVICE,
      }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(res.status).toBe(200);
    const rotated = ((await res.json()) as { token: string }).token;
    expect(rotated).not.toBe(token);
    const row = (await getDevice(w.db, "djdl", DEVICE))!;
    expect(row.trust_level).toBe("attested");
    expect(row.attested_at).toBe(NOW);
  });
});

// ── 4. the rate limit ─────────────────────────────────────────────────────────────────────────

describe("the per-device attestation rate limit", () => {
  it("allows 4 attempts an hour per device, then 429 before the body or the challenge is read", async () => {
    const w = await appleWorld();
    const token = await register(w);
    for (let i = 0; i < 4; i++)
      expect((await attest(w, token, { kind: "app-attest" })).status).toBe(400);
    const limited = await attest(w, token, await appAttestBody(w, token));
    expect(limited.status).toBe(429);
    expect(limited.body.error).toEqual({ code: "rate_limited" });
    // Another device has its own budget.
    const other = await register(w, DEVICE_2);
    expect((await attest(w, other, { kind: "app-attest" })).status).toBe(400);
  });

  it("allows 10 challenges an hour per device", async () => {
    const w = await appleWorld();
    const token = await register(w);
    for (let i = 0; i < 10; i++)
      expect((await challenge(w, token)).status).toBe(200);
    expect((await challenge(w, token)).status).toBe(429);
  });
});

// ── 3. Play Integrity against a fake decode endpoint ─────────────────────────────────────────

const VERDICT = JSON.parse(
  readFileSync(
    join(HERE, "fixtures", "play", "integrity-verdict.json"),
    "utf8",
  ),
) as { tokenPayloadExternal: Record<string, Record<string, unknown>> };

/** A fake integrity token: the request hash and mint time it carries, plus verdict overrides. */
function integrityToken(
  requestHash: string,
  atMs: number,
  over: Record<string, Record<string, unknown>> = {},
): string {
  return `itok.${btoa(JSON.stringify({ requestHash, atMs, over }))}`;
}

async function playAttestWorld(
  opts: {
    pin?: string | null;
    policy?: Record<string, unknown>;
    /** A-16: no credential of the product's own; the platform service account instead. */
    platform?: { pin: string | null };
  } = {},
) {
  const pw = await playWorld({
    ...(opts.pin === undefined ? {} : { pin: opts.pin }),
    ...(opts.platform ? { credential: false } : {}),
  });
  if (opts.platform) {
    (pw.env as Record<string, unknown>).PLATFORM_GOOGLE_SERVICE_ACCOUNT =
      JSON.stringify({
        type: "service_account",
        client_email: CLIENT_EMAIL,
        private_key: pw.keys.privatePem,
        token_uri: "https://oauth2.googleapis.com/token",
      });
    if (opts.platform.pin !== null)
      await setPlatformPin(pw.db, {
        id: "google-play.service-account",
        product: PLAY_SLUG,
        pin: opts.platform.pin,
        actor: "x",
        now: NOW,
      });
  }
  await setServices(
    pw.db,
    PLAY_SLUG,
    serializeServices({
      services: {
        ...CONFIG_ONLY,
        release: { enabled: true },
        distribution: { enabled: true },
      },
    }),
    "manifest",
    NOW,
  );
  const decodes: Array<{
    url: string;
    authorization: string | null;
    body: unknown;
  }> = [];
  let decodeStatus = 200;
  const fetchImpl = async (
    input: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input);
    if (url.hostname !== "playintegrity.googleapis.com")
      return pw.fetchImpl(input, init);
    const authorization = new Headers(init?.headers).get("authorization");
    const body = JSON.parse(String(init?.body)) as { integrity_token: string };
    decodes.push({ url: input, authorization, body });
    // The bearer must be one the fake Google issued for the Play Integrity scope.
    const scoped = pw.fake.tokenRequests.some(
      (t) => t.scope === "https://www.googleapis.com/auth/playintegrity",
    );
    if (!authorization?.startsWith("Bearer ya29.test-") || !scoped)
      return new Response("{}", { status: 401 });
    if (decodeStatus !== 200)
      return new Response("{}", { status: decodeStatus });
    if (!body.integrity_token.startsWith("itok."))
      return new Response(JSON.stringify({ error: { code: 400 } }), {
        status: 400,
      });
    const t = JSON.parse(atob(body.integrity_token.slice(5))) as {
      requestHash: string;
      atMs: number;
      over: Record<string, Record<string, unknown>>;
    };
    const p = structuredClone(VERDICT.tokenPayloadExternal);
    p.requestDetails!.requestHash = t.requestHash;
    p.requestDetails!.timestampMillis = String(t.atMs);
    for (const [k, v] of Object.entries(t.over)) p[k] = { ...p[k], ...v };
    return new Response(JSON.stringify({ tokenPayloadExternal: p }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  if (opts.policy)
    await setTrustPolicy(pw.db, PLAY_SLUG, JSON.stringify(opts.policy), NOW);
  const product = (await loadProduct(pw.env, pw.db, PLAY_SLUG))!;
  const w: World = {
    db: pw.db,
    env: pw.env,
    slug: PLAY_SLUG,
    product,
    hooks: buildHooks(SERVICES, product.services, {
      env: pw.env,
      db: pw.db,
      product,
      now: NOW,
    }),
    deps: { fetchImpl },
  };
  return {
    w,
    decodes,
    setDecodeStatus: (s: number) => {
      decodeStatus = s;
    },
  };
}

async function playBody(
  w: World,
  token: string,
  over: Record<string, Record<string, unknown>> = {},
  atMs = NOW * 1000,
): Promise<Record<string, unknown>> {
  const c = await challenge(w, token);
  expect(c.status).toBe(200);
  return {
    kind: "play-integrity",
    token: integrityToken(c.body.requestHash as string, atMs, over),
    challenge: c.body.challenge,
  };
}

describe("POST /<p>/devices/attest — play-integrity", () => {
  it("a recognised app on a device meeting device integrity is attested, with the licensing verdict recorded", async () => {
    const { w, decodes } = await playAttestWorld();
    const token = await register(w);
    const r = await attest(w, token, await playBody(w, token));
    expect(r).toEqual({
      status: 200,
      body: { trustLevel: "attested", kind: "play-integrity", attestedAt: NOW },
    });
    expect(decodes).toHaveLength(1);
    expect(decodes[0]!.url).toBe(
      `https://playintegrity.googleapis.com/v1/${PLAY_PACKAGE}:decodeIntegrityToken`,
    );
    const row = (await getDevice(w.db, w.slug, DEVICE))!;
    expect(row.trust_level).toBe("attested");
    const verdict = JSON.parse(row.attestation_json!) as Record<
      string,
      unknown
    >;
    expect(verdict).toMatchObject({
      kind: "play-integrity",
      outcome: "attested",
      packageName: PLAY_PACKAGE,
      appLicensingVerdict: "LICENSED",
      deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"],
    });
    // Never the token itself.
    expect(row.attestation_json).not.toContain("itok.");
  });

  it("a verdict without MEETS_DEVICE_INTEGRITY does not raise the level", async () => {
    const { w } = await playAttestWorld();
    const token = await register(w);
    const r = await attest(
      w,
      token,
      await playBody(w, token, {
        deviceIntegrity: {
          deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"],
        },
      }),
    );
    expect(r.status).toBe(422);
    expect(await levelOf(w)).toBe("basic");
    expect(
      JSON.parse((await getDevice(w.db, w.slug, DEVICE))!.attestation_json!),
    ).toMatchObject({
      outcome: "rejected",
      reason: "device_integrity",
    });
  });

  it("a stale verdict does not raise the level", async () => {
    const { w } = await playAttestWorld();
    const token = await register(w);
    const r = await attest(
      w,
      token,
      await playBody(w, token, {}, (NOW - 3600) * 1000),
    );
    expect(r.status).toBe(422);
    expect(await levelOf(w)).toBe("basic");
  });

  it("a token minted for another challenge, or an unrecognised app, does not", async () => {
    const { w } = await playAttestWorld();
    const token = await register(w);
    const body = await playBody(w, token);
    const other = await challenge(w, token);
    expect(
      (await attest(w, token, { ...body, challenge: other.body.challenge }))
        .status,
    ).toBe(422);
    const unrecognised = await playBody(w, token, {
      appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION" },
    });
    expect((await attest(w, token, unrecognised)).status).toBe(422);
    expect(await levelOf(w)).toBe("basic");
  });

  it("an undecodable token is rejected; a Google outage is 503, not a rejection", async () => {
    const { w, setDecodeStatus } = await playAttestWorld();
    const token = await register(w);
    const c = await challenge(w, token);
    expect(
      (
        await attest(w, token, {
          kind: "play-integrity",
          token: "garbage",
          challenge: c.body.challenge,
        })
      ).status,
    ).toBe(422);
    setDecodeStatus(500);
    const r = await attest(w, token, await playBody(w, token));
    expect(r.status).toBe(503);
    expect(r.body.error).toEqual({ code: "attestation_unavailable" });
    expect(await levelOf(w)).toBe("basic");
  });

  it("a testing response (a license tester's configured verdict) is not attested by default", async () => {
    const { w } = await playAttestWorld();
    const token = await register(w);
    const r = await attest(
      w,
      token,
      await playBody(w, token, { testingDetails: { isTestingResponse: true } }),
    );
    expect(r.status).toBe(422);
    expect(await levelOf(w)).toBe("basic");
    expect(
      JSON.parse((await getDevice(w.db, w.slug, DEVICE))!.attestation_json!),
    ).toMatchObject({
      outcome: "rejected",
      reason: "testing_response",
      isTestingResponse: true,
    });
  });

  it("a testing response is attested only when the policy allows testing responses", async () => {
    const { w } = await playAttestWorld({
      policy: {
        playIntegrity: {
          cloudProjectNumber: "123456789012",
          allowTestingResponses: true,
        },
      },
    });
    const token = await register(w);
    const r = await attest(
      w,
      token,
      await playBody(w, token, { testingDetails: { isTestingResponse: true } }),
    );
    expect(r.status).toBe(200);
    expect(
      JSON.parse((await getDevice(w.db, w.slug, DEVICE))!.attestation_json!),
    ).toMatchObject({ outcome: "attested", isTestingResponse: true });
  });

  it("never decodes with an unpinned or mispinned credential (409, nothing sent)", async () => {
    for (const pin of [null, "gg.acme.other"]) {
      const { w, decodes } = await playAttestWorld({ pin });
      const token = await register(w);
      const r = await attest(w, token, await playBody(w, token));
      expect(r.status).toBe(409);
      expect(decodes).toHaveLength(0);
    }
  });
});

// ── A-16: the platform defaults (Team ID, project number, the Play service account) ─────────

describe("the platform store connection's defaults (A-16)", () => {
  const setPlatformSetting = (
    db: Db,
    store: string,
    key: string,
    value: string,
  ) =>
    db.run(
      "INSERT INTO platform_store_settings (store, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, 'x')",
      store,
      key,
      value,
      NOW,
    );

  it("App Attest uses the platform Team ID when the policy omits one; an explicit Team ID wins", async () => {
    const w = await appleWorld({ appAttest: { environment: "production" } });
    let token = await register(w);
    // No Team ID anywhere: unavailable, as before.
    expect((await attest(w, token, await appAttestBody(w, token))).status).toBe(
      409,
    );
    (w.env as Record<string, unknown>).PLATFORM_APPLE_TEAM_ID = TEAM;
    expect(await attest(w, token, await appAttestBody(w, token))).toMatchObject(
      {
        status: 200,
        body: { trustLevel: "attested" },
      },
    );

    // An explicit policy Team ID beats a different platform one.
    const w2 = await appleWorld({
      appAttest: { teamId: TEAM, environment: "production" },
    });
    await setPlatformSetting(w2.db, "app-store", "teamId", "ZZZZZ99999");
    token = await register(w2);
    expect(
      (await attest(w2, token, await appAttestBody(w2, token))).status,
    ).toBe(200);
  });

  it("the challenge hands out the platform's Play project number when the policy omits it; an explicit one wins", async () => {
    const w = await appleWorld({ playIntegrity: {} });
    expect((await challenge(w, await register(w))).body.play).toBeUndefined();
    await setPlatformSetting(w.db, "google-play", "cloudProjectNumber", "999");
    expect((await challenge(w, await register(w))).body.play).toEqual({
      cloudProjectNumber: "999",
    });
    const w2 = await appleWorld({
      playIntegrity: { cloudProjectNumber: "123456789012" },
    });
    await setPlatformSetting(w2.db, "google-play", "cloudProjectNumber", "999");
    expect((await challenge(w2, await register(w2))).body.play).toEqual({
      cloudProjectNumber: "123456789012",
    });
  });

  it("Play Integrity works for a product on the platform service account — only for its pinned package", async () => {
    const { w, decodes } = await playAttestWorld({
      platform: { pin: PLAY_PACKAGE },
    });
    const token = await register(w);
    const r = await attest(w, token, await playBody(w, token));
    expect(r).toMatchObject({ status: 200, body: { trustLevel: "attested" } });
    expect(decodes).toHaveLength(1);

    for (const pin of [null, "gg.acme.other"]) {
      const x = await playAttestWorld({ platform: { pin } });
      const t = await register(x.w);
      expect((await attest(x.w, t, await playBody(x.w, t))).status).toBe(409);
      expect(x.decodes).toHaveLength(0);
    }
  });
});

// ── 5. policy at the enforcement points ───────────────────────────────────────────────────────

async function mintWorld(policy: Record<string, unknown>) {
  const w = await appleWorld({
    ...policy,
    appAttest: { teamId: TEAM, environment: "production" },
  });
  await seedProductSecret(
    w.db,
    "djdl",
    "applemusic_devkey",
    ES_PEM,
    "edge-mint",
  );
  await w.db.run(
    "INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template) VALUES (?,?,?,?,?,?,?,?,?)",
    "djdl",
    "applemusic",
    "ES256",
    "applemusic_devkey",
    "KID123",
    JSON.stringify({ iss: "TEAMID123" }),
    3600,
    null,
    null,
  );
  await approveEdgeMintRecipe(w.db, "djdl", "applemusic", {
    acknowledgeOpenRegistration: true,
  });
  await reload(w);
  const mint = async (token: string) => {
    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      w.env,
      w.db,
      w.product,
      "applemusic",
      NOW,
    );
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  };
  return { w, mint };
}

describe("edge-mint under the trust policy", () => {
  it("the default policy asks nothing and audits nothing", async () => {
    const { w, mint } = await mintWorld({});
    expect((await mint(await register(w))).status).toBe(200);
    expect(
      (await auditActions(w.db)).filter((a) => a.startsWith("device.trust")),
    ).toEqual([]);
  });

  it("enforce: false — a basic device still mints, and one audit row records the would-be refusal", async () => {
    const { w, mint } = await mintWorld({ mint: "attested" });
    const token = await register(w);
    expect((await mint(token)).status).toBe(200);
    expect((await mint(token)).status).toBe(200);
    const rows = await w.db.all<{
      action: string;
      target_id: string;
      summary: string;
    }>(
      "SELECT action, target_id, summary FROM audit WHERE action LIKE 'device.trust.%'",
    );
    // Deduplicated per device and operation within the window.
    expect(rows).toEqual([
      {
        action: "device.trust.would_refuse",
        target_id: DEVICE,
        summary:
          "mint requires an attested device; this device is basic (log-only: allowed)",
      },
    ]);
  });

  it("enforce: true — a basic device gets a typed refusal; an attested one mints", async () => {
    const { w, mint } = await mintWorld({ mint: "attested", enforce: true });
    const token = await register(w);
    const refused = await mint(token);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("attestation_required");
    expect(await auditActions(w.db)).toContain("device.trust.refused");
    expect((await attest(w, token, await appAttestBody(w, token))).status).toBe(
      200,
    );
    expect((await mint(token)).status).toBe(200);
  });
});

describe("gated delivery under the trust policy", () => {
  const LICENSED: ServicesMap = { ...CONFIG_ONLY, license: { enabled: true } };
  const DEVICE_TOKEN = `pkeyt_${"g".repeat(43)}`;

  async function gatedWorld(policy: Record<string, unknown>) {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await setServices(
      db,
      "djdl",
      serializeServices({ services: LICENSED }),
      "manifest",
      NOW,
    );
    await setTrustPolicy(db, "djdl", JSON.stringify(policy), NOW);
    const { licenseId } = await seedLicenseWithKey(db, "djdl", {
      entitlements: { dlc: { state: "enforced", value: true, updatedAt: NOW } },
    });
    await upsertDevice(db, {
      product: "djdl",
      device_id: DEVICE,
      customer_id: null,
      license_id: licenseId,
      status: "authorized",
      first_seen: NOW,
      last_seen: NOW,
      ua: null,
      label: null,
      overrides_json: null,
      reported_json: null,
      token_hash: await hashKey(DEVICE_TOKEN, env.KEY_HASH_PEPPER),
    });
    const product = (await loadProduct(env, db, "djdl"))!;
    return { db, env, product };
  }

  it("a basic device holding the gate's flag still downloads in log-only mode, audited once", async () => {
    const g = await gatedWorld({ gatedDelivery: "attested" });
    for (let i = 0; i < 3; i++)
      expect(
        await entitlementFlagRefusal(
          g.env,
          g.db,
          g.product,
          DEVICE_TOKEN,
          ["dlc"],
          NOW,
        ),
      ).toBeNull();
    expect(
      await accessRefusal(
        g.env,
        g.db,
        g.product,
        DEVICE_TOKEN,
        "licensed",
        {},
        false,
        NOW,
      ),
    ).toBeNull();
    expect(
      (await auditActions(g.db)).filter(
        (a) => a === "device.trust.would_refuse",
      ),
    ).toHaveLength(1);
  });

  it("enforced: the pack gate answers the nested refusal, the licensed mode the flat one", async () => {
    const g = await gatedWorld({ gatedDelivery: "attested", enforce: true });
    const pack = await entitlementFlagRefusal(
      g.env,
      g.db,
      g.product,
      DEVICE_TOKEN,
      ["dlc"],
      NOW,
    );
    expect(pack?.status).toBe(403);
    expect(await pack!.json()).toEqual({
      error: { code: "attestation_required" },
      message: "this operation requires an attested device",
    });
    const mode = await accessRefusal(
      g.env,
      g.db,
      g.product,
      DEVICE_TOKEN,
      "licensed",
      {},
      false,
      NOW,
    );
    expect(mode?.status).toBe(403);
    expect(((await mode!.json()) as { error: string }).error).toBe(
      "attestation_required",
    );
    // The gate itself still decides first: a flag the licence lacks is not_entitled, not trust.
    const lacking = await entitlementFlagRefusal(
      g.env,
      g.db,
      g.product,
      DEVICE_TOKEN,
      ["other"],
      NOW,
    );
    expect(
      ((await lacking!.json()) as { error: { code: string } }).error.code,
    ).toBe("not_entitled");
  });

  it("enforced: an attested device downloads", async () => {
    const g = await gatedWorld({ gatedDelivery: "attested", enforce: true });
    await g.db.run(
      "UPDATE devices SET trust_level = 'attested', attested_at = ? WHERE device_id = ?",
      NOW,
      DEVICE,
    );
    expect(
      await entitlementFlagRefusal(
        g.env,
        g.db,
        g.product,
        DEVICE_TOKEN,
        ["dlc"],
        NOW,
      ),
    ).toBeNull();
  });
});
