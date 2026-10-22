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

## 0.9.0 — Removed: the declared registration policy

**Action required:** Remove `devices.registration` from every `.pkey/product.{json,yaml,yml}`
manifest, then run [`pkey validate`](/docs/reference/cli/#pkey-validate) before you resync or ship.
Do not replace the field with another `devices` value: 0.9 removes it rather than accepting an alias.
Remove `registration` from every services admin API request in the same change.

| Removed                                                                            | Use instead                                                                                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `.pkey/product` `devices.registration`                                             | The enabled service set: License is `requires-license`; otherwise Identity is `requires-identity`; otherwise the product is `open`. |
| `registration` in the body of a services `PATCH` (a policy or `null`)              | Send only `services`. A body that names `registration` is refused with `422 bad_request` and `fields: ["registration"]`.            |
| `registration` in services API responses, the product view and `?dryRun=1` changes | Read `effectiveRegistration`, the policy the enabled services derive.                                                               |

The settings reference no longer lists `core.registration`, the registry entry for the same field.

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

## 0.9.x — Added: exit code 4 for a refusal

**Action required:** Only if a script wraps [`pkey whoami`](/docs/reference/cli/#pkey-whoami) or
[`pkey logout`](/docs/reference/cli/#pkey-logout), which are new, or `pkey login`. These commands
exit 4 when they refuse, and print `▲` rather than `✗`. A refusal is: not signed in, a sign-in that
has ended, no credential store, or a token the server rejects. A network or server failure
exits 1, as it does for every other command, and `--json` prints one result line with `ok`, `exit`
and `error` either way.

| Exit | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | Success.                                                              |
| 1    | Failure: an invalid manifest, a network or server error.              |
| 2    | Usage: an unknown command or a missing or misused flag.               |
| 4    | Refused: not signed in, no credential store, or a token not accepted. |
