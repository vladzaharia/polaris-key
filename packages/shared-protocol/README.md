# @polaris-key/protocol

The Polaris Key wire types and constants: request, response and document shapes for every service, for code that builds a client, a server or tooling on the wire contract.

## Install

The `@polaris-key` scope is published only on Polaris Key's own feed. Route the scope in `.npmrc`, then install:

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
npm install @polaris-key/protocol
```

Yarn, Bun and private feeds are on [Install](https://key.plrs.im/docs/build/install/).

## Quick start

Import from the service subpath you need. The package has no runtime logic: types, plus the frozen constants (`ISSUER`, `PROTOCOL_VERSION`, the `HEADER_*` names, limits).

```ts
import { ISSUER, PROTOCOL_VERSION } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";

// A verified license document is for this product when its issuer and audience match.
export function isFor(doc: LicenseDoc, product: string): boolean {
  return doc.iss === ISSUER && doc.aud === product;
}

console.log(`wire protocol v${PROTOCOL_VERSION}`);
```

Subpaths: `core`, `license`, `config`, `release`, `update`, `trust`, `distribution`, `packs`, `identity`. The package root re-exports `core`'s values, so an import from the root and from `/core` always agree.

## Before you start

To add Polaris Key to an app, use an SDK, not this package. The SDKs verify the signed documents and expose these shapes for you.

- [SDKs](https://key.plrs.im/docs/build/sdks/): one page per language.
- [`@polaris-key/node`](https://github.com/vladzaharia/polaris-key/tree/main/packages/sdk-node#readme) and [`@polaris-key/react`](https://github.com/vladzaharia/polaris-key/tree/main/packages/sdk-react#readme) for JavaScript.

Depend on this package directly when you implement the wire contract yourself: the Worker, `@polaris-key/client-core`, the SDKs and the CLI do. The byte-level rules are in the [wire contract](https://github.com/vladzaharia/polaris-key/blob/main/docs/security/WIRE-CONTRACT-V4.md).

## Docs

- [Protocol reference](https://key.plrs.im/docs/reference/protocol/): every document and its fields.
- [Envelope](https://key.plrs.im/docs/reference/protocol/envelope/): the signed JWS that carries each document.
- [Errors](https://key.plrs.im/docs/reference/protocol/errors/)
- [SDKs](https://key.plrs.im/docs/build/sdks/)

## For agents

- [`AGENTS.md`](https://github.com/vladzaharia/polaris-key/blob/main/AGENTS.md): conventions and commands for working in the repository.
- [This package's source and README](https://github.com/vladzaharia/polaris-key/tree/main/packages/shared-protocol#readme).

## Versions

Every `@polaris-key/*` package publishes at the platform's version, in lockstep with the server. Builds target Node >=22; the package is ESM only.

## License

MIT.
