class_name PKeyDataJsonHandler
extends PKeyPackHandler
## `data.json` (CONTENT §4.2; P4-16; client-core `packs/handlers/types.ts`): a tree of JSON
## documents (balance tables, event definitions), hot, format versions the host lists (default
## [1]). Built in; a host registers a configured instance to change the versions or to hear
## activations:
##
##   PolarisKey.update.packs.register_handler(PKeyDataJsonHandler.new({
##       "format_versions": [1, 2], "on_activate": func(pack_id, documents): ...,
##       "on_deactivate": func(pack_id): ...}))
##
## Every file is parsed with the strict parser (PKeyJson: RFC 8259, no BOM, no duplicate member,
## no trailing comma, nothing after the value; the top-level value an object), whatever its name:
## content is judged by bytes.
## Nothing is evaluated: the documents are plain Variants (Dictionary, Array, String, float,
## bool, null), never objects (no str_to_var, ConfigFile or JSON.to_native). Tiny, frequently
## tuned values belong in managed config (a signed config document), not in a pack.
##
## The check runs over the staged tree before it commits (after the v1 tree rule): a file above
## `max_file_bytes` is `size`, a file that is not strict JSON `json` (`pack-type-check-failed`,
## with the path). Activation keeps documents(pack_id): path → value, in index order.

var format_versions: Array = [1]
var max_file_bytes := 16777216
var on_activate := Callable()
var on_deactivate := Callable()
## Active documents by pack id: {location, documents}.
var _active := {}


func _init(opts: Dictionary = {}) -> void:
	type = "data.json"
	layout = "tree"
	activation = "hot"
	if opts.get("format_versions") is Array:
		format_versions = opts["format_versions"]
	if opts.has("max_file_bytes"):
		max_file_bytes = int(opts["max_file_bytes"])
	if opts.get("on_activate") is Callable:
		on_activate = opts["on_activate"]
	if opts.get("on_deactivate") is Callable:
		on_deactivate = opts["on_deactivate"]


func supports(format_version: int) -> bool:
	return format_versions.has(format_version)


## The check over files given as [{path, size, bytes}] in index order: {ok: true, documents} or
## {ok: false, code, detail, path}. `bytes` may be empty for a file above the limit.
static func check_files(files: Array, max_bytes := 16777216) -> Dictionary:
	var documents := {}
	for f in files:
		if int(f["size"]) > max_bytes:
			return type_refusal("size", f["path"])
		var r := PKeyJson.parse_bytes(f["bytes"])
		if not r["ok"] or not (r["value"] is Dictionary):
			return type_refusal("json", f["path"])
		documents[f["path"]] = r["value"]
	return {"ok": true, "documents": documents}


## The files under `dir`, read for a check (a file above `max_bytes` is not read): {ok: true,
## files} or, when the tree cannot be listed or a file read, the `unreadable` refusal (its path).
static func read_tree(dir: String, max_bytes: int) -> Dictionary:
	var paths = tree_files(dir)
	if paths == null:
		return type_refusal("unreadable", "")
	var out: Array = []
	for p in paths:
		var f := FileAccess.open(dir.path_join(p), FileAccess.READ)
		if f == null:
			return type_refusal("unreadable", p)
		var size := int(f.get_length())
		var bytes := PackedByteArray()
		if size <= max_bytes:
			bytes = f.get_buffer(size)
			if bytes.size() != size:
				return type_refusal("unreadable", p)
		f.close()
		out.append({"path": p, "size": size, "bytes": bytes})
	return {"ok": true, "files": out}


func check_payload(dir: String, _record: Dictionary, _variant: Dictionary) -> Dictionary:
	var files := read_tree(dir, max_file_bytes)
	if not files["ok"]:
		return files
	var r := check_files(files["files"], max_file_bytes)
	if not r["ok"]:
		return r
	return {"ok": true}


func activate(install: Dictionary) -> void:
	var id: String = install["packId"]
	var files := read_tree(String(install["location"]), max_file_bytes)
	var r := check_files(files["files"], max_file_bytes) if files["ok"] else files
	if not r["ok"]:
		push_warning("PolarisKey: %s's data.json documents could not be read at activation." % id)
		return
	_active[id] = {"location": install["location"], "documents": r["documents"]}
	if on_activate.is_valid():
		on_activate.call(id, r["documents"])


func deactivate(install: Dictionary) -> void:
	var id: String = install["packId"]
	var cur = _active.get(id)
	if cur is Dictionary and cur["location"] == install["location"]:
		_active.erase(id)
		if on_deactivate.is_valid():
			on_deactivate.call(id)


## The active release's documents (path → value), or null.
func documents(pack_id: String) -> Variant:
	var cur = _active.get(pack_id)
	return cur["documents"] if cur is Dictionary else null
