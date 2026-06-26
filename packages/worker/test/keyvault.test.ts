import { describe, expect, it } from "vitest";
import { signJws, verifyJws } from "@polaris-key/jws";
import type { Env } from "../src/env.js";
import { generateEd25519, open, seal, type Sealed } from "../src/keyvault.js";
import { TEST_KEK } from "./seed.js";

const env = { PLATFORM_KEK: TEST_KEK } as unknown as Env;
const ctx = { product: "djdl", kind: "signing-key", id: "kid-1" } as const;

describe("keyvault seal/open", () => {
  it("round-trips a value (open(seal(x)) === x)", async () => {
    const plaintext =
      "-----BEGIN PRIVATE KEY-----\nhello world\n-----END PRIVATE KEY-----";
    const sealed = await seal(env, plaintext, ctx);
    expect(await open(env, sealed, ctx)).toBe(plaintext);
  });

  it("produces a fresh nonce per seal (same plaintext ⇒ different ciphertext)", async () => {
    const a = JSON.parse(await seal(env, "secret", ctx)) as Sealed;
    const b = JSON.parse(await seal(env, "secret", ctx)) as Sealed;
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("THROWS on a tampered ciphertext (auth-tag failure, never a partial value)", async () => {
    const sealed = JSON.parse(await seal(env, "top-secret", ctx)) as Sealed;
    // Flip the first base64url char so the decoded ciphertext bytes definitely change.
    const first = sealed.ct[0] === "A" ? "B" : "A";
    const tampered = JSON.stringify({
      ...sealed,
      ct: first + sealed.ct.slice(1),
    });
    await expect(open(env, tampered, ctx)).rejects.toThrow();
  });

  it("THROWS when the KEK is missing", async () => {
    await expect(seal({} as Env, "x", ctx)).rejects.toThrow();
    const sealed = await seal(env, "x", ctx);
    await expect(open({} as Env, sealed, ctx)).rejects.toThrow();
  });

  it("rejects a non-32-byte KEK instead of deriving a deployment key", async () => {
    const weird = { PLATFORM_KEK: btoa("short-kek") } as unknown as Env;
    await expect(seal(weird, "value", ctx)).rejects.toThrow(
      "PLATFORM_KEK must decode to exactly 32 bytes",
    );
  });

  it("binds v2 envelopes to KEK id and associated data", async () => {
    const sealed = await seal(env, "value", ctx);
    expect(JSON.parse(sealed)).toMatchObject({ v: 2, kekId: "default" });
    await expect(
      open(env, sealed, { product: "djdl", kind: "signing-key", id: "kid-2" }),
    ).rejects.toThrow();
    expect(await open(env, sealed, ctx)).toBe("value");
  });
});

describe("keyvault generateEd25519", () => {
  it("yields a PEM that signs a JWS verifiable under its raw public key", async () => {
    const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
    const kid = "kv-test-2026";
    const jws = await signJws({ hello: "world", n: 7 }, privatePkcs8Pem, kid);
    const verified = await verifyJws<{ hello: string; n: number }>(jws, {
      [kid]: publicRawB64url,
    });
    expect(verified).not.toBeNull();
    expect(verified!.kid).toBe(kid);
    expect(verified!.payload).toEqual({ hello: "world", n: 7 });
  });

  it("seals + opens its generated private PEM through the KEK", async () => {
    const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
    const reopened = await open(
      env,
      await seal(env, privatePkcs8Pem, ctx),
      ctx,
    );
    const jws = await signJws({ ok: true }, reopened, "k");
    expect(await verifyJws(jws, { k: publicRawB64url })).not.toBeNull();
  });
});
