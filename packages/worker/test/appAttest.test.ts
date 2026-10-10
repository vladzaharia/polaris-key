// P6-02 — the App Attest verifier, the X.509 chain verifier and the CBOR decoder under it,
// against generated chains (`attestFixtures.ts`) and the pinned Apple root itself.
//
// Each refusal case changes exactly one thing from a passing attestation, so a pass that turns
// into a refusal names the one check that caught it.

import { describe, expect, it } from "vitest";
import {
  APPLE_APP_ATTEST_ROOT_PEM,
  appleAppAttestRoot,
  appleAppAttestRootDer,
  pemToDer,
  verifyAppAttestation,
  type AppAttestInput,
} from "../src/core/trust/appAttest.js";
import { CborError, decodeCbor } from "../src/core/trust/cbor.js";
import {
  certificateKey,
  ecdsaDerToRaw,
  parseCertificate,
  verifyChain,
  X509Error,
} from "../src/core/trust/x509.js";
import { checkPlayVerdict } from "../src/core/trust/playIntegrity.js";
import {
  cbor,
  makeAppAttestation,
  makeTestChain,
  type AttestKnobs,
} from "./attestFixtures.js";

const NOW = 1_767_225_600; // 2026-01-01T00:00:00Z
const APP_ID = "ABCDE12345.gg.acme.dice";
const CDH = new Uint8Array(32).fill(7);

async function attempt(
  knobs: Partial<AttestKnobs> = {},
  input: Partial<AppAttestInput> = {},
) {
  const chain = await makeTestChain(NOW);
  const { attestation, keyId } = await makeAppAttestation(chain, NOW, {
    appId: APP_ID,
    clientDataHash: CDH,
    ...knobs,
  });
  return verifyAppAttestation({
    attestation,
    keyId,
    clientDataHash: CDH,
    appIds: [APP_ID],
    environment: "production",
    now: NOW,
    roots: [chain.root],
    ...input,
  });
}

describe("the pinned Apple App Attestation Root CA", () => {
  it("parses, is a self-signed P-384 CA, and has the published fingerprint", async () => {
    const root = appleAppAttestRoot();
    expect(root.curve).toBe("P-384");
    expect(root.ca).toBe(true);
    expect(root.keyCertSign).toBe(true);
    expect(root.pathLen).toBeNull();
    // The self-signature (ecdsa-with-SHA384 under its own P-384 key).
    expect(root.signatureAlgorithm).toBe("1.2.840.10045.4.3.3");
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-384" },
        await certificateKey(root),
        ecdsaDerToRaw(root.signature, 48),
        root.tbs,
      ),
    ).toBe(true);
    const fp = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        pemToDer(APPLE_APP_ATTEST_ROOT_PEM),
      ),
    );
    expect(
      Array.from(fp, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(
        ":",
      ),
    ).toBe(
      "1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32",
    );
    // Valid 2020-03-18 .. 2045-03-15.
    expect(root.notBefore).toBe(1584556373);
    expect(root.notAfter).toBe(2373148800);
  });

  it("a P-384 root issuing a P-384 intermediate that signs a P-256 leaf verifies through the shared verifier", async () => {
    const chain = await makeTestChain(NOW);
    const { attestation } = await makeAppAttestation(chain, NOW, {
      appId: APP_ID,
      clientDataHash: CDH,
    });
    const att = decodeCbor(attestation) as Map<unknown, unknown>;
    const x5c = (att.get("attStmt") as Map<unknown, unknown>).get(
      "x5c",
    ) as Uint8Array[];
    const v = await verifyChain([...x5c, chain.root], {
      roots: [chain.root],
      at: NOW,
      understood: ["1.2.840.113635.100.8.2"],
      leafDigitalSignature: "ifPresent",
    });
    expect(v.leaf.curve).toBe("P-256");
    expect(v.chain.map((c) => c.curve)).toEqual(["P-256", "P-384", "P-384"]);
    // The pinned Apple root did not issue this chain: the shared verifier refuses it.
    await expect(
      verifyChain([...x5c, appleAppAttestRootDer()], {
        roots: [appleAppAttestRootDer()],
        at: NOW,
      }),
    ).rejects.toThrow(X509Error);
  });

  it("is what production verifies against: a generated chain fails without the test root", async () => {
    expect(await attempt({}, { roots: undefined })).toMatchObject({
      ok: false,
      reason: "chain",
      detail: "untrusted root",
    });
  });
});

describe("verifyAppAttestation", () => {
  it("accepts a well-formed attestation and returns the key for later assertions", async () => {
    const r = await attempt();
    expect(r).toMatchObject({
      ok: true,
      appId: APP_ID,
      environment: "production",
    });
    if (r.ok) expect(r.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
  });

  it("accepts the development aaguid only when the policy says development", async () => {
    expect(
      await attempt(
        { environment: "development" },
        { environment: "development" },
      ),
    ).toMatchObject({ ok: true });
    expect(await attempt({ environment: "development" })).toMatchObject({
      ok: false,
      reason: "aaguid",
    });
    expect(await attempt({}, { environment: "development" })).toMatchObject({
      ok: false,
      reason: "aaguid",
    });
  });

  it("refuses a wrong RP ID (another team or bundle)", async () => {
    expect(await attempt({ appId: "ZZZZZ99999.gg.acme.dice" })).toMatchObject({
      ok: false,
      reason: "rp_id",
    });
    expect(
      await attempt({}, { appIds: ["ABCDE12345.gg.acme.other"] }),
    ).toMatchObject({
      ok: false,
      reason: "rp_id",
    });
  });

  it("refuses a wrong nonce and a different client data hash", async () => {
    expect(await attempt({ nonce: new Uint8Array(32) })).toMatchObject({
      ok: false,
      reason: "nonce",
    });
    expect(
      await attempt({}, { clientDataHash: new Uint8Array(32).fill(8) }),
    ).toMatchObject({ ok: false, reason: "nonce" });
  });

  it("refuses a broken chain: a foreign issuer, an expired credential certificate", async () => {
    expect(await attempt({ foreignIssuer: true })).toMatchObject({
      ok: false,
      reason: "chain",
      detail: "x509: bad certificate signature",
    });
    expect(await attempt({ leafNotAfterOffset: -60 })).toMatchObject({
      ok: false,
      reason: "chain",
      detail: "x509: certificate not valid now",
    });
  });

  it("refuses a non-zero counter", async () => {
    expect(await attempt({ counter: 1 })).toMatchObject({
      ok: false,
      reason: "counter",
    });
  });

  it("refuses a key id that is not the credential key's hash", async () => {
    expect(await attempt({ wrongKeyId: true })).toMatchObject({
      ok: false,
      reason: "key_id",
    });
  });

  it("refuses another format and garbage", async () => {
    expect(await attempt({ fmt: "packed" })).toMatchObject({
      ok: false,
      reason: "format",
    });
    expect(
      await verifyAppAttestation({
        attestation: new Uint8Array([0xff, 0x00]),
        keyId: btoa("x".repeat(32)),
        clientDataHash: CDH,
        appIds: [APP_ID],
        environment: "production",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("decodeCbor", () => {
  it("round-trips the shapes App Attest uses", () => {
    const v = decodeCbor(
      cbor({
        map: [
          ["a", 1],
          ["b", new Uint8Array([1, 2])],
          ["c", ["x", 500, 70000]],
        ],
      }),
    );
    expect(v).toBeInstanceOf(Map);
    const m = v as Map<unknown, unknown>;
    expect(m.get("a")).toBe(1);
    expect(m.get("b")).toEqual(new Uint8Array([1, 2]));
    expect(m.get("c")).toEqual(["x", 500, 70000]);
  });

  it("refuses truncation, trailing bytes, indefinite lengths, floats and duplicate keys", () => {
    for (const bad of [
      new Uint8Array([0x62, 0x61]), // text of 2, 1 byte present
      new Uint8Array([0x01, 0x02]), // trailing
      new Uint8Array([0x9f, 0xff]), // indefinite array
      new Uint8Array([0xf9, 0x3c, 0x00]), // half float
      new Uint8Array([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]), // {"a":1,"a":2}
      new Uint8Array([0x5b, 0, 0, 0, 0, 0, 0, 0, 0xff]), // huge byte string length
    ])
      expect(() => decodeCbor(bad)).toThrow(CborError);
  });

  it("caps nesting", () => {
    const deep = new Uint8Array(40).fill(0x81);
    expect(() => decodeCbor(new Uint8Array([...deep, 0x00]))).toThrow(
      CborError,
    );
  });
});

describe("parseCertificate", () => {
  it("refuses non-DER and non-certificates", () => {
    expect(() => parseCertificate(new Uint8Array([0x30, 0x80, 0, 0]))).toThrow(
      X509Error,
    );
    expect(() => parseCertificate(new Uint8Array([0x04, 0x01, 0x00]))).toThrow(
      X509Error,
    );
  });
});

describe("checkPlayVerdict", () => {
  const good = (over: Record<string, unknown> = {}) => ({
    tokenPayloadExternal: {
      requestDetails: {
        requestPackageName: "gg.acme.dice",
        requestHash: "h".repeat(43),
        timestampMillis: String((NOW - 10) * 1000),
      },
      appIntegrity: {
        appRecognitionVerdict: "PLAY_RECOGNIZED",
        packageName: "gg.acme.dice",
        versionCode: "42",
      },
      deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
      accountDetails: { appLicensingVerdict: "LICENSED" },
      ...over,
    },
  });
  const expected = {
    packageName: "gg.acme.dice",
    requestHash: "h".repeat(43),
    now: NOW,
  };

  it("accepts a recognised app on a device meeting device integrity, recording licensing", () => {
    expect(checkPlayVerdict(good(), expected)).toMatchObject({
      ok: true,
      summary: { appLicensingVerdict: "LICENSED", versionCode: "42" },
    });
  });

  it("refuses without MEETS_DEVICE_INTEGRITY, with a stale timestamp, another hash or package", () => {
    expect(
      checkPlayVerdict(
        good({
          deviceIntegrity: {
            deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"],
          },
        }),
        expected,
      ),
    ).toMatchObject({ ok: false, reason: "device_integrity" });
    expect(
      checkPlayVerdict(
        good({
          requestDetails: {
            requestPackageName: "gg.acme.dice",
            requestHash: "h".repeat(43),
            timestampMillis: String((NOW - 3600) * 1000),
          },
        }),
        expected,
      ),
    ).toMatchObject({ ok: false, reason: "stale" });
    expect(
      checkPlayVerdict(good(), { ...expected, requestHash: "x" }),
    ).toMatchObject({
      ok: false,
      reason: "request_hash",
    });
    expect(
      checkPlayVerdict(good(), { ...expected, packageName: "gg.acme.other" }),
    ).toMatchObject({ ok: false, reason: "package" });
    expect(
      checkPlayVerdict(
        good({
          appIntegrity: {
            appRecognitionVerdict: "UNRECOGNIZED_VERSION",
            packageName: "gg.acme.dice",
          },
        }),
        expected,
      ),
    ).toMatchObject({ ok: false, reason: "app_unrecognized" });
    const testing = good({ testingDetails: { isTestingResponse: true } });
    expect(checkPlayVerdict(testing, expected)).toMatchObject({
      ok: false,
      reason: "testing_response",
      summary: { isTestingResponse: true },
    });
    expect(
      checkPlayVerdict(testing, { ...expected, allowTestingResponses: true }),
    ).toMatchObject({ ok: true, summary: { isTestingResponse: true } });
    expect(checkPlayVerdict({}, expected)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });
});
