@tool
class_name PKeyMdnsConsumers
extends RefCounted
## The browse consumers of a native discovery lane (CC-29b.G4). The OS runs one browse; the account LAN service,
## the local-link service and the pairing windows each want rows from it, so the lane keeps one `Consumer` per
## `browse()` call and the native side is told the union of what they accept: their instance names and their tags
## (`{kind: [h, h]}`, at most [constant MAX_TAGS] per kind). A row reaches a consumer only when its own `accept`
## or its own tags admit it; one consumer's names never let a row into another.

const MAX_TAGS := 2


class Consumer:
	extends RefCounted
	var on_up := Callable()
	var on_down := Callable()
	var accept := Callable()
	var tags: Dictionary = {}
	var names: Array = []
	## Instances reported up and not yet down: name -> whatever the lane keeps to tell a repeat (a tag-only flag,
	## or the address signature).
	var rows: Dictionary = {}

	func _to_string() -> String:
		return "PKeyMdnsConsumers.Consumer()"

	## Whether `txt` is `m=<k>` with an `h` in this consumer's tags for k.
	func tag_admits(txt: Array) -> bool:
		for k: String in tags.keys():
			if txt.has("m=" + k):
				for h: String in tags[k]:
					if txt.has("h=" + h):
						return true
		return false

	## Whether the consumer's roster filter lets `name` in. With no filter every name is let in, unless the consumer
	## holds tags: then it wants tagged rows only.
	func accepts(name: String) -> bool:
		if accept.is_valid():
			return bool(accept.call(name))
		return tags.is_empty()


var _list: Array = []


func is_empty() -> bool:
	return _list.is_empty()


func size() -> int:
	return _list.size()


func all() -> Array:
	return _list.duplicate()


func add(on_up: Callable, on_down: Callable, accept: Callable, tags: Dictionary) -> Consumer:
	var c := Consumer.new()
	c.on_up = on_up
	c.on_down = on_down
	c.accept = accept
	c.tags = tags
	_list.append(c)
	return c


func remove(c: Consumer) -> void:
	_list.erase(c)


func clear() -> void:
	_list = []


func has(c: Consumer) -> bool:
	return _list.has(c)


## The consumer an unkeyed `set_accepted` belongs to: the first one.
func first() -> Consumer:
	return _list.front() if not _list.is_empty() else null


## The consumer that holds a tag kind in `tags` (an unkeyed `set_tags`), else the last one.
func owner_of(tags: Dictionary) -> Consumer:
	for c: Consumer in _list:
		for k in tags.keys():
			if c.tags.has(k):
				return c
	return _list.back() if not _list.is_empty() else null


## Every instance name any consumer accepts.
func names() -> Array:
	var seen := {}
	for c: Consumer in _list:
		for n in c.names:
			seen[n] = true
	return seen.keys()


## The union of the consumers' tags per kind, within the bound.
func tags() -> Dictionary:
	var out := {}
	for c: Consumer in _list:
		for k: String in c.tags.keys():
			var list: Array = out.get(k, [])
			for h in c.tags[k]:
				if not list.has(h) and list.size() < MAX_TAGS:
					list.append(h)
			out[k] = list
	return out
