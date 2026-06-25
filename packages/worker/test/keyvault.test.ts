import { describe, expect, it } from "vitest";
import { signJws, verifyJws } from "@polaris-key/jws";
import type { Env } from "../src/env.js";
import { generateEd25519, open, seal, type Sealed } from "../src/keyvault.js";
import { TEST_KEK } from "./seed.js";

const env = ({ PLATFORM_KEK: TEST_KEK } as unknown) as Env;

describe("keyvault seal/open", () => {
  it("round-trips a value (open(seal(x)) === x)", async () => {
    const plaintext = "-----BEGIN PRIVATE KEY-----\nhello world\n-----END PRIVATE KEY-----";
    const sealed = await seal(env, plaintext);
    expect(await open(env, sealed)).toBe(plaintext);
  });

  it("produces a fresh nonce per seal (same plaintext ⇒ different ciphertext)", async () => {
    const a = JSON.parse(await seal(env, "secret")) as Sealed;
    const b = JSON.parse(await seal(env, "secret")) as Sealed;
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("THROWS on a tampered ciphertext (auth-tag failure, never a partial value)", async () => {
    const sealed = JSON.parse(await seal(env, "top-secret")) as Sealed;
    // Flip the last base64url char of the ciphertext to corrupt the GCM auth tag.
    const last = sealed.ct.at(-1) === "A" ? "B" : "A";
    const tampered = JSON.stringify({ ...sealed, ct: sealed.ct.slice(0, -1) + last });
    await expect(open(env, tampered)).rejects.toThrow();
  });

  it("THROWS when the KEK is missing", async () => {
    await expect(seal({} as Env, "x")).rejects.toThrow();
    const sealed = await seal(env, "x");
    await expect(open({} as Env, sealed)).rejects.toThrow();
  });

  it("accepts a non-32-byte KEK by SHA-256'ing it to 32 bytes", async () => {
    const weird = ({ PLATFORM_KEK: btoa("short-kek") } as unknown) as Env;
    const sealed = await seal(weird, "value");
    expect(await open(weird, sealed)).toBe("value");
  });
});

describe("keyvault generateEd25519", () => {
  it("yields a PEM that signs a JWS verifiable under its raw public key", async () => {
    const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
    const kid = "kv-test-2026";
    const jws = await signJws({ hello: "world", n: 7 }, privatePkcs8Pem, kid);
    const verified = await verifyJws<{ hello: string; n: number }>(jws, { [kid]: publicRawB64url });
    expect(verified).not.toBeNull();
    expect(verified!.kid).toBe(kid);
    expect(verified!.payload).toEqual({ hello: "world", n: 7 });
  });

  it("seals + opens its generated private PEM through the KEK", async () => {
    const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
    const reopened = await open(env, await seal(env, privatePkcs8Pem));
    const jws = await signJws({ ok: true }, reopened, "k");
    expect(await verifyJws(jws, { k: publicRawB64url })).not.toBeNull();
  });
});
