# @polaris-key/server

Gate a server route with the app's signed licence document, verified offline, for developers whose app talks to their own backend. The root is a Fetch core, `createPolarisKey().authenticate(request)`, that runs on Node, Bun, Deno and Workers. `./express`, `./hono` and `./next` are drop-ins over it, and `./testing` signs documents for your unit tests.

## Install

The `@polaris-key` scope is published only on Polaris Key's feed. Route the scope in `.npmrc`, then install:

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
npm install @polaris-key/server
```

See [Installing the SDKs from the feeds](https://key.plrs.im/docs/build/install/) for the other feeds. Express, Hono and Next are optional peers: install the one you use.

## Quick start

```ts
import { polarisKey, requireEntitlement } from "@polaris-key/server/express";

app.use(polarisKey({ config: polarisConfig }));
app.get("/api/export", requireEntitlement("export.pdf"), handler);
```

The app sends its licence document in `X-PKey-License`. The core decides it in the six steps of [WIRE-CONTRACT-V4 §14](https://github.com/vladzaharia/polaris-key/blob/main/docs/security/WIRE-CONTRACT-V4.md) against the product's pinned keys and the signed trust manifest, and answers a refusal as `application/problem+json`.

- The trust manifest refreshes every 900 s on a request, and an unknown `kid` fetches at most once a minute. A failed fetch keeps the last verified set and the pinned keys always verify.
- The trust fetch is claimed before it is awaited, so concurrent junk kids cost one request; the body read stops at 128 KiB and a credential header over 64 KiB is refused unsplit.
- Verified documents sit in an LRU of 1 000, keyed by the header's SHA-256, until their freshness deadline.
- No secret reaches a log line or a `toJSON`: the header, the JWS, the holder's name and email.
- `verifyLicenseDocument` lives here; it moved from `@polaris-key/node/server` in 0.9 with no alias.

## Before you start

The app needs a product registered in Polaris Key and an SDK that sends the licence document. See [Server verification](https://key.plrs.im/docs/features/licensing/server-verification/).

## Docs

- [Server verification](https://key.plrs.im/docs/features/licensing/server-verification/)
- [Installing the SDKs from the feeds](https://key.plrs.im/docs/build/install/)

## For agents

Read [AGENTS.md](https://github.com/vladzaharia/polaris-key/blob/main/AGENTS.md).

## Versions

The package carries the platform's version, in lockstep. It needs Node 18 or later.

## License

MIT
