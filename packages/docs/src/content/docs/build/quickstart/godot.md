---
title: "Godot"
description: "Integrate the Godot addon in five minutes: generate polaris_key_config.gd and boot."
sidebar:
  order: 6
---

For every Godot 4 export target. Install the addon from the Godot feed and enable the
**Polaris Key** plugin, then in the project directory:

```sh
pkey sdk --lang godot --write   # writes polaris_key_config.gd beside project.godot
```

```gdscript
const PolarisConfig := preload("res://polaris_key_config.gd")

func _ready() -> void:
	await PolarisKey.boot({options = PolarisConfig.options(), allow_offline = true})
	get_tree().change_scene_to_file("res://game/title.tscn")
```

`boot()` returns once the player is through. A stop on the way (offline, a blocked build) keeps its
card and Try again on screen, and the await waits through the retries.

`options()` returns a `PKeyOptions` carrying the product facts; the version comes from
`application/config/version`. To keep the setup dock's `res://polaris_key.tres` (with your own
channel, theme or update settings), load it and call `PolarisConfig.apply(opts)` instead. The
boot card, gate, activation, sign-in and update prompt are the addon's UI kit, neutral over the
game's theme by default.

Next: the full [Godot SDK reference](/docs/build/sdks/godot/).
