/// <reference types="@cloudflare/workers-types" />

// I-14.6 (plans/I-14.md §1; WIRE-CONTRACT-V5 §12.11.7): the Game Center verifier. A local RSA
// chain stands in for Apple's, passed as the anchors; the pinned DigiCert constants are checked
// against the public fixtures. Every fetch is a fake: no call leaves the process.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { b64urlEncode } from "../../../src/platform/bytes.js";
import { sha256Hex } from "../../../src/platform/hash.js";
import {
  OidcNetworkError,
  OidcVerifyError,
} from "../../../src/core/oidc/client.js";
import {
  GAME_CENTER_CERT_GRACE_SECONDS,
  verifyGameCenterToken,
  type CachedCert,
  type GameCenterCertCache,
  type GameCenterVerifyOpts,
} from "../../../src/services/identity/providers/gameCenter.js";
import {
  GAME_CENTER_INTERMEDIATES,
  GAME_CENTER_ROOTS,
} from "../../../src/services/identity/providers/gameCenterAnchors.js";
import { NATIVE_HOSTS } from "../../../src/services/identity/providers/net.js";
import type { PlatformSignInAudiences } from "../../../src/services/identity/platformSignIn.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv } from "../../seed.js";
import { singleUseMock } from "../../singleUseMock.js";
import { TEST_ROOT } from "../../paths.js";
import { makeRsaChain, type RsaTestChain } from "../../x509Fixtures.js";

const AT = 1_800_000_000; // epoch seconds the generated chain is valid around
const NOW = AT * 1000;
const URL_OK = "https://static.gc.apple.com/public-key/gc-prod-12.cer";
const TEAM = "ABCDE12345";
const BUNDLE = "com.acme.game";
const PLAYER = "T:team-player-0001";
const enc = new TextEncoder();

const AUD: PlatformSignInAudiences = {
  google: { serverClientId: null, clientIds: [] },
  apple: { teamId: TEAM, bundleIds: [BUNDLE], outletBundleIds: [] },
  gameCenter: true,
  playGames: { applicationId: null, serverClientId: null },
  nearby: false,
};

let chain: RsaTestChain;
beforeAll(async () => {
  chain = await makeRsaChain({ at: AT });
});

function anchorsOf(c: RsaTestChain) {
  return { roots: [c.root], intermediates: [c.intermediate] };
}

interface TokenParts {
  url?: string;
  salt?: Uint8Array;
  signSalt?: Uint8Array;
  timestamp?: number;
  player?: string;
  bundle?: string;
  signBundle?: string;
  key?: CryptoKey;
}

async function mint(
  p: TokenParts = {},
): Promise<{ token: string; sig: string }> {
  const salt = p.salt ?? Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
  const ts = p.timestamp ?? NOW - 5_000;
  const player = p.player ?? PLAYER;
  const bundle = p.bundle ?? BUNDLE;
  const a = enc.encode(player);
  const b = enc.encode(p.signBundle ?? bundle);
  const s = p.signSalt ?? salt;
  const data = new Uint8Array(a.length + b.length + 8 + s.length);
  data.set(a, 0);
  data.set(b, a.length);
  new DataView(data.buffer).setBigUint64(
    a.length + b.length,
    BigInt(ts),
    false,
  );
  data.set(s, a.length + b.length + 8);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      p.key ?? chain.leafKey.keys.privateKey,
      data,
    ),
  );
  const f = (t: string) => b64urlEncode(enc.encode(t));
  const sigText = b64urlEncode(sig);
  return {
    token: [
      "gc1",
      f(p.url ?? URL_OK),
      sigText,
      b64urlEncode(salt),
      String(ts),
      f(player),
      f(bundle),
    ].join("."),
    sig: sigText,
  };
}

class MapCache implements GameCenterCertCache {
  readonly map = new Map<string, CachedCert>();
  puts = 0;
  async get(url: string) {
    return this.map.get(url) ?? null;
  }
  async put(url: string, c: CachedCert) {
    this.puts++;
    this.map.set(url, c);
  }
}

interface Rig {
  env: ReturnType<typeof makeEnv>;
  cache: MapCache;
  calls: { url: string; init?: RequestInit }[];
  opts: GameCenterVerifyOpts;
}

function rig(
  answer: (url: string) => Response | Promise<Response> = () =>
    new Response(chain.leaf, {
      headers: { "cache-control": "max-age=300" },
    }),
  extra: Partial<GameCenterVerifyOpts> = {},
): Rig {
  const env = makeEnv(new KvMock(), []);
  singleUseMock(env);
  const cache = new MapCache();
  const calls: Rig["calls"] = [];
  return {
    env,
    cache,
    calls,
    opts: {
      nowMs: NOW,
      cache,
      anchors: anchorsOf(chain),
      fetch: async (url, init) => {
        calls.push({ url, init });
        return answer(url);
      },
      ...extra,
    },
  };
}

const run = (r: Rig, token: string, aud = AUD, product = "djdl") =>
  verifyGameCenterToken(token, r.env, product, aud, r.opts);

async function kind(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OidcVerifyError) return "refused";
    if (e instanceof OidcNetworkError) return "unavailable";
    throw e;
  }
  return "accepted";
}

describe("Game Center: a valid token", () => {
  it("accepts it, names the team scope and player, and dials Apple's host without redirects", async () => {
    const r = rig();
    const { token } = await mint();
    expect(await run(r, token)).toEqual({
      subject: PLAYER,
      scope: `apple-team:${TEAM}`,
      bundleId: BUNDLE,
    });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe(URL_OK);
    expect(r.calls[0]!.init?.redirect).toBe("manual");
    expect(NATIVE_HOSTS.gamecenter).toEqual(["static.gc.apple.com"]);
  });

  it("accepts the edge of the window and refuses one millisecond outside it", async () => {
    for (const [dt, want] of [
      [-120_000, "accepted"],
      [-120_001, "refused"],
      [30_000, "accepted"],
      [30_001, "refused"],
    ] as const) {
      const r = rig();
      const { token } = await mint({ timestamp: NOW + dt });
      expect(await kind(run(r, token))).toBe(want);
    }
  });
});

describe("Game Center: refusals", () => {
  it("a bundle id that is not the product's", async () => {
    const r = rig();
    const { token } = await mint({ bundle: "com.other.game" });
    expect(await kind(run(r, token))).toBe("refused");
    expect(r.calls).toHaveLength(0);
  });

  it("another team's product: no team, the switch off, or no bundle ids", async () => {
    const { token } = await mint();
    for (const aud of [
      { ...AUD, apple: { ...AUD.apple, teamId: null } },
      { ...AUD, gameCenter: false },
      { ...AUD, apple: { ...AUD.apple, bundleIds: [] } },
    ]) {
      const r = rig();
      expect(await kind(run(r, token, aud))).toBe("refused");
      expect(r.calls).toHaveLength(0);
    }
  });

  it("a signature made for another team player id", async () => {
    const r = rig();
    const good = await mint({ player: "T:someone-else" });
    // Present the signature of another player under this player's name.
    const parts = good.token.split(".");
    parts[5] = b64urlEncode(enc.encode(PLAYER));
    expect(await kind(run(r, parts.join(".")))).toBe("refused");
  });

  it("a tampered salt, bundle or timestamp", async () => {
    const r = rig();
    const { token } = await mint();
    const p = token.split(".");
    const salt = [...p];
    salt[3] = b64urlEncode(Uint8Array.of(9, 9, 9, 9));
    expect(await kind(run(r, salt.join(".")))).toBe("refused");
    const ts = [...p];
    ts[4] = String(NOW - 4_000);
    expect(await kind(run(r, ts.join(".")))).toBe("refused");
    const signedOtherBundle = await mint({ signBundle: "com.acme.other" });
    expect(await kind(run(r, signedOtherBundle.token))).toBe("refused");
  });

  it("a second use of one signature, and not of another", async () => {
    const r = rig();
    const { token } = await mint();
    expect(await kind(run(r, token))).toBe("accepted");
    expect(await kind(run(r, token))).toBe("refused");
    // Another product's scope holds its own record.
    expect(await kind(run(r, token, AUD, "other"))).toBe("accepted");
    const second = await mint({ salt: Uint8Array.of(8, 7, 6, 5) });
    expect(await kind(run(r, second.token))).toBe("accepted");
  });

  it("malformed tokens: wrong prefix, field count, padding, sizes, oversize, odd characters", async () => {
    const r = rig();
    const { token } = await mint();
    const p = token.split(".");
    const cases = [
      ["gc2", ...p.slice(1)].join("."),
      p.slice(0, 6).join("."),
      [...p, "x"].join("."),
      [p[0], p[1], p[2] + "=", ...p.slice(3)].join("."),
      [p[0], p[1], b64urlEncode(new Uint8Array(255)), ...p.slice(3)].join("."),
      [p[0], p[1], p[2], "", ...p.slice(4)].join("."),
      [p[0], p[1], p[2], b64urlEncode(new Uint8Array(65)), ...p.slice(4)].join(
        ".",
      ),
      [...p.slice(0, 4), "01", ...p.slice(5)].join("."),
      [...p.slice(0, 5), b64urlEncode(enc.encode("a\nb")), p[6]].join("."),
      token + "A".repeat(4096),
      "",
    ];
    for (const c of cases) expect(await kind(run(r, c))).toBe("refused");
    expect(r.calls).toHaveLength(0);
  });

  it("a foreign host, plain http, a port, credentials, a path outside public-key", async () => {
    for (const url of [
      "https://evil.example/public-key/gc-prod-12.cer",
      "https://static.gc.apple.com.evil.example/public-key/gc-prod-12.cer",
      "http://static.gc.apple.com/public-key/gc-prod-12.cer",
      "https://static.gc.apple.com:8443/public-key/gc-prod-12.cer",
      "https://user@static.gc.apple.com/public-key/gc-prod-12.cer",
      "https://static.gc.apple.com/other/gc-prod-12.cer",
      "https://static.gc.apple.com/public-key/gc-prod-12.cer?x=1",
      "https://static.gc.apple.com/public-key/gc-prod-12.der",
      "https://static.gc.apple.com/public-key/anything.cer",
      "https://static.gc.apple.com/public-key/gc-prod-.cer",
      "https://static.gc.apple.com/public-key/gc-prod-12345.cer",
      "https://static.gc.apple.com/public-key/gc-prod-1a.cer",
      "https://static.gc.apple.com/public-key/%2e%2e/gc-prod-12.cer",
    ]) {
      const r = rig();
      const { token } = await mint({ url });
      expect(await kind(run(r, token)), url).toBe("refused");
      expect(r.calls).toHaveLength(0);
    }
  });

  it("a team player id outside Apple's shape is refused before any fetch", async () => {
    for (const player of [
      "G:1234",
      "t:abc",
      "T:",
      "T:has space",
      "T:" + "a".repeat(129),
      "plain-id",
      "T:a.b",
    ]) {
      const r = rig();
      const { token } = await mint({ player });
      expect(await kind(run(r, token)), player).toBe("refused");
      expect(r.calls).toHaveLength(0);
    }
  });

  it("a redirect from Apple's host is not followed", async () => {
    const r = rig(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/x.cer" },
        }),
    );
    const { token } = await mint();
    expect(await kind(run(r, token))).toBe("unavailable");
    expect(r.calls).toHaveLength(1);
  });

  it("an intermediate that is not pinned", async () => {
    const r = rig(undefined, {
      anchors: {
        roots: [chain.root],
        intermediates: [chain.intermediate.slice().reverse()],
      },
    });
    const { token } = await mint();
    expect(await kind(run(r, token))).toBe("refused");
    // The real pinned anchors do not vouch for a local chain either.
    const real = rig(undefined, { anchors: undefined });
    expect(await kind(run(real, token))).toBe("refused");
  });

  it("a leaf that has expired, or is not yet valid", async () => {
    for (const o of [{ expiredLeaf: true }, { futureLeaf: true }]) {
      const c = await makeRsaChain({ at: AT, ...o });
      const r = rig(() => new Response(c.leaf), { anchors: anchorsOf(c) });
      const { token } = await mint({ key: c.leafKey.keys.privateKey });
      expect(await kind(run(r, token))).toBe("refused");
    }
  });

  it("a leaf not issued to Apple Inc., without code signing, or signed by a stranger", async () => {
    for (const o of [
      { leafO: "Mallory Ltd" },
      { leafCn: "Mallory Ltd" },
      { eku: ["1.3.6.1.5.5.7.3.1"] },
      { eku: null },
      { brokenLink: true },
    ]) {
      const c = await makeRsaChain({ at: AT, ...o });
      const r = rig(() => new Response(c.leaf), { anchors: anchorsOf(c) });
      const { token } = await mint({ key: c.leafKey.keys.privateKey });
      expect(await kind(run(r, token)), JSON.stringify(o)).toBe("refused");
    }
  });

  it("a signature by a key that is not the leaf's", async () => {
    const other = await makeRsaChain({ at: AT });
    const r = rig();
    const { token } = await mint({ key: other.leafKey.keys.privateKey });
    expect(await kind(run(r, token))).toBe("refused");
  });
});

describe("Game Center: the key host", () => {
  it("answers 404 with a refusal and 5xx, 429, a thrown fetch or an oversized body with unavailable", async () => {
    const { token } = await mint();
    const r404 = rig(() => new Response("nope", { status: 404 }));
    expect(await kind(run(r404, token))).toBe("refused");
    for (const answer of [
      () => new Response("x", { status: 500 }),
      () => new Response("x", { status: 503 }),
      () => new Response("x", { status: 429 }),
      () => Promise.reject(new Error("down")),
      () => new Response(new Uint8Array(16 * 1024 + 1)),
    ]) {
      const r = rig(answer as never);
      expect(await kind(run(r, token))).toBe("unavailable");
    }
    // An unavailable host burns nothing: the signature is still good afterwards.
    expect(await kind(run(rig(), token))).toBe("accepted");
  });

  it("a 200 that is not a certificate is refused", async () => {
    const r = rig(() => new Response(new Uint8Array([1, 2, 3])));
    const { token } = await mint();
    expect(await kind(run(r, token))).toBe("refused");
    expect(r.cache.puts).toBe(0);
  });
});

describe("Game Center: the certificate cache", () => {
  it("a cache hit does not dial again but verifies the chain again", async () => {
    const r = rig();
    const a = await mint();
    expect(await kind(run(r, a.token))).toBe("accepted");
    expect(r.calls).toHaveLength(1);
    expect(r.cache.puts).toBe(1);
    const b = await mint({ salt: Uint8Array.of(4, 4, 4, 4) });
    expect(await kind(run(r, b.token))).toBe("accepted");
    expect(r.calls).toHaveLength(1);

    // Same cache, a chain that no longer verifies: the kept bytes are refused.
    const expired = await makeRsaChain({ at: AT, expiredLeaf: true });
    const kept = rig(undefined, { anchors: anchorsOf(expired) });
    kept.cache.map.set(URL_OK, {
      der: expired.leaf,
      freshUntilMs: NOW + 60_000,
      staleUntilMs: NOW + 120_000,
    });
    const c = await mint({ key: expired.leafKey.keys.privateKey });
    expect(await kind(run(kept, c.token))).toBe("refused");
    expect(kept.calls).toHaveLength(0);
  });

  it("honours Apple's max-age: kept for it, fetched again after it", async () => {
    const r = rig(
      () =>
        new Response(chain.leaf, {
          headers: { "cache-control": "public, max-age=300" },
        }),
    );
    await run(r, (await mint({ salt: Uint8Array.of(1) })).token);
    const stored = r.cache.map.get(URL_OK)!;
    expect(stored.freshUntilMs).toBe(NOW + 300_000);
    expect(stored.staleUntilMs).toBe(
      NOW + 300_000 + GAME_CENTER_CERT_GRACE_SECONDS * 1000,
    );

    r.opts.nowMs = NOW + 299_000;
    await run(
      r,
      (await mint({ salt: Uint8Array.of(2), timestamp: NOW + 299_000 })).token,
    );
    expect(r.calls).toHaveLength(1);
    r.opts.nowMs = NOW + 301_000;
    await run(
      r,
      (await mint({ salt: Uint8Array.of(3), timestamp: NOW + 301_000 })).token,
    );
    expect(r.calls).toHaveLength(2);
  });

  it("keeps nothing when Apple says no-store or max-age=0, and caps a long max-age at a day", async () => {
    for (const cc of ["no-store", "max-age=0", "private, max-age=60"]) {
      const r = rig(
        () => new Response(chain.leaf, { headers: { "cache-control": cc } }),
      );
      await run(r, (await mint()).token);
      expect(r.cache.puts, cc).toBe(0);
    }
    const long = rig(
      () =>
        new Response(chain.leaf, {
          headers: { "cache-control": "max-age=99999999" },
        }),
    );
    await run(long, (await mint()).token);
    expect(long.cache.map.get(URL_OK)!.freshUntilMs).toBe(
      NOW + 24 * 3600 * 1000,
    );
  });

  it("a kept certificate stands in for a short outage, and no longer than the grace", async () => {
    const down = () => new Response("x", { status: 503 });
    const r = rig(down);
    r.cache.map.set(URL_OK, {
      der: chain.leaf,
      freshUntilMs: NOW - 1_000,
      staleUntilMs: NOW + 60_000,
    });
    expect(await kind(run(r, (await mint()).token))).toBe("accepted");
    r.cache.map.set(URL_OK, {
      der: chain.leaf,
      freshUntilMs: NOW - 120_000,
      staleUntilMs: NOW - 1_000,
    });
    expect(
      await kind(run(r, (await mint({ salt: Uint8Array.of(5) })).token)),
    ).toBe("unavailable");
    // A 404 never falls back to the kept copy.
    const gone = rig(() => new Response("", { status: 404 }));
    gone.cache.map.set(URL_OK, {
      der: chain.leaf,
      freshUntilMs: NOW - 1_000,
      staleUntilMs: NOW + 60_000,
    });
    expect(await kind(run(gone, (await mint()).token))).toBe("refused");
  });
});

describe("Game Center: the pinned anchors", () => {
  const dir = join(TEST_ROOT, "fixtures", "gamecenter");
  const read = (f: string) => new Uint8Array(readFileSync(join(dir, f)));

  it("are the DigiCert CA1 and Root G4 of the fixtures, by fingerprint", async () => {
    expect(GAME_CENTER_INTERMEDIATES).toHaveLength(1);
    expect(GAME_CENTER_ROOTS).toHaveLength(1);
    expect(await sha256Hex(GAME_CENTER_INTERMEDIATES[0]!)).toBe(
      "46011ede1c147eb2bc731a539b7c047b7ee93e48b9d3c3ba710ce132bbdfac6b",
    );
    expect(await sha256Hex(GAME_CENTER_ROOTS[0]!)).toBe(
      "552f7bdcf1a7af9e6ce672017f4f12abf77240c78e761ac203d1d9d20ac89988",
    );
    expect(GAME_CENTER_INTERMEDIATES[0]).toEqual(
      read("digicert-g4-codesigning-ca1.der"),
    );
    expect(GAME_CENTER_ROOTS[0]).toEqual(read("digicert-trusted-root-g4.der"));
  });

  it("verify Apple's real leaf at a fixed instant, and refuse it once expired (signature aside)", async () => {
    const { verifyChain, OID } =
      await import("../../../src/core/trust/x509.js");
    const leaf = read("gc-prod-12.der");
    const policy = {
      roots: GAME_CENTER_ROOTS,
      length: 3,
      algorithms: ["rsa"] as const,
      leafExtendedKeyUsage: OID.codeSigning,
      leafDigitalSignature: "require" as const,
    };
    const at = Date.UTC(2026, 9, 28) / 1000;
    await expect(
      verifyChain(
        [leaf, GAME_CENTER_INTERMEDIATES[0]!, GAME_CENTER_ROOTS[0]!],
        { ...policy, at },
      ),
    ).resolves.toBeTruthy();
    await expect(
      verifyChain(
        [leaf, GAME_CENTER_INTERMEDIATES[0]!, GAME_CENTER_ROOTS[0]!],
        {
          ...policy,
          at: Date.UTC(2027, 7, 1) / 1000,
        },
      ),
    ).rejects.toThrow();
  });

  it("the real leaf is fetched and refused for a signature it did not make", async () => {
    const real = read("gc-prod-12.der");
    const at = Date.UTC(2026, 9, 28);
    const r = rig(() => new Response(real), { anchors: undefined, nowMs: at });
    const { token } = await mint({ timestamp: at - 1_000 });
    // Nothing of ours signed it, so the signature check refuses it; it is never kept.
    expect(await kind(run(r, token))).toBe("refused");
    expect(r.calls).toHaveLength(1);
    expect(r.cache.puts).toBe(0);
  });
});
