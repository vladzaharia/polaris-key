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
##
## First, every staged path must already be normalised: equal to its own `simplify_path()`
## (plans/P4-19.md §2.5 rule 1, P4-08's finding). The files index's path rules make that the
## identity on every admitted path, so this is an assertion: a path that fails it is
## `files-unsafe-path`, and nothing commits.
func check_tree(dir: String, _record: Dictionary, _variant: Dictionary) -> Dictionary:
	var paths = PKeyPackStorage.walk_tree(dir)
	if paths == null:
		return {"ok": false, "code": PKeyPck.DIRECTORY_REFUSED, "detail": "the staged tree cannot be listed", "path": ""}
	for p in paths:
		if not simplified(p):
			return {"ok": false, "code": PKeyPackFiles.FILES_UNSAFE_PATH, "detail": "%s is not a normalised path" % p, "path": p}
	return PKeyPck.tree_check(dir)


## Whether a tree path is its own `simplify_path()`. Thread-safe.
static func simplified(path: String) -> bool:
	return path != "" and path.simplify_path() == path
