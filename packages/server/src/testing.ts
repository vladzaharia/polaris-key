// Test helpers for an app that gates routes with @polaris-key/server: sign licence documents with
// a throwaway key, get the matching pins and a clock you control.
//
//   const kit = await createTestKit({ product: "acme" });
//   const polaris = kit.polarisKey();                       // trust refresh off, kit clock
//   const jws = await kit.sign({ entitlements: { "export.pdf": true } });
//   const res = await app.request("/api/export", { headers: kit.headers(jws) });
//
// Each verdict, and a fake trust service, with no network:
//
//   await kit.headersFor("license_stale")                   // 401 license_stale
//   await kit.headersFor("not_entitled")                    // a license that grants nothing
//   const other = kit.trust.addKey("rotated-2027");         // a key only the trust manifest vouches for
//   const polaris = kit.polarisKey(kit.trust.options());    // refresh on, served by kit.trust.fetch
//
// Never import this from production code: the key it makes signs anything.

import { signJws } from "@polaris-key/jws";
import type { BackendRefusalCode } from "@polaris-key/client-core/backend";
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

/** What `headersFor` can produce: a refusal's code, or a request that passes. */
export type TestVerdict = BackendRefusalCode | "ok";

/** A key only the fake trust manifest vouches for: its documents verify once the core has
 *  fetched the manifest (`kit.trust.options()`), and are `license_invalid` before. */
export interface TestTrustedKey {
  readonly kid: string;
  sign(options?: SignOptions): Promise<string>;
}

/** The fake trust service: a `fetch` that answers `/<product>/.well-known/polaris-trust.jws`. */
export interface TestTrust {
  /** Pass as the core's `fetch`. Any other URL answers 404. */
  readonly fetch: typeof fetch;
  /** Requests it has seen, in order (URLs). */
  readonly calls: string[];
  /** Publish a second signing key in the manifest and return it. */
  addKey(kid?: string): Promise<TestTrustedKey>;
  /** True: every fetch fails like an unreachable Polaris Key. Default false. */
  offline: boolean;
  /** `{ trustRefresh: true, fetch }` for `kit.polarisKey(...)` or an adapter's options. */
  options(): Pick<PolarisKeyOptions, "trustRefresh" | "fetch">;
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
  /** The options for an adapter: `polarisKey(kit.options())` in Express or Hono,
   *  `createNextPolarisKey(kit.options())` in Next. Kit config and clock, trust refresh off. */
  options(extra?: Partial<PolarisKeyOptions>): PolarisKeyOptions;
  /** Sign and return the headers in one step. */
  signedHeaders(options?: SignOptions): Promise<Record<string, string>>;
  /**
   * The headers that make a gate answer `verdict` (`{}` for `license_required`). `options` shapes
   * the document: `"ok"` signs exactly what you pass (so grant the entitlement the route needs),
   * `"not_entitled"` and `"sign_in_required"` sign a license with no entitlements and no
   * signed-in account unless you say otherwise.
   */
  headersFor(
    verdict: TestVerdict,
    options?: SignOptions,
  ): Promise<Record<string, string>>;
  /** The fake trust service. */
  readonly trust: TestTrust;
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

  const extraKeys: { kid: string; publicKey: string; pem: string }[] = [];
  const calls: string[] = [];
  let manifestSeq = 0;
  const trustFetch: typeof fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push(url);
    if (trust.offline) throw new TypeError("fetch failed (kit.trust.offline)");
    if (!url.includes(`/${product}/.well-known/polaris-trust.jws`))
      return new Response("not found", { status: 404 });
    const issuedAt = now + manifestSeq++;
    const keys = [
      { kid, publicKey },
      ...extraKeys.map((k) => ({ kid: k.kid, publicKey: k.publicKey })),
    ].map((k) => ({
      kid: k.kid,
      alg: "EdDSA",
      kty: "OKP",
      crv: "Ed25519",
      publicKey: k.publicKey,
      status: "active",
    }));
    const jws = await signJws(
      {
        schemaVersion: 1,
        aud: product,
        iss: ISSUER,
        issuedAt,
        expiresAt: issuedAt + 300,
        jwksUrl: `https://key.plrs.im/${product}/.well-known/jwks.json`,
        cacheSeconds: 300,
        keys,
      },
      pem,
      kid,
      "pkey-trust+jws",
    );
    return new Response(jws, {
      status: 200,
      headers: { "content-type": "application/jose" },
    });
  };
  const trust: TestTrust = {
    fetch: trustFetch,
    calls,
    offline: false,
    async addKey(newKid = `pkey-test-extra-${extraKeys.length + 1}`) {
      const k = await newKey();
      extraKeys.push({ kid: newKid, publicKey: k.publicKey, pem: k.pem });
      return { kid: newKid, sign: (o) => signWith(k.pem, newKid, o) };
    },
    options: () => ({ trustRefresh: true, fetch: trustFetch }),
  };

  const signWith = async (
    signingPem: string,
    signingKid: string,
    o: SignOptions = {},
  ): Promise<string> => {
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
    return signJws(doc, signingPem, signingKid, "pkey-license+jws");
  };

  const headers = (jws: string, device = deviceId): Record<string, string> => ({
    [HEADER_LICENSE]: jws,
    [HEADER_DEVICE]: device,
  });
  const optionsFor = (
    extra: Partial<PolarisKeyOptions> = {},
  ): PolarisKeyOptions => ({
    config,
    trustRefresh: false,
    now: clock.now,
    ...extra,
  });

  return {
    product,
    deviceId,
    clock,
    pinnedKeys,
    config,
    sign: (o) => signWith(pem, kid, o),
    headers,
    polarisKey: (extra = {}) => createPolarisKey(optionsFor(extra)),
    options: optionsFor,
    signedHeaders: async (o) => headers(await signWith(pem, kid, o)),
    async headersFor(verdict, o = {}) {
      switch (verdict) {
        case "license_required":
          return {};
        case "license_invalid": {
          // A real signature over the real payload, broken: no key can verify it.
          const jws = await signWith(pem, kid, o);
          const last = jws.slice(-1) === "A" ? "B" : "A";
          return headers(jws.slice(0, -1) + last);
        }
        case "license_stale":
          // Past expiresAt plus the 300 s skew, still inside the grace window.
          return headers(
            await signWith(pem, kid, {
              issuedAt: now - 2 * HOUR,
              expiresIn: HOUR,
              ...o,
            }),
          );
        case "not_entitled":
          return headers(await signWith(pem, kid, { user: null, ...o }));
        case "sign_in_required":
          return headers(await signWith(pem, kid, { user: null, ...o }));
        case "ok":
          return headers(await signWith(pem, kid, o));
      }
    },
    trust,
  };
}
