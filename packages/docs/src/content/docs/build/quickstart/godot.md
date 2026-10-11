---
title: "Godot"
description: "Integrate the Godot addon: install it from the feed, generate polaris_key_config.gd, then take the drop-in boot, place the scenes, or draw your own screens on the controllers."
sidebar:
  order: 6
---

For every Godot 4 export target. Godot 4.4 or later; 4.6 or later recommended.

## Install

Add Polaris Key's Godot feed to the editor, with no trailing slash:

| Editor              | Editor Settings                | Value                                                     |
| ------------------- | ------------------------------ | --------------------------------------------------------- |
| Godot 4.4 to 4.6    | Asset Library → Available URLs | `https://pkg.plrs.im/godot/polaris-key/asset-library/api` |
| Godot 4.7 and later | `asset_store/available_urls`   | `https://pkg.plrs.im/godot/polaris-key/store/api/v1`      |

Search for "Polaris Key" in the AssetLib tab and install it. On Godot 4.4 to 4.6, untick **Ignore
asset root** in the install dialog: it is ticked by default and installs the addon at
`res://polaris_key/` instead of `res://addons/polaris_key/`. Then enable **Polaris Key** under
Project → Project Settings → Plugins, which registers the `PolarisKey` autoload and the setup dock.
GodotEnv and scripted installs: [Installing the SDKs from the feeds](/docs/build/install/).

## Config

Without Node, run the CLI from its image, in the project directory:

[Run Polaris Key locally](/docs/build/local/) to try this without a registered product.

```sh
docker run --rm -v "$PWD:/work" pkg.plrs.im/polaris-key/pkey:latest \
  sdk --lang godot --product <slug> --write
```

With Node, `pnpm exec pkey sdk --lang godot --product <slug> --write` does the same; the setup
dock's **Generate config** runs it too. It writes `polaris_key_config.gd` beside `project.godot`:
the slug, base URL, trust pins, advertised services and, when the product has release keys, the
pinned release keys. Compare the printed pin fingerprints with the console before you ship. A local
Polaris Key to run against is planned.

## Pick a lane

| You want                          | Lane            | Start here                                        |
| --------------------------------- | --------------- | ------------------------------------------------- |
| Every screen from one call        | Drop-in screens | [Boot](#drop-in-boot)                             |
| The screens as scenes you place   | Drop-in screens | [Scenes](/docs/build/ui/frameworks/godot/#scenes) |
| Your own menus on the controllers | Your own UI     | [The controllers](#your-own-ui-the-controllers)   |

### Drop-in: boot

```gdscript
extends Node

const PolarisConfig := preload("res://polaris_key_config.gd")


func _ready() -> void:
	await PolarisKey.boot({options = PolarisConfig.options()})
	get_tree().change_scene_to_file("res://game/title.tscn")
```

`boot()` configures the SDK, starts offline from the verified cache, syncs, gates on the licence and
checks for an update, with the addon's own screens above the game, and returns once the player is
through. A stop on the way (offline, a blocked build) keeps its card with Try again on screen and
the await waits through the retries; `{resolve_on_stop = true}` resolves at the first stop instead.
`options()` returns a `PKeyOptions` carrying the product facts; the version comes from
`application/config/version`, which must be SemVer. To keep the setup dock's `res://polaris_key.tres`
(your own channel, theme or update settings), load it and call `PolarisConfig.apply(opts)` instead.

The screens are the addon's UI kit, neutral over the game's theme by default:
[Godot](/docs/build/ui/frameworks/godot/) has the scenes, theming and the one-line settings panel.

### Your own UI: the controllers

Four headless controllers return the screen, the copy keys and the controls; the game draws the
nodes. Start the SDK yourself (`configure()`, `start()`, `discover()`, `sync()`, in
[Your own UI](/docs/build/sdks/godot/your-own-ui/)), then render from its state:

```gdscript
extends Node


func _ready() -> void:
	PolarisKey.state_changed.connect(_on_state_changed)


func _on_state_changed(state: Dictionary) -> void:
	var screen := PKeyGateController.screen_for(String(state["status"]))
	print(screen)  # usable, grace, activation, revoked, expired, ...
```

## The same eight checkpoints

| #   | Checkpoint         | Drop-in (boot and scenes)                                                                        | Your own UI (controllers)                                                                    |
| --- | ------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1   | Install            | above                                                                                            | above                                                                                        |
| 2   | Config             | above                                                                                            | above                                                                                        |
| 3   | First activation   | The key field of `PKeyActivationPanel`                                                           | `PolarisKey.license.activate_with_key(key)`                                                  |
| 4   | Each refusal       | Shown by the panel; a full device list gets Replace a device                                     | `PKeyActivationController.message_for(r)`, `manage_link(r, key, return_url)`                 |
| 5   | Sign-in            | Sign in on the panel (`PKeySignInDialog`); `boot({confirm_identity = true})` asks "Is this you?" | `PolarisKey.identity.begin_sign_in()`, then `PKeySignInController.identity_line(r.identity)` |
| 6   | Status and offline | The boot card's Try again and `PKeyStatusBanner` for grace                                       | `PolarisKey.status()`, `PKeyGateController.screen_for()`, `result.classify()`                |
| 7   | An update offer    | `PKeyUpdatePrompt`, shown by `boot()`                                                            | `PolarisKey.update.decide()`, `PKeyUpdatePromptController.model(check)`                      |
| 8   | Tests              | `PKeyOptions.store` set to a `PKeyMemoryStore`, `now_source`, `local_only`                       | The same, and the controllers as pure functions                                              |

[Your own UI](/docs/build/sdks/godot/your-own-ui/) gives each call with its state and its words.
The whole API is the [Godot SDK reference](/docs/build/sdks/godot/); a full device list has a
[recipe](/docs/build/recipes/device-limit/).
