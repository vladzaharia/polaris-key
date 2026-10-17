// Test helpers for an app that gates routes with @polaris-key/server: sign licence documents with
// a throwaway key, get the matching pins and a clock you control.
//
//   const kit = await createTestKit({ product: "acme" });
//   const polaris = kit.polarisKey();                       // trust refresh off, kit clock
//   const jws = await kit.sign({ entitlements: { "export.pdf": true } });
//   const res = await app.request("/api/export", { headers: kit.headers(jws) });
//
// Never import this from production code: the key it makes signs anything.

import { signJws } from "@polaris-key/jws";
import { ISSUER, type ManagedEntry } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import {
  createPolarisKey,
  type PolarisKey,
  type PolarisKeyOptions,
  type PolarisServerConfig,
} from "./core.js";
import { HEADER_DEVICE, HEADER_LICENSE } from "@polaris-key/protocol/core";

const HOUR = 3600;
const DAY = 86400;

/** A clock the test moves. */
export interface TestClock {
  /** Epoch seconds. */
  now(): number;
  set(seconds: number): void;
  advance(seconds: number): void;
}

export interface TestKitOptions {
  /** The product slug (the document's `aud`); default `"test-product"`. */
  product?: string;
  /** The signing key's id; default `"pkey-test-2026"`. */
  kid?: string;
  /** The clock's start, epoch seconds; default 1 700 000 000. */
  now?: number;
}

export interface SignOptions {
  /** `true`/`false` for a boolean entitlement, or the value itself. */
  entitlements?: Record<string, boolean | string | number | string[]>;
  /** Becomes the `license.tier` entitlement. */
  tier?: string;
  /** The holder's name and email in the signed profile. */
  holder?: { name: string; email: string } | null;
  /** The pairwise subject of the signed-in account (`ps_` and 22 base64url characters). */
  user?: { subject: string } | null;
  deviceId?: string;
  licenseId?: string;
  /** Default the kit clock's now. */
  issuedAt?: number;
  /** Seconds the document lives; default 3600. */
  expiresIn?: number;
  /** Seconds past `expiresAt` the gate still opens; default 30 days. */
  graceFor?: number;
  /** Override the audience, to test a document for another product. */
  aud?: string;
}

export interface TestKit {
  readonly product: string;
  readonly deviceId: string;
  readonly clock: TestClock;
  /** `kid` → raw Ed25519 public key (base64url): the pins. */
  readonly pinnedKeys: Record<string, string>;
  /** The configuration `pkey sdk` would write, with the kit's pins. */
  readonly config: PolarisServerConfig;
  /** Sign a licence document. */
  sign(options?: SignOptions): Promise<string>;
  /** The request headers a client sends: `X-PKey-License` and `X-PKey-Device`. */
  headers(jws: string, deviceId?: string): Record<string, string>;
  /** A core on the kit's pins and clock, with the trust refresh off. */
  polarisKey(options?: Partial<PolarisKeyOptions>): PolarisKey;
}

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function newKey(): Promise<{ pem: string; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const body = btoa(String.fromCharCode(...pkcs8));
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`,
    publicKey: b64u(raw),
  };
}

export async function createTestKit(
  options: TestKitOptions = {},
): Promise<TestKit> {
  const product = options.product ?? "test-product";
  const kid = options.kid ?? "pkey-test-2026";
  const deviceId = "dev_test";
  let now = options.now ?? 1_700_000_000;
  const clock: TestClock = {
    now: () => now,
    set: (seconds) => {
      now = seconds;
    },
    advance: (seconds) => {
      now += seconds;
    },
  };
  const { pem, publicKey } = await newKey();
  const pinnedKeys = { [kid]: publicKey };
  const config: PolarisServerConfig = {
    productSlug: product,
    trust: { pinnedKeys },
    expectedServices: ["license"],
  };

  return {
    product,
    deviceId,
    clock,
    pinnedKeys,
    config,
    async sign(o = {}) {
      const issuedAt = o.issuedAt ?? now;
      const expiresAt = issuedAt + (o.expiresIn ?? HOUR);
      const entitlements: Record<string, ManagedEntry> = {};
      for (const [name, value] of Object.entries(o.entitlements ?? {}))
        entitlements[name] = {
          state: "enforced",
          value,
          updatedAt: issuedAt,
        };
      if (o.tier !== undefined)
        entitlements["license.tier"] = {
          state: "enforced",
          value: o.tier,
          updatedAt: issuedAt,
        };
      const holder =
        o.holder === undefined
          ? { name: "Test Holder", email: "holder@example.com" }
          : o.holder;
      const doc: LicenseDoc = {
        iss: ISSUER,
        aud: o.aud ?? product,
        deviceId: o.deviceId ?? deviceId,
        issuedAt,
        expiresAt,
        graceUntil: expiresAt + (o.graceFor ?? 30 * DAY),
        licenseId: o.licenseId ?? "lic_test",
        ...(holder || o.user
          ? {
              profile: {
                ...(holder
                  ? {
                      name: holder.name,
                      firstName: holder.name.split(" ")[0] ?? holder.name,
                      email: holder.email,
                    }
                  : {}),
                activatedAt: issuedAt,
                ...(o.user ? { user: o.user } : {}),
              },
            }
          : {}),
        entitlements,
      } as LicenseDoc;
      return signJws(doc, pem, kid, "pkey-license+jws");
    },
    headers: (jws, device = deviceId) => ({
      [HEADER_LICENSE]: jws,
      [HEADER_DEVICE]: device,
    }),
    polarisKey: (extra = {}) =>
      createPolarisKey({
        config,
        trustRefresh: false,
        now: clock.now,
        ...extra,
      }),
  };
}
