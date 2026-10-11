# @polaris-key/zstd-wasm

libzstd 1.5.7 compiled to wasm32: a one-frame decoder (optionally over a raw-content prefix, window-checked before decoding) and, under `./encoder`, the lazy-delta `--patch-from` encoder, for code that applies or produces pack deltas.

## Install

The `@polaris-key` scope is published only on Polaris Key's own feed. Route the scope in `.npmrc`, then install:

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
npm install @polaris-key/zstd-wasm
```

Yarn, Bun and private feeds are on [Install](https://key.plrs.im/docs/build/install/).

## Quick start

`decode` takes one zstd frame and its declared content size. `decodeWithPrefix` takes a `--patch-from` frame, the base it was made against, the target size and the largest window log to accept; it refuses a larger window before decoding.

```ts
import {
  decode,
  decodeWithPrefix,
  ZstdWasmError,
} from "@polaris-key/zstd-wasm";

declare const frame: Uint8Array; // one zstd frame
declare const patch: Uint8Array; // one `zstd --patch-from` frame
declare const base: Uint8Array; // the bytes the patch was made against

const plain = decode(frame, 1024); // content size declared in the frame

try {
  const target = decodeWithPrefix(patch, base, 4096, 27);
  console.log(plain.byteLength, target.byteLength);
} catch (e) {
  if (e instanceof ZstdWasmError)
    console.error(e.code); // "window", "size", "header", ...
  else throw e;
}
```

Entries:

| Import                                           | Contents                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `@polaris-key/zstd-wasm`                         | `decode`, `decodeWithPrefix`, `version`, `ZstdWasmError`. The `workerd` condition loads the module for Cloudflare Workers, `node` for Node. |
| `@polaris-key/zstd-wasm/browser`                 | `loadZstdWasm()`: async, compiles the module once and returns the same decoder.                                                             |
| `@polaris-key/zstd-wasm/core`                    | `createZstdWasm(module)` over a `WebAssembly.Module` you provide.                                                                           |
| `@polaris-key/zstd-wasm/encoder`                 | `patchFrom`, `encoderVersion`, `ZstdEncodeError`, `wasmWindowLogMax`: one verified `--patch-from` frame at levels 1 to 15.                  |
| `@polaris-key/zstd-wasm/zdec.wasm`, `/zenc.wasm` | The compiled modules, for a host that bundles them itself.                                                                                  |

## Before you start

Most apps never import this package. The SDKs apply pack deltas for you.

- [SDKs](https://key.plrs.im/docs/build/sdks/)
- [Packs](https://key.plrs.im/docs/features/ship-builds/packs/): how packs, deltas and the delivery gate work.

Depend on it directly to apply or build deltas outside an SDK. The Worker (lazy delta encode), the CLI, `@polaris-key/client-core` and the Node and React SDKs do.

### Rebuild the modules

The `.wasm` files in `src/` are committed, built from zstd 1.5.7's `lib/common`, `lib/decompress` (and `lib/compress` for the encoder) with no libc and no emscripten. The build script downloads the zstd 1.5.7 source and checks its SHA-256. It needs a clang with the WebAssembly target and `wasm-ld`:

```sh
packages/zstd-wasm/wasm/build.sh        # src/zdec.wasm, the decoder
packages/zstd-wasm/wasm/build.sh enc    # src/zenc.wasm, the encoder
```

`ZSTD_SRC`, `CC` and `WASM_LD` override the source tree and tools. The script writes each module's SHA-256 to `src/*.wasm.sha256`, and the package tests check each module against it, so a rebuild is a reviewed change to both files. Another compiler or linker builds a working but different module.

## Docs

- [Packs](https://key.plrs.im/docs/features/ship-builds/packs/)
- [Pack protocol](https://key.plrs.im/docs/reference/protocol/packs/): the delta rules the decoder enforces.
- [SDKs](https://key.plrs.im/docs/build/sdks/)

## For agents

- [`AGENTS.md`](https://github.com/vladzaharia/polaris-key/blob/main/AGENTS.md): conventions and commands for working in the repository.
- [This package's source and README](https://github.com/vladzaharia/polaris-key/tree/main/packages/zstd-wasm#readme).

## Versions

Every `@polaris-key/*` package publishes at the platform's version, in lockstep with the server. Builds target Node >=22. The package is ESM only and runs in Node, Cloudflare Workers and browsers; a decode is limited to 2 GiB of output.

## License

`MIT AND BSD-3-Clause`. The wrapper code is MIT ([`LICENSE-MIT`](https://github.com/vladzaharia/polaris-key/blob/main/packages/zstd-wasm/LICENSE-MIT)); the compiled modules are built from Zstandard 1.5.7 and covered by its BSD license ([`LICENSE`](https://github.com/vladzaharia/polaris-key/blob/main/packages/zstd-wasm/LICENSE)).
