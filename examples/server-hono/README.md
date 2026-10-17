# Hono: gate a route with the app's licence

`polarisKey()` reads `X-PKey-License`, checks it offline and sets `c.var.polaris`. The `require*`
middleware refuse with a `401` or `403` `application/problem+json` body; a route without one stays
open. The same app runs on Workers, Bun and Deno: export `createApp().fetch` instead of using
`@hono/node-server`. Workers allow no timers, so the 900 s trust refresh runs when a request
arrives; pass `waitUntil` to keep it alive after the response, or set `trustRefresh: false` to run
on the pinned keys alone.

```sh
# .npmrc: @polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
npm install && npm start
```

| Route             | Needs                    |
| ----------------- | ------------------------ |
| `GET /health`     | nothing                  |
| `GET /api/export` | entitlement `export.pdf` |
| `POST /api/saves` | a signed-in account      |
| `GET /whoami`     | a valid licence          |

Replace `polaris.config.ts` with the file `pkey sdk --lang node --write` generates.

Unit tests sign documents with a throwaway key:

```ts
import { createTestKit } from "@polaris-key/server/testing";

const kit = await createTestKit({ product: "djdl" });
const app = createApp(kit.config, { now: kit.clock.now, trustRefresh: false });
const jws = await kit.sign({ entitlements: { "export.pdf": true } });
const res = await app.request("/api/export", { headers: kit.headers(jws) });
```
