class_name PKeyConfigBinding
extends RefCounted
## Binds a config key to a plain property and keeps it applied:
##
##   PKeyConfigBinding.bind_property($Dice, "roll_speed", "dice.animSpeed", 1.0)
##   PolarisKey.config.bind_property($Label, "text", "ui.motd", "")          # the same thing
##
## The value is set at once and again on every `config_changed` that names the key. The binding
## holds the object weakly and drops itself once the object is freed; `unbind()` drops it early.
## A number is converted to the property's current type (int <-> float), since every number the
## server sends is a float.
##
## Engine settings that are not node properties (vsync, audio buses, `Engine.max_fps`) are the
## game's to apply in a `config_changed` handler: `ProjectSettings.set_setting` at run time does
## not re-apply most of them.

var key := ""
var property: StringName = &""
var fallback: Variant = null

var _target: WeakRef
var _config: WeakRef


## Bind `object.property` to `key` on `config` (default: the PolarisKey autoload's). Returns the
## binding, already applied; null when there is no config to bind to.
static func bind_property(object: Object, p_property: StringName, p_key: String, p_fallback: Variant = null, config: PKeyConfig = null) -> PKeyConfigBinding:
	var c := config if config != null else _autoload_config()
	if c == null or object == null:
		return null
	var b := PKeyConfigBinding.new()
	b.key = p_key
	b.property = p_property
	b.fallback = p_fallback
	b._target = weakref(object)
	b._config = weakref(c)
	c._add_binding(b)
	b.apply()
	return b


static func _autoload_config() -> PKeyConfig:
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return null
	var root := tree.root.get_node_or_null("PolarisKey")
	if root == null:
		return null
	var c = root.get("config")
	return c if c is PKeyConfig else null


## The bound object, or null once it is freed.
func target() -> Object:
	var o = _target.get_ref() if _target != null else null
	return o if is_instance_valid(o) else null


## Set the property to the key's current value. False once the object is gone.
func apply() -> bool:
	var o := target()
	var c: PKeyConfig = _config.get_ref() if _config != null else null
	if o == null or c == null:
		return false
	o.set(property, _coerce(c.get_value(key, fallback), o.get(property)))
	return true


func unbind() -> void:
	var c: PKeyConfig = _config.get_ref() if _config != null else null
	if c != null:
		c._remove_binding(self)
	_target = null


## Numbers follow the property's current type; anything else is set as it is.
static func _coerce(value: Variant, current: Variant) -> Variant:
	if current is int and value is float:
		return int(round(value))
	if current is float and value is int:
		return float(value)
	if (current is String or current is StringName) and not (value is String or value is StringName) and value != null:
		return str(value)
	return value
