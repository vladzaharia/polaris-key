class_name PKeyHolderText
extends RefCounted
## What the two holder scenes share (ActivateDone, AddToAccount): the arguments a model's view names,
## made ready for the catalog, and the reason lines of the recommendation.

const Context := preload("res://addons/polaris_key/ui/model/context.gd")

## The recommendation's reason keys, in the order they show.
const REASONS := ["activate.recommend.sync", "activate.recommend.recover", "activate.recommend.devices", "activate.recommend.portal"]


## The enabled services left when `off` are turned off (closed under `requires`).
static func services_without(off: Array) -> Array:
	return Context.services_without(off)


## The view's arguments as the catalog takes them: someone's own text (the product, the developer, a
## tier) in an isolated run, a whole number without its decimals.
static func args_of(view: Dictionary) -> Dictionary:
	var out := {}
	var raw: Dictionary = view.get("args", {})
	var isolate: Array = view.get("isolate", [])
	for k in raw:
		var v = raw[k]
		if v is float and v == floorf(v):
			v = int(v)
		var text := str(v)
		out[k] = PKeyUiTheme.isolate(text) if isolate.has(k) else (text if v is String else v)
	return out


## The reason keys an ActivateDone view names, in order.
static func reasons(view: Dictionary) -> Array:
	var copy: Array = view.get("copy", [])
	return REASONS.filter(func(k): return copy.has(k))
