/// <reference types="@cloudflare/workers-types" />

// I-13.4 (WIRE-CONTRACT-V5 §12.11.3): the token-exchange grant. Provider tokens are signed by a
// local key (identityProviderHarness); no call leaves the process.
//
//   - the lookup is by link only: a cross-team Apple id misses, an address joins nothing;
//   - the nonce is spent once, and bound to the device and the key;
//   - a foreign key, a bad proof and every verifier failure are ONE byte-identical refusal;
//   - Identity off answers 404.

import { beforeEach, describe, expect, it } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import {
  appleClaims,
  googleClaims,
  makeProviderHarness,
  type ProviderHarness,
} from "../../identityProviderHarness.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import { NOW } from "../../seed.js";
import { dispatchWith } from "../../../src/dispatch.js";
import {
  serializeServices,
  type ServiceSlug,
} from "../../../src/core/services.js";
import { servicesOn } from "../../transcripts/world.js";
import { setServices } from "../../../src/core/products/store.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { getDeviceKeys } from "../../../src/core/devices/keys.js";
import { sha256B64url } from "../../../src/platform/hash.js";
import {
  exchangeLinkRef,
  type ExchangeLinkRecord,
} from "../../../src/services/identity/passthrough/exchange.js";
import { getArtefact } from "../../../src/core/singleUse.js";
import {
  EXCHANGE_SUBJECT_TOKEN_TYPE,
  LINK_HANDLE_PATTERN,
  TOKEN_EXCHANGE_GRANT_TYPE,
} from "@polaris-key/protocol/identity";

const SLUG = "djdl";
const BASE = "https://key.plrs.im";
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const DEVICE_2 = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";
const WEB = "1234-web.apps.googleusercontent.com";
const AND = "1234-and.apps.googleusercontent.com";
const TEAM = "ABCDE12345";
const BUNDLE = "com.acme.mac";
const GOOGLE_SUB = "g-sub-1";
const APPLE_SUB = "a-sub-1";

let h: ProviderHarness;

async function setting(key: string, value: unknown): Promise<void> {
  await h.db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, ?, ?, 'manifest', ?, 'test')`,
    SLUG,
    key,
    JSON.stringify(value),
    NOW,
  );
}

/** Config and Identity on; `license` and `identity` can be flipped. */
async function services(
  over: { license?: boolean; identity?: boolean } = {},
): Promise<void> {
  const on: ServiceSlug[] = ["config"];
  if (over.identity !== false) on.push("identity");
  if (over.license) on.push("license");
  await setServices(
    h.db,
    SLUG,
    serializeServices({ services: servicesOn(...on) }),
    "manifest",
    NOW,
  );
}

beforeEach(async () => {
  h = await makeProviderHarness();
  h.env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  await services();
  await setting("identity.platformSignIn.google.serverClientId", WEB);
  await setting("identity.platformSignIn.google.clientIds", [AND]);
  await setting("identity.platformSignIn.apple.teamId", TEAM);
  await setting("identity.platformSignIn.apple.bundleIds", [BUNDLE]);
});

const route = (path: string, init: RequestInit) =>
  dispatchWith(
    new Request(`${BASE}${path}`, init) as unknown as Request,
    h.env,
    h.db,
    NOW,
  );

/** POST the exchange grant with exactly these form fields. */
const postExchange = (
  fields: {
    token: string;
    nonce: string;
    keys: { signKey: string };
    proof: string;
  },
  device = DEVICE,
) =>
  route(`/${SLUG}/identity/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-pkey-device": device,
    },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      client_id: SLUG,
      subject_token: fields.token,
      subject_token_type: EXCHANGE_SUBJECT_TOKEN_TYPE,
      nonce: fields.nonce,
      device_key: fields.keys.signKey,
      proof: fields.proof,
    }).toString(),
  });

async function nonceFor(
  keys: { signKey: string; agreeKey: string },
  device = DEVICE,
): Promise<string> {
  const res = await route(`/${SLUG}/identity/nonce`, {
    method: "POST",
    headers: { "x-pkey-device": device, "content-type": "application/json" },
    body: JSON.stringify({ signKey: keys.signKey, agreeKey: keys.agreeKey }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { nonce: string }).nonce;
}

async function proofFor(
  priv: CryptoKey,
  o: {
    nonce: string;
    signKey: string;
    token: string;
    device?: string;
    purpose?: string;
  },
): Promise<string> {
  const msg = [
    "pkey-proof/1",
    o.purpose ?? "exchange",
    SLUG,
    o.device ?? DEVICE,
    `${o.nonce}.${o.signKey}`,
    await sha256B64url(o.token),
  ].join("\n");
  return base64UrlEncodeBytes(
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(msg)),
    ),
  );
}

interface Keys {
  signKey: string;
  agreeKey: string;
  priv: CryptoKey;
}

/** One full attempt: nonce, token, proof, POST. `mint` receives the nonce the token must carry. */
async function exchange(
  mint: (nonce: string) => Promise<string>,
  o: {
    keys?: Keys;
    device?: string;
    proofKeys?: Keys;
    nonceKeys?: Keys;
    nonce?: string;
    token?: string;
  } = {},
): Promise<{
  status: number;
  text: string;
  body: Record<string, unknown>;
  keys: Keys;
  nonce: string;
  token: string;
}> {
  const keys = o.keys ?? (await newKeys());
  const device = o.device ?? DEVICE;
  const nonce = o.nonce ?? (await nonceFor(o.nonceKeys ?? keys, device));
  const token = o.token ?? (await mint(nonce));
  const signer = o.proofKeys ?? keys;
  const proof = await proofFor(signer.priv, {
    nonce,
    signKey: keys.signKey,
    token,
    device,
  });
  const res = await postExchange(
    { token: token, nonce: nonce, keys: keys, proof: proof },
    device,
  );
  const text = await res.text();
  return {
    status: res.status,
    text,
    body: text.startsWith("{") ? (JSON.parse(text) as never) : {},
    keys,
    nonce,
    token,
  };
}

const google =
  (over: Record<string, unknown> = {}) =>
  (nonce: string) =>
    h.signGoogle(
      googleClaims(nonce, { aud: WEB, azp: AND, sub: GOOGLE_SUB, ...over }),
    );
const apple =
  (over: Record<string, unknown> = {}) =>
  (nonce: string) =>
    h.signApple(appleClaims(nonce, { aud: BUNDLE, sub: APPLE_SUB, ...over }));

async function link(
  issuerKey: string,
  tenantScope: string,
  subject: string,
  kind: "google" | "apple",
  email = "ada@example.com",
): Promise<string> {
  const r = await signIn(
    h.db,
    { issuerKey, tenantScope, subject, kind, email, emailVerified: true },
    NOW,
    { unfenced: true, product: { slug: SLUG, tenantScopes: [tenantScope] } },
  );
  if (r.status !== "signed_in") throw new Error("seed link failed");
  return r.account.id;
}

const count = async (table: string): Promise<number> =>
  (await h.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;

describe("the token exchange", () => {
  it("signs in through a global Google link: a device token, the keys registered, the audit without the token", async () => {
    await link("https://accounts.google.com", "", GOOGLE_SUB, "google");
    const r = await exchange(google());
    expect(r.status).toBe(200);
    expect(r.body.issued_token_type).toBe("urn:polaris-key:token-type:device");
    expect(typeof r.body.access_token).toBe("string");
    const held = await getDeviceKeys(h.db, SLUG, DEVICE);
    expect(held?.sign_key).toBe(r.keys.signKey);
    expect(held?.agree_key).toBe(r.keys.agreeKey);
    const audit = await h.db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM audit WHERE action = 'signin.exchange'",
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(r.token);
    expect(audit[0]!.summary).toContain("google");
  });

  it("hands over a pending grant when a licence choice is due, carrying the keys for complete", async () => {
    await services({ license: true });
    await link("https://accounts.google.com", "", GOOGLE_SUB, "google");
    const r = await exchange(google());
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("choose");
    expect(r.body.access_token).toBeUndefined();
    // The device is not bound yet, so its keys are not written.
    expect(await getDeviceKeys(h.db, SLUG, DEVICE)).toBeNull();
  });

  it("finds a link under the second tenant scope, in order", async () => {
    await link(
      "https://accounts.google.com",
      `google-client:${WEB}`,
      GOOGLE_SUB,
      "google",
    );
    const r = await exchange(google());
    expect(r.status).toBe(200);
  });

  it("an Apple id under another team misses (cross-team): no_link with a link handle, nothing created", async () => {
    await link(
      "https://appleid.apple.com",
      "apple-team:OTHERTEAM1",
      APPLE_SUB,
      "apple",
    );
    const accounts = await count("accounts");
    const links = await count("account_links");
    const r = await exchange(apple());
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({
      error: "interstitial_required",
      reason: "no_link",
      expiresIn: 600,
    });
    expect(r.body.linkHandle).toMatch(new RegExp(LINK_HANDLE_PATTERN));
    expect(await count("accounts")).toBe(accounts);
    expect(await count("account_links")).toBe(links);
    expect(await getDeviceKeys(h.db, SLUG, DEVICE)).toBeNull();
  });

  it("the link handle holds the verified identity, bound to product, device and key", async () => {
    const r = await exchange(google());
    const handle = r.body.linkHandle as string;
    const raw = await getArtefact(
      h.env,
      await exchangeLinkRef(h.env, SLUG, handle),
    );
    const rec = JSON.parse(raw!) as ExchangeLinkRecord;
    expect(rec).toMatchObject({
      product: SLUG,
      deviceId: DEVICE,
      kind: "google",
      subject: GOOGLE_SUB,
      tenantScopes: ["", `google-client:${WEB}`],
    });
    expect(rec.keyThumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("an address joins nothing: a verified email another account uses, with no link, is still no_link", async () => {
    // The address is held by an email method on another account.
    const other = await signIn(
      h.db,
      {
        issuerKey: "email",
        subject: "ada@example.com",
        kind: "email",
        email: "ada@example.com",
        emailVerified: true,
      },
      NOW,
      { unfenced: true },
    );
    expect(other.status).toBe("signed_in");
    const accounts = await count("accounts");
    const links = await count("account_links");
    const r = await exchange(google({ email: "ada@example.com" }));
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe("no_link");
    expect(await count("accounts")).toBe(accounts);
    expect(await count("account_links")).toBe(links);
  });

  it("a replayed exchange is refused: the nonce is spent", async () => {
    await link("https://accounts.google.com", "", GOOGLE_SUB, "google");
    const first = await exchange(google());
    expect(first.status).toBe(200);
    // The same nonce, the same token, a fresh proof by the same key.
    const again = await exchange(google(), {
      keys: first.keys,
      nonce: first.nonce,
      token: first.token,
    });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
  });

  it("a foreign key is refused: a nonce issued for another key, a proof by another key, a device holding another key", async () => {
    await link("https://accounts.google.com", "", GOOGLE_SUB, "google");
    const a = await newKeys();
    const b = await newKeys();
    // Nonce issued for A, presented with B.
    const n1 = await exchange(google(), { keys: b, nonceKeys: a });
    expect(n1.body.error).toBe("invalid_grant");
    // Proof signed by A for B's key.
    const n2 = await exchange(google(), { keys: b, proofKeys: a });
    expect(n2.body.error).toBe("invalid_grant");
    // The device registers A, then B tries.
    const early = await nonceFor(b); // issued before A registers
    expect((await exchange(google(), { keys: a })).status).toBe(200);
    const n3 = await exchange(google(), { keys: b, nonce: early });
    expect(n3.body.error).toBe("invalid_grant");
    expect((await getDeviceKeys(h.db, SLUG, DEVICE))?.sign_key).toBe(a.signKey);
  });

  it("a proof for another purpose, device or token is refused", async () => {
    await link("https://accounts.google.com", "", GOOGLE_SUB, "google");
    const keys = await newKeys();
    const nonce = await nonceFor(keys);
    const token = await google()(nonce);
    for (const bad of [
      { purpose: "link" },
      { device: DEVICE_2 },
      { token: token + "x" },
    ]) {
      const proof = await proofFor(keys.priv, {
        nonce,
        signKey: keys.signKey,
        token,
        ...bad,
      });
      const res = await postExchange(
        { token: token, nonce: nonce, keys: keys, proof: proof },
        DEVICE,
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_grant",
      );
    }
    // A bad proof spends no nonce: the right one still goes through.
    const proof = await proofFor(keys.priv, {
      nonce,
      signKey: keys.signKey,
      token,
    });
    const ok = await postExchange(
      { token: token, nonce: nonce, keys: keys, proof: proof },
      DEVICE,
    );
    expect(ok.status).toBe(200);
  });

  it("Identity off answers 404 and mints nothing", async () => {
    await link("https://accounts.google.com", "", GOOGLE_SUB, "google");
    const keys = await newKeys();
    const nonce = await nonceFor(keys);
    await services({ identity: false });
    const token = await google()(nonce);
    const res = await postExchange(
      {
        token: token,
        nonce: nonce,
        keys: keys,
        proof: await proofFor(keys.priv, {
          nonce,
          signKey: keys.signKey,
          token,
        }),
      },
      DEVICE,
    );
    expect(res.status).toBe(404);
    expect(await getDeviceKeys(h.db, SLUG, DEVICE)).toBeNull();
  });
});

describe("one refusal for every verifier failure", () => {
  it("different failures answer byte-identical responses", async () => {
    await link("https://accounts.google.com", "", GOOGLE_SUB, "google");
    const failures: Array<(nonce: string) => Promise<string>> = [
      google({ aud: "evil" }), // audience
      google({ azp: "evil" }), // authorised party
      google({ iss: "https://rogue.example" }), // issuer (no provider)
      google({ nonce: "another-nonce" }), // nonce claim
      google({ iat: Math.floor(Date.now() / 1000) - 3600 }), // stale
      google({ exp: Math.floor(Date.now() / 1000) - 3600 }), // expired
      async () => "not.a.jwt", // not a token at all
    ];
    const seen: Array<{ status: number; text: string }> = [];
    for (const mint of failures) {
      const r = await exchange(mint);
      seen.push({ status: r.status, text: r.text });
    }
    expect(seen[0]!.status).toBe(400);
    expect(seen[0]!.text).toContain("invalid_grant");
    for (const s of seen) expect(s).toEqual(seen[0]);
    // The verifier's own words never reach the caller.
    expect(seen[0]!.text).not.toMatch(/azp|nonce|audience|aud\b|expired/i);
    // A failed exchange writes no audit row.
    expect(await count("audit")).toBe(0);
  });
});
