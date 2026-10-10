class_name PKeySettingsController
extends RefCounted
## PKeySettingsPanel's headless logic (notes/A2 §10–§11): the rows a settings screen shows, built
## from PolarisKey.config's catalog (fetched, else the compiled mirror) and its resolver, never
## from a second copy of the precedence rules.
##
##   rows        one per non-hidden `config` entry (secrets and flags are not settings), plus any
##               key the verified document carries that no catalog names; `hidden` is never shown
##               (the document's state, or the catalog's managementDefault when the document does
##               not carry the key)
##   order       grouped by `category` (categories by their smallest ui.order, then first
##               appearance), each sorted by `ui.order`, then key
##   widget      ui.widget, else from the schema: switch (boolean) → CheckButton, stepper
##               (number, integer) → SpinBox, select (an enum) → OptionButton with optionLabels,
##               textarea → TextEdit, password → masked LineEdit, text → LineEdit; an object or
##               array is shown read-only
##   enforced    disabled, with a lock and "Set by <product>"
##   editable    every other row writes the override store (PKeyOverrideStore); `reset` shows
##               while the player's own value is in use
##   badge       the provenance: local, env, remote default, fallback (enforced: locked)
##   visible     false while `dependsOn` {key, equals} does not hold
##   advanced    ui.advanced: behind the panel's toggle

const BADGES := {
	&"local": "settings_badge_local",
	&"env": "settings_badge_env",
	&"remote-default": "settings_badge_remote_default",
	&"fallback": "settings_badge_fallback",
	&"enforced": "settings_locked",
}


static func rows(config: PKeyConfig) -> Array:
	var out: Array = []
	if config == null:
		return out
	var doc_rows := {}
	for e in config.list_user_config():
		doc_rows[e.key] = e
	var seen := {}
	var position := 0
	var entries: Array = config.catalog().get("entries", [])
	for e in entries:
		if not (e is Dictionary) or e.get("kind") != "config" or not (e.get("key") is String):
			continue
		var key: String = e["key"]
		seen[key] = true
		var source := config.get_source(key)
		if source == &"hidden":
			continue
		if not doc_rows.has(key) and e.get("managementDefault") == "hidden":
			continue
		out.append(_row(config, key, e, source, position))
		position += 1
	for key in doc_rows:
		if not seen.has(key):
			out.append(_row(config, key, {}, config.get_source(key), position))
			position += 1
	_sort(out)
	for r in out:
		r["visible"] = _depends_holds(config, r["depends_on"])
	return out


static func _row(config: PKeyConfig, key: String, entry: Dictionary, source: StringName, position: int) -> Dictionary:
	var ui: Dictionary = entry.get("ui", {}) if entry.get("ui") is Dictionary else {}
	var schema: Dictionary = entry.get("schema", {}) if entry.get("schema") is Dictionary else {}
	var value = config.get_value(key, entry.get("default"))
	var widget := widget_for(ui, schema)
	var enforced := source == &"enforced"
	var options: Array = []
	if widget == "select":
		var labels: Dictionary = ui.get("optionLabels", {}) if ui.get("optionLabels") is Dictionary else {}
		for v in schema.get("enum", []):
			options.append([v, String(labels.get(str(v), str(v)))])
	return {
		"key": key,
		"label": String(entry.get("label", key)) if entry.get("label") is String else key,
		"description": String(entry.get("description", "")) if entry.get("description") is String else "",
		"category": String(entry.get("category", "")) if entry.get("category") is String else "",
		"order": float(ui["order"]) if PKeyClaims.is_number(ui.get("order")) else INF,
		"position": position,
		"widget": widget,
		"value": value,
		"source": source,
		"enforced": enforced,
		"editable": not enforced and widget != "readonly",
		"reset": source == &"local" and not enforced,
		"badge": String(BADGES.get(source, "")),
		"options": options,
		"min": float(schema["minimum"]) if PKeyClaims.is_number(schema.get("minimum")) else -1e9,
		"max": float(schema["maximum"]) if PKeyClaims.is_number(schema.get("maximum")) else 1e9,
		"step": float(ui["step"]) if PKeyClaims.is_number(ui.get("step")) else (1.0 if schema.get("type") == "integer" else 0.05),
		"integer": schema.get("type") == "integer",
		"unit": String(ui.get("unit", "")) if ui.get("unit") is String else "",
		"placeholder": String(ui.get("placeholder", "")) if ui.get("placeholder") is String else "",
		"advanced": ui.get("advanced") == true,
		"depends_on": entry.get("dependsOn") if entry.get("dependsOn") is Dictionary else null,
		"accessor": String(entry.get("accessor", "")) if entry.get("accessor") is String else "",
	}


## The control a catalog entry asks for.
static func widget_for(ui: Dictionary, schema: Dictionary) -> String:
	var w = ui.get("widget")
	if w in ["switch", "stepper", "select", "textarea", "password"]:
		return w
	match schema.get("type"):
		"boolean":
			return "switch"
		"number", "integer":
			return "stepper"
		"string":
			return "select" if schema.get("enum") is Array else "text"
	if schema.get("enum") is Array:
		return "select"
	return "readonly"


static func _depends_holds(config: PKeyConfig, dep: Variant) -> bool:
	if not (dep is Dictionary) or not (dep.get("key") is String):
		return true
	return PKeyConfig._same(config.get_value(dep["key"]), dep.get("equals"))


static func _sort(rows: Array) -> void:
	var cat_rank := {}
	for r in rows:
		var c: String = r["category"]
		var rank: Array = cat_rank.get(c, [INF, r["position"]])
		cat_rank[c] = [minf(rank[0], r["order"]), mini(rank[1], r["position"])]
	rows.sort_custom(func(a, b):
		var ra: Array = cat_rank[a["category"]]
		var rb: Array = cat_rank[b["category"]]
		if ra != rb:
			return ra[0] < rb[0] or (ra[0] == rb[0] and ra[1] < rb[1])
		if a["order"] != b["order"]:
			return a["order"] < b["order"]
		return a["key"] < b["key"])


## The name "Set by …" names: the product's name from this session's discovery document, else its
## slug.
static func product_name(sdk: Node) -> String:
	if sdk == null or sdk.get("core") == null:
		return String(PKeyUiTheme.product_identity()["name"])
	var m = sdk.core.discovery_manifest
	if m is Dictionary and m.get("developerName") is String and m["developerName"] != "":
		return m["developerName"]
	if m is Dictionary and m.get("name") is String and m["name"] != "":
		return m["name"]
	# The product's name from the options or the project, never its slug.
	var n := String(PKeyUiTheme.product_identity()["name"])
	return n
