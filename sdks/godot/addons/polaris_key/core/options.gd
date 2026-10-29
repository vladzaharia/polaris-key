@tool
class_name PKeyOptions
extends Resource
## Everything `PolarisKey.configure()` needs, as an inspector-editable Resource. Keep the game's
## copy outside `addons/` (for example `res://polaris_key.tres`) so an addon update cannot
## overwrite it.

## `config_env_layer`: on in debug builds and on desktop, off in release builds on mobile and web.
const CONFIG_ENV_AUTO := 0
## `config_env_layer`: on everywhere.
const CONFIG_ENV_ALWAYS := 1
## `config_env_layer`: off everywhere.
const CONFIG_ENV_NEVER := 2
## Default locations retain their historical names on production. PKeyCore gives local origins
## their own host-suffixed descendants before creating SDK-owned stores.
const DEFAULT_STORE_ROOT := "user://pkey"
const DEFAULT_SETTINGS_PATH := "user://pkey_settings.cfg"


## The product slug (`aud`, `/<product>/…`). Named `product` before 0.9.
@export var product_slug := ""
## https only; plain http is accepted for localhost, 127.0.0.1 and [::1] alone.
@export var base_url := "https://key.plrs.im"
## The game's version, sent as X-PKey-Version and gated on by the server. Empty: the project's
## `application/config/version`. Must be semver; `configure` refuses anything else.
@export var version := ""
## X-PKey-Channel until the build stamp (P1-11) supplies one (WIRE-CONTRACT-V3 §5.1), so in
## practice the editor channel (the setup dock writes it): `stable`,
## `beta`, `pr-<n>`, `dev` or a manual channel the product declares (`^[a-z0-9][a-z0-9-]{0,63}$`).
## Aliases are sent as their canonical name (`staging` as `beta`, `latest` as `stable`);
## `configure` refuses anything malformed. Empty: derived from the version (`stable`, or
## `dev`/`beta`/`pr` for 0.0.0-* versions; the server narrows `pr` to the build's number).
@export var default_channel := ""
## kid -> raw Ed25519 public key (base64url). The ONLY trust root; never taken from discovery.
@export var pinned_keys: Dictionary = {}
## kid -> raw Ed25519 release key (base64url): the ONLY keys a release record
## (`pkey-release+jws`) verifies against (WIRE-CONTRACT-V4 §2.6). CI holds the private half;
## never a product key, never merged with pinned_keys, never extended from the network.
## Empty: PolarisKey.update.decide() answers `not-configured`. A key that is also a trust pin
## makes `configure` refuse (`invalid-options`). Two keys are valid at once during a rotation.
@export var pinned_release_keys: Dictionary = {}

@export_group("Update")
## The outlet this build was published through, as the HOST knows it: one of the 17 outlet
## kinds (`steam`, `direct`, `app-store`, …). Empty: the build stamp's outlet (P1-11), else
## `unknown`, which is never offered an update. A host value always wins (plans/P3-01.md §2.8).
@export var update_outlet := ""
## The product's outlet id when it differs from the kind (`altstore-beta` of kind `altstore`).
## Empty: the id is the kind.
@export var update_outlet_id := ""
## How a `direct` install was put on the device (`homebrew`, `scoop`, `flatpak`, `appimage`, …);
## a package-managed install is never self-updated. Empty: none.
@export var update_outlet_subkind := ""
## What this host can do with a new binary: any of `native`, `download`, `sidecar-pck`
## (P3-10's adapters narrow it per install type). Default: download.
@export var update_methods := PackedStringArray(["download"])
## The installed build's format (`dmg`, `zip`, `exe`, …) when it is known, so a binary update
## picks the same kind of build. Empty: the stamp's `format`, else any format.
@export var update_format := ""
## The https release page a direct build opens for a `download` answer when discovery names no
## builds URL, and for a `blocked` answer (P3-10). Empty: none.
@export var update_release_url := ""
## The https page a `store` answer opens when the feed carries no https listing (AltStore and
## AltStore PAL sources, Obtainium, F-Droid repositories and an iOS web-distribution page carry
## none): the source, repository or page this build was published through (P3-10). Empty: none.
@export var update_page_url := ""
## The base64 Ed25519 public key Sparkle and WinSparkle verify updates with (`generate_keys` /
## `winsparkle-tool`; CI holds the private half, never the Worker). WinSparkle (P5-07) reads it
## at run time; the export plugin writes it into a macOS build's Info.plist as SUPublicEDKey, the
## only place Sparkle reads it. Empty: Sparkle and WinSparkle refuse to start.
@export var update_eddsa_public_key := ""
## Detect the outlet at run time when update_outlet is empty (P3-11): this build's signals
## (PKeyOutletSignals) and the stamp, through PKeyOutlet.detect_outlet, whose result goes to
## PKeyDecision.resolve_update_outlet as `detected`. Off: the stamp alone decides.
@export var update_detect := true
@export_group("")
## The services this build expects when discovery has not been loaded this session (D-21).
## Empty: licence and config only.
@export var expected_services: PackedStringArray = PackedStringArray()
## Never touch the network: every call that would dial returns `local-only`.
@export var local_only := false
## Sync every N seconds while running, and on resume (0: off, the default).
@export var refresh_interval_seconds := 0.0
## Refresh the signed trust manifest at the top of every sync (§4.2). Leave on.
@export var trust_refresh := true
## Per-request deadline.
@export var request_timeout_seconds := 15.0
## Per-frame budget for a verify sliced across frames on a build without threads (4–8 ms).
@export_range(4.0, 8.0, 0.5) var verify_slice_ms := 6.0
## Where the file store keeps `<product>/{device, token, managed.json}`.
@export var store_root := DEFAULT_STORE_ROOT
## The device key store the key ring opens its own wrap with (a `PKeyDeviceKeyStore`, or any object with
## `ensure()` and `dh()`). Null: the product's own store under `store_root`, the one the app registers keys
## from. Not an export: a game passes a store it already made, and tests pass a scratch one.
var device_keys: Object = null
## Where the key ring keeps its pin and root (`PKeySyncRingVault`). Null: the product's vault under `store_root`.
## The root rests sealed by the platform key (Keychain, Keystore, DPAPI: protection) or, with no native
## sealer (Linux), in an engine-encrypted file that is obfuscation, NOT protection: any code running as
## the same user can derive its key. A vault made with `encrypted = false` is refused (`invalid-options`).
var ring_vault: PKeySyncRingVault = null

## Send a hashed hardware fingerprint when registering (PolarisKey.devices). Off: the server
## records the device `unverified` (a `strict` tier refuses it). Raw values never leave the device.
@export var fingerprint_enabled := true
## The device label the sign-in page and the customer's device list show (WIRE-CONTRACT-V4
## §12.7.1): sent on device-code sign-in, activation and registration. Empty: the device's model
## where the OS reports one, else the OS name.
@export var device_name := ""
## Off: send no device label at all (a per-call name to `sign_in.start` still goes).
@export var send_device_name := true
## Product-declared companion-app probes answered in the device report, each a Dictionary
## {id, label?, macos?, windows?, linux?} naming a path to test on that OS. Nothing else is ever
## enumerated.
@export var probes: Array[Dictionary] = []
## The Google Cloud project number Play Integrity tokens are requested for
## (PolarisKey.devices.attest() on a Play install). Empty: the one the Worker's attestation
## challenge carries (`play.cloudProjectNumber`, set by the operator). Digits only.
@export var play_cloud_project_number := ""
## `PolarisKey.backend`: the exact origins the licence document may be sent to (scheme, host and
## port; https, or http on loopback), e.g. ["https://api.example.com"]. Empty refuses every URL.
## A malformed one fails configure() with `invalid-options`.
@export var backend_origins := PackedStringArray()
## Attest and retry (SDK parity §3.10): when an edge-mint, a gated download or a commerce claim
## answers 403 `attestation_required`, run PolarisKey.devices.attest() once and retry once. Only
## iOS and Android store installs can attest; elsewhere the refusal comes back unchanged. Off: the
## caller always gets the refusal.
@export var auto_attest := true

@export_group("Cloud Sync")
## Cloud Sync's mode (app code's choice, never the Worker's): "e2e" (default) or "server". An app
## that says "server" still refuses a Worker it has seen speak E2E. `configure` refuses anything else.
@export var cloud_sync_encryption := "e2e"
## Renames the app declares for synced settings (old name to current name). Never taken from a served body.
@export var cloud_sync_aliases: Dictionary = {}
## The codec the E2E lane seals with (a PKeyCloudSync codec port). Not an export. Null: PKeySyncHostCodec over the key ring.
var cloud_sync_codec: Object = null

@export_group("Config")
## Persist the player's settings by default (SDK parity §3.11): when the game has not installed its
## own override store, PolarisKey.config keeps the local layer in a PKeyConfigFileStore at
## `settings_path`, so a PKeySettingsPanel change survives a restart. Off: an in-memory layer
## (the game installs its own store with config.set_override_store()).
@export var persist_settings := true
## Where the default settings store lives (a ConfigFile; your own settings.cfg works too).
@export var settings_path := DEFAULT_SETTINGS_PATH
## The config environment layer (`PKEY_CONFIG_*` variables and `--pkey-config key=value`
## arguments). Auto: on in debug builds and on desktop, off in release builds on mobile and web.
@export_enum("Auto", "Always", "Never") var config_env_layer := CONFIG_ENV_AUTO
## A key's variable is this prefix plus the key with every `.` replaced by `__`.
@export var config_env_prefix := "PKEY_CONFIG_"
## A compiled catalog mirror (`catalog_generated.gd` from `tools/gen-mirrors.ts --lang
## gdscript`): its defaults back `PolarisKey.config.get_value` when nothing else resolves.
@export var config_catalog: Script = null

@export_group("Packs")
## P4-28: what a `godot.pck` pack's resources may reference outside the pack. Each entry is an
## app script (`res://scripts/die.gd`), a directory of scripts (`res://scripts/dice/`) or a UID
## (`uid://c3x…`). Empty (the default): a pack attaches no app script; such a pack is refused
## before it is committed and again before it is mounted (`pck-directory-refused`). A UID outside
## the pack's own uid cache that this app registers is judged by the path it names (an app
## resource passes, an app script needs listing); one it does not register needs listing. The CLI
## lint cannot resolve app UIDs and refuses every unlisted one, so `.pkey/release`'s
## `deliverables.app.content.attachable` lists the UIDs packs use as well as the scripts (Godot
## 4.4+ writes the path and the UID of every reference). A malformed entry makes `configure`
## refuse (`invalid-options`).
@export var pack_attachable := PackedStringArray()

@export_group("UI")
## The UI kit's look (PKeyUiTheme). `polaris-key` (the default): the Polaris Key design system (its
## palette, Rubik, your product's accent and icon; no Polaris Key mark on the screens). `none`: the
## scenes follow your game's project theme and font instead.
@export_enum("none", "polaris-key") var ui_branding := "polaris-key"
## The Polaris Key theme's scheme when `ui_branding` is `polaris-key`: `dark` (the default for a
## game), `light`, or `system` to follow the OS live (dark where it has no preference).
@export_enum("dark", "light", "system") var ui_brand_scheme := "dark"
## Your accent in the Polaris Key theme (primary button, chips, focus ring); transparent derives
## it from your product's icon, else ink. It is resolved for contrast on every surface.
@export var ui_accent := Color(0, 0, 0, 0)
## A Theme of your own for every kit scene, whatever `ui_branding` says. Null: none.
@export var ui_theme: Theme = null
## Show "Powered by Polaris Locker" at the foot of the settings scene (off by default; never on the gate or boot).
@export var ui_powered_by := false
## How it is drawn (UI-KITS.md §1.6): `line` (the default: the Locker micro mark and the phrase) or
## `badge` (the 320 x 104 Locker badge on a credits or about scene you place with `PKeyPoweredBy`,
## where 320 px are free, else the line). The kit's own scenes (settings) draw the line only, and
## never the gate or boot.
@export_enum("line", "badge") var ui_powered_by_style := "line"
## The kit's spacing (PKeyUiTheme.DENSITIES; UI-KITS.md §3.1): `spacious` (the default, for a
## game at TV distance), `comfortable` or `compact`. A screen too small for it steps down.
@export_enum("spacious", "comfortable", "compact") var ui_density := "spacious"
## Motion in the kit's screens (UI-KITS.md DL16): `auto` follows the system's reduced-motion
## setting where the engine reports it (Godot 4.5+), `on` holds every loading and busy indicator
## still and swaps states at once, `off` always animates.
@export_enum("auto", "on", "off") var ui_reduce_motion := "auto"
## Transparency in the kit's screens (DL16): `auto` follows the system's reduced-transparency
## setting where the engine reports it, `on` draws the scrim behind a dialog over the game opaque,
## `off` keeps it see-through.
@export_enum("auto", "on", "off") var ui_reduce_transparency := "auto"
## The product name the kit's screens lead with; empty: the project's `application/config/name`.
@export var ui_product_name := ""
## The product icon beside it; null: the project's `application/config/icon` (else a monogram
## tile of the name's initial).
@export var ui_product_icon: Texture2D = null
## The game's wordmark, drawn beside the icon on Welcome and the boot screen (UI-KITS.md §1.2
## ProductIdentity.wordmark); null: the icon and the name alone.
@export var ui_product_wordmark: Texture2D = null
## The game's key art: the landscape identity pane's ground on Welcome and the boot screen's ground
## (ProductIdentity.art); null: the icon on the accent ground, as before.
@export var ui_product_art: Texture2D = null
## Vibrate a handheld briefly when a kit button is pressed or a dialog opens or closes. Off by default.
@export var ui_haptics := false
@export_group("")
## UI sound hook: a Callable taking one StringName, `focus`, `confirm`, `open` or `close` (see
## PKeyUiFeedback). The kit plays nothing itself; your hook plays your game's sound. Not exported.
var ui_sound_hook: Callable = Callable()

## A PKeyStore to use instead of the file store (tests, a platform secure store). Not exported.
var store: PKeyStore = null
## A Callable returning epoch seconds, replacing the system clock (tests and replays).
var now_source: Callable = Callable()
## Where the build stamp is read (PKeyBuildStamp). "" means no stamp (tests that must not see
## the exported one). Not exported.
var build_stamp_path := PKeyBuildStamp.PATH

## The pre-0.9 property names, captured by `_set` so a file that still carries them is refused,
## never read (SP-35 D7).
# api-allow: the D7 refusal has to name the removed options
const REMOVED_NAMES := ["product", "pinned_trust_keys"]
## Name -> the value the file held.
var _removed: Dictionary = {}
var _warned := false


## An unknown property lands here when a resource loads. The two renamed in 0.9 are kept apart
## from the live options: nothing is ever copied from `_removed` into them.
func _set(property: StringName, value: Variant) -> bool:
	if not REMOVED_NAMES.has(String(property)):
		return false
	_removed[String(property)] = value
	if Engine.is_editor_hint() and not _warned:
		_warned = true
		push_warning("Polaris Key: this PKeyOptions uses names removed in 0.9 (%s). Open the Polaris Key dock and Save, or run `pkey sdk --lang godot --write`, to rewrite it with product_slug and pinned_keys." % ", ".join(REMOVED_NAMES))
	return true


## The pre-0.9 option names this resource was loaded with, in a stable order. Empty: none.
func removed_names() -> PackedStringArray:
	var out := PackedStringArray()
	for n in REMOVED_NAMES:
		if _removed.has(n):
			out.append(n)
	return out


## What a removed option held, for the setup dock's pre-fill only (never for the SDK).
func removed_value(name: String) -> Variant:
	return _removed.get(name)


## The host outlet option for PKeyDecision.resolve_update_outlet: null when `update_outlet` is
## empty, the kind alone when no id or subkind is set, else {id, kind, subkind}.
func host_outlet() -> Variant:
	if update_outlet == "":
		return null
	if update_outlet_id == "" and update_outlet_subkind == "":
		return update_outlet
	return {
		"id": update_outlet_id if update_outlet_id != "" else update_outlet,
		"kind": update_outlet,
		"subkind": update_outlet_subkind if update_outlet_subkind != "" else null,
	}


## The version to send: `version`, else the project's `application/config/version`.
func resolved_version() -> String:
	if version != "":
		return version
	return str(ProjectSettings.get_setting("application/config/version", ""))
