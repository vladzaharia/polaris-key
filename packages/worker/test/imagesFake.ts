/// <reference types="@cloudflare/workers-types" />
/**
 * PX-W16: a stand-in for the Cloudflare Images binding (`env.IMAGES`).
 *
 * It decodes nothing. `input()` reads the source and refuses anything that is not a PNG, JPEG,
 * WebP or GIF by magic number (the real binding's error 9412); `output()` answers a tiny image of
 * the asked type whose bytes carry the asked size, so a test can tell the renditions apart. Every
 * transformation is recorded.
 */

export interface ImagesCall {
  width: number | undefined;
  height: number | undefined;
  fit: string | undefined;
  format: string;
  anim: boolean | undefined;
}

export interface FakeImages {
  binding: ImagesBinding;
  calls: ImagesCall[];
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isImage(b: Uint8Array): boolean {
  const at = (i: number, ...sig: number[]) =>
    sig.every((v, k) => b[i + k] === v);
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...b.subarray(from, to));
  return (
    at(0, ...PNG_SIG) ||
    at(0, 0xff, 0xd8, 0xff) ||
    (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") ||
    ascii(0, 4) === "GIF8"
  );
}

/** The fake's output: the format's magic number, then the size. */
export function fakeRendition(format: string, size: number): Uint8Array {
  const tag = new TextEncoder().encode(`fake-${size}`);
  if (format === "image/png")
    return new Uint8Array([...PNG_SIG, 0, 0, 0, 13, ...tag]);
  // RIFF....WEBPVP8 , the length bytes left at zero.
  return new Uint8Array([
    ...new TextEncoder().encode("RIFF"),
    0,
    0,
    0,
    0,
    ...new TextEncoder().encode("WEBPVP8 "),
    ...tag,
  ]);
}

class ImagesError extends Error {
  constructor(readonly code: number) {
    super(`IMAGES_TRANSFORM_ERROR ${code}`);
  }
}

export function fakeImages(
  opts: {
    /** Answer this instead of a fake rendition (to test what the caller accepts). */
    output?: (format: string, size: number) => Uint8Array;
  } = {},
): FakeImages {
  const calls: ImagesCall[] = [];
  const binding = {
    info: async () => ({ format: "image/png", width: 1, height: 1 }),
    input(stream: ReadableStream<Uint8Array>) {
      const source = new Response(stream).arrayBuffer();
      const transforms: ImageTransform[] = [];
      const handle = {
        transform(t: ImageTransform) {
          transforms.push(t);
          return handle;
        },
        draw() {
          return handle;
        },
        async output(o: ImageOutputOptions) {
          const bytes = new Uint8Array(await source);
          if (!isImage(bytes)) throw new ImagesError(9412);
          const t = Object.assign({}, ...transforms) as ImageTransform;
          calls.push({
            width: t.width,
            height: t.height,
            fit: t.fit,
            format: o.format,
            anim: o.anim,
          });
          const out = (opts.output ?? fakeRendition)(o.format, t.width ?? 0);
          return {
            response: () => new Response(out),
            contentType: () => o.format,
            image: () => new Response(out).body!,
          };
        },
      };
      return handle;
    },
  };
  return { binding: binding as unknown as ImagesBinding, calls };
}
