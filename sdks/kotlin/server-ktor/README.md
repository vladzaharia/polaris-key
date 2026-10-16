# polaris-key-server-ktor

Gate a Ktor route with the app's signed licence document, verified offline
(`im.plrs.key:polaris-key-server-ktor`, over `im.plrs.key:polaris-key-server`).

```kotlin
install(Authentication) {
    polarisKey { products = listOf(PolarisProduct("acme", PolarisConfig.pinnedKeys)) }
}
routing {
    requireEntitlement("export.pdf") {
        get("/api/export") { call.respond(mapOf("tier" to call.principal<PolarisLicense>()!!.tier)) }
    }
}
```

- `requireLicense { }`, `requireEntitlement(name) { }` and `requireSignIn { }` wrap
  `authenticate(PolarisKey.AUTH)`; `RequireEntitlement` and `RequireSignIn` are the plugins for
  your own `authenticate`.
- A refusal is `application/problem+json`, `Cache-Control: no-store` and, on a 401, a
  `PKey-License` challenge. `onRefusal { call, problem -> }` replaces the response;
  `errors = ErrorMode.Throw` raises `PolarisKeyError` into StatusPages.
- `maxAgeSeconds` tightens the freshness window; `trustRefresh = false` runs on the pins alone.
- Nothing here logs the header, the JWS or the holder. List `X-PKey-License` for your APM's header
  scrubbing. The drop-in sets no CORS header; `BackendWire.POLARIS_REQUEST_HEADERS` is the list for
  your allow-list.
