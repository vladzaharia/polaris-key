# polaris-key-server-ktor

Gate a Ktor route with the app's signed license document, verified offline
(`im.plrs.key:polaris-key-server-ktor`, over `im.plrs.key:polaris-key-server`). The full guide, with
tiers, refusals and tests, is [Gate a Kotlin route with the license](https://key.plrs.im/docs/features/licensing/server-kotlin/).

```kotlin
install(Authentication) {
    polarisKey { product(PolarisConfig.PRODUCT_SLUG, PolarisConfig.pinnedKeys, PolarisConfig.BASE_URL) }
}
routing {
    get("/health") { call.respondText("ok") }                      // no gate: open
    requireEntitlement("export.pdf") {
        get("/api/export") { call.respondText(call.requirePolarisLicense().tier ?: "none") }
    }
    requireTier("pro", "team") { get("/api/team") { call.respondText("team") } }
    requireAll(Require.signIn(), Require.tier("pro")) { get("/api/me/pro") { call.respondText("pro") } }
}
```

- `requireLicense { }`, `requireEntitlement(name) { }` (or `requireEntitlement(name, test = { value -> … }) { }`
  for a valued one), `requireTier(vararg) { }`, `requireSignIn { }` and `requireAll(vararg) { }` wrap
  `authenticate(PolarisKey.AUTH)`; `RequireEntitlement`, `RequireTier`, `RequireSignIn` and `RequireAll` are
  the plugins for your own `authenticate`. `Require.entitlement/tier/signIn` build the requirements.
- `call.requirePolarisLicense()` is the license without a null check and throws on an ungated route;
  `call.polarisLicense` and `call.polarisAuth` are the nullable forms.
- A refusal is `application/problem+json`, `Cache-Control: no-store` and, on a 401, a `PKey-License`
  challenge; the default statuses stay 401 and 403. `onRefusal { call, problem -> }` replaces the response
  (`call.respondProblem(problem, status)` keeps the localized body and changes the status);
  `errors = ErrorMode.Throw` raises `PolarisKeyError` into StatusPages.
- A CORS preflight (`OPTIONS` with `Access-Control-Request-Method`) passes every gate;
  `preflight = PreflightMode.Gate` refuses it. A gated response without a `Cache-Control` is sent
  `private`, streamed ones included.
- Bad configuration (no product, no pin, a malformed pin, a base URL that is not https) raises
  `IllegalArgumentException` at startup and names `pkey sdk --lang kotlin --write`.
- `debug = logger::debug` reports each verdict's step, key id and a short device hash, and why a trust fetch
  failed (the pinned keys keep verifying). `maxAgeSeconds` tightens the freshness window;
  `trustRefresh = false` runs on the pins alone.
- Tests: `useTestKit(PolarisTestKit(product = "acme"))` in `polarisKey { }` signs with a throwaway key; see
  `server/README.md`.
- Nothing here logs the header, the JWS or the holder. List `X-PKey-License` for your APM's header
  scrubbing. The drop-in sets no CORS header; `BackendWire.POLARIS_REQUEST_HEADERS` is the list for your
  allow-list.
