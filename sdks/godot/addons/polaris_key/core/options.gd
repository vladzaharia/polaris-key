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

## The product slug (`aud`, `/<product>/…`).
@export var product := ""
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
@export var pinned_trust_keys: Dictionary = {}
## Release-signing pins (unused until P3-08).
@export var pinned_release_keys: Dictionary = {}
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
@export var store_root := "user://pkey"

## Send a hashed hardware fingerprint when registering (PolarisKey.devices). Off: the server
## records the device `unverified` (a `strict` tier refuses it). Raw values never leave the device.
@export var fingerprint_enabled := true
## Product-declared companion-app probes answered in the device report, each a Dictionary
## {id, label?, macos?, windows?, linux?} naming a path to test on that OS. Nothing else is ever
## enumerated.
@export var probes: Array[Dictionary] = []

@export_group("Config")
## The config environment layer (`PKEY_CONFIG_*` variables and `--pkey-config key=value`
## arguments). Auto: on in debug builds and on desktop, off in release builds on mobile and web.
@export_enum("Auto", "Always", "Never") var config_env_layer := CONFIG_ENV_AUTO
## A key's variable is this prefix plus the key with every `.` replaced by `__`.
@export var config_env_prefix := "PKEY_CONFIG_"
## A compiled catalog mirror (`catalog_generated.gd` from `tools/gen-mirrors.ts --lang
## gdscript`): its defaults back `PolarisKey.config.get_value` when nothing else resolves.
@export var config_catalog: Script = null

## A PKeyStore to use instead of the file store (tests, a platform secure store). Not exported.
var store: PKeyStore = null
## A Callable returning epoch seconds, replacing the system clock (tests and replays).
var now_source: Callable = Callable()
## Where the build stamp is read (PKeyBuildStamp). "" means no stamp (tests that must not see
## the exported one). Not exported.
var build_stamp_path := PKeyBuildStamp.PATH


## The version to send: `version`, else the project's `application/config/version`.
func resolved_version() -> String:
	if version != "":
		return version
	return str(ProjectSettings.get_setting("application/config/version", ""))
