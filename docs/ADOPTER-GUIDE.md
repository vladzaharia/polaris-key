# Adopter guide: onboarding a product onto Polaris Key

This guide is a template for bringing a product onto Polaris Key, using **djdl** — the
first Polaris Key product — as the worked example throughout. Substitute your own product
slug, repo, and secrets wherever djdl appears.

For djdl specifically the cutover was a **fresh start** — no KV data was migrated; keys are
re-issued (users sign in again), and the legacy `djdl.vlad.gg` host is retired once the new
djdl release is live and verified.

## 1. Stand up Polaris Key (prod)

See `docs/RUNBOOK.md`. In short: `terraform apply` (D1/KV/custom domain), set platform
secrets, `wrangler deploy --env prod`, confirm `https://key.plrs.im` answers.

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

The engine's managed-config client moves from `djdl.vlad.gg` to `key.plrs.im/djdl`:

| File                                                         | Change                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/integrations/remoteConfig/fetch.ts`                     | `DEFAULT_CONFIG_URL = "https://key.plrs.im/djdl/config"` (keep the `DJDL_CONFIG_URL` override).                                                                                                                                                         |
| `src/integrations/remoteConfig/{enroll,report,subscribe}.ts` | Endpoints become product-scoped (`/djdl/enroll`, `/djdl/token`, `/djdl/deauthorize`, `/djdl/config/report`, `/djdl/config/subscribe`); update `subscribeUrl()` + tests.                                                                                 |
| request headers                                              | `X-DJDL-Device/Version/Channel` → `X-PKey-Device/Version/Channel`.                                                                                                                                                                                      |
| `src/integrations/remoteConfig/verify.ts`                    | Replace the prod entry in `TRUSTED_KEYS` with `pkey-djdl-prod-2026-06` → its base64url pubkey. **Keep** `djdl-test-2026` so the committed vector still verifies. The engine tolerates the new `aud`/`iss` fields (it JSON-parses and ignores unknowns). |
| `macos/project.yml`                                          | `SUFeedURL → https://key.plrs.im/djdl/appcast.xml` (keep `SUPublicEDKey`).                                                                                                                                                                              |
| `macos/djdl/Services/AppleMusicAuthService.swift`            | dev-token URL → `https://key.plrs.im/djdl/mint/applemusic/token`; auth page → `…/mint/applemusic/auth`.                                                                                                                                                 |
| `LicenseGateView.swift` / landing / `CloudSettings.swift`    | copy `djdl.vlad.gg` → `key.plrs.im`.                                                                                                                                                                                                                    |

The macOS app keeps **delegating licensing to the embedded engine** (it is not retrofitted
to the Swift SDK now). Optionally, the engine's `remoteConfig` client can later be replaced
by `@polaris-key/node` — a post-cutover follow-up; the wire contract is identical.

**Deleted from the djdl repo:** the entire `worker/` tree (+ `worker/admin`), the
`release.yml deploy-worker` + `ci.yml worker` jobs, and the worker-mirror target of
`gen-config-schema.ts` (the Swift mirror stays).

## 4. Cut over

1. Land the engine/app edits + README + tests on a branch; merge; tag `vX.Y.Z`. The
   unchanged sign/notarize/appcast pipeline publishes the GitHub Release; Polaris Key
   proxies it.
2. Verify end-to-end against `key.plrs.im/djdl`: `enroll → /config` JWS verifies under the
   new kid; anti-replay/device-bind pass; Sparkle update downloads + verifies; OIDC loopback
   mints a license + token; the admin portal shows the machine.
3. **Rollback** (before step 5): the old worker is still live — revert + re-tag, or set
   `DJDL_CONFIG_URL=https://djdl.vlad.gg/config` as a stop-gap.

## 5. Decommission `djdl.vlad.gg`

1. Turn the old worker into a 301 shim: redirect release/appcast/install paths to
   `key.plrs.im/djdl/…` (covers cached `SUFeedURL`/`install.sh`); 410 the control plane.
2. `wrangler delete djdl-gateway` + its custom domain; delete its KV + HubDO.
3. Revoke old secrets: the old `GITHUB_TOKEN` PAT, the old `CONFIG_SIGNING_KEY/KID`
   (`djdl-prod-2026-06`, now untrusted), the old MusicKit `.p8` copy; recreate
   `OIDC_CLIENT_*` for Polaris. **Keep** the Sparkle private key.
4. Remove the `djdl.vlad.gg` DNS record last.
