# Express: gate a route with the app's licence

`polarisKey()` reads `X-PKey-License`, checks it offline and sets `req.polaris`. The `require*`
middleware refuse with a `401` or `403` `application/problem+json` body; a route without one stays
open.

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

Your browser app needs `X-PKey-License` and `X-PKey-Device` in its CORS allow-list; import
`POLARIS_REQUEST_HEADERS` for it. The drop-in sets no CORS header.

Unit tests sign documents with a throwaway key:

```ts
import { createTestKit } from "@polaris-key/server/testing";

const kit = await createTestKit({ product: "djdl" });
const app = createApp(kit.config, { now: kit.clock.now, trustRefresh: false });
const jws = await kit.sign({ entitlements: { "export.pdf": true } });
// send kit.headers(jws) with the request
```
