/**
 * The platform primitives (P0-15): `src/platform/{bytes,hash,compare,random,pkce,json,hmacToken,
 * html,returnTo,email}.ts`, which services import directly.
 *
 * Three jobs:
 *
 *   1. PIN THE SESSION FORMAT. The console and portal sessions moved onto the shared
 *      `hmacToken` module. A cookie minted by the code BEFORE the move must still verify, and
 *      the new code must mint the identical bytes, or every operator and customer is signed out
 *      by the deploy. The tokens below were minted by the pre-P0-15 `core/console/session.ts` and
 *      `services/identity/portal/session.ts` with the random source fixed.
 *   2. PIN THE SEMANTICS of each primitive where the copies it replaced could have differed
 *      (padding, alphabet, hex case, length mismatch, the apostrophe, the return-to policy).
 *   3. REFUSE NEW LOCAL COPIES. A grep over `src/`: the shapes and the names of the helpers
 *      this package consolidated may appear only in `src/platform/`. A regex, not a parser, as
 *      in `boundaries.test.ts`: over-matching produces a failure someone must read, never a
 *      silent pass.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionCookie,
  issueSession,
  verifySession,
} from "../src/core/console/session.js";
import {
  issuePortalSession,
  verifyPortalSession,
} from "../src/services/identity/portal/session.js";
import {
  b64urlDecode,
  b64urlDecodeBinary,
  b64urlDecodeBinaryUnpadded,
  b64urlDecodeStrict,
  b64urlDecodeUtf8,
  b64urlEncode,
  b64urlEncodeBinary,
  b64urlEncodeUtf8,
  base64Decode,
  base64DecodeEitherAlphabet,
  base64Encode,
  hexDecode,
  hexEncode,
} from "../src/platform/bytes.js";
import {
  constantTimeEqual,
  constantTimeEqualBytes,
} from "../src/platform/compare.js";
import { normalizeEmail } from "../src/platform/email.js";
import { sha256B64url, sha256Base64, sha256Hex } from "../src/platform/hash.js";
import { importHmacKey } from "../src/platform/hash.js";
import { signHmacToken, verifyHmacToken } from "../src/platform/hmacToken.js";
import {
  escapeHtml,
  escapeHtmlDecimalApostrophe,
  escapeHtmlKeepApostrophe,
} from "../src/platform/html.js";
import {
  parseJsonArray,
  parseJsonColumn,
  parseJsonObject,
  parseJsonOr,
  parseJsonStringList,
  toJsonColumn,
  tryParseJson,
} from "../src/platform/json.js";
import { pkceChallenge, pkcePair } from "../src/platform/pkce.js";
import { randomHex, randomToken } from "../src/platform/random.js";
import {
  CARD_RETURN_TO,
  PORTAL_SIGNIN_RETURN_TO,
  PRODUCT_SIGNIN_RETURN_TO,
  safeReturnTo,
} from "../src/platform/returnTo.js";
import type { Env } from "../src/platform/env.js";
import { open, seal } from "../src/platform/keyvault.js";
import {
  mintDownloadTicket,
  verifyDownloadTicket,
} from "../src/core/downloadTicket.js";
import {
  signPullToken,
  verifyPullToken,
} from "../src/core/registry/registryTokens.js";

// ── 1. Session pins ──────────────────────────────────────────────────────────────────────────

/** The fixed random source the pins were minted under: byte i = (7i + 3) mod 256. */
function fixRandom(): void {
  vi.spyOn(crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView | null>(a: T): T => {
      const bytes = a as unknown as Uint8Array;
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) & 0xff;
      return a;
    },
  );
}

const PIN_NOW = 1_800_000_000;

const PIN_ENV = {
  ADMIN_SESSION_SECRET: "pin-admin-secret-0123456789",
  PORTAL_SESSION_SECRET: "pin-portal-secret-9876543210",
} as unknown as Env;

/** Minted by the pre-P0-15 `core/console/session.ts`. */
const ADMIN_PIN =
  "eyJzdWIiOiJvcC1zdWItMSIsIm5hbWUiOiJBZGEgT3AiLCJlbWFpbCI6ImFkYUBleGFtcGxlLmNvbSIsImdyb3VwcyI6WyJwb2xhcmlzLWFkbWlucyJdLCJjc3JmIjoiQXdvUkdCOG1MVFE3UWtsUVYxNWxiQSIsImV4cCI6MTgwMDAyODgwMCwiYXV0aEF0IjoxNzk5OTk5OTcwfQ.DwEnh2CmprxeDBR8RN87_ZrORb9J9XR34l4x_spJLhk";

/** Minted by the pre-P0-15 portal `session.ts` under `PORTAL_SESSION_SECRET` (a non-ASCII name). */
const PORTAL_PIN =
  "eyJhY2NvdW50SWQiOiJhY2N0X3BpbjEiLCJuYW1lIjoiQmVhIMOcIiwiZW1haWwiOiJiZWFAZXhhbXBsZS5jb20iLCJjc3JmIjoiQXdvUkdCOG1MVFE3UWtsUVYxNWxiQSIsImV4cCI6MTgwMTIwOTYwMCwiaWF0IjoxNzk5OTk5OTkwLCJzaWQiOiJzaWRfcGluMSJ9.ympSFSK06GrL7ZAH0ahpSRWWdkRmV42AWo14LscdmTU";

/** Minted by the pre-P0-15 portal `session.ts` falling back to `ADMIN_SESSION_SECRET`. */
const PORTAL_FALLBACK_PIN =
  "eyJhY2NvdW50SWQiOiJhY2N0X3BpbjIiLCJuYW1lIjoiY0BleGFtcGxlLmNvbSIsImVtYWlsIjoiY0BleGFtcGxlLmNvbSIsImNzcmYiOiJBd29SR0I4bUxUUTdRa2xRVjE1bGJBIiwiZXhwIjoxODAxMjA5NjAwLCJpYXQiOjE4MDAwMDAwMDB9.9Pqtx7V0bd0Cg_l-CaYtbkrqnybpRM8OB4J1a19dz6Y";

const FALLBACK_ENV = {
  ADMIN_SESSION_SECRET: "shared-secret-for-both",
  // The fallback is gone; the same material is now set explicitly so the pins
  // (and the domain-tag test below, which needs one shared key) still hold.
  PORTAL_SESSION_SECRET: "shared-secret-for-both",
} as unknown as Env;

describe("session cookies survive the move onto platform/hmacToken", () => {
  afterEach(() => vi.restoreAllMocks());

  it("verifies a console session minted by the old code", async () => {
    expect(await verifySession(PIN_ENV, ADMIN_PIN, PIN_NOW)).toEqual({
      sub: "op-sub-1",
      name: "Ada Op",
      email: "ada@example.com",
      groups: ["polaris-admins"],
      csrf: "AwoRGB8mLTQ7QklQV15lbA",
      exp: 1800028800,
      authAt: 1799999970,
    });
  });

  it("mints the identical console token and cookie from the same inputs", async () => {
    fixRandom();
    const { token } = await issueSession(
      PIN_ENV,
      {
        sub: "op-sub-1",
        name: "Ada Op",
        email: "ada@example.com",
        groups: ["polaris-admins"],
        authTime: PIN_NOW - 30,
      },
      PIN_NOW,
    );
    expect(token).toBe(ADMIN_PIN);
    expect(buildSessionCookie(token)).toBe(
      `__Host-pkey_admin=${ADMIN_PIN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`,
    );
  });

  it("verifies portal sessions minted by the old code, both key sources", async () => {
    expect(await verifyPortalSession(PIN_ENV, PORTAL_PIN, PIN_NOW)).toEqual({
      accountId: "acct_pin1",
      name: "Bea Ü",
      email: "bea@example.com",
      csrf: "AwoRGB8mLTQ7QklQV15lbA",
      exp: 1801209600,
      iat: 1799999990,
      sid: "sid_pin1",
    });
    expect(
      await verifyPortalSession(FALLBACK_ENV, PORTAL_FALLBACK_PIN, PIN_NOW),
    ).toMatchObject({ accountId: "acct_pin2", iat: PIN_NOW });
  });

  it("mints the identical portal tokens from the same inputs", async () => {
    fixRandom();
    const a = await issuePortalSession(
      PIN_ENV,
      {
        accountId: "acct_pin1",
        name: "Bea Ü",
        email: "bea@example.com",
        sid: "sid_pin1",
      },
      PIN_NOW,
      { authenticatedAt: PIN_NOW - 10 },
    );
    expect(a.token).toBe(PORTAL_PIN);
    const b = await issuePortalSession(
      FALLBACK_ENV,
      { accountId: "acct_pin2", email: "c@example.com" },
      PIN_NOW,
    );
    expect(b.token).toBe(PORTAL_FALLBACK_PIN);
  });

  it("keeps the realms apart under one shared key (R1-02 domain tags)", async () => {
    // FALLBACK_ENV signs both realms with ADMIN_SESSION_SECRET.
    expect(
      await verifySession(FALLBACK_ENV, PORTAL_FALLBACK_PIN, PIN_NOW),
    ).toBeNull();
    const admin = await issueSession(
      FALLBACK_ENV,
      { sub: "s", groups: ["g"] },
      PIN_NOW,
    );
    expect(
      await verifyPortalSession(FALLBACK_ENV, admin.token, PIN_NOW),
    ).toBeNull();
    const key = await importHmacKey("shared-secret-for-both");
    const portalShaped = await signHmacToken(key, "pkey.portal.v1|", {
      sub: "s",
      groups: ["g"],
      exp: PIN_NOW + 60,
    });
    expect(await verifySession(FALLBACK_ENV, portalShaped, PIN_NOW)).toBeNull();
  });

  it("refuses a tampered body, a tampered MAC and an expired session", async () => {
    const [body, mac] = ADMIN_PIN.split(".") as [string, string];
    const flipped = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    expect(
      await verifySession(PIN_ENV, `${flipped(body)}.${mac}`, PIN_NOW),
    ).toBeNull();
    expect(
      await verifySession(PIN_ENV, `${body}.${flipped(mac)}`, PIN_NOW),
    ).toBeNull();
    expect(await verifySession(PIN_ENV, ADMIN_PIN, 1800028800)).toBeNull();
  });

  it("answers signed-out without touching a missing secret, and fails closed when it must", async () => {
    const noSecret = {} as Env;
    expect(await verifySession(noSecret, null, PIN_NOW)).toBeNull();
    expect(await verifySession(noSecret, "no-dot", PIN_NOW)).toBeNull();
    await expect(verifySession(noSecret, ADMIN_PIN, PIN_NOW)).rejects.toThrow(
      "ADMIN_SESSION_SECRET is required",
    );
    expect(await verifyPortalSession(noSecret, null, PIN_NOW)).toBeNull();
    await expect(
      verifyPortalSession(noSecret, PORTAL_PIN, PIN_NOW),
    ).rejects.toThrow("PORTAL_SESSION_SECRET is required");
  });

  it("hmacToken answers undefined, never throws, for a malformed token", async () => {
    const key = () => importHmacKey("k");
    for (const t of [null, "", ".", ".abc", "abc", "a.b"]) {
      expect(await verifyHmacToken(t, "d|", key)).toBeUndefined();
    }
    const good = await signHmacToken(await key(), "d|", { a: 1 });
    expect(await verifyHmacToken(good, "d|", key)).toEqual({ a: 1 });
    expect(await verifyHmacToken(good, "e|", key)).toBeUndefined();
  });
});

describe("sealed values, download tickets and pull tokens survive the move", () => {
  afterEach(() => vi.restoreAllMocks());

  // Minted by the pre-P0-15 keyvault.ts, downloadTicket.ts and registryTokens.ts.
  const env = {
    PLATFORM_KEK: "BRIfLDlGU2BteoeUoa67yNXi7/wJFiMwPUpXZHF+i5g=",
    PLATFORM_KEK_ID: "pin1",
    DOWNLOAD_TICKET_KEY: "pin-ticket-key",
    BLOB_ORIGIN: "https://dl.example.test",
    REGISTRY_TOKEN_KEY: "pin-registry-key",
  } as unknown as Env;
  const slot = {
    product: "pinprod",
    kind: "product-secret",
    id: "S1",
  } as const;
  const SEALED =
    '{"v":2,"kekId":"pin1","iv":"AwoRGB8mLTQ7QklQ","ct":"J6AlVXfS89WT-FkLfcw8dwzKEbF5nLCaOFlSElBYJwc"}';
  const file = {
    product: "pinprod",
    releaseId: "rel_1",
    name: "App 1.0.dmg",
    sha256: "a".repeat(64),
  };
  const TICKET =
    "v1.mEA8dVfO.1800000120.2ynWwdSkaMFyC33U9TC92IkQIrohAXD_6hMba9IV71Q";
  const PULL =
    "v1.eyJzdWIiOiJhY2N0XzEiLCJyZXBvcyI6WyJwaW5wcm9kL2FwcCJdLCJwdXNoIjpbInBpbnByb2QvYXBwIl0sImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwMzAwfQ.37SzGD7tEeWK0HGeMtcBQYekl4glbc_4PIA7k4fJcSY";

  it("opens a value sealed by the old vault and seals the identical bytes", async () => {
    expect(await open(env, SEALED, slot)).toBe("pin plaintext Ü");
    fixRandom();
    expect(await seal(env, "pin plaintext Ü", slot)).toBe(SEALED);
  });

  it("opens under a KEK pasted with a trailing newline, as atob always allowed", async () => {
    const pasted = {
      ...env,
      PLATFORM_KEK: `${env.PLATFORM_KEK}\n`,
    } as unknown as Env;
    expect(await open(pasted, SEALED, slot)).toBe("pin plaintext Ü");
  });

  it("mints and verifies the identical download ticket", async () => {
    expect(await mintDownloadTicket(env, file, PIN_NOW)).toBe(TICKET);
    const at = { ...file, host: "dl.example.test" };
    expect(await verifyDownloadTicket(env, TICKET, at, PIN_NOW)).toBe(true);
    expect(
      await verifyDownloadTicket(env, `${TICKET.slice(0, -1)}A`, at, PIN_NOW),
    ).toBe(false);
  });

  it("mints the identical registry pull token, and the format round-trips", async () => {
    const signed = await signPullToken(
      env,
      { sub: "acct_1", repos: ["pinprod/app"], push: ["pinprod/app"] } as never,
      PIN_NOW,
    );
    expect(signed?.token).toBe(PULL);
    const full = await signPullToken(
      env,
      { sub: "acct_1", own: null, repos: ["pinprod/app"] } as never,
      PIN_NOW,
    );
    expect(await verifyPullToken(env, full!.token, PIN_NOW)).toMatchObject({
      sub: "acct_1",
      repos: ["pinprod/app"],
      exp: PIN_NOW + 300,
    });
    expect(
      await verifyPullToken(env, `${full!.token.slice(0, -1)}A`, PIN_NOW),
    ).toBeNull();
  });
});

// ── 2. Semantics ─────────────────────────────────────────────────────────────────────────────

describe("bytes", () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x3e, 0x3f]);

  it("encodes base64url unpadded in the URL alphabet, base64 padded in the standard one", () => {
    expect(base64Encode(bytes)).toBe("+/8APj8=");
    expect(b64urlEncode(bytes)).toBe("-_8APj8");
    expect(b64urlEncode(bytes.buffer)).toBe("-_8APj8");
    expect(b64urlEncode(bytes.subarray(1, 3))).toBe("_wA");
    expect(b64urlEncodeUtf8("Ü")).toBe("w5w");
  });

  it("decodes base64url leniently (padding, standard alphabet) and throws on garbage", () => {
    for (const s of ["-_8APj8", "-_8APj8=", "+/8APj8", "+/8APj8="]) {
      expect([...b64urlDecode(s)]).toEqual([...bytes]);
    }
    expect(() => b64urlDecode("A")).toThrow();
    expect(() => b64urlDecode("ab!c")).toThrow();
    expect(b64urlDecodeUtf8("w5w")).toBe("Ü");
    expect([...base64Decode("+/8APj8=")]).toEqual([...bytes]);
  });

  it("keeps the binary-string variants on btoa/atob semantics, padded and as-is", () => {
    expect(b64urlEncodeBinary('[1,"a"]')).toBe("WzEsImEiXQ");
    expect(() => b64urlEncodeBinary("Ā")).toThrow();
    expect(b64urlDecodeBinary("WzEsImEiXQ")).toBe('[1,"a"]');
    expect(b64urlDecodeBinaryUnpadded("WzEsImEiXQ")).toBe('[1,"a"]');
    // A partial padding is repaired by one and refused by the other, as the two cursors were.
    expect(b64urlDecodeBinary("WzEsImEiXQ=")).toBe('[1,"a"]');
    expect(() => b64urlDecodeBinaryUnpadded("WzEsImEiXQ=")).toThrow();
    expect(b64urlDecodeBinary("w5w")).toBe("\u00c3\u009c");
  });

  it("reads operator key material in either alphabet with atob's whitespace rule", () => {
    expect([...base64DecodeEitherAlphabet("+/8APj8=\n")]).toEqual([...bytes]);
    expect([...base64DecodeEitherAlphabet("-_8APj8")]).toEqual([...bytes]);
    expect(() => base64DecodeEitherAlphabet("-_8APj8=A")).toThrow();
  });

  it("decodes base64url strictly: alphabet only, no padding, never a dangling character", () => {
    expect([...(b64urlDecodeStrict("-_8APj8") ?? [])]).toEqual([...bytes]);
    expect(b64urlDecodeStrict("")).toEqual(new Uint8Array());
    for (const s of ["-_8APj8=", "+/8APj8", " -_8APj8", "A", "AAAAA"]) {
      expect(b64urlDecodeStrict(s)).toBeNull();
    }
  });

  it("encodes hex lower-case and decodes either case, refusing odd, empty and non-hex", () => {
    expect(hexEncode(bytes)).toBe("fbff003e3f");
    expect(hexEncode(bytes.buffer)).toBe("fbff003e3f");
    expect([...(hexDecode("FBff003E3f") ?? [])]).toEqual([...bytes]);
    for (const s of ["", "a", "abc", "zz", "0x00"])
      expect(hexDecode(s)).toBeNull();
  });
});

describe("hash", () => {
  it("hashes a string as UTF-8 and bytes as themselves, the same digest either way", async () => {
    const hello =
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    expect(await sha256Hex("hello")).toBe(hello);
    expect(await sha256Hex(new TextEncoder().encode("hello"))).toBe(hello);
    const view = new TextEncoder().encode("xxhelloxx").subarray(2, 7);
    expect(await sha256Hex(view)).toBe(hello);
    expect(await sha256B64url("hello")).toBe(
      "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ",
    );
    expect(await sha256B64url("hello", 8)).toBe("LPJNul-w");
    expect(await sha256Base64("hello")).toBe(
      "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
    );
  });
});

describe("compare", () => {
  it("compares strings and bytes, unequal lengths unequal", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    const a = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqualBytes(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqualBytes(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqualBytes(a, new Uint8Array([1, 2]))).toBe(false);
  });
});

describe("random and pkce", () => {
  it("mints base64url and hex tokens of the documented lengths", () => {
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomHex(12)).toMatch(/^[0-9a-f]{24}$/);
    expect(randomToken(32)).not.toBe(randomToken(32));
  });

  it("computes the RFC 7636 appendix B S256 challenge", async () => {
    expect(
      await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(await pkceChallenge(verifier));
  });
});

describe("json", () => {
  it("degrades absent, empty and malformed columns to the fallback, never throws", () => {
    for (const raw of [null, undefined, "", "{nope"]) {
      expect(parseJsonOr(raw, 7)).toBe(7);
      expect(parseJsonColumn(raw)).toBeNull();
      expect(tryParseJson(raw)).toBeUndefined();
      expect(parseJsonObject(raw)).toBeNull();
      expect(parseJsonArray(raw)).toBeNull();
      expect(parseJsonStringList(raw)).toEqual([]);
    }
    expect(parseJsonColumn("null")).toBeNull();
    expect(parseJsonColumn("0")).toBe(0);
    expect(parseJsonOr('"x"', "y")).toBe("x");
  });

  it("checks the shape where the helper names one", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    for (const raw of ["[]", "null", "1", '"s"', 42, null]) {
      expect(parseJsonObject(raw)).toBeNull();
    }
    expect(parseJsonArray("[1]")).toEqual([1]);
    expect(parseJsonArray('{"a":1}')).toBeNull();
    expect(parseJsonStringList('["a",1,"b",null]')).toEqual(["a", "b"]);
    expect(parseJsonStringList('{"a":"b"}')).toEqual([]);
    expect(toJsonColumn(null)).toBeNull();
    expect(toJsonColumn(undefined)).toBeNull();
    expect(toJsonColumn({ a: [1] })).toBe('{"a":[1]}');
  });
});

describe("html", () => {
  const raw = `<a href="x">Ada's & co</a>`;
  it("keeps the three apostrophe spellings apart", () => {
    expect(escapeHtml(raw)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Ada&#x27;s &amp; co&lt;/a&gt;",
    );
    expect(escapeHtmlDecimalApostrophe(raw)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Ada&#39;s &amp; co&lt;/a&gt;",
    );
    expect(escapeHtmlKeepApostrophe(raw)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Ada's &amp; co&lt;/a&gt;",
    );
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

describe("returnTo", () => {
  const req = new Request("https://key.plrs.im/portal/sign-in?x=1");
  const cases: [
    unknown,
    string | undefined,
    string | undefined,
    string | undefined,
  ][] = [
    // raw, product sign-in, portal sign-in, card
    [null, undefined, undefined, undefined],
    ["", undefined, undefined, undefined],
    [42, undefined, undefined, undefined],
    [
      "https://key.plrs.im/library?a=1#b",
      "https://key.plrs.im/library?a=1#b",
      "https://key.plrs.im/library?a=1#b",
      "/library?a=1#b",
    ],
    [
      "https://key.plrs.im/manage/products",
      "https://key.plrs.im/manage/products",
      undefined,
      undefined,
    ],
    ["/library", undefined, undefined, "/library"],
    ["//evil.example/x", undefined, undefined, undefined],
    ["https://evil.example/", undefined, undefined, undefined],
    ["javascript:alert(1)", undefined, undefined, undefined],
  ];
  it.each(cases)("%s", (raw, product, portal, card) => {
    expect(safeReturnTo(req, raw, PRODUCT_SIGNIN_RETURN_TO)).toBe(product);
    expect(safeReturnTo(req, raw, PORTAL_SIGNIN_RETURN_TO)).toBe(portal);
    expect(safeReturnTo(req, raw, CARD_RETURN_TO)).toBe(card);
  });
});

describe("email", () => {
  it("trims and lower-cases, nothing more", () => {
    expect(normalizeEmail("  Ada.Lovelace+x@Example.COM \n")).toBe(
      "ada.lovelace+x@example.com",
    );
  });
});

// ── 3. No new local copies ───────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, "..");
const SRC = join(WORKER_ROOT, "src");

/** The canonical modules: the only files allowed to implement these helpers. */
const CANONICAL = new Set(
  [
    "bytes",
    "hash",
    "compare",
    "random",
    "pkce",
    "json",
    "hmacToken",
    "html",
    "returnTo",
    "email",
  ].map((m) => `src/platform/${m}.ts`),
);

interface Rule {
  id: string;
  /** What to use instead. */
  use: string;
  pattern: RegExp;
}

/** Names the consolidated copies went by; a function or arrow const with one is a copy. */
const COPY_NAMES = [
  // bytes
  "b64url",
  "b64urlEncode",
  "b64urlDecode",
  "b64urlBytes",
  "b64UrlEncode",
  "b64UrlDecode",
  "base64url",
  "base64Url",
  "base64UrlEncode",
  "base64UrlEncodeString",
  "base64UrlDecode",
  "base64UrlDecodeToString",
  "hex",
  "hexOf",
  "toHex",
  "hexToBytes",
  "toAB",
  "toBuffer",
  // hash
  "sha256Hex",
  "sha256HexOfAscii",
  "sha256HexOfBytes",
  "sha256B64url",
  "sha256Base64",
  // compare
  "safeEqual",
  "timingSafeEqual",
  "constantTimeEqual",
  // random
  "randomBytes",
  "randomToken",
  "randomHex",
  "randomSecret",
  // pkce
  "pkce",
  "s256",
  // json
  "parseJson",
  "parseJsonColumn",
  "parseJsonList",
  "parseJsonArray",
  "parseJsonObject",
  "parseJsonOrNull",
  "parseJsonUnknown",
  "parseObject",
  "parseArray",
  "parseStored",
  "jsonOr",
  "jsonOrNull",
  "objectJson",
  "jsonObject",
  // html, returnTo, email
  "escapeHtml",
  "esc",
  "safeReturnTo",
  "normalizeEmail",
].join("|");

const RULES: Rule[] = [
  {
    id: "base64url encoder",
    use: "b64urlEncode (platform/bytes)",
    pattern: /\.replace\(\s*\/\\\+\/g\s*,\s*["']-["']\s*\)/,
  },
  {
    id: "base64url decoder",
    use: "b64urlDecode / b64urlDecodeStrict (platform/bytes)",
    pattern: /\.replace\(\s*\/-\/g\s*,\s*["']\+["']\s*\)/,
  },
  {
    id: "hex encoder",
    use: "hexEncode (platform/bytes)",
    pattern: /\.toString\(\s*16\s*\)\s*\.padStart\(\s*2\b/,
  },
  {
    id: "SHA-256 digest",
    use: "sha256 / sha256Hex / sha256B64url / sha256Base64 (platform/hash)",
    pattern: /\.digest\(\s*["']SHA-256["']/,
  },
  {
    id: "constant-time compare loop",
    use: "constantTimeEqual / constantTimeEqualBytes (platform/compare)",
    pattern: /\|=\s*[\w.]+(?:\[\w+\]!?|\.charCodeAt\(\s*\w+\s*\))\s*\^/,
  },
  {
    id: "CSPRNG read",
    use: "randomBytes / randomToken / randomHex (platform/random)",
    pattern: /\bgetRandomValues\s*\(/,
  },
  {
    id: "HTML escaper",
    use: "escapeHtml (platform/html)",
    pattern: /\.replace\(\s*\/&\/g\s*,\s*["']&amp;["']\s*\)/,
  },
  {
    id: "JSON-column reader",
    use: "parseJsonOr / parseJsonColumn / parseJsonObject / … (platform/json)",
    // A function that is nothing but `[if (!raw) return F;] try { return JSON.parse(raw); }
    // catch { return F; }`, whatever it is called.
    pattern:
      /function\s+\w+\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^{]+)?\{\s*(?:if\s*\([^)]*\)\s*return\s+[^;]+;\s*)?try\s*\{\s*return\s+JSON\.parse\(\s*\w+\s*\)(?:\s+as\s+[^;]+)?;\s*\}\s*catch\s*(?:\(\s*\w*\s*\))?\s*\{\s*return\s+[^;]+;\s*\}\s*\}/,
  },
  {
    id: "local copy by name",
    use: "the platform/ export of the same job",
    pattern: new RegExp(
      `(?:\\bfunction\\s+(?:${COPY_NAMES})\\s*[<(])|(?:\\b(?:const|let|var)\\s+(?:${COPY_NAMES})\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*(?::[^=]+)?=>)`,
    ),
  },
];

/**
 * The documented exceptions: a file that may keep a local copy because it must not import the
 * platform module, each with the rule it may break and why. Adding one is a review decision.
 * An entry that no longer matches anything fails too, so a stale exception cannot linger.
 */
const EXCEPTIONS: Record<string, { rules: string[]; why: string }> = {
  "src/core/storefront/polarisKeyListing.ts": {
    rules: ["JSON-column reader", "local copy by name"],
    why: "an A-18a declaration module: it imports only the adapter layer, so the CLI's copy is a straight serialise (boundaries.test.ts, 'the adapter layer')",
  },
  "src/services/distribution/dictionary.ts": {
    rules: ["hex encoder"],
    why: "the pure half of dcz with no imports at all, loaded as-is by the Chromium harness in conformance/runners/browser/dcz.setup.ts",
  },
};

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Every rule match in `source`, as `rule id @ line`. */
function findings(source: string): { rule: Rule; line: number }[] {
  const out: { rule: Rule; line: number }[] = [];
  for (const rule of RULES) {
    const global = new RegExp(rule.pattern.source, "g");
    for (const m of source.matchAll(global)) {
      out.push({
        rule,
        line: source.slice(0, m.index).split("\n").length,
      });
    }
  }
  return out;
}

describe("src/platform/ is a leaf layer", () => {
  it("imports nothing but its own siblings (no src/ module, no package)", () => {
    const bad: string[] = [];
    for (const file of walkTs(join(SRC, "platform"))) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(
        /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\sfrom\s+)?["']([^"']+)["']/g,
      )) {
        const spec = m[1]!;
        if (!/^\.\/[A-Za-z]+\.js$/.test(spec))
          bad.push(`${relative(WORKER_ROOT, file)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("no new local copies of the platform primitives", () => {
  it("each rule fires on the shape it names (the guard is not vacuous)", () => {
    const samples: Record<string, string> = {
      "base64url encoder": `btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_")`,
      "base64url decoder": `s.replace(/-/g, "+").replace(/_/g, "/")`,
      "hex encoder": `[...d].map((b) => b.toString(16).padStart(2, "0"))`,
      "SHA-256 digest": `await crypto.subtle.digest(\n  "SHA-256",\n  bytes)`,
      "constant-time compare loop": `diff |= a.charCodeAt(i) ^ b.charCodeAt(i);`,
      "CSPRNG read": `crypto.getRandomValues(a)`,
      "HTML escaper": `s.replace(/&/g, "&amp;")`,
      "JSON-column reader": `function readIt(raw: string | null): unknown {\n  if (!raw) return null;\n  try {\n    return JSON.parse(raw) as unknown;\n  } catch {\n    return null;\n  }\n}`,
      "local copy by name": `const sha256Hex = async (s: string) => s;`,
    };
    for (const rule of RULES) {
      const sample = samples[rule.id];
      expect(sample, `no sample for ${rule.id}`).toBeDefined();
      expect(
        findings(sample!).some((f) => f.rule.id === rule.id),
        rule.id,
      ).toBe(true);
    }
    expect(findings(`d |= a[i]! ^ b[i]!;`)).toHaveLength(1);
    expect(findings(`function escapeHtml(s: string) {}`)).toHaveLength(1);
    // A variable that happens to be called `hex` is not a copy.
    expect(findings(`const hex = OCI_DIGEST_RE.exec(ref)?.[1];`)).toHaveLength(
      0,
    );
  });

  it("only src/platform/ implements them", () => {
    const files = walkTs(SRC);
    expect(files.length).toBeGreaterThan(400);
    for (const c of CANONICAL) {
      expect(files.map((f) => relative(WORKER_ROOT, f))).toContain(c);
    }
    const offenders: string[] = [];
    const excused = new Set<string>();
    for (const file of files) {
      const rel = relative(WORKER_ROOT, file).split("\\").join("/");
      if (CANONICAL.has(rel)) continue;
      for (const f of findings(readFileSync(file, "utf8"))) {
        if (EXCEPTIONS[rel]?.rules.includes(f.rule.id)) {
          excused.add(`${rel} ${f.rule.id}`);
          continue;
        }
        offenders.push(`${rel}:${f.line} ${f.rule.id} → use ${f.rule.use}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
    for (const [file, { rules }] of Object.entries(EXCEPTIONS))
      for (const rule of rules)
        expect(
          excused.has(`${file} ${rule}`),
          `stale exception: ${file} no longer needs "${rule}"; remove it`,
        ).toBe(true);
  });
});
