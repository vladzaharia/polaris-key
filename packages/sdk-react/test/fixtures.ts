// One license fixture that drives BOTH adapters in parity.test.tsx, plus the fakes that let
// each transport read it: a fake `PolarisBridge` (desktop, protocol v2) and a fake `fetch`
// returning the identity session + v3 discovery shapes. The same documents → identical hook
// outputs is the parity guarantee.

import type { ManagedEntry } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { BridgeState, PolarisBridge } from "../src/desktop/bridge.js";
import type { ServiceSlug, ServicesMap } from "../src/core/services.js";
import { noServices } from "../src/core/services.js";

/** A fixed "now" (seconds) every adapter is pinned to so the gate is deterministic. */
export const NOW_SEC = 2000;

/** Shorthand `ManagedEntry` builder for tests (every entry carries `updatedAt`). */
export function entry(
  state: ManagedEntry["state"],
  value: ManagedEntry["value"],
  updatedAt = 950,
): ManagedEntry {
  return { state, value, updatedAt };
}

/** A capability map with the listed slugs on. The default is the shape every pre-suite test
 *  implicitly assumed: licensing, settings AND identity, so a login card offers both methods. */
export function services(...slugs: ServiceSlug[]): ServicesMap {
  const list = slugs.length > 0 ? slugs : ["license", "config", "identity"];
  const out = noServices();
  for (const slug of list as ServiceSlug[]) out[slug] = { enabled: true };
  return out;
}

/** The v3 license document: claims + grants (D-20). */
export function makeDoc(over: Partial<LicenseDoc> = {}): LicenseDoc {
  return {
    aud: "acme",
    iss: "key.plrs.im",
    licenseId: "lic-1",
    deviceId: "dev-1",
    issuedAt: 1000,
    expiresAt: 1000 + 3600, // valid at NOW_SEC=2000 → "ok"
    graceUntil: 1000 + 30 * 86400,
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@acme.test",
      activatedAt: 900,
    },
    entitlements: {
      polarisVpn: { state: "enforced", value: true, updatedAt: 950 },
      beta: { state: "enforced", value: false, updatedAt: 950 },
    },
    ...over,
  };
}

/** The config document's entries — v3 split these off the license document. */
export function makeConfig(
  over: Record<string, ManagedEntry> = {},
): Record<string, ManagedEntry> {
  return {
    "theme.mode": { state: "enforced", value: "dark", updatedAt: 950 },
    ...over,
  };
}

/** A `BridgeState` (protocol v2) carrying the standard ok fixture. */
export function okBridgeState(over: Partial<BridgeState> = {}): BridgeState {
  return {
    activation: "token",
    doc: makeDoc(),
    config: makeConfig(),
    capabilities: services(),
    lastVerifiedAt: NOW_SEC * 1000,
    highWaterMark: 1000,
    ...over,
  };
}

/** An unauthenticated bridge state (no credential, no documents). */
export function emptyBridgeState(over: Partial<BridgeState> = {}): BridgeState {
  return {
    activation: null,
    doc: null,
    capabilities: services(),
    ...over,
  };
}

/** A fake bridge backed by an in-memory `BridgeState`, with a push channel for tests. The
 *  `invoke` escape hatch answers the device + update verbs the components exercise. */
export function makeFakeBridge(
  initial: BridgeState,
): PolarisBridge & { push(s: BridgeState): void } {
  let state = initial;
  const listeners = new Set<(s: BridgeState) => void>();
  return {
    version: 2,
    async getSyncState() {
      return state;
    },
    async refresh() {
      return state;
    },
    async beginSignIn() {
      return {
        flowId: "flow-1",
        verificationUrl: "https://key.plrs.im/acme/device",
        userCode: "ABCD-1234",
      };
    },
    async pollSignIn() {
      return { kind: "ok" } as const;
    },
    async submitKey() {
      return { kind: "ok" } as const;
    },
    async signOut() {
      state = { ...state, activation: null, doc: null };
      for (const l of listeners) l(state);
    },
    on(_event, cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    push(s: BridgeState) {
      state = s;
      for (const l of listeners) l(state);
    },
  };
}

/** The v3 discovery document a fake fetch answers with. */
export function discoveryBody(
  map: ServicesMap = services(),
  product = "acme",
): string {
  return JSON.stringify({
    version: 2,
    protocolVersion: 4,
    product,
    slug: product,
    baseUrl: "https://key.plrs.im",
    core: { registration: "requires-license" },
    services: {
      license: map.license.enabled
        ? {
            enabled: true,
            endpoints: { document: `/${product}/license/document` },
          }
        : { enabled: false },
      config: map.config.enabled
        ? {
            enabled: true,
            endpoints: { document: `/${product}/config/document` },
          }
        : { enabled: false },
      release: map.release.enabled ? { enabled: true } : { enabled: false },
      update: map.update.enabled
        ? {
            enabled: true,
            endpoints: { version: `/${product}/update/version` },
          }
        : { enabled: false },
      identity: map.identity.enabled
        ? {
            enabled: true,
            endpoints: {
              session: `/${product}/identity/session`,
              authStart: `/${product}/identity/auth/start`,
            },
          }
        : { enabled: false },
    },
  });
}

/**
 * A fake `fetch` answering the browser adapter's routes: v3 discovery plus the identity
 * session endpoints at their §R1 homes (`/<p>/identity/session`, `/session/license`,
 * `/auth/logout`). The session body is still the FUSED document the identity service mints —
 * §R1 moved the routes and left the response shapes alone.
 */
export function makeFakeFetch(
  doc: LicenseDoc | null,
  opts: {
    config?: Record<string, ManagedEntry>;
    capabilities?: ServicesMap;
    product?: string;
  } = {},
): typeof fetch {
  const product = opts.product ?? "acme";
  const body = JSON.stringify({
    authenticated: doc !== null,
    doc: doc ? fuse(doc, opts.config ?? makeConfig()) : null,
    csrfToken: "csrf-1",
  });
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes("/.well-known/polaris.json")) {
      return new Response(
        discoveryBody(opts.capabilities ?? services(), product),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.includes("/identity/session/license")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/identity/session")) {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/identity/auth/logout")) {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

/** Re-fuse the split v3 pair into the artifact the identity session still returns, so a test
 *  writes ONE fixture and both transports read the shape they actually receive. */
export function fuse(
  doc: LicenseDoc,
  config: Record<string, ManagedEntry>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    aud: doc.aud,
    iss: doc.iss,
    licenseId: doc.licenseId,
    deviceId: doc.deviceId,
    issuedAt: doc.issuedAt,
    expiresAt: doc.expiresAt,
    graceUntil: doc.graceUntil,
    profile: doc.profile,
    payload: {
      config,
      secrets: {
        "api.token": { state: "enforced", value: "s3cr3t", updatedAt: 950 },
      },
      entitlements: doc.entitlements,
    },
  };
}

// ── Signing (wire v4 update tests) ──────────────────────────────────────────────────────────
// A throwaway Ed25519 signer over WebCrypto, so this package's tests mint feeds and records
// without depending on `@polaris-key/jws`: the header is `{alg, typ, kid}` in that order, as
// `signJws` writes it, and the signing input is the exact ASCII of `header.payload`.

export interface TestKey {
  kid: string;
  /** The raw 32-byte public key, base64url: a `TrustSet` value. */
  raw: string;
  privateKey: CryptoKey;
}

const b64url = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export async function newTestKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    kid,
    raw: b64url(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ),
    privateKey: pair.privateKey,
  };
}

export async function signCompact(
  payload: unknown,
  key: TestKey,
  typ: "pkey-feed+jws" | "pkey-release+jws",
): Promise<string> {
  const enc = new TextEncoder();
  const input =
    b64url(enc.encode(JSON.stringify({ alg: "EdDSA", typ, kid: key.kid }))) +
    "." +
    b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key.privateKey,
    enc.encode(input),
  );
  return `${input}.${b64url(new Uint8Array(sig))}`;
}
