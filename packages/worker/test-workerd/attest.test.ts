/// <reference types="@cloudflare/workers-types" />
// ── Device attestation on workerd (P6-02) ─────────────────────────────────────────────────
//
// The Node lane (test/attest.test.ts, test/appAttest.test.ts) proves the routes and the checks.
// This proves what only workerd can: the hand-written DER/X.509/CBOR code and WebCrypto ECDSA
// (P-384 issuers signing P-256 leaves with SHA-256, P-384 with SHA-384) verify in the runtime
// that ships, with no runtime code generation, and the 0053 migrations apply to real D1.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  appleAppAttestRoot,
  verifyAppAttestation,
} from "../src/core/trust/appAttest.js";
import { certificateKey, ecdsaDerToRaw } from "../src/core/trust/x509.js";
import { checkPlayVerdict } from "../src/core/trust/playIntegrity.js";
import { makeAppAttestation, makeTestChain } from "../test/attestFixtures.js";

const NOW = 1_767_225_600;
const APP_ID = "ABCDE12345.gg.acme.dice";

describe("attestation on workerd", () => {
  it("parses the pinned Apple App Attestation Root CA and verifies its self-signature", async () => {
    const root = appleAppAttestRoot();
    expect(root.curve).toBe("P-384");
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-384" },
        await certificateKey(root),
        ecdsaDerToRaw(root.signature, 48),
        root.tbs,
      ),
    ).toBe(true);
  });

  it("verifies a generated App Attest object and refuses a tampered one", async () => {
    const chain = await makeTestChain(NOW);
    const clientDataHash = new Uint8Array(32).fill(9);
    const base = {
      clientDataHash,
      appIds: [APP_ID],
      environment: "production" as const,
      now: NOW,
      roots: [chain.root],
    };
    const good = await makeAppAttestation(chain, NOW, {
      appId: APP_ID,
      clientDataHash,
    });
    expect(await verifyAppAttestation({ ...base, ...good })).toMatchObject({
      ok: true,
    });
    const foreign = await makeAppAttestation(chain, NOW, {
      appId: APP_ID,
      clientDataHash,
      foreignIssuer: true,
    });
    expect(await verifyAppAttestation({ ...base, ...foreign })).toMatchObject({
      ok: false,
      reason: "chain",
    });
  });

  it("checks a Play verdict", () => {
    expect(
      checkPlayVerdict(
        {
          tokenPayloadExternal: {
            requestDetails: {
              requestPackageName: "gg.acme.dice",
              requestHash: "h",
              timestampMillis: String(NOW * 1000),
            },
            appIntegrity: {
              appRecognitionVerdict: "PLAY_RECOGNIZED",
              packageName: "gg.acme.dice",
            },
            deviceIntegrity: {
              deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"],
            },
          },
        },
        { packageName: "gg.acme.dice", requestHash: "h", now: NOW },
      ),
    ).toMatchObject({ ok: true });
  });

  it("D1 has the trust columns from the 0053 migrations", async () => {
    const db = env.DB;
    await db
      .prepare(
        "SELECT trust_level, attested_at, attestation_json FROM devices LIMIT 0",
      )
      .all();
    await db
      .prepare(
        "SELECT trust_policy_json, trust_policy_source FROM products LIMIT 0",
      )
      .all();
  });
});
