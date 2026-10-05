/**
 * Image decode and encode for `pkey listing assets`, through `sharp` (A-18d). Only here: the
 * pixels in between are `raster.ts`'s, in integer arithmetic, so the golden hashes hold on every
 * platform. Decoding is lossless for PNG; an encoded PNG decodes back to exactly the hashed
 * pixels, a JPEG (Steam's community icon) only approximately, which is why the hash is taken
 * before encoding.
 *
 * The one step that is not integer-only is `toColourspace("srgb")` in `decodeImage`: an input with
 * an embedded non-sRGB ICC profile goes through libvips/lcms float conversion first, so its
 * pixels (and the hashes after them) are not guaranteed identical across architectures. Plain
 * sRGB inputs, like the fixtures, are untouched by it. The docs ask for sRGB masters.
 *
 * `sharp` is loaded on first use, not at import: the rest of `pkey` (and the standalone bundle,
 * which leaves `sharp` external) runs where no native image library is installed.
 */

import type { Raster } from "./raster.js";
import { channels } from "./raster.js";
import type { Format } from "./specs.js";

/** The largest side the listing model stores (`dist_listing_assets` width and height). */
export const MAX_SIDE = 16384;

type SharpModule = (typeof import("sharp"))["default"];
let loaded: Promise<SharpModule> | null = null;

/** The `sharp` module, or a clear error when it is not installed. */
export async function loadSharp(): Promise<SharpModule> {
  loaded ??= import("sharp")
    .then((m) => m.default)
    .catch((e: unknown) => {
      loaded = null;
      throw new Error(
        `pkey listing assets needs the sharp image library (${(e as Error).message}). ` +
          "Install it beside pkey: npm install sharp",
      );
    });
  return loaded;
}

export interface Decoded {
  raster: Raster;
  /** The input had an alpha channel. */
  alpha: boolean;
  format: string;
}

/** A file's pixels, auto-oriented, in sRGB, as 8-bit RGBA. */
export async function decodeImage(
  bytes: Uint8Array,
  what: string,
): Promise<Decoded> {
  const sharp = await loadSharp();
  let meta: import("sharp").Metadata;
  try {
    meta = await sharp(bytes, { failOn: "error" }).metadata();
  } catch (e) {
    throw new Error(
      `${what} is not an image sharp can read (${(e as Error).message}).`,
    );
  }
  if (!meta.width || !meta.height)
    throw new Error(`${what} has no pixel dimensions.`);
  if (meta.width > MAX_SIDE || meta.height > MAX_SIDE)
    throw new Error(
      `${what} is ${meta.width}x${meta.height}; at most ${MAX_SIDE} px a side.`,
    );
  const { data, info } = await sharp(bytes, { failOn: "error" })
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4)
    throw new Error(`${what} decoded to ${info.channels} channels, not RGBA.`);
  return {
    raster: {
      width: info.width,
      height: info.height,
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    },
    alpha: meta.hasAlpha === true,
    format: meta.format ?? "unknown",
  };
}

/** The encoded bytes of `raster` (RGB when `alpha` is false: flatten first). */
export async function encodeImage(
  raster: Raster,
  format: Format,
  alpha: boolean,
): Promise<Buffer> {
  const sharp = await loadSharp();
  const n = alpha ? 4 : 3;
  const img = sharp(Buffer.from(channels(raster, n)), {
    raw: { width: raster.width, height: raster.height, channels: n },
  });
  return format === "jpeg"
    ? img
        .jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: false })
        .toBuffer()
    : img.png({ compressionLevel: 9, palette: false }).toBuffer();
}

/** Encode a fixture or a test input: lossless PNG of the RGBA pixels. */
export async function encodePng(raster: Raster): Promise<Buffer> {
  return encodeImage(raster, "png", true);
}
