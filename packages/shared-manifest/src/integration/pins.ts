/**
 * The trust-pin fingerprints and the `pkey sdk add` command built from them (ST-41). The console's
 * Integration page shows both; the CLI checks `--expect` against its own `fingerprintOf`, which this
 * agrees with byte for byte (`cli/test/sdkConfig.test.ts` runs the rendered command through the
 * CLI itself).
 *
 * Isomorphic: WebCrypto exists in the browser, Node 22 and the Worker.
 */

import type { SdkId } from "./fit.js";

interface SubtleLike {
  digest(alg: string, data: Uint8Array): Promise<ArrayBuffer>;
}

/** Lowercase hex SHA-256 of the raw key (the base64url-decoded public key). */
export async function pinFingerprint(publicKey: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto
    ?.subtle;
  if (!subtle) throw new Error("pinFingerprint: no WebCrypto here");
  const b64 = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const raw = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const hash = new Uint8Array(await subtle.digest("SHA-256", raw));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PinFingerprint {
  kid: string;
  /** Lowercase hex, 64 digits. */
  fingerprint: string;
}

/**
 * `pkey sdk add <sdk> --product <slug> --expect <kid>@sha256:<hex>[,…]` and one `--release-key
 * <kid>=<key>` per declared release key, wrapped at the flag boundary. It runs in any folder, so it names the product; `--expect` makes the CLI refuse to
 * write the config unless the served pins are these.
 */
export function sdkAddCommand(
  sdk: SdkId,
  slug: string,
  pins: readonly PinFingerprint[],
  releaseKeys: readonly { kid: string; publicKey: string }[] = [],
): string {
  const expect = pins.map((p) => `${p.kid}@sha256:${p.fingerprint}`).join(",");
  const lines = [
    `pkey sdk add ${sdk}`,
    `--product ${slug}`,
    `--expect ${expect}`,
    // Release keys are public. The CLI refuses a product whose discovery advertises release keys
    // it was not given, so a folder with no `.pkey/release` needs each one on the command line.
    ...releaseKeys.map((k) => `--release-key ${k.kid}=${k.publicKey}`),
  ];
  return lines.map((l, i) => (i === 0 ? l : `  ${l}`)).join(" \\\n");
}
