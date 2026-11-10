// The kit loads the QR encoder and the settings, device and account rows on demand (src/kit/lazy.ts).
// The suite loads them first, as a host that awaits `preloadKitParts()` would, so a test sees a
// screen whole on its first render.
import { preloadKitParts } from "@polaris-key/react/kit";
import { preloadParts } from "../src/kit/lazy.js";

await Promise.all([preloadKitParts(), preloadParts()]);

// English's second copy table loads on demand too (screens after a network answer); the suite
// provides the whole table, so a test sees every string on its first render.
import { provideKitCopy } from "@polaris-key/react/kit";
import {
  KIT_COPY_EN_LEAN,
  loadKitCopyEnRest,
} from "@polaris-key/brand/kit-copy/lean";

import { provideTable } from "../src/kit/contract.js";

const fullEn = { ...KIT_COPY_EN_LEAN, ...(await loadKitCopyEnRest()) };
provideKitCopy("en", fullEn);
// The built kit and the source modules keep separate tables: a test that draws a component through
// the source (`kitComponent`, as the matrix does for NearbyApproval) needs its own copy.
provideTable("en", fullEn);

// jsdom's cross-realm typed arrays make WebCrypto's Ed25519 `importKey` and `verify` reject
// every key and signature, so a jsdom test could never load a signed document. Hand them
// Node-realm copies of their inputs.
if (typeof window !== "undefined") {
  const NodeU8 = Object.getPrototypeOf(Buffer) as Uint8ArrayConstructor;
  const realm = <T>(d: T): T =>
    ArrayBuffer.isView(d) || d instanceof ArrayBuffer
      ? (NodeU8.from(
          ArrayBuffer.isView(d)
            ? new Uint8Array(
                d.buffer as ArrayBuffer,
                d.byteOffset,
                d.byteLength,
              )
            : new Uint8Array(d),
        ) as unknown as T)
      : d;
  const subtle = globalThis.crypto.subtle;
  for (const [name, at] of [
    ["verify", [2, 3]],
    ["importKey", [1]],
  ] as const) {
    const orig = (
      subtle as unknown as Record<string, (...a: unknown[]) => unknown>
    )[name]!.bind(subtle);
    Object.defineProperty(subtle, name, {
      configurable: true,
      value: (...args: unknown[]) =>
        orig(
          ...args.map((a, i) =>
            (at as readonly number[]).includes(i) ? realm(a) : a,
          ),
        ),
    });
  }
}
