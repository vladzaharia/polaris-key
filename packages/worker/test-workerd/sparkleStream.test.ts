/// <reference types="@cloudflare/workers-types" />
// ── Streaming Sparkle verification on workerd (P0-10) ─────────────────────────────────────
//
// `streamingEd25519Verify` hashes the DMG with `node:crypto`'s incremental SHA-512 and does the
// point arithmetic with `@noble/curves`. The Node lane proves both work in Node; this proves
// they work in the runtime that ships: `node:crypto` here is workerd's `nodejs_compat`
// implementation, not Node's, and a streamed `Response` body is workerd's own stream.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { streamingEd25519Verify } from "../src/services/release/ed25519Stream.js";
import { verifySparkleSignature } from "../src/services/release/sparkle.js";

const MiB = 1024 * 1024;
const CHUNK = 64 * 1024;

/** A deterministic `total`-byte body, served one fresh `CHUNK` at a time on demand. */
function body(total: number): ReadableStream<Uint8Array> {
  let produced = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (produced >= total) {
          controller.close();
          return;
        }
        const n = Math.min(CHUNK, total - produced);
        const chunk = new Uint8Array(n);
        for (let i = 0; i < n; i++) chunk[i] = (produced + i) * 13 + 5;
        produced += n;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
}

async function materialise(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const b64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

async function signed(
  total: number,
): Promise<{ pub: Uint8Array; sig: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      pair.privateKey,
      await materialise(body(total)),
    ),
  );
  return { pub, sig };
}

describe("streaming Ed25519 verification on workerd", () => {
  it("verifies a WebCrypto signature over a streamed 8 MiB body and refuses a tampered one", async () => {
    const { pub, sig } = await signed(8 * MiB);
    expect(
      await streamingEd25519Verify(pub, sig, body(8 * MiB), 16 * MiB),
    ).toBe(true);
    const tampered = sig.slice();
    tampered[40]! ^= 1;
    expect(
      await streamingEd25519Verify(pub, tampered, body(8 * MiB), 16 * MiB),
    ).toBe(false);
    // One byte short of the signed body is a different message.
    expect(
      await streamingEd25519Verify(pub, sig, body(8 * MiB - 1), 16 * MiB),
    ).toBe(false);
  });

  it("returns false past the cap without throwing", async () => {
    const { pub, sig } = await signed(2 * MiB);
    await expect(
      streamingEd25519Verify(pub, sig, body(2 * MiB), MiB),
    ).resolves.toBe(false);
  });

  it("verifySparkleSignature streams a GitHub-shaped response and memoises in real KV", async () => {
    const total = 4 * MiB;
    const { pub, sig } = await signed(total);
    let fetches = 0;
    const input = {
      token: "t",
      owner: "o",
      repo: "r",
      assetId: 4242,
      signature: b64(sig),
      publicKey: b64(pub),
      fetchImpl: async (url: string) => {
        fetches++;
        if (url !== "https://api.github.com/repos/o/r/releases/assets/4242") {
          return new Response("not found", { status: 404 });
        }
        // No Content-Length: the cap and the hash both run while streaming.
        return new Response(body(total));
      },
    };
    expect(await verifySparkleSignature(env, "workerd-sparkle", input)).toBe(
      true,
    );
    expect(await verifySparkleSignature(env, "workerd-sparkle", input)).toBe(
      true,
    );
    expect(fetches).toBe(1);
    // Over the cap: false, not a throw, and nothing memoised under the new asset id.
    expect(
      await verifySparkleSignature(env, "workerd-sparkle", {
        ...input,
        assetId: 4243,
        maxBytes: MiB,
        fetchImpl: async () => new Response(body(total)),
      }),
    ).toBe(false);

    // A final negative (the body read to the end, the signature over other bytes) is memoised
    // too, so a failing release does not re-download the DMG on every appcast miss.
    let badFetches = 0;
    const bad = {
      ...input,
      assetId: 4244,
      fetchImpl: async () => {
        badFetches++;
        return new Response(body(total - 1));
      },
    };
    expect(await verifySparkleSignature(env, "workerd-sparkle", bad)).toBe(
      false,
    );
    expect(await verifySparkleSignature(env, "workerd-sparkle", bad)).toBe(
      false,
    );
    expect(badFetches).toBe(1);
  });
});
