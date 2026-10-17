# Next.js: gate a route handler with the app's licence

App Router route handlers, header-only: the credential is `X-PKey-License`, never a cookie.
`polaris.requireEntitlement(name, handler)` wraps a handler; a refusal is a `401` or `403`
`application/problem+json` response and the handler never runs. To decide inside a handler:

```ts
export async function POST(req: Request) {
  const auth = await polaris.auth(req);
  if (!auth.license) return polaris.refuse(auth.problem!, req);
}
```

```sh
# .npmrc: @polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
npm install && npm run build && npm start
```

| Route             | Needs                    |
| ----------------- | ------------------------ |
| `GET /api/health` | nothing                  |
| `GET /api/export` | entitlement `export.pdf` |
| `POST /api/saves` | a signed-in account      |
| `GET /api/whoami` | a valid licence          |

Replace `polaris.config.ts` with the file `pkey sdk --lang node --write` generates. Run the
handlers in a unit test by calling them with a `Request` and signing documents with
`createTestKit()` from `@polaris-key/server/testing`.
