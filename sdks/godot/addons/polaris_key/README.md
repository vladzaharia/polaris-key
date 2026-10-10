# Polaris Key for Godot

Licensing, managed config, device sign-in, updates and downloadable content for Godot 4 games,
verified offline against keys you pin. Pure GDScript: no GDExtension, so it runs on every
platform Godot exports to, web included.

This folder is the whole addon. The full guide (install, the setup dock, the boot, every
service, export presets and CI, the UI kit, supported engines and the platform caveats) is
`sdks/godot/README.md` in the repository:
https://github.com/vladzaharia/polaris-key/tree/main/sdks/godot#readme

## Install

1. Copy this folder to `res://addons/polaris_key/` (unzip the release zip at the project root),
   or install it from the Godot Asset Store or Asset Library.
2. **Project → Project Settings → Plugins**: enable **Polaris Key**. That registers the
   `PolarisKey` autoload and adds the **Polaris Key** setup dock.
3. In the dock, enter your product slug, paste the pinned trust keys that `pkey trust` prints,
   press **Check**, tick the confirmation and **Save**. Settings go to `res://polaris_key.tres`,
   outside this folder, so updating the addon never overwrites them.

## Quick start

```gdscript
func _ready() -> void:
	await PolarisKey.boot({allow_offline = true})
	get_tree().change_scene_to_file("res://title.tscn")
```

`PolarisKey.boot()` configures from `res://polaris_key.tres`, syncs, gates on the licence and
checks for an update, showing the `PKeyBoot` screen while it works. It returns once the player is
through: a stop (offline, a blocked build, an error) keeps its card and Try again on screen, and the
await waits through the retries. Then read config with
`PolarisKey.config.get_value("key", fallback)`, check `PolarisKey.license.is_entitled("name")`,
and so on.

Requires Godot 4.4 or later; 4.6 or later is recommended. Version: see `plugin.cfg`.

## Licence and credits

MIT (see `LICENSE`); the bundled Ed25519 and SHA-512 code's notices are in
`core/crypto/THIRD_PARTY_NOTICES`. `brand/` holds the Polaris Key editor glyph and the
"Powered by Polaris Key" credit screens and badges (dark and light) for your game's credits; it
is never imported, so copy the file you want into your project to use it.
