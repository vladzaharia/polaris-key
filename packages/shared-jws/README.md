# @polaris-key/jws

The frozen EdDSA (Ed25519) compact-JWS encoder and strict verifier that every signed Polaris Key document uses, for code that signs or verifies those documents itself.

## Install

The `@polaris-key` scope is published only on Polaris Key's own feed. Route the scope in `.npmrc`, then install:

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
npm install @polaris-key/jws
```

Yarn, Bun and private feeds are on [Install](https://key.plrs.im/docs/build/install/).

## Quick start

`signJws` signs a payload with a PKCS#8 PEM key and a `kid`. `verifyJws` checks a compact JWS against a trust set (`kid` to raw 32-byte public key, base64url) and returns `{ kid, payload, nonWireIntegers }`, or `null` on any failure.

```ts
import { signJws, verifyJws } from "@polaris-key/jws";

const pem = process.env.SIGNING_KEY_PEM!; // Ed25519 PKCS#8
const trust = { "key-1": process.env.PUBLIC_KEY_B64URL! };

const jws = await signJws(
  { iss: "key.plrs.im", aud: "demo" },
  pem,
  "key-1",
  "pkey-config+jws",
);

const verified = await verifyJws<{ iss: string; aud: string }>(jws, trust, {
  typ: "pkey-config+jws",
});
if (!verified) throw new Error("rejected");
console.log(verified.kid, verified.payload.aud);
```

Pass `typ` on every verify: a header with a different `typ`, or none, is refused. Also exported: `importSigningKey`, `importVerifyKey`, `sha256Base64Url`, `base64UrlEncodeBytes`, `base64UrlDecode`, `scanStrictJson`, `StrictJsonError` and the strictness helpers (`isCanonicalB64url`, `hasDuplicateKeys`, `isNonWireIntegerToken`, `numberTokenInRange`, `ed25519Prechecks`).

## Before you start

To add Polaris Key to an app, use an SDK. The SDKs verify every document with this code, through `@polaris-key/client-core`.

- [SDKs](https://key.plrs.im/docs/build/sdks/): one page per language.
- [`@polaris-key/node`](https://github.com/vladzaharia/polaris-key/tree/main/packages/sdk-node#readme) and [`@polaris-key/react`](https://github.com/vladzaharia/polaris-key/tree/main/packages/sdk-react#readme) for JavaScript.

Depend on this package directly when you sign or verify Polaris Key documents without an SDK. The Worker signs with it; the CLI, `@polaris-key/client-core` and the Node and React SDKs depend on it.

Strictness is part of the contract. `verifyJws` rejects, before any signature check: a non-canonical base64url segment, a duplicate JSON key, ill-formed UTF-8, a header or payload over its size cap, an `alg` other than `EdDSA`, and small-order Ed25519 points. `signJws` throws `StrictJsonError` rather than emit a document a strict verifier would refuse.

## Docs

- [Envelope](https://key.plrs.im/docs/reference/protocol/envelope/): the JWS format, `typ` values and the rules above.
- [Protocol reference](https://key.plrs.im/docs/reference/protocol/)
- [Trust](https://key.plrs.im/docs/reference/protocol/trust/): the trust sets `verifyJws` takes.
- [SDKs](https://key.plrs.im/docs/build/sdks/)

## For agents

- [`AGENTS.md`](https://github.com/vladzaharia/polaris-key/blob/main/AGENTS.md): conventions and commands for working in the repository.
- [This package's source and README](https://github.com/vladzaharia/polaris-key/tree/main/packages/shared-jws#readme).

## Versions

Every `@polaris-key/*` package publishes at the platform's version, in lockstep with the server. Builds target Node >=22. The package is ESM only and uses WebCrypto (`crypto.subtle` with Ed25519), so it also runs in Cloudflare Workers and browsers that support Ed25519.

## License

MIT.
