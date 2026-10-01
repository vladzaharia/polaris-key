/**
 * `core/jwt.ts` — the Worker's only ES256 and RS256 JWT signers (P5-01).
 *
 * The signers moved out of `services/config/mint.ts` and `services/release/githubApp.ts`; the
 * output bytes must not change. RS256 (PKCS#1 v1.5) is deterministic, so it is pinned against
 * an independent implementation: Node's own `crypto.sign` over the same signing input. ES256 is
 * randomised, so it is pinned by header bytes and by verification with the public key.
 */

import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  importEs256PrivateKey,
  importRs256PrivateKey,
  signJwtEs256,
  signJwtRs256,
} from "../src/core/jwt.js";

const b64url = (s: string): string => Buffer.from(s).toString("base64url");

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RSA_PKCS8 = rsa.privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;
const RSA_PKCS1 = rsa.privateKey.export({
  type: "pkcs1",
  format: "pem",
}) as string;
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const EC_PKCS8 = ec.privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

describe("signJwtRs256", () => {
  const payload = { iat: 1_700_000_000 - 30, exp: 1_700_000_540, iss: "12345" };

  it("is byte-identical to an independent RS256 over the same header and payload", async () => {
    const jwt = await signJwtRs256(payload, RSA_PKCS1);
    // The GitHub App JWT's exact header: `{"alg":"RS256","typ":"JWT"}`, no kid.
    const input = `${b64url('{"alg":"RS256","typ":"JWT"}')}.${b64url(JSON.stringify(payload))}`;
    const expected = sign(
      "sha256",
      Buffer.from(input),
      rsa.privateKey,
    ).toString("base64url");
    expect(jwt).toBe(`${input}.${expected}`);
  });

  it("accepts PKCS#1 and PKCS#8 PEMs and signs identically with both", async () => {
    expect(await signJwtRs256(payload, RSA_PKCS8, "k1")).toBe(
      await signJwtRs256(payload, RSA_PKCS1, "k1"),
    );
  });

  it("puts kid after alg and typ", async () => {
    const jwt = await signJwtRs256(payload, RSA_PKCS8, "k1");
    expect(Buffer.from(jwt.split(".")[0]!, "base64url").toString()).toBe(
      '{"alg":"RS256","typ":"JWT","kid":"k1"}',
    );
  });
});

describe("signJwtEs256", () => {
  it("emits the pinned header and a raw r||s signature that verifies", async () => {
    const jwt = await signJwtEs256({ iss: "T", iat: 1 }, EC_PKCS8, "KID");
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(Buffer.from(h, "base64url").toString()).toBe(
      '{"alg":"ES256","typ":"JWT","kid":"KID"}',
    );
    expect(Buffer.from(s, "base64url")).toHaveLength(64);
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        { key: createPublicKey(ec.privateKey), dsaEncoding: "ieee-p1363" },
        Buffer.from(s, "base64url"),
      ),
    ).toBe(true);
  });

  it("omits kid when none is given", async () => {
    const jwt = await signJwtEs256({}, EC_PKCS8);
    expect(Buffer.from(jwt.split(".")[0]!, "base64url").toString()).toBe(
      '{"alg":"ES256","typ":"JWT"}',
    );
  });
});

describe("key import", () => {
  it("refuses a non-P-256 key as ES256 and a non-RSA key as RS256", async () => {
    const p384 = generateKeyPairSync("ec", {
      namedCurve: "P-384",
    }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    await expect(importEs256PrivateKey(p384)).rejects.toThrow();
    await expect(importEs256PrivateKey(RSA_PKCS8)).rejects.toThrow();
    await expect(importRs256PrivateKey(EC_PKCS8)).rejects.toThrow();
    await expect(importEs256PrivateKey(EC_PKCS8)).resolves.toBeDefined();
    await expect(importRs256PrivateKey(RSA_PKCS1)).resolves.toBeDefined();
  });
});
