---
title: "Integrate in 5 minutes"
description: "From a registered product to a gated, configured app in each SDK: generate the config module with pkey sdk, create the client, gate, read config."
sidebar:
  order: 4.1
  label: "Integrate in 5 minutes"
---

Every SDK starts the same way, and none of the product facts are pasted by hand:

1. **Register the product** ([Registering a product](/docs/build/registering/)) and note its slug.
2. **Install the SDK** from its feed ([Installing the SDKs from the feeds](/docs/build/install-from-feeds/)).
3. **Generate the config module** with the CLI, in the product repo:

   ```sh
   pkey sdk --lang <node|react|python|swift|kotlin|godot> --write
   ```

   It reads the product's discovery document and writes the slug, the base URL, the trust pins,
   the pinned release keys and the services the product runs, in that SDK's own option names.
   Release keys come from `.pkey/release` and are checked against what the server advertises.
   It prints each trust pin's fingerprint: compare them with the console (or pass the
   `pkey trust` pair as `--kid`/`--public-key`) before you ship. Every flag is in
   `packages/cli/README.md` (`@polaris-key/cli`).

4. **Create the client** from the module and the app's own version, **gate** on the licence,
   **read config**, and **sync**. The page for your SDK has the four lines.

| SDK                                      | Generated module        | Then                                                                 |
| ---------------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| [Node](/docs/build/quickstart/node/)     | `polaris.config.ts`     | `PolarisKeyClient.create({ ...polarisConfig, version })`             |
| [React](/docs/build/quickstart/react/)   | `polaris.config.ts`     | `<PolarisKeyProvider {...polarisConfig}>` + `LicenseGate`            |
| [Python](/docs/build/quickstart/python/) | `polaris_config.py`     | `PolarisKeyClient.create(**polaris_config.CONFIG, ...)`              |
| [Swift](/docs/build/quickstart/swift/)   | `PolarisConfig.swift`   | `PolarisKeyClient.create(options: PolarisConfig.clientOptions(...))` |
| [Kotlin](/docs/build/quickstart/kotlin/) | `PolarisConfig.kt`      | `PolarisKeyClient.create(PolarisConfig.clientOptions(...))`          |
| [Godot](/docs/build/quickstart/godot/)   | `polaris_key_config.gd` | `PolarisKey.boot({options = PolarisConfig.options()})`               |

Re-run the command whenever a key rotates or a service is turned on: it replaces only the file
it wrote. Typed catalog mirrors for compile-time config keys come from `pkey mirror`
(`pkey mirror --lang ts,python,swift,gdscript,kotlin --product <slug>`).

What each SDK does beyond these lines, and what it declares unsupported on a given runtime, is in
the [parity matrix](/docs/reference/parity/). Task-shaped recipes are under
[Recipes](/docs/build/recipes/).
