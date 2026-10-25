# NestJS: gate a route with the app's licence

`PolarisKeyModule.register()` checks `X-PKey-License` offline. A `Require*` decorator on a route or controller refuses with a `401` or `403` `application/problem+json` body; a route without one stays open. Needs `experimentalDecorators`. Nest 10 and 11, on Express or Fastify.

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
const app = await createApp(kit.options());
await app.listen(0);
const headers = await kit.signedHeaders({
  entitlements: { "export.pdf": true },
});
// fetch the app's /api/export with headers
```
