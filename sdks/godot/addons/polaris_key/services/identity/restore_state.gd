class_name PKeyRestoreState
extends RefCounted
## The two local facts silent restore keeps (V5 12.11.8): when this device last checked its restore key,
## and whether a `DELETE restore` is still owed to the Worker. One small JSON file per product,
## `user://pkey/<product>/restore.v1`, in the directory every backup excludes (PKeyBackupExclusion): a
## backup that carried either would tell a new device the wrong thing. Neither fact is a secret.
## A store made with `memory = true` (or a root that is not private) keeps them for the process only.

const FILE := "restore.v1"

var product: String
var dir: String

var _memory: bool
var _root_ok := true
var _mem := {}


func _init(p_product: String, root := "user://pkey", memory := false) -> void:
	product = p_product
	dir = root.path_join(p_product)
	_memory = memory
	var name_ok := PKeyClaims.whole("[A-Za-z0-9][A-Za-z0-9@._-]{0,127}").search(p_product) != null
	_root_ok = name_ok and not p_product.contains("..") and PKeyBackupExclusion.is_private_root(root)


## Epoch seconds of the last completed check or enrolment; 0 when none.
func checked_at() -> int:
	return int(_read().get("checked", 0))


func stamp(now: int) -> void:
	var r := _read()
	r["checked"] = now
	_write(r)


func clear_checked() -> void:
	var r := _read()
	r.erase("checked")
	_write(r)


## A `DELETE restore` that could not be settled (no Worker, no bearer) and goes first at the next launch.
func pending_delete() -> bool:
	return _read().get("delete") == true


func set_pending_delete(on: bool) -> void:
	var r := _read()
	if on:
		r["delete"] = true
	else:
		r.erase("delete")
	_write(r)


func _persistent() -> bool:
	return not _memory and _root_ok and not (OS.has_feature("web") and not OS.is_userfs_persistent())


func _read() -> Dictionary:
	if not _persistent():
		return _mem.duplicate()
	var path := dir.path_join(FILE)
	if not FileAccess.file_exists(path):
		return {}
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	return parsed if parsed is Dictionary else {}


func _write(r: Dictionary) -> void:
	if not _persistent():
		_mem = r.duplicate()
		return
	var path := dir.path_join(FILE)
	if r.is_empty():
		if FileAccess.file_exists(path):
			DirAccess.remove_absolute(path)
		return
	if DirAccess.make_dir_recursive_absolute(dir) != OK and not DirAccess.dir_exists_absolute(dir):
		return
	PKeyBackupExclusion.exclude(dir)
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f != null:
		f.store_string(JSON.stringify(r))
		f.close()
