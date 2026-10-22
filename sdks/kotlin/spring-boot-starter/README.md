# polaris-key-spring-boot-starter

Gate a Spring MVC route with the app's signed license document, verified offline
(`im.plrs.key:polaris-key-spring-boot-starter`, over `im.plrs.key:polaris-key-server`, on Spring
Boot 3.5 / Spring Security 6.5). The full guide, with refusals and tests, is
[Gate a Kotlin route with the license](https://key.plrs.im/docs/features/licensing/server-kotlin/#spring-boot).

```properties
polaris-key.product=acme
polaris-key.pinned-keys.pkey-2026=<43-character public key>
```

```kotlin
@Bean
fun api(http: HttpSecurity): SecurityFilterChain {
    http.csrf { it.disable() }
    http.polarisKey()
    http.authorizeHttpRequests {
        it.requestMatchers("/health").permitAll()
            .requestMatchers("/api/export").access(PolarisKey.entitlement("export.pdf"))
            .requestMatchers("/api/team").access(PolarisKey.tier("pro", "team"))
            .requestMatchers("/api/pro").access(PolarisKey.all(Require.signIn(), Require.tier("pro")))
            .anyRequest().denyAll()
    }
    return http.build()
}
```

- `http.polarisKey()` (or `http.with(PolarisKeyConfigurer.polarisKey(), Customizer.withDefaults())`)
  adds a filter that decides steps 1 to 5 when a request carries `X-PKey-License`; it never refuses.
  The `PolarisKey` managers (`license()`, `entitlement(name[, test])`, `tier(vararg)`, `signIn()`,
  `all(vararg)`) decide step 6 and refuse. The licence is the `@AuthenticationPrincipal`
  (`PolarisLicense`); `request.requirePolarisLicense()` throws on an ungated route.
- A refusal is `application/problem+json`, `Cache-Control: no-store` and, on a 401, a `PKey-License`
  challenge, in the caller's `Accept-Language`: 401 through the entry point, 403 through the denied
  handler, both only for requests a gate refused. A `PolarisKeyRefusalHandler` bean changes the
  response (`response.respondProblem(problem, status)`); `polaris-key.errors=throw` raises
  `PolarisKeyError` into `@ControllerAdvice`.
- A CORS preflight passes every gate (`polaris-key.preflight=gate` turns that off). The starter sets
  no CORS header: use `http.cors { }` and allow `BackendWire.POLARIS_REQUEST_HEADERS`. A granted
  response without a Cache-Control is sent `private`.
- Properties: `product`, `pinned-keys.<kid>`, `base-url`, `products[n].*`, `max-age-seconds`,
  `trust-refresh`, `cache-size`, `errors`, `preflight`, `enabled`. The `im.plrs.key.server.spring`
  logger at debug prints each verdict's step, key id and a short device hash, never the header.
- Tests: `@Import(PolarisKeyTestConfiguration::class)` and `mvc.perform(get(..).with(kit.license { .. }))`
  or `kit.refusing(BackendRefusal.NotEntitled)`; no network, no properties.
- Nothing here logs the header, the JWS or the holder.
