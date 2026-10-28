class_name PKeyConfigSetting
extends RefCounted
## A live handle on one config key (`PolarisKey.config.setting(key)`, SDK parity §3.11, S-17
## §5.11): its effective value and where it comes from now, then `changed` on every change (a
## local write, a sync, a store reload, a catalog that moved the key's accessor).
##
##   var vol := PolarisKey.config.setting("audio.musicVolume")
##   slider.value = vol.value
##   slider.editable = not vol.locked
##   vol.changed.connect(func(v, _source): slider.set_value_no_signal(v))
##   slider.value_changed.connect(func(v): vol.set_value(v))   # PKeyResult; refused when locked
##
## One handle per key: `setting(key)` returns the same object while the config client lives. The
## handle holds the client weakly, so keeping a handle does not keep the client alive.

## The effective value changed (`value` and `source` already hold the new state).
signal changed(value: Variant, source: StringName)

## The config key.
var key := ""
## The effective value (`get_value(key)` with no fallback): a copy, or null when nothing answers.
var value: Variant = null
## `get_config_source(key)`: &"enforced", &"hidden", &"local", &"env", &"remote-default" or &"fallback".
var source: StringName = &"fallback"
## True when the operator locked the key (enforced or hidden): `set_value` is refused
## (`managed_by_admin`) and a settings screen shows it read-only.
var locked := false
## How the app shows the key (`PKeyConstants.SettingVisibility`): &"hidden" for a hidden key, &"readonly" for an
## enforced one, else &"editable". Follows `source`.
var visibility: StringName = &"editable"

var _config: WeakRef


func _init(p_key: String, p_config: Object) -> void:
	key = p_key
	_config = weakref(p_config)


## Write a device-local override for this key: `PolarisKey.config.set_value(key, v)`.
func set_value(v: Variant) -> PKeyResult:
	var c = _config.get_ref()
	if c == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "The config client is gone.")
	return c.set_value(key, v)


## Remove this key's device-local override: `PolarisKey.config.clear(key)`.
func clear() -> PKeyResult:
	var c = _config.get_ref()
	if c == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "The config client is gone.")
	return c.clear(key)


## Where this key's value is with Cloud Sync: `"local"` (Cloud Sync off, nobody signed in, or a
## `local` key), `"pending"` (an edit waits to be sent) or `"synced"`.
func sync() -> String:
	var c = _config.get_ref()
	return c._sync_state(key) if c != null else "local"


## Whether a device-local override currently answers for this key.
func is_local() -> bool:
	return source == &"local"


## Called by the config client: take the new state and emit when the value or source moved.
func _update(p_value: Variant, p_source: StringName, p_locked: bool, emit: bool) -> void:
	var moved := not PKeyConfig._same(value, p_value) or source != p_source
	value = p_value
	source = p_source
	locked = p_locked
	visibility = &"hidden" if p_source == &"hidden" else (&"readonly" if p_source == &"enforced" else &"editable")
	if moved and emit:
		changed.emit(value, source)
