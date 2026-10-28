// Byte helpers the relay uses (no Buffer in a browser).

export const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function b64urlEncode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `n` random bytes from the platform's CSPRNG. */
export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** A random 32-bit unsigned integer. */
export function randomUint32(): number {
  return new DataView(randomBytes(4).buffer).getUint32(0, false);
}
