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
