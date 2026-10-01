/**
 * Release keys in CI (P3-03, WIRE-CONTRACT-V4 §2.4): the Ed25519 keys that sign release records
 * (`pkey-release+jws`). The private half lives only in CI — a GitHub Environment secret today
 * (`PKEY_RELEASE_KEY`, a PKCS#8 PEM), KMS later (README §11 decision 3) — and is never sent to
 * Polaris Key, logged, or written anywhere but the file `pkey release keys generate` creates.
 *
 *   - `generateReleaseKey`: `pkey release keys generate --kid <kid> --out <file>` makes a key
 *     pair, writes the private key (0600, never over an existing file) and prints the
 *     `releaseKeys` entry for `.pkey/release`.
 *   - `recordSigner`: `pkey release publish`'s implementation of P2-06's `signRecord` seam. The
 *     `kid` is the declared release key whose public half matches the private key, so CI needs
 *     no second setting, and a key the manifest does not declare is refused before any request.
 *   - `checkSignedRecord`: the CLI verifies its own record with `verifyJws` and runs
 *     `releaseRecordClaims` — the claims every v4 SDK runs — before it publishes.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { writeFile } from "node:fs/promises";
import { signJws, verifyJws } from "@polaris-key/jws";
import { releaseRecordClaims } from "@polaris-key/client-core/record";
import { MAX_RECORD_JWS_BYTES } from "@polaris-key/protocol/core";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import {
  canonicalDescriptorJson,
  RELEASE_KEY_KID_PATTERN,
  type ManifestReleaseKey,
} from "@polaris-key/manifest";

/** The CI environment variable holding the release key's PKCS#8 PEM. */
export const RELEASE_KEY_ENV = "PKEY_RELEASE_KEY";

export const KEYS_USAGE =
  "Usage: pkey release keys generate --kid <kid> --out <file> [--force]";

/** The raw public key (base64url, the `TrustSet` encoding) of an Ed25519 PKCS#8 PEM. */
export function publicKeyOfPem(pem: string): string {
  let key;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new Error(
      `${RELEASE_KEY_ENV} is not a PEM private key (PKCS#8, as pkey release keys generate writes it).`,
    );
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error(`${RELEASE_KEY_ENV} must be an Ed25519 key.`);
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error(`${RELEASE_KEY_ENV}: no public key.`);
  return jwk.x;
}

/** Lowercase hex SHA-256 of a raw key: what discovery's `releaseKeyFingerprints` lists. */
export function fingerprintOf(publicKey: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64url"))
    .digest("hex");
}

/** The non-empty, base64 lines of a PEM: what a CI log must never show. */
export function pemSecretLines(pem: string): string[] {
  return pem
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("-----"));
}

export interface GeneratedKey {
  kid: string;
  publicKey: string;
  fingerprint: string;
  out: string;
}

/** `pkey release keys generate`: a new Ed25519 key pair, the private half written to `out`. */
export async function generateReleaseKey(opts: {
  kid: string;
  out: string;
  force?: boolean;
}): Promise<GeneratedKey> {
  if (!RELEASE_KEY_KID_PATTERN.test(opts.kid))
    throw new Error(
      `--kid must match ${RELEASE_KEY_KID_PATTERN.source}.\n${KEYS_USAGE}`,
    );
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const raw = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  try {
    await writeFile(opts.out, pem, {
      mode: 0o600,
      flag: opts.force ? "w" : "wx",
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `${opts.out} exists; pass --force to overwrite it (the key in it is then gone for good).`,
      );
    throw e;
  }
  return {
    kid: opts.kid,
    publicKey: raw,
    fingerprint: fingerprintOf(raw),
    out: opts.out,
  };
}

/** What to print after generating: the `.pkey/release` entry and where the private key went. */
export function generatedKeyText(g: GeneratedKey): string {
  return (
    `Wrote the private release key to ${g.out} (mode 0600). Store it as the GitHub Environment\n` +
    `secret ${RELEASE_KEY_ENV} of the publishing environment, then delete the file. Never commit it.\n\n` +
    `Add to .pkey/release:\n\n` +
    `releaseKeys:\n  - kid: ${g.kid}\n    publicKey: ${g.publicKey}\n\n` +
    `Pin the same key in the app (pinnedReleaseKeys: { "${g.kid}": "${g.publicKey}" }).\n` +
    `Fingerprint (sha256 of the raw key): ${g.fingerprint}\n`
  );
}

/**
 * The `kid` a private key signs under: the declared release key with the same public half.
 * Throws when none is declared, or the key is not among them.
 */
export function kidFor(
  pem: string,
  declared: readonly ManifestReleaseKey[],
): { kid: string; publicKey: string } {
  const publicKey = publicKeyOfPem(pem);
  const match = declared.find((k) => k.publicKey === publicKey);
  if (!match)
    throw new Error(
      declared.length === 0
        ? `${RELEASE_KEY_ENV} is set, but .pkey/release declares no releaseKeys; add the key's releaseKeys entry first.`
        : `${RELEASE_KEY_ENV}'s public key (${publicKey}) is not one of .pkey/release's releaseKeys (${declared.map((k) => k.kid).join(", ")}).`,
    );
  return { kid: match.kid, publicKey };
}

/** P2-06's `signRecord` seam: sign the record with the CI-held key, as `pkey-release+jws`. */
export function recordSigner(
  pem: string,
  declared: readonly ManifestReleaseKey[],
): (record: ReleaseRecordDoc) => Promise<string> {
  const { kid } = kidFor(pem, declared);
  return (record) => signJws(record, pem, kid, "pkey-release+jws");
}

/**
 * The CLI's own check of what it is about to publish: the JWS verifies against one of the
 * declared release keys with the `typ`, its payload passes the v4 record claims (given the
 * verifier's non-wire-integer pointers), and it is the record that was meant to be signed.
 */
export async function checkSignedRecord(
  jws: string,
  record: ReleaseRecordDoc,
  declared: readonly ManifestReleaseKey[],
): Promise<void> {
  if (jws.length > MAX_RECORD_JWS_BYTES)
    throw new Error(
      `The signed release record is ${jws.length} bytes; a record is at most ${MAX_RECORD_JWS_BYTES}.`,
    );
  const trust: Record<string, string> = {};
  for (const k of declared) trust[k.kid] = k.publicKey;
  const v = await verifyJws(jws, trust, { typ: "pkey-release+jws" });
  if (!v)
    throw new Error(
      "The signed release record does not verify against .pkey/release's releaseKeys; nothing was published.",
    );
  if (
    !releaseRecordClaims(v.payload, {
      expectedAud: record.aud,
      nonWire: v.nonWireIntegers,
    })
  )
    throw new Error(
      "The release record fails the v4 record claims (WIRE-CONTRACT-V4 §2.4); nothing was published.",
    );
  if (canonicalDescriptorJson(v.payload) !== canonicalDescriptorJson(record))
    throw new Error(
      "The signed release record is not the record pkey built; nothing was published.",
    );
}
