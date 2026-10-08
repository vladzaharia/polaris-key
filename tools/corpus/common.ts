// Shared corpus fixtures (tools/sign-corpus.ts drives every family module in tools/corpus/).
// The repository root, the four committed TEST keys and the helpers that sign with them, the
// fixed clocks and envelope constants, the licence, config and trust-manifest builders, raw
// tokens and raw-byte signing (V4 §1.2), and the ASCII-only JSON printer. Nothing here decides
// a verdict: the reference implementations live in `reference/`.

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  signJws,
  base64UrlEncodeBytes,
  importSigningKey,
} from "@polaris-key/jws";

/** The repository root (this file is `tools/corpus/common.ts`). */
export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Committed TEST keypairs. These are NOT production keys — they exist only to sign the
 *  corpus. `djdl-test-2026` signs the DJDL baseline; `pkey-test-prod-2026` is a Polaris Key
 *  test key. */
interface CorpusKey {
  kid: string;
  publicKeyRaw: string;
  privateKeyPkcs8Pem: string;
}

export const KEYS: CorpusKey[] = [
  {
    kid: "djdl-test-2026",
    publicKeyRaw: "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U",
    privateKeyPkcs8Pem:
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIIXpeKmxx2+0A+lz89t+5fp5PPjd2vFGhXqwTpWYeL5O\n-----END PRIVATE KEY-----",
  },
  {
    kid: "pkey-test-prod-2026",
    publicKeyRaw: "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI",
    privateKeyPkcs8Pem:
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----",
  },
  // Wire contract v4 §2.4: the CI-held RELEASE keys that sign `pkey-release+jws` records,
  // generated once with `crypto.generateKeyPairSync("ed25519")`. Never a product key, never in
  // a feed case's trust; the 2027 key is the rotation.
  {
    kid: "djdl-release-test-2026",
    publicKeyRaw: "U9d9Ix2jwC1-l_GJgrInN5zMPJgjPkgZC8Ekg7nKlEE",
    privateKeyPkcs8Pem:
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIMPC/pYWRN17C6MFlFHhktg/TQgXNUydx+PQtkD9KTBs\n-----END PRIVATE KEY-----",
  },
  {
    kid: "djdl-release-test-2027",
    publicKeyRaw: "TOde4jqFFVbzka-bES32oJRK6Whg1kqa16Jk7y3d2Lo",
    privateKeyPkcs8Pem:
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIIwJqSkvipky0ygUQh67CbUmFH5641YiVLQRAdtWfA3g\n-----END PRIVATE KEY-----",
  },
];

function keyOf(kid: string): CorpusKey {
  const k = KEYS.find((x) => x.kid === kid);
  if (!k) throw new Error(`unknown corpus kid: ${kid}`);
  return k;
}
export const pem = (kid: string): string => keyOf(kid).privateKeyPkcs8Pem;
export const pub = (kid: string): string => keyOf(kid).publicKeyRaw;
export const encSeg = (o: unknown): string =>
  base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(o)));

/** The DJDL baseline doc under the product-scoped v2 wire contract. */
export interface VerifyExpect {
  verify: "ok" | "fail";
  kid?: string;
  doc?: unknown;
  /** WIRE-CONTRACT-V3 §10: RFC 6901 pointer -> the string at that pointer under `doc` with
   *  every U+0000 replaced by U+FFFD. Written by `annotateNul`, never by hand. Only a runner
   *  whose platform string type cannot hold U+0000 (Godot) reads it; every other runner
   *  ignores it. */
  docNulReplaced?: Record<string, string>;
}

/** RFC 6901 reference token: `~` -> `~0`, then `/` -> `~1`. */
export const pointerToken = (key: string): string =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");

/** WIRE-CONTRACT-V3 §10 (the U+0000 representation limit). Walks `expect.doc` depth-first in
 *  insertion order and, for each string that contains U+0000, records its pointer and its
 *  U+FFFD form under `docNulReplaced`, written right after `doc` and only when the map is not
 *  empty — so every case without a NUL stays byte-identical. A NUL in an object KEY is outside
 *  the §10 entry (P3-01 decides it), so the generator refuses to emit one. Reuse this for any
 *  later section that pins a decoded document; never apply it to `bundleCases`, whose whole
 *  `expect` object the Node and Python runners compare. */
export function annotateNul(expect: VerifyExpect): VerifyExpect {
  if (!("doc" in expect)) {
    if ("docNulReplaced" in expect)
      throw new Error("annotateNul: docNulReplaced without doc");
    return expect;
  }
  const replaced: Record<string, string> = {};
  const walk = (value: unknown, pointer: string): void => {
    if (typeof value === "string") {
      if (!value.includes("\u0000")) return;
      const out = value.replaceAll("\u0000", "\ufffd");
      if (out.includes("\u0000") || out === value)
        throw new Error(`annotateNul: bad replacement at ${pointer}`);
      replaced[pointer] = out;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${pointer}/${i}`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key.includes("\u0000"))
          throw new Error(
            `annotateNul: U+0000 in an object key under ${pointer || "/"}`,
          );
        walk(item, `${pointer}/${pointerToken(key)}`);
      }
    }
  };
  walk(expect.doc, "");
  if (Object.keys(replaced).length === 0) return expect;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(expect)) {
    if (key === "docNulReplaced") continue;
    out[key] = value;
    if (key === "doc") out.docNulReplaced = replaced;
  }
  return out as unknown as VerifyExpect;
}

/** A syntactically valid Ed25519 public key that belongs to nobody — the "attacker" bytes in
 *  the substitution cases. Deterministic so `--check` is stable. */
export const FOREIGN_PUB = base64UrlEncodeBytes(
  new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 13) & 0xff)),
);

/** Document-type domain separator, wire contract v2 §2.4. */
export async function signRawSegments(
  headerText: string,
  payloadText: string,
  kid: string,
): Promise<string> {
  const utf8 = new TextEncoder();
  const signingInput = `${base64UrlEncodeBytes(utf8.encode(headerText))}.${base64UrlEncodeBytes(utf8.encode(payloadText))}`;
  const key = await importSigningKey(pem(kid));
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    utf8.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}

/** Grow `base` with a filler field until its JSON is EXACTLY `target` UTF-8 bytes. */
export function docOfExactBytes(
  target: number,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const size = (o: unknown): number =>
    new TextEncoder().encode(JSON.stringify(o)).length;
  const empty = size({ ...base, pad: "" });
  if (empty > target)
    throw new Error(`cannot pad to ${target}: base is already ${empty}`);
  // `pad` holds ASCII, so one added character is exactly one added JSON byte.
  const doc = { ...base, pad: "A".repeat(target - empty) };
  if (size(doc) !== target)
    throw new Error(`padding did not converge: ${size(doc)} != ${target}`);
  return doc;
}

export const CLOCK_SKEW = 300;

/** Document-type domain separators, wire contract v3 §2. */
export type TypV3 =
  | "pkey-license+jws"
  | "pkey-config+jws"
  | "pkey-trust+jws"
  | "pkey-bundle+jws"
  | "pkey-feed+jws"
  | "pkey-release+jws";

/** §8 — the ISSUER is host-neutral. `key.plrs.im` remains the serving HOST and is no longer
 *  a valid `iss`; `license-iss-v2-host-rejected` pins exactly that. */
export const ISSUER_V3 = "key.plrs.im";
export const AUD_V3 = "djdl";
export const DEVICE_V3 = "dev_7c1e2d";
/** The kid the host application PINS. Manifests and bundles verify against this alone. */
export const PIN_KID = "pkey-test-prod-2026";
/** A second real key, published by manifests as the rotated/staged one. */
export const ALT_KID = "djdl-test-2026";
export const PINNED_V3 = { [PIN_KID]: pub(PIN_KID) };

/** The v3 document timeline. `expiresAt = issuedAt + DOC_EXPIRY_SECONDS`,
 *  `graceUntil = issuedAt + 30 × SECONDS_PER_DAY` (a 30-day `maxOfflineDays`). */
export const V3_ISSUED = 1700000000;
export const V3_EXPIRES = V3_ISSUED + 3600;
export const V3_GRACE = V3_ISSUED + 30 * 86400;
/** Inside the document window — the clock every claim case is evaluated at unless it says
 *  otherwise. */
export const V3_NOW = 1700001000;
/** §2 `MAX_GRACE_SECONDS` — the 365-day ceiling, enforced at VERIFY time (§3.3). */
export const MAX_GRACE_SECONDS = 31536000;
/** §1 — the bundle payload cap, the one artifact that is not 65 536. */
export const MAX_BUNDLE_BYTES = 262144;

/** A `pkey-license+jws` payload (§2.1): the shared envelope + grants. `entitlements` is the
 *  sole carrier of grant data (D-20) — tier, channels and the version window ride here. */
export function licenseDoc(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: ISSUER_V3,
    aud: AUD_V3,
    deviceId: DEVICE_V3,
    issuedAt: V3_ISSUED,
    expiresAt: V3_EXPIRES,
    graceUntil: V3_GRACE,
    licenseId: "lic_3f8a9b",
    profile: {
      name: "Grace Hopper",
      firstName: "Grace",
      email: "grace@example.com",
      activatedAt: 1690000000,
    },
    entitlements: {
      "license.tier": {
        state: "enforced",
        value: "pro",
        updatedAt: 1699990000,
      },
      channels: {
        state: "enforced",
        value: ["stable", "staging"],
        updatedAt: 1699990000,
      },
      "app.minVersion": {
        state: "enforced",
        value: "1.0.0",
        updatedAt: 1699990000,
      },
      polarisVpn: { state: "enforced", value: true, updatedAt: 1699990000 },
    },
    ...overrides,
  };
}

/** A `pkey-config+jws` payload (§2.2): the same envelope, config + secrets, and NO license
 *  fields whatsoever — the wire-level guarantee of service independence (D-08). */
export function configDoc(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: ISSUER_V3,
    aud: AUD_V3,
    deviceId: DEVICE_V3,
    issuedAt: V3_ISSUED,
    expiresAt: V3_EXPIRES,
    graceUntil: V3_GRACE,
    // The PRODUCT's catalog version, not the wire version (§2.2).
    schemaVersion: 4,
    config: {
      "run.concurrency": {
        state: "enforced",
        value: 4,
        updatedAt: 1699990000,
      },
      "ui.theme": { state: "default", value: "dark", updatedAt: 1699992222 },
    },
    secrets: {
      "proxy.subscriptionUrl": {
        state: "hidden",
        value: "https://vpn.example.com/sub/abc",
        updatedAt: 1699993333,
      },
    },
    ...overrides,
  };
}

export function keyEntry(
  kid: string,
  publicKey: string,
  status: string,
): Record<string, unknown> {
  return { kid, alg: "EdDSA", kty: "OKP", crv: "Ed25519", publicKey, status };
}

/** A `pkey-trust+jws` payload (§2.3). Shape unchanged from v2; only `iss` and `typ` moved. */
export function trustManifestV3(fields: {
  issuedAt?: number;
  aud?: string;
  keys: Record<string, unknown>[];
}): Record<string, unknown> {
  const issuedAt = fields.issuedAt ?? V3_ISSUED;
  const aud = fields.aud ?? AUD_V3;
  return {
    schemaVersion: 1,
    aud,
    iss: ISSUER_V3,
    issuedAt,
    expiresAt: issuedAt + 300,
    jwksUrl: `https://key.plrs.im/${aud}/.well-known/jwks.json`,
    cacheSeconds: 300,
    keys: fields.keys,
  };
}

export const signAs = (
  payload: unknown,
  kid: string,
  typ: TypV3,
): Promise<string> => signJws(payload, pem(kid), kid, typ);

export const SKEW = 300;

/** JSON with every non-ASCII UTF-16 unit escaped (`\uXXXX`, astral as a surrogate pair). */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Wire contract v4 (docs/security/WIRE-CONTRACT-V4.md, plans/P3-01.md §2–§4)
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// The v4 families restate the v4 rules as literals and reference implementations (`reference/`),
// written from the plan and importing nothing they check: the strict verifier's vectors, the
// feed and record families, the per-claim integer cases, `update-matrix.json`,
// `outlet-matrix.json` and the stage matrix's confirmation cases. Each builder recomputes its own
// expectations and throws when a hand-written expectation disagrees, so a row that contradicts
// the plan fails `gen:corpus` instead of shipping. The constants and signing helpers they share
// follow.

/** V4 §3: the largest integer claim, 2^53 − 1. */
export const MAX_WIRE_INTEGER_REF = 9007199254740991;
/** The v4 feed clocks, beside `V3_ISSUED`. */
export const FEED_ISSUED = V3_ISSUED;
export const FEED_EXPIRES = FEED_ISSUED + 900;
export const FEED_NOW = FEED_ISSUED + 100;
export const FEED_TTL_REF = 900;
export const MAX_FEED_TTL_REF = 3600;
export const ROLLOUT_BUCKETS_REF = 10000;
/** The release keys (V4 §2.4). Records are signed by these two, never by a product key. */
export const REL_KID = "djdl-release-test-2026";
export const REL2_KID = "djdl-release-test-2027";

// ── Raw tokens and raw bytes ─────────────────────────────────────────────────────────────────
// `JSON.stringify` cannot write `7.0`, `17e8` or `9007199254740993`, so a vector that needs one
// carries the string `raw(token)` and `rawJson` splices the token in after serialising.

const RAW_RE = /"@@raw:([^"@]*)@@"/g;
export const raw = (token: string): string => `@@raw:${token}@@`;
export const rawJson = (value: unknown): string =>
  JSON.stringify(value).replace(RAW_RE, "$1");
export const headerText = (typ: TypV3, kid: string): string =>
  JSON.stringify({ alg: "EdDSA", typ, kid });
export const utf8Bytes = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s);

/** Sign raw header and payload BYTES — the UTF-8 and BOM vectors, which text cannot hold. */
export async function signRawBytes(
  header: Uint8Array,
  payload: Uint8Array,
  kid: string,
): Promise<string> {
  const signingInput = `${base64UrlEncodeBytes(header)}.${base64UrlEncodeBytes(payload)}`;
  const key = await importSigningKey(pem(kid));
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    utf8Bytes(signingInput),
  );
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}

/** Sign a payload given as JSON TEXT (with any raw tokens already spliced in). */
export const signText = (
  text: string,
  kid: string,
  typ: TypV3,
): Promise<string> => signRawSegments(headerText(typ, kid), text, kid);
export const sha256Hex = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

export type AnyCase = Record<string, any>;
