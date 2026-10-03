class_name PKeyL10nTableHandler
extends PKeyPackHandler
## `l10n.table` (CONTENT §4.2; P4-16): a tree of PO, CSV or JSON tables, hot through the
## TranslationServer, format versions the host lists (default [1] = those three text formats).
## Built in; a host registers a configured instance to change the versions or to hear
## activations (`on_activate(pack_id, tables)`, `on_deactivate(pack_id, tables)`).
##
## The check (after the v1 tree rule) parses every file with PKeyL10nParse, whatever its name:
## a file above `max_file_bytes` is `size`, one that is not a table `table`, a locale that is not
## a well-formed BCP-47 tag or not the variant's `locale` axis value `locale`
## (`pack-type-check-failed`, with the path). Nothing is evaluated and no `.translation` resource
## is ever loaded: each table becomes a `Translation` built in code with add_message().
##
## Activation adds one Translation per table to the TranslationServer; a swap, a rollback or a
## deactivation removes exactly the previous install's Translation objects first, so two
## releases of one pack never answer at once. Plural messages: on an engine whose Translation
## handles plurals itself (4.6+, by its locale's built-in rule) they are added with
## add_plural_message(); on older engines (no scriptable TranslationPO) only the singular form
## is added. A pack's `Plural-Forms` header is never handed to the engine (its formula would be
## evaluated by Godot's Expression), and plural_rules_override is never set from pack data.

var format_versions: Array = [1]
var max_file_bytes := 16777216
var on_activate := Callable()
var on_deactivate := Callable()
## Active tables by pack id: {location, tables, translations: Array[Translation]}.
var _active := {}


func _init(opts: Dictionary = {}) -> void:
	type = "l10n.table"
	layout = "tree"
	activation = "hot"
	PKeyL10nParse.warm()
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


## The check over files given as [{path, size, bytes}] in index order, against the variant's
## axes (`variant.variant`): {ok: true, tables} or {ok: false, code, detail, path}.
static func check_files(files: Array, axes: Variant, max_bytes := 16777216) -> Dictionary:
	var want = axes.get("locale") if axes is Dictionary else null
	var tables: Array = []
	for f in files:
		if int(f["size"]) > max_bytes:
			return type_refusal("size", f["path"])
		var r := PKeyL10nParse.parse_file(f["path"], f["bytes"])
		if not r["ok"]:
			return type_refusal(r["detail"], f["path"])
		for t in r["tables"]:
			if want is String and not PKeyL10nParse.same_locale(t["locale"], want):
				return type_refusal("locale", f["path"])
		tables.append_array(r["tables"])
	return {"ok": true, "tables": tables}


func check_payload(dir: String, _record: Dictionary, variant: Dictionary) -> Dictionary:
	var files := PKeyDataJsonHandler.read_tree(dir, max_file_bytes)
	if not files["ok"]:
		return files
	var r := check_files(files["files"], variant.get("variant"), max_file_bytes)
	if not r["ok"]:
		return r
	return {"ok": true}


## Whether this engine's Translation handles plural messages itself (Godot 4.6+).
static func native_plurals() -> bool:
	return ClassDB.class_has_method("Translation", "set_plural_rules_override")


## One Translation per table, built in code (never a loaded resource).
static func translations_of(tables: Array) -> Array:
	var plurals := native_plurals()
	var out: Array = []
	for t in tables:
		var tr := Translation.new()
		tr.locale = t["locale"]
		for m in t["messages"]:
			var ctx: String = m["context"] if m["context"] is String else ""
			if m["plural"] is String and plurals:
				tr.add_plural_message(m["id"], PackedStringArray(m["strings"]), ctx)
			else:
				tr.add_message(m["id"], m["strings"][0], ctx)
		out.append(tr)
	return out


func _remove(id: String) -> Dictionary:
	var cur = _active.get(id)
	if not (cur is Dictionary):
		return {}
	for tr in cur["translations"]:
		TranslationServer.remove_translation(tr)
	_active.erase(id)
	return cur


func activate(install: Dictionary) -> void:
	var id: String = install["packId"]
	var files := PKeyDataJsonHandler.read_tree(String(install["location"]), max_file_bytes)
	var r := check_files(files["files"], null, max_file_bytes) if files["ok"] else files
	if not r["ok"]:
		push_warning("PolarisKey: %s's l10n.table could not be read at activation." % id)
		return
	# A release replaced without a deactivation (an embedded baseline, say) leaves nothing behind.
	_remove(id)
	var trs := translations_of(r["tables"])
	for tr in trs:
		TranslationServer.add_translation(tr)
	_active[id] = {"location": install["location"], "tables": r["tables"], "translations": trs}
	if on_activate.is_valid():
		on_activate.call(id, r["tables"])


func deactivate(install: Dictionary) -> void:
	var id: String = install["packId"]
	var cur = _active.get(id)
	if cur is Dictionary and cur["location"] == install["location"]:
		_remove(id)
		if on_deactivate.is_valid():
			on_deactivate.call(id, cur["tables"])


## The active release's tables, or null.
func tables(pack_id: String) -> Variant:
	var cur = _active.get(pack_id)
	return cur["tables"] if cur is Dictionary else null


## The Translation objects the active release added (for tests and tools), or [].
func translations(pack_id: String) -> Array:
	var cur = _active.get(pack_id)
	return cur["translations"] if cur is Dictionary else []
