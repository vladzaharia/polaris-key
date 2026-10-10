extends RefCounted
## What every view model answers: the port of ui-core's `view.ts`. A view is a plain Dictionary:
##
##   component  the UI-KITS §4.1 component
##   state      one of its components.json states, or "hidden" (its service is off)
##   copy       the catalog keys of the strings the state shows, sorted
##   actions    what its controls do, sorted (`vocabulary.actions`)
##   args       the arguments its strings take (`{product}`, `{count}`, …)
##   isolate    the args that carry someone's own text, drawn in an isolated run (FSI…PDI)
##   decisions  the design language's decisions for the state (DL4, DL6, DL7, DL9, DL14):
##              primary (a copy key or null), tone ("neutral", "danger" or null), errorSlot,
##              focus (a copy key, "heading" or null), link (a link verdict or null), qr (bool)

const Context := preload("res://addons/polaris_key/ui/model/context.gd")
const Vocabulary := preload("res://addons/polaris_key/ui/model/vocabulary.gd")

## The argument names whose values are someone's own text, never the catalog's.
const ISOLATED_ARGS := ["product", "app", "developer", "device", "thisDevice", "name", "org", "tier"]

## The copy keys of fields: never focused on appear under a coarse pointer (DL9).
const FIELDS := ["part.keyField.label", "devices.renameLabel", "offlineActivation.paste"]

## Sentinel for "spec leaves `focus` out" (focus the primary, else the heading).
const UNSET := "\uE000unset"


## A view's actions: those its copy's controls perform, plus `extra` (actions with no copy key).
static func actions_for(copy: Array, extra: Array = []) -> Array:
	var out := {}
	for a in extra:
		out[a] = true
	for action in Vocabulary.ACTION_KEYS:
		for k in Vocabulary.ACTION_KEYS[action]:
			if copy.has(k):
				out[action] = true
				break
	var list := out.keys()
	list.sort()
	return list


## Build a view from a spec Dictionary:
##
##   state         required
##   copy          an Array of keys; null, false and "" entries are dropped (ui-core's
##                 `cond && "key"`)
##   extraActions  actions with no copy key of their own (`replace-in-browser`)
##   args          null values are dropped
##   primary, tone, errorSlot, link, qr
##   focus         leave out to focus the primary, or the heading when there is none; null for a
##                 view that never takes focus
static func make(ctx: RefCounted, component: String, spec: Dictionary) -> Dictionary:
	var seen := {}
	for k in spec.get("copy", []):
		if k is String and not (k as String).is_empty():
			seen[k] = true
	var copy: Array = seen.keys()
	copy.sort()
	var args := {}
	var raw_args = spec.get("args", {})
	for k in raw_args:
		if raw_args[k] != null:
			args[k] = raw_args[k]
	var isolate := []
	for k in args:
		if ISOLATED_ARGS.has(k):
			isolate.append(k)
	isolate.sort()
	var primary = spec.get("primary")
	var focus_target = spec.get("focus", UNSET)
	if focus_target is String and focus_target == UNSET:
		focus_target = primary if primary != null else "heading"
	var link = spec.get("link")
	var qr = spec.get("qr")
	if qr == null:
		qr = link.get("qr", false) if link is Dictionary else false
	return {
		"component": component,
		"state": spec["state"],
		"copy": copy,
		"actions": actions_for(copy, spec.get("extraActions", [])),
		"args": args,
		"isolate": isolate,
		"decisions": {
			"primary": primary,
			"tone": spec.get("tone"),
			"errorSlot": spec.get("errorSlot"),
			"focus": _focus_for(ctx, focus_target),
			"link": link,
			"qr": qr,
		},
	}


## DL9: a field is never focused on appear under a coarse pointer, and a TV or pad-only screen
## never focuses a control that opens a browser; both fall back to the heading.
static func _focus_for(ctx: RefCounted, target: Variant) -> Variant:
	if target == null:
		return null
	if FIELDS.has(target) and Context.coarse_pointer(ctx.platform):
		return "heading"
	var c := Context.platform_class(ctx.platform)
	if (c == "tv" or c == "console") and _opener(target):
		return "heading"
	return target


static func _opener(key: Variant) -> bool:
	for a in ["open-card", "open-browser", "open-manage-url"]:
		if Vocabulary.ACTION_KEYS[a].has(key):
			return true
	return false


## The `hidden` view: the component's service is off, so the drop-in renders nothing.
static func hidden(ctx: RefCounted, component: String) -> Dictionary:
	return make(ctx, component, {"state": Vocabulary.HIDDEN, "copy": [], "focus": null})


## Who the screens are about, for their strings (UI-KITS.md §1.2's order: the integrator, then
## the presentation, then the bundle): `{name, inlineName, developer, icon}`.
static func identity_text(ctx: RefCounted) -> Dictionary:
	var i: Dictionary = ctx.member("integrator")
	var p = ctx.input.get("presentation")
	if not (p is Dictionary):
		p = {}
	var b: Dictionary = ctx.member("bundle")
	var name = _first([i.get("name"), p.get("name"), b.get("name"), b.get("slug")])
	if name == null:
		name = ""
	var short = i.get("shortName")
	var developer = _first([i.get("developer"), p.get("developerName")])
	return {
		"name": name,
		"inlineName": short if short is String else name,
		"developer": developer,
		"icon": i.get("icon") == true or p.get("icon") == true,
	}


## JavaScript truthiness, for porting ui-core's `if (x)` and `x && "key"` exactly: null, false,
## 0, NaN and "" are falsy; every Dictionary and Array is truthy.
static func truthy(v: Variant) -> bool:
	match typeof(v):
		TYPE_NIL:
			return false
		TYPE_BOOL:
			return v
		TYPE_INT:
			return v != 0
		TYPE_FLOAT:
			return v != 0.0 and not is_nan(v)
		TYPE_STRING, TYPE_STRING_NAME:
			return not String(v).is_empty()
	return true


## ui-core's `a ?? b ?? c`: the first value that is not null.
static func first(values: Array) -> Variant:
	return _first(values)


static func _first(values: Array) -> Variant:
	for v in values:
		if v != null:
			return v
	return null
