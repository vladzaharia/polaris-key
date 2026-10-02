class_name PKeyPackHandler
extends RefCounted
## A pack type's handler (CONTENT §4.1; client-core `PackHandler`). The engine owns the bytes; a
## handler says which formats it holds, the layout it expects and what activation does.
## `files.tree` (PKeyFilesTreeHandler) and `godot.pck` (PKeyGodotPckHandler) are built in; P4-16
## and games add more through PolarisKey.update.packs.register_handler().
##
##   type, layout ("tree" | "container"), activation ("hot" | "restart")
##   supports(format_version) -> bool
##   check_output(source, record, variant) -> {ok} or {ok: false, code, detail, path?}: a check of
##       the verified output before it is committed (godot.pck: the header and the directory)
##   activate(install)       a committed install becomes live (hot: at commit; restart: at load)
##   deactivate(install)     a live hot install is replaced or rolled back

var type := ""
var layout := "tree"
var activation := "restart"


func supports(_format_version: int) -> bool:
	return false


func check_output(_source: PKeyByteSource, _record: Dictionary, _variant: Dictionary) -> Dictionary:
	return {"ok": true}


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
