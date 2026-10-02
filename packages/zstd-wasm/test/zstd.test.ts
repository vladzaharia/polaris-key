// @polaris-key/zstd-wasm through its Node entry (plans/P4-01.md §2.13, §9): the committed
// module is the recorded one, it decodes one frame and a `--patch-from` frame, and it refuses a
// window above 2^windowLogMax before decoding, which libzstd's one-shot decode alone would not.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ZstdWasmError,
  decode,
  decodeWithPrefix,
  version,
} from "../src/node.js";
import {
  PATCH_FRAME,
  TEXT,
  TEXT_FRAME,
  WINDOW_23_FRAME,
  base,
  target,
} from "./fixtures.js";

const wasm = readFileSync(new URL("../src/zdec.wasm", import.meta.url));

const codeOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ZstdWasmError);
    return (e as ZstdWasmError).code;
  }
  return "decoded";
};

describe("the committed zdec.wasm", () => {
  it("is the module whose SHA-256 build.sh recorded", () => {
    const recorded = readFileSync(
      new URL("../src/zdec.wasm.sha256", import.meta.url),
      "utf8",
    ).trim();
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(recorded);
  });
  it("imports nothing and exports only the decoder", () => {
    const m = new WebAssembly.Module(wasm);
    expect(WebAssembly.Module.imports(m)).toEqual([]);
    expect(
      WebAssembly.Module.exports(m)
        .map((e) => e.name)
        .sort(),
    ).toEqual(["memory", "zd_alloc", "zd_decode", "zd_version"]);
  });
  it("is libzstd 1.5.7", () => {
    expect(version()).toBe(10507);
  });
});

describe("decode", () => {
  it("decodes one frame to its declared size", () => {
    expect(decode(TEXT_FRAME, TEXT.length)).toEqual(TEXT);
  });
  it("refuses another size, trailing bytes, a skippable frame and a short header", () => {
    expect(codeOf(() => decode(TEXT_FRAME, TEXT.length + 1))).toBe("size");
    expect(
      codeOf(() => decode(new Uint8Array([...TEXT_FRAME, 0x00]), TEXT.length)),
    ).toBe("not-one-frame");
    expect(
      codeOf(() =>
        decode(new Uint8Array([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]), 0),
      ),
    ).toBe("header");
    expect(codeOf(() => decode(TEXT_FRAME.slice(0, 4), TEXT.length))).toBe(
      "header",
    );
    expect(codeOf(() => decode(TEXT_FRAME, -1))).toBe("argument");
  });
  it("refuses a frame without a content size", () => {
    // Descriptor 0x00: no content size, a Window_Descriptor 0x00, one raw block "hello".
    const f = new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x29, 0x00, 0x00, 0x68, 0x65, 0x6c,
      0x6c, 0x6f,
    ]);
    expect(codeOf(() => decode(f, 5))).toBe("size");
  });
  it("refuses a corrupt frame with a decode error", () => {
    const f = TEXT_FRAME.slice();
    f[f.length - 1]! ^= 0xff; // the checksum
    expect(codeOf(() => decode(f, TEXT.length))).toBe("decode");
  });
});

describe("decodeWithPrefix: the window check of plans/P4-01.md §2.7 rule 3", () => {
  it("applies a --patch-from frame over its base", () => {
    expect(decodeWithPrefix(PATCH_FRAME, base(), 20000, 15)).toEqual(target());
  });
  it("refuses that frame's 20,000-byte window at windowLogMax 14, before decoding", () => {
    expect(codeOf(() => decodeWithPrefix(PATCH_FRAME, base(), 20000, 14))).toBe(
      "window",
    );
  });
  it("accepts a hand-assembled 2^23 window at 23 and refuses it at 22", () => {
    const hello = new TextEncoder().encode("hello");
    expect(decodeWithPrefix(WINDOW_23_FRAME, new Uint8Array(0), 5, 23)).toEqual(
      hello,
    );
    expect(
      codeOf(() => decodeWithPrefix(WINDOW_23_FRAME, new Uint8Array(0), 5, 22)),
    ).toBe("window");
    // libzstd's one-shot decode alone accepts it: `decode` runs no window check.
    expect(decode(WINDOW_23_FRAME, 5)).toEqual(hello);
  });
  it("refuses a wrong base, another size and a limit outside 10..31", () => {
    const wrong = base();
    wrong[0]! ^= 1;
    expect(codeOf(() => decodeWithPrefix(PATCH_FRAME, wrong, 20000, 15))).toBe(
      "decode",
    );
    expect(codeOf(() => decodeWithPrefix(PATCH_FRAME, base(), 19999, 15))).toBe(
      "size",
    );
    expect(codeOf(() => decodeWithPrefix(PATCH_FRAME, base(), 20000, 9))).toBe(
      "argument",
    );
    expect(codeOf(() => decodeWithPrefix(PATCH_FRAME, base(), 20000, 32))).toBe(
      "argument",
    );
  });
  it("gives every call its own memory", () => {
    for (let i = 0; i < 50; i++)
      expect(decodeWithPrefix(PATCH_FRAME, base(), 20000, 15).length).toBe(
        20000,
      );
  });
});

// P4-04 (plans/P4-01.md §8.4): the same window check over the content corpus's real
// `zstd --patch-from` frame, v1 → v2. Its window is its content size, 5,256,232 bytes, above
// 2^22 and at most 2^23: refused at 22 before a byte is decoded, decoded to v2 at 23.
describe("decodeWithPrefix over content/blobs/deltas/v1-v2.pf.zst", () => {
  const content = new URL(
    "../../../conformance/corpus/v2/content/",
    import.meta.url,
  );
  const cases = JSON.parse(
    readFileSync(new URL("cases.json", content), "utf8"),
  ) as {
    payloads: Record<"v1" | "v2", { size: number; sha256: string }>;
  };
  const blob = (name: string): Uint8Array =>
    new Uint8Array(readFileSync(new URL(`blobs/${name}`, content)));
  const { v1, v2 } = cases.payloads;
  const frame = blob("deltas/v1-v2.pf.zst");
  const sha = (b: Uint8Array): string =>
    createHash("sha256").update(b).digest("hex");

  it("refuses the frame at windowLogMax 22 and decodes it to v2 at 23", () => {
    const base = decode(blob("payload/v1.full.zst"), v1.size);
    expect(sha(base)).toBe(v1.sha256);
    expect(codeOf(() => decodeWithPrefix(frame, base, v2.size, 22))).toBe(
      "window",
    );
    const out = decodeWithPrefix(frame, base, v2.size, 23);
    expect(out.length).toBe(v2.size);
    expect(sha(out)).toBe(v2.sha256);
  });
});
