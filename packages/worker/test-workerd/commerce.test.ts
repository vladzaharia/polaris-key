/// <reference types="@cloudflare/workers-types" />
// ── The commerce bridge's cryptography on workerd (P6-01) ──────────────────────────────────
//
// The brief: "the X.509 code must run in workerd". `core/x509.ts` is a DER interpreter over
// WebCrypto ECDSA (P-256 and P-384, SHA-256 and SHA-384) and the App Store verification is built
// on it; the Play push check is jose over a KV-cached JWKS. The Node lane covers the behaviour
// (`test/x509.test.ts`, `test/commerce.test.ts`); this proves the same code verifies — and
// refuses — inside the runtime it ships to, with chains generated in the isolate.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { verifyChain, parseCertificate } from "../src/core/x509.js";
import {
  AppleRejected,
  setAppleRootsForTesting,
  verifyAppleJws,
} from "../src/services/distribution/commerce/apple.js";
import { APPLE_ROOT_CA_G3_DER } from "../src/services/distribution/commerce/appleRoot.js";
import { verifyPushJwt } from "../src/services/distribution/commerce/play.js";
import {
  GoogleFake,
  PUSH_ACCOUNT,
  PUSH_AUDIENCE,
} from "../test/commerceFake.js";
import {
  APPLE_INTERMEDIATE_OID,
  APPLE_LEAF_OID,
  makeChain,
  signX5cJws,
} from "../test/x509Fixtures.js";
import type { Env as WorkerEnv } from "../src/env.js";

const workerEnv = env as unknown as WorkerEnv;
const now = Math.floor(Date.now() / 1000);

afterEach(() => setAppleRootsForTesting(null));

describe("workerd: X.509 and the App Store JWS", () => {
  it("parses the pinned Apple Root CA - G3", () => {
    const root = parseCertificate(APPLE_ROOT_CA_G3_DER);
    expect(root.curve).toBe("P-384");
    expect(root.ca).toBe(true);
  });

  it("verifies an Apple-shaped chain and refuses a broken link", async () => {
    const c = await makeChain({ at: now });
    const policy = {
      roots: [c.root],
      at: now,
      length: 3,
      leafOids: [APPLE_LEAF_OID],
      intermediateOids: [APPLE_INTERMEDIATE_OID],
    };
    const { leaf } = await verifyChain(c.chain, policy);
    expect(leaf.curve).toBe("P-256");
    const broken = await makeChain({ at: now, brokenLink: true });
    await expect(
      verifyChain(broken.chain, { ...policy, roots: [broken.root] }),
    ).rejects.toThrow("bad certificate signature");
  });

  it("verifies a StoreKit-shaped JWS end to end and refuses one from an unpinned root", async () => {
    const c = await makeChain({ at: now });
    setAppleRootsForTesting([c.root]);
    const jws = await signX5cJws(
      { transactionId: "1", bundleId: "gg.acme.djdl", signedDate: now * 1000 },
      c.leafKey,
      c.x5c,
    );
    expect(await verifyAppleJws(jws, now)).toMatchObject({
      transactionId: "1",
    });
    setAppleRootsForTesting(null); // back to Apple's root: the test chain is now untrusted
    await expect(verifyAppleJws(jws, now)).rejects.toBeInstanceOf(
      AppleRejected,
    );
  });
});

describe("workerd: the Play push token", () => {
  it("verifies a Google-shaped OIDC push token against a KV-cached JWKS", async () => {
    const google = await GoogleFake.create();
    const jwks = (await google
      .handle(
        {
          method: "GET",
          url: new URL("https://www.googleapis.com/oauth2/v3/certs"),
          authorization: null,
        },
        undefined,
      )
      .then((r) => r.json())) as { keys: unknown[] };
    await workerEnv.HOT.put(
      "commerce:google-jwks",
      JSON.stringify({ keys: jwks.keys, fetchedAt: now }),
    );
    const settings = {
      packageName: "gg.acme.djdl",
      pushAudience: PUSH_AUDIENCE,
      pushServiceAccount: PUSH_ACCOUNT,
      acceptTestPurchases: false,
    };
    const good = await google.pushToken(now);
    expect(
      await verifyPushJwt(workerEnv, `Bearer ${good}`, settings, now),
    ).toEqual({ ok: true });
    const other = await google.pushToken(now, {
      email: "someone@else.iam.gserviceaccount.com",
    });
    expect(
      await verifyPushJwt(workerEnv, `Bearer ${other}`, settings, now),
    ).toEqual({
      ok: false,
      reason: "wrong_account",
    });
  });
});
