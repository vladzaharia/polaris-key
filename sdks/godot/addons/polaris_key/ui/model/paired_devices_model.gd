class_name PKeyPairedDevicesModel
extends RefCounted
## PairedDevicesModel (CC-29K): the list of devices this one paired with by a code, the port of
## ui-core's `pairedDevicesModel.ts`, over the same `links` object as `PKeyLocalPairingModel`. It
## re-reads `list()` on `on_change`, so a pairing, a rename in another window, a forget or a gate flip
## shows without a refresh.
##
##   - rows: the switch column's rule is `Local.show_switch_column` (more than 8, or one off);
##   - Rename and Forget work in the row: a refused name keeps its text and says why; after a Forget
##     focus moves to the next row, or the title when none is left;
##   - a switch the SDK refuses with cap `reachable` says "Up to 8 can connect", never the 32-device
##     copy; an unreadable record is "load-failed" with Try again;
##   - with the gate off only Rename and Forget remain, and the host's entry shows while a link is
##     held (`entryVisible`).
##
## `links` calls: `local_pairing()`, `list()`, `rename(id, label)`, `remove(id)`,
## `set_reachable(id, bool)` and `on_change(fn)` (answers the Callable that unsubscribes).

## The snapshot changed (`snapshot()`).
signal changed(snapshot: Dictionary)

const Context := preload("res://addons/polaris_key/ui/model/context.gd")
const Local := preload("res://addons/polaris_key/ui/model/local.gd")

## The views' other input.
var base: Dictionary = {}
## An answer the host gave about a device (its own connection's), shown with the list.
var host_notice: Variant = null

var _links: Object = null
var _unsubscribe: Callable = Callable()
## `step`, `devices`, `target`, `renameError`, `forgetError`, `notice`, plus `draft`, `focus` (where
## focus goes after an edit: {"kind": "row", "id"} or {"kind": "title"} or null), `loaded`,
## `entryVisible`, `left`, `pairAnother`.
var _s: Dictionary = {}


func _init(options: Dictionary) -> void:
	_links = options["links"]
	base = options.get("base", {})
	# Nothing is said about what is paired until the first read answers.
	_s = {
		"step": "loading",
		"devices": [],
		"draft": "",
		"focus": null,
		"loaded": false,
		"entryVisible": false,
		"left": false,
		"pairAnother": false,
	}


func snapshot() -> Dictionary:
	return _s


func _emit() -> void:
	changed.emit(_s)


## The views' input: the base with the step on top.
func input() -> Dictionary:
	var out := base.duplicate(true)
	var list := _s.duplicate(true)
	for k in ["draft", "focus", "loaded", "entryVisible", "left", "pairAnother"]:
		list.erase(k)
	var notice: Variant = list.get("notice")
	if notice == null:
		notice = host_notice
	if notice == null and base.get("pairedDevices") is Dictionary:
		notice = base["pairedDevices"].get("notice")
	if notice != null:
		list["notice"] = notice
	out["pairedDevices"] = list
	return out


func view() -> Dictionary:
	return Local.paired_devices_view(Context.new(input()))


## Read the list and follow the SDK's changes until `stop()`.
func start() -> void:
	if not _unsubscribe.is_valid():
		_unsubscribe = _links.on_change(Callable(self, "_on_links_changed"))
	refresh()


func stop() -> void:
	if _unsubscribe.is_valid():
		_unsubscribe.call()
	_unsubscribe = Callable()


func _on_links_changed() -> void:
	refresh()


## Read `list()` and the gate again (also Try again).
func refresh() -> void:
	# Try again from a failed read shows the loading treatment, not the stale failure.
	if _s.get("step") == "load-failed":
		_s["step"] = "loading"
	var on: bool = _links.local_pairing()
	var r: PKeyResult = _links.list()
	if not r.ok:
		_s.merge(
			{"step": "load-failed", "devices": [], "loaded": true, "entryVisible": false}, true
		)
		_emit()
		return
	var devices: Array = []
	for row in r.detail:
		(
			devices
			. append(
				{
					"id": row["id"],
					"label": row.get("label"),
					"lastSeen": row.get("last_seen"),
					"reachable": row.get("reachable") == true,
					"platform": row.get("platform"),
				}
			)
		)
	var editing: bool = _s.get("step") == "renaming" or _s.get("step") == "forgetting"
	var still_there := false
	if editing:
		for d in devices:
			if d["id"] == _s.get("target"):
				still_there = true
	_s["devices"] = devices
	_s["loaded"] = true
	_s["entryVisible"] = on or not devices.is_empty()
	_s["step"] = "off" if not on else (_s["step"] if still_there else "list")
	if not on or not still_there:
		_s.erase("target")
		_s.erase("renameError")
	_emit()


# ── Rows ─────────────────────────────────────────────────────────────────────────────────────


func _device(id: String) -> Dictionary:
	for d in _s["devices"]:
		if d["id"] == id:
			return d
	return {}


## Rename, from the row's menu. The field starts with the name now held.
func start_rename(id: String) -> void:
	var d := _device(id)
	if d.is_empty():
		return
	_s.merge(
		{
			"step": "renaming",
			"target": id,
			"draft": String(d["label"]) if d["label"] != null else "",
			"focus": null
		},
		true
	)
	_s.erase("renameError")
	_emit()


func set_draft(text: String) -> void:
	if _s["step"] == "renaming":
		_s["draft"] = text
		_s.erase("renameError")
		_emit()


## Save: a refused name keeps its text and focus and says why. Nothing is sent to the other device.
func save_rename() -> void:
	if _s["step"] != "renaming" or not _s.has("target"):
		return
	var name := String(_s["draft"]).strip_edges()
	var error := ""
	if name == "":
		error = "empty"
	elif name.length() > Local.MAX_NAME:
		error = "long"
	if error != "":
		_s["renameError"] = error
		_emit()
		return
	var target: String = _s["target"]
	var r: PKeyResult = _links.rename(target, name)
	if not r.ok:
		# `bad_input` is a name the SDK cleans to nothing; any other refusal is the store's. The text
		# and the focus stay either way.
		var reason := (
			String((r.detail as Dictionary).get("reason", "")) if r.detail is Dictionary else ""
		)
		_s["renameError"] = "empty" if reason == "bad_input" else "failed"
		_emit()
		return
	_end_edit(target)
	refresh()


## Forget, from the row's menu: asks inside the row.
func ask_forget(id: String) -> void:
	if _device(id).is_empty():
		return
	_s.merge({"step": "forgetting", "target": id, "focus": null}, true)
	_s.erase("renameError")
	_s.erase("forgetError")
	_emit()


## Forget: deletes it here only; the other device is not told. Focus moves on.
func confirm_forget() -> void:
	if _s["step"] != "forgetting" or not _s.has("target"):
		return
	var rows: Array = _s["devices"]
	var target: String = _s["target"]
	var at := -1
	for i in rows.size():
		if rows[i]["id"] == target:
			at = i
	var next: Dictionary = {}
	if at >= 0 and at + 1 < rows.size():
		next = rows[at + 1]
	elif at - 1 >= 0:
		next = rows[at - 1]
	var r: PKeyResult = _links.remove(target)
	if not r.ok:
		# Not forgotten: the question stays, with the reason, so Forget can be pressed again.
		_s["forgetError"] = true
		_emit()
		return
	_end_edit("")
	refresh()
	var still := false
	for d in _s["devices"]:
		if not next.is_empty() and d["id"] == next["id"]:
			still = true
	_s["focus"] = {"kind": "row", "id": next["id"]} if still else {"kind": "title"}
	_emit()


## Cancel an edit: the row is as it was.
func cancel_edit() -> void:
	_end_edit(String(_s.get("target", "")))


## The edit is over: the list again, with focus back on the row's menu button unless the row is gone.
func _end_edit(row: String) -> void:
	_s["step"] = "list" if _links.local_pairing() else "off"
	for k in ["target", "renameError", "forgetError"]:
		_s.erase(k)
	_s["draft"] = ""
	_s["focus"] = {"kind": "row", "id": row} if row != "" else null
	_emit()


## A Can connect switch. A ninth is refused by the SDK (cap `reachable`); the list says "Up to 8 can
## connect" itself, so the refusal changes nothing but the re-read that puts the switch back.
func set_reachable(id: String, on: bool) -> void:
	_links.set_reachable(id, on)
	refresh()


## The answer of the app's own connection to a device, shown with the list: `kind` is "not-found",
## "busy", "unknown" or "" for none.
func report(id: String, kind: String) -> void:
	var d := _device(id)
	if kind != "" and not d.is_empty():
		_s["notice"] = {
			"device": String(d["label"]) if d["label"] != null else "", "kind": kind, "id": id
		}
	else:
		_s.erase("notice")
	_emit()


## Pair with a Code, the one primary.
func request_pair() -> void:
	_s["pairAnother"] = true
	_emit()


## Done.
func done() -> void:
	stop()
	_s["left"] = true
	_emit()
