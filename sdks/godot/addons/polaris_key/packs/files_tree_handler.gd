class_name PKeyFilesTreeHandler
extends PKeyPackHandler
## `files.tree` (CONTENT §4.2): a directory tree, hot, format version 1. Activation is the
## pointer swap: the committed tree lives in its own versioned directory
## (`user://pkey/trees/<treeDigest>/`) and the state's pointer names it, so a game reading
## PolarisKey.update.packs.path(id) after `pack_ready` sees the new files at once; nothing in a
## committed tree is ever rewritten.


func _init() -> void:
	type = "files.tree"
	layout = "tree"
	activation = "hot"


func supports(format_version: int) -> bool:
	return format_version == 1


## A Godot can load a tree's resources (`ResourceLoader.load("user://…")`), so every file sniffed
## as a Godot resource passes the same embedded-code check as a `godot.pck` entry before the tree
## commits (P4-08 review N5), and a script or native library is refused by name.
func check_tree(dir: String, _record: Dictionary, _variant: Dictionary) -> Dictionary:
	return PKeyPck.tree_check(dir)
