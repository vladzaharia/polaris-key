class_name PKeyOverrideStore
extends RefCounted
## The local-override layer of config resolution: the player's own settings. PolarisKey.config
## asks it at CALL time (`get_value` reads the player's current value, never a snapshot), so a
## settings screen that writes through the store is live at once.
##
## This base class is an in-memory table (`PKeyOverrideStore.new({"dice.animSpeed": 2.0})`), the
## twin of the other SDKs' static `localOverrides`. PKeyConfigFileStore keeps the values in the
## game's own `ConfigFile`. A custom store subclasses this and overrides the four methods.
##
## `accessor` is the catalog entry's `accessor` (a dotted path into the client's config object,
## catalog.md), or "" when no catalog names one. A store may use it to locate the value; this one
## ignores it.
##
## The store is never written by a sync: an enforced or hidden key IGNORES the saved value, it
## does not delete it, so the player's choice comes back if the operator relaxes the state.

## Overrides changed (written through this store, or reloaded from its backing file).
signal changed(keys: PackedStringArray)

var values := {}


func _init(initial: Dictionary = {}) -> void:
	values = initial.duplicate(true)


func has_override(key: String, _accessor := "") -> bool:
	return values.has(key)


## The override's value, or null when there is none (check `has_override` first: null is a
## legitimate JSON value).
func get_override(key: String, _accessor := "") -> Variant:
	return values.get(key)


func set_override(key: String, value: Variant, _accessor := "") -> bool:
	values[key] = value
	changed.emit(PackedStringArray([key]))
	return true


func clear_override(key: String, _accessor := "") -> bool:
	if values.erase(key):
		changed.emit(PackedStringArray([key]))
	return true
