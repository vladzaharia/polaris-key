class_name PKeyConfigEntry
extends RefCounted
## One row of `PolarisKey.config.list_user_config()`, for a settings screen (client-core
## `UserConfigEntry`). Hidden keys never appear; enforced ones are flagged read-only.

var key := ""
## The effective value (`get_value(key, <the remote value>)`): a player's override or an
## environment value where the key is a `default`, the locked remote value where it is enforced.
var value: Variant = null
## The operator locked it: show it read-only.
var enforced := false
## Where `value` came from (PKeyConfigResolve: enforced, local, env, remote-default).
var source: StringName = &""
## The catalog entry (fetched with `fetch_schema()`, else the compiled mirror), or {} when
## neither names this key: label, category, `ui` hints, `dependsOn`.
var catalog: Dictionary = {}


func _init(p_key := "", p_value: Variant = null, p_enforced := false, p_source: StringName = &"", p_catalog: Dictionary = {}) -> void:
	key = p_key
	value = p_value
	enforced = p_enforced
	source = p_source
	catalog = p_catalog


func _to_string() -> String:
	return "PKeyConfigEntry(%s = %s%s, %s)" % [key, JSON.stringify(value), ", enforced" if enforced else "", source]
