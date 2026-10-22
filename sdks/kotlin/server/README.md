# polaris-key-server

The framework-free core of the Polaris Key server drop-ins (`im.plrs.key:polaris-key-server`, over
`:core` only): the six-step verdict of WIRE-CONTRACT-V4 §14.2, the problem body and challenge in eight
locales, and the trust refresh. `:server-ktor` is the Ktor plugin over it.

```kotlin
val server = PolarisServer(
    PolarisServerOptions(listOf(PolarisProduct(PolarisConfig.PRODUCT_SLUG, PolarisConfig.pinnedKeys, PolarisConfig.BASE_URL))),
)
server.start()                                    // trust manifest now and every 900 s; close() ends it
val auth = server.authenticate(headers, listOf(Require.tier("pro"), Require.entitlement("export.pdf")))
val problem = auth.problem                        // status, headers and body to send, or null: auth.license
```

- `Require.entitlement(name)` (boolean), `Require.entitlement(name) { value -> … }` (valued), `Require.tier(vararg)`
  and `Require.signIn()` are checked in order at step 6; the first unmet one refuses.
- A product that could never verify (no slug, no pin, a malformed pin, a base URL that is not https) throws
  `IllegalArgumentException` from `PolarisProduct`, with `pkey sdk --lang kotlin --write` as the fix.
- `debug` receives one line per verdict (step, key id, audience, short device hash) and one per failed trust
  fetch, with the reason. It never carries the header, the document or the holder.

## Testing (`im.plrs.key.server.testing`)

`PolarisTestKit` signs documents with a throwaway Ed25519 key. Never use it from production code.

```kotlin
val kit = PolarisTestKit(product = "acme")
val server = PolarisServer(kit.options())                       // the kit's pins and clock, trust refresh off
val ok = kit.signedHeaders { entitle("export.pdf"); tier = "pro" }
val stale = kit.headersFor(BackendRefusal.LicenseStale)          // or LicenseRequired, LicenseInvalid, NotEntitled, SignInRequired
kit.clock.advance(3600)
val rotated = kit.trust.addKey("rotated-2027")                   // vouched for by the fake trust manifest only
kit.trust.offline = true                                         // the fetch fails like an unreachable Polaris Key
val withRefresh = PolarisServer(kit.options(trustRefresh = true)) // refresh served by kit.trust
```
