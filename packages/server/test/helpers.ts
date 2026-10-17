import { base64UrlEncodeBytes, signJws } from "@polaris-key/jws";

export interface TestKey {
  kid: string;
  pem: string;
  pub: string;
}

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  return {
    kid,
    pem: `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`,
    pub: base64UrlEncodeBytes(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ),
  };
}

/** A trust manifest for `product` signed by `signer`, publishing `keys` as active. */
export function manifest(
  product: string,
  signer: TestKey,
  keys: TestKey[],
  issuedAt: number,
  ttl = 300,
): Promise<string> {
  return signJws(
    {
      schemaVersion: 1,
      aud: product,
      iss: "key.plrs.im",
      issuedAt,
      expiresAt: issuedAt + ttl,
      jwksUrl: `https://key.plrs.im/${product}/.well-known/jwks.json`,
      cacheSeconds: 300,
      keys: keys.map((k) => ({
        kid: k.kid,
        alg: "EdDSA",
        kty: "OKP",
        crv: "Ed25519",
        publicKey: k.pub,
        status: "active",
      })),
    },
    signer.pem,
    signer.kid,
    "pkey-trust+jws",
  );
}

export function licenseDoc(
  product: string,
  issuedAt: number,
  extra: Record<string, unknown> = {},
) {
  return {
    iss: "key.plrs.im",
    aud: product,
    deviceId: "dev_1",
    issuedAt,
    expiresAt: issuedAt + 3600,
    graceUntil: issuedAt + 3600 * 24 * 30,
    licenseId: "lic_1",
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: issuedAt,
    },
    entitlements: {
      "export.pdf": { state: "enforced", value: true, updatedAt: issuedAt },
    },
    ...extra,
  };
}
