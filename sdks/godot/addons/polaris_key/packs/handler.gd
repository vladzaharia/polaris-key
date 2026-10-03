class_name PKeyPackHandler
extends RefCounted
## A pack type's handler (CONTENT §4.1; client-core `PackHandler`). The engine owns the bytes; a
## handler says which formats it holds, the layout it expects and what activation does.
## `files.tree` (PKeyFilesTreeHandler) and `godot.pck` (PKeyGodotPckHandler) are built in; P4-16
## and games add more through PolarisKey.update.packs.register_handler().
##
## Replacing the built-in `files.tree` handler (register_handler with type `files.tree`) drops its
## `check_tree`, and with it the `simplify_path()` identity assertion and the resource scan over
## staged trees (plans/P4-19.md §2.5 rule 1). A replacement is host code and trusted as such; the
## engine's data-only rule for delegated installs still runs, since it gates the tree sink itself.
##
##   type, layout ("tree" | "container"), activation ("hot" | "restart")
##   supports(format_version) -> bool
##   check_output(source, record, variant) -> {ok} or {ok: false, code, detail, path?}: a check of
##       the verified output before it is committed (godot.pck: the header and the directory)
##   check_tree(dir, record, variant)  the same for a staged tree. The base runs the v1 Godot
##       tree rule first (PKeyPck.tree_check: a script, a native library or a resource that embeds
##       code is refused), then check_payload(); so a game's `custom.*` handler that does not
##       override check_tree keeps the rule (P4-16: custom types never relax it)
##   check_payload(dir, record, variant)  the type-specific check of a staged tree (P4-16): {ok}
##       or {ok: false, code, detail, path}; the hook a game's handler overrides. The built-in
##       types refuse with `pack-type-check-failed` and a detail token (CONTENT §4.2). A handler
##       PARSES untrusted bytes and never evaluates them (no str_to_var, ConfigFile,
##       JSON.to_native with objects, ResourceLoader or load_resource_pack on a tree)
##   THREADS: check_output, check_tree and check_payload run on a WorkerThreadPool thread (the
##       engine's PKeyPackJob), never the main thread. A game's `custom.*` check_payload may read
##       files and parse bytes, but must not touch nodes, the SceneTree, resources being loaded or
##       any other main-thread-only API, and must not compile RegEx lazily into shared state
##       (compile in _init or a static initialiser, on the main thread)
##   activate(install)       a committed install becomes live (hot: at commit; restart: at load)
##   deactivate(install)     a live hot install is replaced or rolled back

var type := ""
var layout := "tree"
var activation := "restart"


func supports(_format_version: int) -> bool:
	return false


func check_output(_source: PKeyByteSource, _record: Dictionary, _variant: Dictionary) -> Dictionary:
	return {"ok": true}


## The same check over a staged TREE payload (`dir`) before it commits: the v1 Godot tree rule,
## then the type's own check.
func check_tree(dir: String, record: Dictionary, variant: Dictionary) -> Dictionary:
	var v1 := PKeyPck.tree_check(dir)
	if not v1["ok"]:
		return v1
	var r = check_payload(dir, record, variant)
	if r is Dictionary and r.get("ok") == true:
		return {"ok": true}
	# A refusal keeps its code (a game may name its own); a detail that is not a token, or a
	# check that returned something else, is `check`.
	var out := {"ok": false, "code": PKeyConstants.ErrorCode.PACK_TYPE_CHECK_FAILED, "detail": "check", "path": ""}
	if r is Dictionary:
		if r.get("code") is String and r["code"] != "":
			out["code"] = r["code"]
		var d = r.get("detail")
		if d is String and _token_re().search(d) != null:
			out["detail"] = d
		if r.get("path") is String:
			out["path"] = r["path"]
	return out


## Compiled eagerly when the class loads (on the main thread, before any check runs on a worker).
static var _token: RegEx = RegEx.create_from_string("\\A[a-z][a-z0-9-]{0,31}\\z")


static func _token_re() -> RegEx:
	return _token


## The type-specific check of a staged tree (`dir`): {ok} or {ok: false, code, detail, path}.
func check_payload(_dir: String, _record: Dictionary, _variant: Dictionary) -> Dictionary:
	return {"ok": true}


## The files of a staged or installed tree, by index path in byte order (the `.pkey/` index kept
## inside a committed tree is not one of them); null when it cannot be listed.
static func tree_files(dir: String) -> Variant:
	var paths = PKeyPackStorage.walk_tree(dir)
	if paths == null:
		return null
	var out: Array = Array(paths)
	out.sort_custom(func(a, b): return PKeyPackClaims.compare_bytes(a, b) < 0)
	return out


## The refusal a built-in type's check returns (`pack-type-check-failed`).
static func type_refusal(detail: String, path: String) -> Dictionary:
	return {"ok": false, "code": PKeyConstants.ErrorCode.PACK_TYPE_CHECK_FAILED, "detail": detail, "path": path}


func activate(_install: Dictionary) -> void:
	pass


func deactivate(_install: Dictionary) -> void:
	pass


## A handler shaped right for the engine: {type, layout, activation, supports}.
static func valid(h: Variant) -> bool:
	if not (h is Object) or not h.has_method("supports"):
		return false
	var t = h.get("type")
	var l = h.get("layout")
	var a = h.get("activation")
	return t is String and t != "" and l is String and (l == "tree" or l == "container") and a is String and (a == "hot" or a == "restart")
