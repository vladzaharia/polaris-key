// English's second copy table loads on demand (screens after a network answer). The suite provides
// the whole table, so a test sees every string on its first render.
import { KIT_COPY_EN } from "@polaris-key/brand/kit-copy";
import { provideTable } from "../src/copy.js";

provideTable("en", KIT_COPY_EN);

// jsdom's cross-realm typed arrays make WebCrypto's Ed25519 `importKey` and `verify` reject
// every key and signature, so a jsdom test could never load a signed document. Hand them
// Node-realm copies of their inputs.
if (typeof window !== "undefined" && typeof Buffer !== "undefined") {
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
