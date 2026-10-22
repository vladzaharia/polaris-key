class_name PKeyToastController
extends RefCounted
## PKeyToast's headless logic: the model view of a toast, what it says, which glyph marks its status,
## and its actions (at most two). No node here, so a game drawing its own toasts reuses it as is.

const Models := preload("res://addons/polaris_key/ui/model/models.gd")

## The most actions a toast offers (UI-KITS.md §4.1).
const MAX_ACTIONS := 2


static func view(inp: Dictionary) -> Dictionary:
	return Models.view_of("Toast", inp)


## The glyph for a model state: info for info and progress, a check for success, a warning mark for
## warning and error (status is a glyph and a word, never colour alone).
static func glyph_for(state: String) -> String:
	match state:
		"success":
			return "success"
		"warning", "error":
			return "warning"
	return "info"


## `{title, consequence, data}` for the toast `t`: `data` is true when the title is someone's own
## text (a game's warning, the core's heading) and not the kit's copy.
static func words(t: Dictionary, copy: PKeyUiCopy, _progress: Dictionary = {}) -> Dictionary:
	match String(t.get("kind", "")):
		"update":
			return {"title": copy.text("toast_update_available", String(t.get("version", ""))), "consequence": String(t.get("consequence", "")), "data": false}
		"copied":
			return {"title": copy.text("copied"), "consequence": "", "data": false}
		"warning":
			return {"title": String(t.get("title", "")), "consequence": String(t.get("consequence", "")), "data": true}
		"error":
			var code := String(t.get("code", ""))
			var core := PKeyCopy.shared()
			var consequence := String(t.get("consequence", ""))
			if consequence == "":
				var r = t.get("result")
				consequence = copy.for_result(r) if r is PKeyResult else copy.for_code(code)
			return {"title": core.title(code), "consequence": consequence, "data": true}
		"progress":
			return {"title": "", "consequence": "", "data": false}
	return {"title": "", "consequence": "", "data": false}


## The actions of the toast `t`, at most MAX_ACTIONS: `[{id, key | label}]`. The toast's own list
## wins; otherwise the kind's: an update offers Update now and Dismiss, progress offers Undo, a
## warning or an error offers Dismiss, and a copied note offers none.
static func actions_for(t: Dictionary) -> Array:
	var given = t.get("actions")
	var out: Array = []
	if given is Array and not given.is_empty():
		for a in given:
			if a is Dictionary and (a.has("key") or a.has("label")) and a.has("id"):
				out.append(a)
		if out.size() > MAX_ACTIONS:
			push_warning("PKeyToast: a toast has at most %d actions; the rest are dropped." % MAX_ACTIONS)
			out = out.slice(0, MAX_ACTIONS)
		return out
	match String(t.get("kind", "")):
		"update":
			return [{"id": "install", "key": "update_install"}, {"id": "dismiss", "key": "dismiss"}]
		"progress":
			return [{"id": "undo", "key": "toast_undo"}]
		"warning", "error":
			return [{"id": "dismiss", "key": "dismiss"}]
	return []
