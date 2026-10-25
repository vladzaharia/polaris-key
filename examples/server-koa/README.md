# Koa: gate a route with the app's licence

`polarisKey()` reads `X-PKey-License`, checks it offline and sets `ctx.state.polaris`. Install it above the router. The `require*` middleware refuse with a `401` or `403` `application/problem+json` body; a route without one stays open. Koa 2 and 3.

```sh
# .npmrc: @polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
npm install && npm start
```

| Route             | Needs                    |
| ----------------- | ------------------------ |
| `GET /health`     | nothing                  |
| `GET /api/export` | entitlement `export.pdf` |
| `GET /api/team`   | tier `pro` or `team`     |
| `POST /api/saves` | a signed-in account      |
| `GET /whoami`     | a valid licence          |

Replace `polaris.config.ts` with the file `pkey sdk --lang node --write` generates.

Unit tests need no network:

```ts
import { createTestKit } from "@polaris-key/server/testing";

const kit = await createTestKit({ product: "djdl" });
const app = createApp(kit.options());
const server = app.listen(0);
const headers = await kit.signedHeaders({
  entitlements: { "export.pdf": true },
});
// fetch the server's /api/export with headers
```
