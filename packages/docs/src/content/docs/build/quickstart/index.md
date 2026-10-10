---
title: "Integrate in 5 minutes"
description: "From a registered product to a gated, configured app in each SDK: install, generate the config module with pkey sdk, then take the drop-in screens or draw your own UI."
sidebar:
  order: 4.1
  label: "Integrate in 5 minutes"
---

Every SDK starts the same way, and none of the product facts are pasted by hand:

1. **Register the product** ([Registering a product](/docs/build/registering/)) and note its slug.
2. **Install the SDK** from its feed ([Installing the SDKs from the feeds](/docs/build/install-from-feeds/)).
3. **Generate the config module** with the CLI, in the product repo:

   ```sh
   pkey sdk --lang <node|react|python|swift|kotlin|godot> --product <slug> --write
   ```

   It reads the product's discovery document and writes the slug, the base URL, the trust pins,
   the pinned release keys and the services the product runs, in that SDK's own option names.
   Release keys come from `.pkey/release` and are checked against what the server advertises.
   It prints each trust pin's fingerprint: compare them with the console (or pass the
   `pkey trust` pair as `--kid`/`--public-key`) before you ship. Every flag is in
   `packages/cli/README.md` (`@polaris-key/cli`).

4. **Create the client** from the module and the app's own version.
5. **Pick a lane.** Each SDK's page forks here, and both lanes reach the same eight checkpoints:
   install, config, first activation, each refusal, sign-in, status and offline, an update offer,
   and tests.

   | Lane            | You get                                               | You write                                 |
   | --------------- | ----------------------------------------------------- | ----------------------------------------- |
   | Drop-in screens | The finished screens: gate, sign-in, devices, updates | The one call the kit documents            |
   | Your own UI     | The state, the call and the words for each step       | Your screens, on the SDK's headless layer |

| SDK                                      | Generated module        | Create the client                                                    | Drop-in lane                                                                                                                         | Your own UI                                    |
| ---------------------------------------- | ----------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| [Node](/docs/build/quickstart/node/)     | `polaris.config.ts`     | `PolarisKeyClient.create({ ...polarisConfig, version })`             | [Terminal kit](/docs/build/ui/frameworks/terminal-node/); the [React kit](/docs/build/ui/frameworks/react/) over the Electron bridge | [Node](/docs/build/sdks/node/your-own-ui/)     |
| [React](/docs/build/quickstart/react/)   | `polaris.config.ts`     | `<PolarisKeyProvider {...polarisConfig}>` + `LicenseGate`            | [React kit](/docs/build/ui/frameworks/react/)                                                                                        | [React](/docs/build/sdks/react/your-own-ui/)   |
| [Python](/docs/build/quickstart/python/) | `polaris_config.py`     | `PolarisKeyClient.create(**polaris_config.CONFIG, ...)`              | [Terminal kit](/docs/build/ui/frameworks/terminal-python/)                                                                           | [Python](/docs/build/sdks/python/your-own-ui/) |
| [Swift](/docs/build/quickstart/swift/)   | `PolarisConfig.swift`   | `PolarisKeyClient.create(options: PolarisConfig.clientOptions(...))` | [Swift](/docs/build/sdks/swift/)                                                                                                     |                                                |
| [Kotlin](/docs/build/quickstart/kotlin/) | `PolarisConfig.kt`      | `PolarisKeyClient.create(PolarisConfig.clientOptions(...))`          | [Compose](/docs/build/ui/frameworks/compose/)                                                                                        |                                                |
| [Godot](/docs/build/quickstart/godot/)   | `polaris_key_config.gd` | `PolarisKey.boot({options = PolarisConfig.options()})`               | [Godot](/docs/build/sdks/godot/)                                                                                                     |                                                |

Re-run the command whenever a key rotates or a service is turned on: it replaces only the file
it wrote. Typed catalog mirrors for compile-time config keys come from `pkey mirror`
(`pkey mirror --lang ts,python,swift,gdscript,kotlin --product <slug>`).

What each SDK does beyond these lines, and what it declares unsupported on a given runtime, is in
the [parity matrix](/docs/reference/parity/). Task-shaped recipes are under
[Recipes](/docs/build/recipes/).
