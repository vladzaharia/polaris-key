# hosted-assets (S-20)

The reference puller for [S-20](../../notes/S-20-hosted-assets.md). It covers the URL guard
(§6.3), manual redirects, the byte cap, the magic-number sniff and the SHA-256 check. HA-01
ports these steps to the Worker as `core/safeFetch.ts` and `core/hostedAssets.ts`. Requires
Node 22 and has no dependencies. It writes nothing to disk.

```sh
mise exec node@22 -- node pull.mjs --self-test
mise exec node@22 -- node pull.mjs <https-url> [--cap <bytes>] [--sha256 <hex>] [--kind image|file]
```

Each pull prints one JSON line with these fields:

- `final`: the final host.
- `hops`: the redirect hops.
- `sniffedType` and `declaredType`: the type sniffed from the bytes, and the type the server sent.
- `bytes`: the size.
- `sha256`: the digest.
- `ms`: the elapsed time.
- `verdict`: `ok` or `refused:<reason>`.

S-20 §5 records the measured runs. The guard table in `--self-test` is the acceptance table
for HA-01's `safeFetch` unit test. The two must not drift apart.
