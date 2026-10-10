# Polaris Key minimal sample (Godot)

The smallest game that uses the Godot SDK end to end: it boots, gates on the licence, reads
config, opens the settings panel and sells one licence flag through the store. It stands in until
the full Diceroll sample (D-02) lands.

## Run it

1. Copy the SDK's `addons/polaris_key` folder into this directory (or symlink it:
   `ln -s ../../addons addons` from here).
2. Open `project.godot` in Godot 4.4 or later (4.6+ recommended). The plugin is already enabled.
3. In the **Polaris Key** dock, enter your product slug, paste the pins `pkey trust` prints,
   **Check**, confirm and **Save** (or **Generate config**, which runs
   `pkey sdk --lang godot --write`).
4. Press F5.

## What it shows

| Step     | Code in `main.gd`                                   | What happens                                                                 |
| -------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Boot     | `await PolarisKey.boot({allow_offline = true})`     | Sync, gate, update check and packs on the `PKeyBoot` screen; READY continues |
| Gate     | `PolarisKey.license.is_entitled(...)`               | Reads the verified licence; false once the licence is revoked or expired     |
| Config   | `PolarisKey.config.get_value("difficulty")`         | The resolved value from the signed config document                           |
| Settings | `PKeySettingsPanel.open(self)` over the game        | Every user-adjustable key, saved to `user://pkey_settings.cfg`               |
| Commerce | `PolarisKey.commerce.purchase(...)` and `restore()` | Buys in this build's store (App Store, Steam), claims and syncs              |

Change `SKINS_FLAG`, `SKINS_ENTITLEMENT` and `DIFFICULTY_KEY` to names your product declares. A
build that no store sells answers `unsupported` with reason `outlet`, which the sample shows as
text.
