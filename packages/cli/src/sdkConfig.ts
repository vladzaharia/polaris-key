/**
 * `pkey sdk --lang <lang> [--write] [--out <path>]` (SDK parity pass §3.19, SP-02): fetch a
 * product's discovery document and write a typed configuration module for one SDK, so an
 * integration starts from generated product facts instead of pasted ones.
 *
 * The module holds the product slug, the base URL, the trust pins (`trust.pinnedKeys` from
 * discovery), the pinned release keys and the services the product runs (each SDK's D-21
 * `expectedServices` fallback). Release keys are not served by any public route: they come from
 * the product's own `.pkey/release` `releaseKeys` (or `--release-key kid=key`), and every one of
 * them must match discovery's `release.releaseKeyFingerprints` (SHA-256 of the raw key), both
 * ways. A mismatch refuses: the module would otherwise pin a key the server does not advertise,
 * or leave out one it does.
 *
 * Trust pins are compiled in, never learned at runtime. Fetching them here is a build-time
 * convenience over HTTPS, so the command prints each pin's fingerprint for comparison with the
 * console, and `--kid`/`--public-key` (the `pkey trust` pair) makes it refuse unless discovery
 * serves exactly that pin.
 *
 * Nothing here changes the wire: discovery and the fingerprints are what the Worker already
 * serves (`/<product>/.well-known/polaris.json`).
 */

import { createHash } from "node:crypto";
import { PROTOCOL_VERSION } from "@polaris-key/protocol/core";
import { SERVICE_SLUGS } from "@polaris-key/manifest";
import {
  SDK_CONFIG_DEFAULT_OUT,
  SDK_CONFIG_MARKER,
  SDK_LANGS,
  isSdkLang,
  mergeGodotOptions,
  renderSdkConfig,
  type SdkConfigFacts,
  type SdkLang,
} from "@polaris-key/manifest/integration";
import { untrusted } from "./untrusted.js";

// The renderers and their types live in @polaris-key/manifest/integration (SP-33a); the console's
// Integration page calls the same functions.
export {
  SDK_CONFIG_DEFAULT_OUT,
  SDK_CONFIG_MARKER,
  SDK_LANGS,
  isSdkLang,
  mergeGodotOptions,
  renderSdkConfig,
  type SdkConfigFacts,
  type SdkLang,
};

export const SDK_CONFIG_USAGE =
  "Usage: pkey sdk --lang node|react|python|swift|kotlin|godot --product <slug> [--base-url <url>]\n" +
  "                [--write] [--out <path>] [--force] [--kid <kid> --public-key <key>]\n" +
  "                [--release-key <kid>=<key> ...] [--package <kotlin package>]";

export interface DeclaredReleaseKey {
  kid: string;
  publicKey: string;
}

/** A discovery value quoted in a refusal: the server's, so cleaned (`untrusted.ts`). */
const shown = (v: unknown): string => untrusted(v, {});
const PRODUCT_RE = /^[a-z0-9][a-z0-9_-]*$/;
// Narrow on purpose: every value is emitted inside a string literal in six languages (Kotlin
// interpolates `$`, Swift `\(`), so anything outside these alphabets is refused, not escaped.
const KID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const URL_CHARS_RE = /^[A-Za-z0-9:/._~%-]+$/;

/** Lowercase hex SHA-256 of a raw key: what discovery's `releaseKeyFingerprints` lists. */
export function fingerprintOf(publicKey: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64url"))
    .digest("hex");
}

/** `https:` (or loopback `http:`), no query or fragment, no trailing slash. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--base-url ${raw} is not a URL.`);
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error(
      `--base-url must be https: (http: only for localhost); got ${raw}.`,
    );
  if (url.search || url.hash || url.username || url.password)
    throw new Error(
      `--base-url must not carry credentials, a query or a fragment.`,
    );
  const out = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  if (!URL_CHARS_RE.test(out))
    throw new Error(`--base-url ${raw} has characters pkey sdk cannot emit.`);
  return out;
}

/** `--release-key kid=key` values. */
export function parseReleaseKeyFlags(values: string[]): DeclaredReleaseKey[] {
  return values.map((v) => {
    const eq = v.indexOf("=");
    if (eq <= 0) throw new Error(`--release-key takes <kid>=<key>; got ${v}.`);
    return { kid: v.slice(0, eq), publicKey: v.slice(eq + 1) };
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Fetch discovery and resolve the facts. Throws, writing nothing, on any refusal: a product or
 * protocol mismatch, a malformed pin, an expected pin discovery does not serve, or release keys
 * that do not match `releaseKeyFingerprints`.
 */
export async function resolveSdkFacts(opts: {
  product: string;
  baseUrl: string;
  /** Declared release keys (`.pkey/release` plus `--release-key`). */
  releaseKeys: readonly DeclaredReleaseKey[];
  /** The `pkey trust` pair the caller expects discovery to serve. */
  expectPin?: { kid: string; publicKey: string };
  fetchImpl?: typeof fetch;
}): Promise<SdkConfigFacts> {
  if (!PRODUCT_RE.test(opts.product))
    throw new Error(
      `--product must be a lower-case slug; got ${opts.product}.`,
    );
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const discoveryUrl = `${baseUrl}/${opts.product}/.well-known/polaris.json`;
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(discoveryUrl, {
      headers: { accept: "application/json" },
    });
  } catch (e) {
    throw new Error(`Could not reach ${discoveryUrl}: ${(e as Error).message}`);
  }
  if (!res.ok)
    throw new Error(
      `${discoveryUrl} answered ${res.status}; is the product registered and the base URL right?`,
    );
  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    throw new Error(`${discoveryUrl} did not answer JSON.`);
  }
  if (!isRecord(doc)) throw new Error(`${discoveryUrl} is not an object.`);
  if (doc.product !== opts.product)
    throw new Error(
      `Discovery names product ${shown(JSON.stringify(doc.product))}, not ${opts.product}.`,
    );
  if (doc.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(
      `Discovery speaks protocol ${shown(doc.protocolVersion)}; this pkey speaks ${PROTOCOL_VERSION}. Update pkey or the server.`,
    );

  // Trust pins.
  const trust = isRecord(doc.trust) ? doc.trust : {};
  const pins = isRecord(trust.pinnedKeys) ? trust.pinnedKeys : {};
  const pinnedKeys: Record<string, string> = {};
  for (const kid of Object.keys(pins).sort()) {
    const key = pins[kid];
    if (!KID_RE.test(kid) || typeof key !== "string" || !KEY_RE.test(key))
      throw new Error(
        `Discovery's trust.pinnedKeys has a malformed entry (${shown(kid)}).`,
      );
    pinnedKeys[kid] = key;
  }
  if (Object.keys(pinnedKeys).length === 0)
    throw new Error(`Discovery lists no trust.pinnedKeys.`);
  if (opts.expectPin) {
    const { kid, publicKey } = opts.expectPin;
    if (pinnedKeys[kid] !== publicKey)
      throw new Error(
        `Discovery does not pin ${kid} with the key you gave (--kid/--public-key); nothing was written. ` +
          `Compare the console's signing keys with ${discoveryUrl}.`,
      );
  }

  // Services, in canonical order.
  const services = isRecord(doc.services) ? doc.services : {};
  const enabled = SERVICE_SLUGS.filter((slug) => {
    const s = services[slug];
    return isRecord(s) && s.enabled === true;
  });

  // Release keys, matched against releaseKeyFingerprints both ways.
  const release = isRecord(services.release) ? services.release : {};
  const advertised = Array.isArray(release.releaseKeyFingerprints)
    ? release.releaseKeyFingerprints.filter(
        (f): f is string => typeof f === "string",
      )
    : [];
  const pinnedReleaseKeys: Record<string, string> = {};
  for (const k of opts.releaseKeys) {
    if (!KID_RE.test(k.kid) || !KEY_RE.test(k.publicKey))
      throw new Error(`Release key ${k.kid} is malformed.`);
    if (
      pinnedReleaseKeys[k.kid] !== undefined &&
      pinnedReleaseKeys[k.kid] !== k.publicKey
    )
      throw new Error(
        `Release key ${k.kid} is declared twice with different keys.`,
      );
    if (Object.values(pinnedKeys).includes(k.publicKey))
      throw new Error(
        `Release key ${k.kid} is also a trust pin; a release key is never a product signing key.`,
      );
    pinnedReleaseKeys[k.kid] = k.publicKey;
  }
  const declaredPrints = new Map(
    Object.entries(pinnedReleaseKeys).map(([kid, key]) => [
      fingerprintOf(key),
      kid,
    ]),
  );
  const notAdvertised = [...declaredPrints]
    .filter(([fp]) => !advertised.includes(fp))
    .map(([, kid]) => kid);
  if (notAdvertised.length > 0)
    throw new Error(
      `Discovery does not advertise release key${notAdvertised.length === 1 ? "" : "s"} ${notAdvertised.join(", ")} ` +
        `(release.releaseKeyFingerprints). Push .pkey/release and resync the product, then run pkey sdk again.`,
    );
  const undeclared = advertised.filter((fp) => !declaredPrints.has(fp));
  if (undeclared.length > 0)
    throw new Error(
      `Discovery advertises ${undeclared.length} release key${undeclared.length === 1 ? "" : "s"} you did not declare ` +
        `(fingerprint ${undeclared.map(shown).join(", ")}). Run pkey sdk in the product repo (it reads .pkey/release), ` +
        `or pass each key with --release-key <kid>=<key>.`,
    );

  return {
    product: opts.product,
    baseUrl,
    discoveryUrl,
    pinnedKeys,
    pinnedReleaseKeys: Object.fromEntries(
      Object.entries(pinnedReleaseKeys).sort(([a], [b]) => a.localeCompare(b)),
    ),
    services: enabled,
  };
}

/** What `pkey sdk` prints after resolving: each pin's fingerprint; the console shows the key itself. */
export function factsSummary(facts: SdkConfigFacts): string {
  const lines = [
    `Product ${facts.product} at ${facts.baseUrl}`,
    `Services: ${facts.services.join(", ") || "(none)"}`,
    "Trust pins (compare each key with Public key under Core → Keys & secrets before you ship):",
    ...Object.entries(facts.pinnedKeys).map(
      ([kid, key]) => `  ${kid}  sha256:${fingerprintOf(key)}`,
    ),
  ];
  const rk = Object.entries(facts.pinnedReleaseKeys);
  lines.push(
    rk.length === 0
      ? "Release keys: none"
      : "Release keys (matched against discovery's releaseKeyFingerprints):",
    ...rk.map(([kid, key]) => `  ${kid}  sha256:${fingerprintOf(key)}`),
  );
  return lines.join("\n");
}
