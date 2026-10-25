# Fastify: gate a route with the app's licence

`polarisKey` is a plugin: it reads `X-PKey-License`, checks it offline and sets `req.polaris`. Each `require*` hook is a `preHandler` that refuses with a `401` or `403` `application/problem+json` body; a route without one stays open. Fastify 4 and 5.

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
const headers = await kit.signedHeaders({
  entitlements: { "export.pdf": true },
});
const res = await app.inject({ url: "/api/export", headers });
```
