# Adopter guide: onboarding a product onto Polaris Key

This guide is a template for bringing a product onto Polaris Key, using **djdl** — the
first Polaris Key product — as the worked example throughout. Substitute your own product
slug, repo, and secrets wherever djdl appears.

For djdl specifically the onboarding is a **fresh start** — no KV data is migrated, and
users sign in again or activate with newly issued keys.

## 1. Stand up Polaris Key (prod)

See `docs/RUNBOOK.md`. In short: create the D1/KV resources with wrangler, set platform
secrets, apply migrations, `wrangler deploy --env prod`, and confirm
`https://key.plrs.im` answers.

## 2. Register the djdl product

1. Add `.pkey/product.yaml`, `.pkey/schema.yaml`, and `.pkey/release.yaml` to the product
   repo. `pkey init` can scaffold the v1 files; edit them until `pkey validate` passes.
2. Install the Polaris Key GitHub App on `vladzaharia/djdl`, then link the repo in the
   admin portal. Polaris fetches the default-branch `.pkey/` files, validates them, mints a
   sealed Ed25519 product signing key in `product_keys`, and returns the public trust key.
   Confirm the GitHub App webhook is active so future default-branch `.pkey/` changes sync
   automatically and appear in the Releases view with changed paths and validation errors.
3. In Settings, set every required product secret shown by setup health. For djdl this
   includes the OIDC client secret and the Apple MusicKit edge-mint private key. These are
   write-only admin/API values stored sealed in `product_secrets`; they are not Worker
   secrets and are never echoed back.
4. Verify `GET /djdl/.well-known/jwks.json` returns the active kid, `GET /djdl/appcast.xml`
   streams, and product setup/release health has no missing required secrets or release
   assets.

## 3. Engine + app changes (in the djdl repo)

The engine's managed-config client uses `key.plrs.im/djdl`:

| File                                                      | Change                                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/integrations/remoteConfig/fetch.ts`                  | `DEFAULT_CONFIG_URL = "https://key.plrs.im/djdl/config"` (keep the `DJDL_CONFIG_URL` override).                                                                                                               |
| `src/integrations/remoteConfig/{activate,report}.ts`      | Endpoints become product-scoped (`/djdl/activate`, `/djdl/token`, `/djdl/deauthorize`, `/djdl/config/report`); update tests.                                                                                  |
| request headers                                           | `X-DJDL-Device/Version/Channel` → `X-PKey-Device/Version/Channel`.                                                                                                                                            |
| `src/integrations/remoteConfig/verify.ts`                 | Set the prod entry in `TRUSTED_KEYS` to `pkey-djdl-prod-2026-06` → its base64url pubkey. **Keep** `djdl-test-2026` so the committed vector still verifies. The engine requires the scoped `aud`/`iss` fields. |
| `macos/project.yml`                                       | `SUFeedURL → https://key.plrs.im/djdl/appcast.xml` (keep `SUPublicEDKey`).                                                                                                                                    |
| `macos/djdl/Services/AppleMusicAuthService.swift`         | dev-token URL → `https://key.plrs.im/djdl/mint/applemusic/token`; auth page → `…/mint/applemusic/auth`.                                                                                                       |
| `LicenseGateView.swift` / landing / `CloudSettings.swift` | use the Polaris Key host, `key.plrs.im`.                                                                                                                                                                      |

The macOS app keeps **delegating licensing to the embedded engine** (it is not retrofitted
to the Swift SDK now). Optionally, the engine's `remoteConfig` client can later be replaced
by `@polaris-key/node` — a post-cutover follow-up; the wire contract is identical.

## 4. Cut over

1. Land the engine/app edits + README + tests on a branch; merge; tag `vX.Y.Z`. The
   unchanged sign/notarize/appcast pipeline publishes the GitHub Release; Polaris Key
   proxies it.
2. Verify end-to-end against `key.plrs.im/djdl`: `activate → /config` JWS verifies under the
   new kid; anti-replay/device-bind pass; Sparkle update downloads + verifies; OIDC loopback
   mints a license + token; the admin portal shows the device.
3. Roll forward by fixing the product manifest or release tag and re-running setup health.

## 5. Optional: free tier and live re-licensing

**Auto-issued licenses.** Declare an `autoIssue` block in `.pkey/product` (see
`docs/CONFIG-AUTHORING.md`) and the client can obtain a license with no key and no sign-in:

```ts
const client = await PolarisKeyClient.create({
  productSlug: "djdl",
  version,
  trust,
});
if (!client.isLicensed()) {
  const r = await client.enroll(); // 404 → { kind: "enroll-disabled" }
}
```

One license per machine, deduplicated on the hardware fingerprint. Signing in later _claims_
that license in place, so the user's devices and local state survive.

**Live re-licensing.** Changing a license's tier in the admin panel changes what running
clients are entitled to on their next config refresh — nothing is pushed. Nothing polls by
default, so opt in where you want an upgrade to land without a restart:

```ts
const client = await PolarisKeyClient.create({
  productSlug: "djdl",
  version,
  trust,
  refreshIntervalSeconds: 900,
  onChange: (state) => applyEntitlements(client.getEntitlements(), state),
});
// …
client.close(); // stops the timer
```

`onChange` fires only when the managed config actually changed — it keys off the document
ETag, which is stable across a pure re-sign. The current plan is readable as the
`license.tier` / `license.tierLabel` entitlements.

Python takes `refresh_interval_seconds=` / `on_change=` and has `close()`; Swift takes
`refreshIntervalSeconds:` and `startRefreshLoop(onChange:)` / `stopRefreshLoop()`; the React
provider takes `refreshIntervalSeconds`.

**Downgrades grandfather.** Moving a license to a tier with fewer seats never evicts a device:
existing devices keep working and new activations are refused until the count drops below the
new limit. The admin API reports `overLimit` so the UI can say so at the moment of the change.
