---
title: "Upgrade to 0.9"
description: "Move an integration from 0.8 to 0.9, change by change."
type: "how-to"
status: "shipped"
lastReviewed: "2026-10-11"
---

Update each product manifest, and any script that calls the services admin API, for 0.9's
service-derived device-registration policy before you resync or ship.

1. Remove the retired manifest field.
2. Remove the retired field from services API requests, and stop reading it from responses.
3. Choose the enabled services that now set the policy.
4. Validate the manifest before you resync or ship.

Each removal, with its fix and the release that made it, is in the [developer changelog](/docs/reference/changelog/). The tables below list every removed name and what to use instead.

## Manifest

<!-- prettier-ignore-start -->
<!-- GENERATED:upgrade-manifest — do not edit; regenerate with `pnpm --filter @polaris-key/docs gen` from packages/docs/changelog and conformance/parity/api.json -->

| Removed | Use instead | Since |
| --- | --- | --- |
| `.pkey/product` `devices.registration` | The enabled service set: License is `requires-license`; otherwise Identity is `requires-identity`; otherwise the product is `open`. | 0.9.0 |

<!-- /GENERATED:upgrade-manifest -->
<!-- prettier-ignore-end -->

## CLI

<!-- prettier-ignore-start -->
<!-- GENERATED:upgrade-cli — do not edit; regenerate with `pnpm --filter @polaris-key/docs gen` from packages/docs/changelog and conformance/parity/api.json -->

| Removed | Use instead | Since |
| --- | --- | --- |
| `pkey feeds fdroid` | `pkey storefront fdroid`, with the same flags | 0.9.18 |

<!-- /GENERATED:upgrade-cli -->
<!-- prettier-ignore-end -->

## Action

<!-- prettier-ignore-start -->
<!-- GENERATED:upgrade-action — do not edit; regenerate with `pnpm --filter @polaris-key/docs gen` from packages/docs/changelog and conformance/parity/api.json -->

| Removed | Use instead | Since |
| --- | --- | --- |
| `with: product` | `--product <value>` in `args` | 0.9.18 |
| `with: deliverable` | `--deliverable <value>` in `args` | 0.9.18 |
| `with: version` | `--version <value>` in `args` | 0.9.18 |
| `with: tag` | `--tag <value>` in `args` | 0.9.18 |
| `with: channel` | `--channel <value>` in `args` | 0.9.18 |
| `with: dir` | `--dir <value>` in `args` | 0.9.18 |
| `with: source` | `--source <value>` in `args` | 0.9.18 |
| `with: meta` | `--meta <value>` in `args` | 0.9.18 |
| `with: delegation` | `--delegation <value>` in `args` | 0.9.18 |
| `with: min-supported-seq` | `--min-supported-seq <value>` in `args` | 0.9.18 |
| `with: content-stamp` | `--content-stamp <value>` in `args` | 0.9.18 |
| `with: embedded` | `--embedded <value>` in `args` | 0.9.18 |
| `with: pins` | `--pin <value>` in `args` | 0.9.18 |
| `with: out` | `--out <value>` in `args` | 0.9.18 |
| `with: bases` | `--bases <value>` in `args` | 0.9.18 |
| `with: script-extensions` | `--script-extensions <value>` in `args` | 0.9.18 |
| `with: script-types` | `--script-types <value>` in `args` | 0.9.18 |
| `with: assets` | `command: assets push`, with the file and `--slot` in `args` | 0.9.18 |
| `with: transport` | `command: transport <step> …`, with its flags in `args` | 0.9.18 |
| `with: content-api` | `--content-api <value>` in `args` | 0.9.18 |
| `with: variant` | `--variant <value>` in `args` | 0.9.18 |
| `with: transport-out` | `--out <value>` in `args` | 0.9.18 |
| `with: gradle-project` | `--project <value>` in `args` | 0.9.18 |
| `with: pad-delivery` | `--delivery <value>` in `args` | 0.9.18 |
| `with: steam-depot` | `--depot <value>` in `args` | 0.9.18 |
| `with: steam-branch` | `--branch <value>` in `args` | 0.9.18 |
| `with: steam-setlive` | `--setlive` in `args` | 0.9.18 |
| `with: asc-expect-resource` | `--expect-resource <value>` in `args` | 0.9.18 |
| `with: transport-report` | `--no-report` in `args` | 0.9.18 |
| `with: storefront` | `channels: auto`, or `command: storefront <store> <step> …` | 0.9.18 |
| `with: itch-platform` | `--platform <value>` in `args` | 0.9.18 |
| `with: storefront-outlet` | `--outlet <value>` in `args` | 0.9.18 |

<!-- /GENERATED:upgrade-action -->
<!-- prettier-ignore-end -->

## Console and API

<!-- prettier-ignore-start -->
<!-- GENERATED:upgrade-console — do not edit; regenerate with `pnpm --filter @polaris-key/docs gen` from packages/docs/changelog and conformance/parity/api.json -->

| Removed | Use instead | Since |
| --- | --- | --- |
| The seven `/manage/api/platform/override-migration` routes (read, prerequisites, notice, dry-run, run, report) | Nothing: there is no run to read. | 0.9.0 |
| `pnpm --filter @polaris-key/worker override-migration:dry-run` | Nothing. | 0.9.0 |
| The job `core.licence-override-migration` | `core.provisioned-secrets-to-account` moves provisioned secrets to the owner's account row (see the migration ledger). | 0.9.0 |
| `configOverrides.phase` and `runNotBefore` in the license detail, `licenseLayerRetired` in the account overrides answer, `migrationReport` in the Users data answer | Read the license's overrides; an owned license shows `owned`, `ownerSubject` and `signUpUrl`. | 0.9.0 |
| `registration` in the body of a services `PATCH` (a policy or `null`) | Send only `services`. A body that names `registration` is refused with `422 bad_request` and `fields: ["registration"]`. | 0.9.0 |
| `registration` in services API responses, the product view and `?dryRun=1` changes | Read `effectiveRegistration`, the policy the enabled services derive. | 0.9.0 |

<!-- /GENERATED:upgrade-console -->
<!-- prettier-ignore-end -->

## SDK names

0.9 removes SDK names without an alias; a removed option fails with `invalid-options` naming its replacement.

<!-- prettier-ignore-start -->
<!-- GENERATED:upgrade-sdk — do not edit; regenerate with `pnpm --filter @polaris-key/docs gen` from packages/docs/changelog and conformance/parity/api.json -->

| SDK | Removed | Use instead | Since |
| --- | --- | --- | --- |
| swift | `PolarisLoginView`, `PolarisGateModel` | `PolarisKeyGate` (or `.polarisKey(client)`, which now draws it) | 0.9.18 |
| swift | `PolarisSignIn`, `PolarisOfflineActivation` | The kit's sign-in and offline screens, inside `PolarisKeyGate` | 0.9.18 |
| swift | `GateOptions` | `KitGateOptions` (`keyEntry`, `offlineActivation`); `returnURL`, `renewURL` and `blockedAction` have no counterpart | 0.9.18 |
| swift | `config.config` | `config.get` | 0.9 |
| swift | `PolarisKeyClient.config(_:default:)` | `config.get` | 0.9 |
| swift | `config.configSource` | `config.getConfigSource` | 0.9 |
| swift | `config.secret` | `config.getSecret` | 0.9 |
| swift | `ConfigSetting.value(default:)` | `config.setting.value` | 0.9 |
| swift | `ConfigSetting.source()` | `config.setting.source` | 0.9 |
| swift | `ConfigSetting.isLocked()` | `config.setting.locked` | 0.9 |
| swift | `ConfigSetting.onChange(_:)` | `config.setting.on` | 0.9 |
| swift | `license.isEntitled` | `entitlements.has` | 0.9 |
| swift | `license.entitlementValue` | `entitlements.value` | 0.9 |
| swift | `license.entitlements()` | `entitlements.all` | 0.9 |
| swift | `client.isEnabled(flag:)` | `entitlements.has` | 0.9 |
| swift | `license.activate(key:)` | `license.activateWithKey` | 0.9 |
| node | `config.getConfig` | `config.get` | 0.9 |
| node | `PolarisKeyClient.getConfig` | `config.get` | 0.9 |
| python | `config.get_config` | `config.get` | 0.9 |
| python | `client.get_config` | `config.get` | 0.9 |
| python | `client.on_config_change` | `config.onConfigChange` | 0.9 |
| python | `config.on_change` | `config.onConfigChange` | 0.9 |
| node | `ConfigSetting.get` | `config.setting.value` | 0.9 |
| node | `ConfigSetting.source()` | `config.setting.source` | 0.9 |
| node | `ConfigSetting.locked()` | `config.setting.locked` | 0.9 |
| python | `config.setting.enforced` | `config.setting.locked` | 0.9 |
| python | `config.setting.subscribe` | `config.setting.on` | 0.9 |
| python | `config.setting(key, fallback)` | `config.get` | 0.9 |
| node | `license.isEntitled` | `entitlements.has` | 0.9 |
| node | `license.entitlementValue` | `entitlements.value` | 0.9 |
| node | `license.getEntitlements` | `entitlements.all` | 0.9 |
| python | `license.is_entitled` | `entitlements.has` | 0.9 |
| python | `license.entitlement_value` | `entitlements.value` | 0.9 |
| python | `license.get_entitlements` | `entitlements.all` | 0.9 |
| react | `expectServices` | `options.expectedServices` | 0.9 |
| react | `usePolarisKey().getConfig` | `config.get` | 0.9 |
| react | `usePolarisKey().isEntitled` | `entitlements.has` | 0.9 |
| python | `trust` | `options.pinnedKeys` | 0.9 |
| node | `PolarisKeyClient.getCurrentDevice` | `client.currentDevice` | 0.9 |
| godot | `options.product` | `options.productSlug` | 0.9 |
| godot | `options.pinned_trust_keys` | `options.pinnedKeys` | 0.9 |
| godot | `config.get_source` | `config.getConfigSource` | 0.9 |
| godot | `license.is_entitled` | `entitlements.has` | 0.9 |
| godot | `license.get_entitlements` | `entitlements.all` | 0.9 |
| godot | `devices.get_current_device` | `client.currentDevice` | 0.9 |
| godot | `commerce.get_binding` | `commerce.binding` | 0.9 |
| godot | `update.apply` | `update.install` | 0.9 |
| swift | `PolarisKeyClient.changes` | `client.events` | 0.9 |
| swift | `PolarisKeyClient.syncState()` | `client.getSyncState` | 0.9 |
| swift | `PolarisKeyClient.startRefreshLoop(onChange:)` | `client.startRefresh` | 0.9 |
| swift | `LicenseClient.profile()` | `license.getProfile` | 0.9 |
| swift | `LicenseClient.licenseId()` | `license.getLicenseId` | 0.9 |
| swift | `LicenseClient.licenseUser()` | `license.getLicenseUser` | 0.9 |
| swift | `ReleaseClient.installURL()` | `release.installUrl` | 0.9 |
| swift | `ReleaseClient.downloadURL(version:binary:arch:checksum:dmg:)` | `release.downloadUrl` | 0.9 |
| swift | `UpdateClient.buildURL(version:buildId:)` | `update.buildUrl` | 0.9 |
| kotlin | `PolarisKeyClient.syncState()` | `client.getSyncState` | 0.9 |
| kotlin | `PolarisKeyClient.startRefreshLoop()` | `client.startRefresh` | 0.9 |
| kotlin | `LicenseClient.profile()` | `license.getProfile` | 0.9 |
| kotlin | `LicenseClient.licenseId()` | `license.getLicenseId` | 0.9 |
| kotlin | `LicenseClient.licenseUser()` | `license.getLicenseUser` | 0.9 |
| kotlin | `DevicesFacet.attestUnavailable()` | `devices.attestSupport` | 0.9 |
| kotlin | `license.isEntitled` | `entitlements.has` | 0.9 |
| kotlin | `license.entitlementValue` | `entitlements.value` | 0.9 |
| kotlin | `license.entitlements()` | `entitlements.all` | 0.9 |
| kotlin | `PolarisKeyFutures.isEntitled` | `hasEntitlement` | 0.9 |
| kotlin | `config.config` | `config.get` | 0.9 |
| kotlin | `PolarisKeyClient.config(key, default)` | `config.get` | 0.9 |
| kotlin | `config.configSource` | `config.getConfigSource` | 0.9 |
| kotlin | `config.secret` | `config.getSecret` | 0.9 |
| kotlin | `license.activate` | `license.activateWithKey` | 0.9 |
| kotlin | `client.licenseChanges` | `undefined` | 0.9 |
| swift | `PolarisLoginView` | `undefined` | 0.9 |
| swift | `PolarisGateModel` | `undefined` | 0.9 |
| swift | `PolarisSignIn` | `undefined` | 0.9 |
| swift | `PolarisOfflineActivation` | `undefined` | 0.9 |
| swift | `GateOptions` | `undefined` | 0.9 |
| swift | `identity.signInWithBrowser` | `identity.signIn.start` | 0.9 |
| swift | `identity.beginSignIn` | `identity.signIn.start` | 0.9 |
| swift | `identity.pollSignIn` | `identity.signIn.session.wait` | 0.9 |
| swift | `identity.waitForSignIn` | `identity.signIn.session.wait` | 0.9 |
| swift | `identity.acceptSignIn` | `identity.attachLicense` | 0.9 |
| kotlin | `identity.beginSignIn` | `identity.signIn.start` | 0.9 |
| kotlin | `identity.pollSignIn` | `identity.signIn.session.wait` | 0.9 |
| kotlin | `identity.waitForSignIn` | `identity.signIn.session.wait` | 0.9 |

<!-- /GENERATED:upgrade-sdk -->
<!-- prettier-ignore-end -->

## Choose the services that set the policy

Set the services in `modules.<service>.enabled`:

| Enabled services                  | Registration policy |
| --------------------------------- | ------------------- |
| License, with or without Identity | `requires-license`  |
| Identity without License          | `requires-identity` |
| Neither License nor Identity      | `open`              |

See [Registering a product](/docs/build/manifest/register/) for the manifest service declaration.
A licensed product registers no device without a license, so a product that declared `open` beside
License gets no keyless device token under 0.9. Enrollment is a different mechanism with a
different result: it issues a license to an anonymous caller, and it does not change the
registration policy. See [Enrollment](/docs/features/licensing/access/).

## Check the result

Run [`pkey validate`](/docs/reference/cli/#pkey-validate) from the product repository. If a
manifest still declares `devices.registration`, it reports `invalid_registration_policy`; see
[Manifest validation codes](/docs/reference/validation-codes/) for the full message.

A services `PATCH` that still sends `registration`, with any value including `null`, answers `422`
and writes nothing.
