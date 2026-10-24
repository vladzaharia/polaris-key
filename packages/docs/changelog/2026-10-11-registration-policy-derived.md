---
title: "The declared registration policy is removed"
date: "2026-10-11"
version: "0.9.0"
type: "removed"
services: ["license", "identity"]
sdks: []
replaces:
  - old: "`.pkey/product` `devices.registration`"
    new: "The enabled service set: License is `requires-license`; otherwise Identity is `requires-identity`; otherwise the product is `open`."
    surface: "manifest"
  - old: "`registration` in the body of a services `PATCH` (a policy or `null`)"
    new: 'Send only `services`. A body that names `registration` is refused with `422 bad_request` and `fields: ["registration"]`.'
    surface: "console"
  - old: "`registration` in services API responses, the product view and `?dryRun=1` changes"
    new: "Read `effectiveRegistration`, the policy the enabled services derive."
    surface: "console"
---

**Action required:** remove `devices.registration` from every `.pkey/product.{json,yaml,yml}` manifest, then run [`pkey validate`](/docs/reference/cli/#pkey-validate) before you resync or ship. Remove `registration` from every services admin API request in the same change.

Do not replace the field with another `devices` value: 0.9 removes it rather than accepting an alias. A manifest that still declares it reports `invalid_registration_policy`.

The settings reference no longer lists `core.registration`, the registry entry for the same field.
