# @polaris-key/server

Gate a server route with the app's signed licence document, verified offline, for developers whose app talks to their own backend. The root is a Fetch core, `createPolarisKey().authenticate(request)`, that runs on Node, Bun, Deno and Workers. `./express`, `./hono`, `./next`, `./fastify`, `./nestjs` and `./koa` are drop-ins over it, and `./testing` signs documents for your unit tests.

## Install

The `@polaris-key` scope is published only on Polaris Key's feed. Route the scope in `.npmrc`, then install:

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
npm install @polaris-key/server
```

See [Installing the SDKs from the feeds](https://key.plrs.im/docs/build/install/) for the other feeds. Express, Hono, Next, Fastify, NestJS and Koa are optional peers: install the one you use.

## Quick start

Write the config once with `pkey sdk --lang node --write`, then pick your framework. Every drop-in works the same way: install it once, then put a gate on the routes that need one. A route with no gate stays open.

### Express

```ts
import express from "express";
import {
  getPolarisLicense,
  polarisKey,
  requireEntitlement,
  requireTier,
} from "@polaris-key/server/express";
import { polarisConfig } from "./polaris.config";

const app = express();
app.use(polarisKey({ config: polarisConfig }));

app.get("/api/export", requireEntitlement("export.pdf"), (req, res) => {
  res.json({ tier: getPolarisLicense(req).tier });
});
app.get("/api/team", requireTier("pro", "team"), (_req, res) => void res.end());
```

`polarisKey()` sets `req.polaris` and never refuses. `getPolarisLicense(req)` is the license without a null check.

### Hono

```ts
import { Hono } from "hono";
import {
  polarisKey,
  requireEntitlement,
  type PolarisEnv,
} from "@polaris-key/server/hono";
import { polarisConfig } from "./polaris.config";

const app = new Hono<PolarisEnv>();
app.use("/api/*", polarisKey({ config: polarisConfig }));
app.get("/api/export", requireEntitlement("export.pdf"), (c) =>
  c.json({ tier: c.var.polaris.license.tier }),
);
export default app;
```

On Workers, pass `waitUntil: ctx.waitUntil.bind(ctx)` so the trust refresh outlives the response.

### Next.js route handlers

```ts
import { createNextPolarisKey } from "@polaris-key/server/next";
import { polarisConfig } from "./polaris.config";

export const polaris = createNextPolarisKey({ config: polarisConfig });

export const GET = polaris.requireEntitlement(
  "export.pdf",
  async (_req, { license }) => Response.json({ tier: license.tier }),
);
```

### Next.js middleware

```ts
import { createNextPolarisKey, requirement } from "@polaris-key/server/next";
import { polarisConfig } from "./polaris.config";

const polaris = createNextPolarisKey({ config: polarisConfig });

export const middleware = polaris.middleware([
  { path: "/api/pro/*", require: [requirement.tier("pro")] },
  { path: "/api/*" },
]);
export const config = { matcher: "/api/:path*" };
```

The first matching rule decides; a path no rule matches passes. The middleware can't hand the license to the route.

### Fastify, NestJS and Koa

```ts
import Fastify from "fastify";
import { polarisKey, requireEntitlement } from "@polaris-key/server/fastify";
import { polarisConfig } from "./polaris.config";

const app = Fastify();
await app.register(polarisKey, { config: polarisConfig });
app.get(
  "/api/export",
  { preHandler: requireEntitlement("export.pdf") },
  async () => ({ ok: true }),
);
```

Koa is `app.use(polarisKey({ config }))` with `requireEntitlement(...)` as route middleware, and the license in `ctx.state.polaris`. NestJS is `PolarisKeyModule.register({ config })` plus the `@RequireEntitlement(...)`, `@RequireTier(...)`, `@RequireLicense()`, `@RequireSignIn()` and `@RequireAll(...)` decorators, with `@GetPolarisLicense()` for the license. See [Gate a Node route](https://key.plrs.im/docs/features/licensing/server-node/).

### How it decides

The app sends its license document in `X-PKey-License`. The core decides it in the six steps of [WIRE-CONTRACT-V4 §14](https://github.com/vladzaharia/polaris-key/blob/main/docs/security/WIRE-CONTRACT-V4.md) against the product's pinned keys and the signed trust manifest, and answers a refusal as `application/problem+json`.

- The trust manifest refreshes every 900 s on a request, and an unknown `kid` fetches at most once a minute. A failed fetch keeps the last verified set and the pinned keys always verify.
- The trust fetch is claimed before it is awaited, so concurrent junk kids cost one request; the body read stops at 128 KiB and a credential header over 64 KiB is refused unsplit.
- Verified documents sit in an LRU of 1 000, keyed by the header's SHA-256, until their freshness deadline.
- No secret reaches a log line or a `toJSON`: the header, the JWS, the holder's name and email.
- `verifyLicenseDocument` lives here; it moved from `@polaris-key/node/server` in 0.9 with no alias.

## Gates

| Gate                          | Refuses unless                                       |
| ----------------------------- | ---------------------------------------------------- |
| `requireLicense()`            | the document is valid and fresh                      |
| `requireEntitlement(name, t)` | boolean entitlement `name` is granted, or `t(value)` |
| `requireTier(...tiers)`       | the `license.tier` entitlement is one of `tiers`     |
| `requireSignIn()`             | an account is signed in on the device                |
| `requireAll(...reqs)`         | every `requirement.*` holds, checked in order        |

In Next.js a gate wraps the handler and `requireTier` and `requireAll` take a list first. Each refusal carries the catalog's title and detail in the caller's `Accept-Language`.

| Code               | Status | Cause                                  |
| ------------------ | ------ | -------------------------------------- |
| `license_required` | 401    | No `X-PKey-License` header             |
| `license_invalid`  | 401    | Bad signature, wrong product or device |
| `license_stale`    | 401    | Past its window; the app must refresh  |
| `not_entitled`     | 403    | Missing entitlement or tier            |
| `sign_in_required` | 403    | No account signed in                   |

## Options

Every drop-in takes the core's options plus:

| Option         | Default     | Effect                                                                   |
| -------------- | ----------- | ------------------------------------------------------------------------ |
| `config`       | required    | The object `pkey sdk --lang node --write` writes, or an array of them    |
| `onRefusal`    | respond     | Answer a refusal yourself, in your shape or with another status          |
| `errors`       | `"respond"` | `"throw"` raises a `PolarisKeyError` into the framework's error handling |
| `preflight`    | `"pass"`    | A CORS preflight passes every gate; `"gate"` refuses it                  |
| `waitUntil`    | none        | Keeps the trust refresh alive after the response (Workers)               |
| `debug`        | none        | One line per verdict, no header or document; trust failures with reason  |
| `trustRefresh` | `true`      | `false` runs on the pinned keys alone                                    |

The drop-ins set no CORS headers: allow `X-PKey-License` and `X-PKey-Device` in your own. A passing response gets `Cache-Control: private` unless the route set one; streaming responses are unaffected.

Startup throws a `TypeError` that says what to fix when the config is missing, has no pins, has a pin that isn't a 43-character key, or has a `baseUrl` that isn't an origin.

## Testing a gated route

`@polaris-key/server/testing` signs documents with a throwaway key and fakes the trust manifest, so a test needs no network.

```ts
import { createTestKit } from "@polaris-key/server/testing";
import { polarisKey, requireEntitlement } from "@polaris-key/server/express";
import express from "express";

const kit = await createTestKit({ product: "acme" });
const app = express();
app.use(polarisKey(kit.options()));
app.get(
  "/api/export",
  requireEntitlement("export.pdf"),
  (_req, res) => void res.end(),
);

const ok = await kit.signedHeaders({ entitlements: { "export.pdf": true } });
const stale = await kit.headersFor("license_stale"); // each refusal code, or "ok"
kit.clock.advance(3600); // the kit's clock
const rotated = await kit.trust.addKey(); // a key only the fake manifest vouches for
kit.trust.offline = true; // the trust fetch fails like an unreachable Polaris Key
```

Never import it from production code.

## Before you start

The app needs a product registered in Polaris Key and an SDK that sends the licence document. See [Server verification](https://key.plrs.im/docs/features/licensing/server-verification/).

## Docs

- [Server verification](https://key.plrs.im/docs/features/licensing/server-verification/)
- [Installing the SDKs from the feeds](https://key.plrs.im/docs/build/install/)

## For agents

Read [AGENTS.md](https://github.com/vladzaharia/polaris-key/blob/main/AGENTS.md).

## Versions

The package carries the platform's version, in lockstep. It needs Node 22.13 or later, or any runtime with Ed25519 in Web Crypto: Bun, Deno and Workers.

## License

MIT
