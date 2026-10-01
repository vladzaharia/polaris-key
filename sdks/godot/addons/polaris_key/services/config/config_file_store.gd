class_name PKeyConfigFileStore
extends PKeyOverrideStore
## The local-override layer over the game's own settings file (report §5.4): a live provider
## over a `ConfigFile`, so the player's settings and Polaris Key's local layer are one file.
##
##   PolarisKey.config.set_override_store(PKeyConfigFileStore.new("user://settings.cfg"))
##
## Where a config key lives in the file:
##   1. the catalog entry's `accessor` when it has one: `section.key` -> `[section] key` (split at
##      the FIRST dot; `audio.music.volume` -> `[audio] music.volume`);
##   2. else the explicit `mapping` table: key -> `"section.key"` or `["section", "key"]`;
##   3. else the config key itself, split the same way. A name without a dot goes in
##      `[default_section]`.
##
## Reads are at call time: the file is re-read whenever its modification time changes, so a
## value the game's own settings code saved is seen by the next `get_value`. (Modification times
## have one-second resolution on some file systems: after writing the file yourself, call
## `reload()`, which also emits `changed`.) Writes through this store save the file at once.
##
## A `ConfigFile` cannot hold `null` (`set_value(…, null)` erases the key), so a null override
## is the same as clearing it.

var path := ""
var mapping := {}
var default_section := "settings"

var _cfg := ConfigFile.new()
var _mtime := -1


func _init(p_path := "user://settings.cfg", p_mapping: Dictionary = {}) -> void:
	path = p_path
	mapping = p_mapping.duplicate(true)


## [section, key] for a config key.
func locate(key: String, accessor := "") -> PackedStringArray:
	if accessor != "":
		return _split(accessor)
	var m = mapping.get(key)
	if (m is Array or m is PackedStringArray) and m.size() == 2:
		return PackedStringArray([String(m[0]), String(m[1])])
	if m is String and m != "":
		return _split(m)
	return _split(key)


func _split(dotted: String) -> PackedStringArray:
	var at := dotted.find(".")
	if at <= 0 or at == dotted.length() - 1:
		return PackedStringArray([default_section, dotted])
	return PackedStringArray([dotted.substr(0, at), dotted.substr(at + 1)])


func has_override(key: String, accessor := "") -> bool:
	_fresh()
	var at := locate(key, accessor)
	return _cfg.has_section_key(at[0], at[1])


func get_override(key: String, accessor := "") -> Variant:
	_fresh()
	var at := locate(key, accessor)
	return _cfg.get_value(at[0], at[1], null)


func set_override(key: String, value: Variant, accessor := "") -> bool:
	_fresh()
	var at := locate(key, accessor)
	_cfg.set_value(at[0], at[1], value)
	var ok := _save()
	changed.emit(PackedStringArray([key]))
	return ok


func clear_override(key: String, accessor := "") -> bool:
	_fresh()
	var at := locate(key, accessor)
	if not _cfg.has_section_key(at[0], at[1]):
		return true
	_cfg.erase_section_key(at[0], at[1])
	var ok := _save()
	changed.emit(PackedStringArray([key]))
	return ok


## Re-read the file now and announce it (every key it holds). OK, or the load error (a missing
## file is OK: no overrides).
func reload() -> Error:
	var err := _load()
	var keys := PackedStringArray()
	for section in _cfg.get_sections():
		for k in _cfg.get_section_keys(section):
			keys.append("%s.%s" % [section, k])
	changed.emit(keys)
	return err


func _fresh() -> void:
	var m := _file_mtime()
	if m != _mtime:
		_load()


func _load() -> Error:
	_cfg = ConfigFile.new()
	_mtime = _file_mtime()
	if _mtime == 0:
		return OK
	var err := _cfg.load(path)
	if err != OK:
		_cfg = ConfigFile.new()
	return err


func _save() -> bool:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var err := _cfg.save(path)
	_mtime = _file_mtime()
	return err == OK


func _file_mtime() -> int:
	return FileAccess.get_modified_time(path) if FileAccess.file_exists(path) else 0
