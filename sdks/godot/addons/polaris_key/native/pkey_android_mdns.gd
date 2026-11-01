@tool
class_name PKeyAndroidMdns
extends RefCounted
## The Android discovery lane of Cloud Connect's LAN service (CC-14b.9, D-15): `advertise` and `browse`
## with the interface `PKeyMdns` has, over the plugin's `nsd_*` ops (Android's NsdManager through
## `:platform`'s PeerNsd). Pass it to `PKeyConnectLan.start` as the `mdns` option.
##
## Only discovery is native. The listener is the LAN service's own `TCPServer`; the advert names its
## port, and a browse hit carries the addresses the OS resolved, so the LAN service dials them with
## `StreamPeerTCP` as on desktop (IPv4 and unique-local only, D-6). A row is
## {instance, txt, hosts, host, port}; there is no `native` flag and no `dial` or `set_acceptor`.
##
## The roster filter lives in the plugin: `set_accepted(names)` is the list of instance names this
## device would accept (the LAN service pushes it whenever the epoch, K_disc or the roster changes), and
## everything else is dropped natively before it takes a table slot, a watch or an event. Until the first
## call nothing is accepted. `accept` of `browse` is applied again here, as a second check.
##
## Errors: from Android 17 an app that targets it needs ACCESS_LOCAL_NETWORK. Without it, advertise and
## browse answer `nearby-permission-denied` (reason `permission_denied`) after asking the user once per
## call, and start nothing; retry after the grant. Below API 34 (no service-info callbacks) the lane
## does not exist (`create` answers null).
##
## Slots (CC-15b.GK), the same contract as `PKeyAppleMdns`: `advertise({.., slot})` takes `a` (the default),
## `v`, `p` or `c` (a contact advert, up to 8). Every slot advertises the caller's own `TCPServer` port; the
## plugin keeps one registration per slot (`a`, `v`, `p`, `c0` to `c7`). `capabilities()` says whether the plugin
## has slots and tags (`nsd_status` has `slots`); with an older plugin only slot `a` and a roster-only browse
## work, and a request for more answers `nearby-unsupported`, never a silent reuse of slot a.
## `browse(.., tags)` is `{"v": [h, h_prev], "p": [h, h_prev]}`: a `p1-` name that `accept` refuses still
## enters when its TXT is `m=<k>` and its `h` is in `tags[k]`. The plugin watches those names (at most 32)
## and the consumer checks the TXT again. There are no native pipes, so there is no `set_acceptor`.
##
## Events reach this object as the facade's `nsd_event` signal (the facade drains the plugin once per
## frame); `poll()` drains by hand.

const MAX_ROWS := 256
const MAX_HOSTS := 8
const MAX_ACCEPTED := 1024
const MAX_CONTACTS := 8
const MAX_TAGS := 2
const SLOTS := ["a", "v", "p"]

var _android: PKeyAndroid
var _on_up := Callable()
var _on_down := Callable()
var _accept := Callable()
var _browsing := false
## The native slots (a, v, p, c0 to c7) -> {up, gen, port, instance}.
var _slots: Dictionary = {}
var _caps_slots := false
## The names and tags last pushed with `nsd_accept` (one op sets both).
var _names: Array = []
var _tags: Dictionary = {}
var _error := ""
## The instances reported up and not yet down, with the signature last reported (bounded).
var _up: Dictionary = {}
## Asks the OS for a runtime permission: Callable(permission: String). Tests replace it.
var _request := Callable()


## The lane over `android` (a PKeyAndroid, or one over a fake native in tests), else the process's shared
## one. Null when this is not Android, the plugin is missing or its NSD ops are unsupported here.
static func create(android: PKeyAndroid = null, request := Callable()) -> PKeyAndroidMdns:
	if android == null:
		if OS.get_name() != "Android" or not Engine.has_singleton(PKeyAndroid.SINGLETON):
			return null
		android = PKeyAndroid.shared()
	if not android.is_available():
		return null
	var st := android.call_sync({"op": "nsd_status"})
	if not bool(st.get("ok", false)) or not bool(st.get("supported", false)):
		return null
	var out := PKeyAndroidMdns.new()
	out._android = android
	out._caps_slots = bool(st.get("slots", false))
	out._request = request if request.is_valid() else Callable(PKeyAndroidMdns, "_os_request")
	android.nsd_event.connect(out._on_event)
	return out


static func _os_request(permission: String) -> void:
	OS.request_permission(permission)


func _to_string() -> String:
	return "PKeyAndroidMdns()"


## {active, responder, querier, reason}, as `PKeyMdns.status()`: the OS is both.
func status() -> Dictionary:
	var up := _browsing or _slots.values().any(func(s): return bool(s["up"]))
	return {"active": up, "responder": up, "querier": up, "reason": _error}


## What the plugin offers: {slots, tags}, both false for an older plugin (which has slot a only).
func capabilities() -> Dictionary:
	return {"slots": _caps_slots, "tags": _caps_slots}


func _slot(name: String) -> Dictionary:
	if not _slots.has(name):
		_slots[name] = {"up": false, "gen": 0, "port": 0, "instance": ""}
	return _slots[name]


## Whether the advert of `slot` (a, v or p) is running.
func advertising(slot := "a") -> bool:
	return bool(_slot(slot)["up"])


## The port the advert of `slot` names (0 when it is not running): the caller's own listener port.
func port_of(slot := "a") -> int:
	return int(_slot(slot)["port"]) if bool(_slot(slot)["up"]) else 0


func _unsupported(what: String) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, "Nearby discovery is not available here.", {"reason": what})


## Register the advert (or move the running one to a new name). `advert.port` is the TCP listener's port.
## ok with a handle that has `stop()` and `update(instance, txt)`. `slot` is a (default), v, p or c; the
## others need `capabilities().slots`.
func advertise(advert: Dictionary) -> PKeyResult:
	var instance := str(advert.get("instance", ""))
	var port := int(advert.get("port", 0))
	var kind := str(advert.get("slot", "a"))
	var refused := _advert_refusal(instance, port, kind)
	if refused != null:
		return refused
	var name := kind
	if kind == "c":
		name = _free_contact(instance)
		if name.is_empty() or name == "dup":
			return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "No contact advert place.", {"reason": "contacts" if name.is_empty() else "instance_name"})
	var txt: Array = []
	for t in advert.get("txt", []):
		if t is String:
			txt.append(t)
	var r := _send_advert(name, instance, port, txt)
	if not bool(r.get("ok", false)):
		return _failure(r)
	var s := _slot(name)
	s["up"] = true
	s["gen"] = int(s["gen"]) + 1
	s["port"] = port
	s["instance"] = instance
	return PKeyResult.success(Handle.new(self, name, int(s["gen"])))


## The failure for an advert that cannot be asked for, or null.
func _advert_refusal(instance: String, port: int, kind: String) -> PKeyResult:
	if not PKeyPeerAdvert.is_instance_name(instance):
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Bad instance name.", {"reason": "instance_name"})
	if port < 1 or port > 65535:
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Bad port.", {"reason": "port"})
	if kind != "c" and not SLOTS.has(kind):
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Bad slot.", {"reason": "slot"})
	if kind != "a" and not _caps_slots:
		return _unsupported("slots")
	return null


func _send_advert(name: String, instance: String, port: int, txt: Array) -> Dictionary:
	var body := {"op": "nsd_advertise", "instance": instance, "port": port, "txt": txt}
	# Slot a is the plugin's default, so an older plugin is asked the way it always was.
	if name != "a" or _caps_slots:
		body["slot"] = name
	return _android.call_sync(body)


## The first contact slot (c0 to c7) that is not running, "" when all 8 are, "dup" when `instance` runs.
func _free_contact(instance: String) -> String:
	var free := ""
	for i in MAX_CONTACTS:
		var n := "c%d" % i
		var s := _slot(n)
		if bool(s["up"]):
			if s["instance"] == instance:
				return "dup"
		elif free.is_empty():
			free = n
	return free


## Browse for the roster. `on_up` gets {instance, txt, hosts, host, port} (again when the addresses or
## port change); `on_down` the instance name. `tags` is {"v": [h, h_prev], "p": [h, h_prev]}; it needs
## `capabilities().tags`.
func browse(on_up: Callable, on_down := Callable(), accept := Callable(), tags := {}) -> PKeyResult:
	if _browsing:
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Already browsing.", {"reason": "busy"})
	var clean := _clean_tags(tags)
	if not clean.is_empty() and not _caps_slots:
		return _unsupported("tags")
	var r := _android.call_sync({"op": "nsd_browse_start"})
	if not bool(r.get("ok", false)):
		return _failure(r)
	_browsing = true
	_on_up = on_up
	_on_down = on_down
	_accept = accept
	if not clean.is_empty():
		set_tags(clean)
	return PKeyResult.success(Handle.new(self, "", 0))


static func _clean_tags(tags: Dictionary) -> Dictionary:
	var out := {}
	for k in ["v", "p"]:
		var list: Array = []
		for h in tags.get(k, []):
			if h is String and not (h as String).is_empty() and list.size() < MAX_TAGS:
				list.append(h)
		if not list.is_empty():
			out[k] = list
	return out


## Replace the tags of the browse (the current and previous `h` of each kind). False when the plugin refused
## them (it then holds neither tags nor names; push the names again) or has no tags.
func set_tags(tags: Dictionary) -> bool:
	var clean := _clean_tags(tags)
	if clean.is_empty() and _tags.is_empty():
		return true
	if not _caps_slots:
		return clean.is_empty()
	return _push_accept(_names, clean)


## Replace what the plugin accepts: the names and the tags. One op sets both, so each call sends the other as
## last set. A refused list clears both natively.
func _push_accept(names: Array, tags: Dictionary) -> bool:
	var body := {"op": "nsd_accept", "names": names}
	if not tags.is_empty():
		body["tags"] = tags
	var r := _android.call_sync(body)
	var ok := bool(r.get("ok", false))
	_names = names if ok else []
	_tags = tags if ok else {}
	return ok


## The instance names to report (current and previous epoch, every delivered key). Replaces the last set.
func set_accepted(names: Array) -> bool:
	var list: Array = []
	if names.size() <= MAX_ACCEPTED:
		for n in names:
			var s := str(n)
			if not PKeyPeerAdvert.is_instance_name(s):
				list = []
				break
			list.append(s)
	# A set that did not take is cleared natively too: it must not leave the old, possibly larger one in force.
	return _push_accept(list, _tags) and list.size() == names.size()


## Drain the plugin's events by hand (the facade also does it once per frame). The number drained.
func poll() -> int:
	return _android.poll()


## End the browse and the advert (sign-out, lock, stop).
func stop() -> void:
	_android.call_sync({"op": "nsd_stop_all"})
	if _android.nsd_event.is_connected(_on_event):
		_android.nsd_event.disconnect(_on_event)
	_browsing = false
	_slots = {}
	_names = []
	_tags = {}
	_on_up = Callable()
	_on_down = Callable()
	_accept = Callable()
	_up = {}


func _on_event(e: Dictionary) -> void:
	match str(e.get("ev", "")):
		"nsd_found":
			_found(e)
		"nsd_lost":
			var name := str(e.get("instance", ""))
			if _up.erase(name) and _on_down.is_valid():
				_on_down.call(name)
		"nsd_advert":
			if not bool(e.get("ok", false)):
				var slot := str(e.get("slot", "a"))
				if _slots.has(slot):
					(_slots[slot] as Dictionary)["up"] = false
					(_slots[slot] as Dictionary)["port"] = 0
				_error = str(e.get("reason", "failed"))
		"nsd_error":
			_error = str(e.get("reason", "failed"))


func _found(d: Dictionary) -> void:
	var name := str(d.get("instance", ""))
	if not _browsing or not PKeyPeerAdvert.is_instance_name(name) or not _on_up.is_valid():
		return
	var txt: Array = []
	for t in d.get("txt", []):
		if t is String and txt.size() < 8:
			txt.append(t)
	if _accept.is_valid() and not bool(_accept.call(name)) and not _tag_admits(txt):
		return
	var port := int(d.get("port", 0))
	var hosts: Array = []
	for h in d.get("hosts", []):
		if h is String and (h as String).length() <= 64 and hosts.size() < MAX_HOSTS and not hosts.has(h):
			hosts.append(h)
	if port < 1 or port > 65535 or hosts.is_empty():
		# Nothing dialable is left: the name is lost, not kept at its old address.
		if _up.erase(name) and _on_down.is_valid():
			_on_down.call(name)
		return
	if not _up.has(name) and _up.size() >= MAX_ROWS:
		return
	var sig := "%d|%s" % [port, ",".join(PackedStringArray(hosts))]
	if _up.get(name, "") == sig:
		return
	_up[name] = sig
	_on_up.call({"instance": name, "txt": txt, "hosts": hosts, "host": hosts[0], "port": port})


## Whether a TXT is `m=<k>` with an `h` in `_tags[k]`.
func _tag_admits(txt: Array) -> bool:
	for k: String in _tags.keys():
		if txt.has("m=" + k):
			for h: String in _tags[k]:
				if txt.has("h=" + h):
					return true
	return false


## The last error the plugin reported ("" when none): permission_denied, unsupported, renamed, limit or failed.
func last_error() -> String:
	return _error


func _failure(r: Dictionary) -> PKeyResult:
	match str(r.get("error", "")):
		"permission_denied":
			_error = "permission_denied"
			# Ask now so the next attempt can succeed; Android shows its own prompt.
			_request.call(PKeyAndroidExport.LOCAL_NETWORK_PERMISSION)
			return PKeyConnectErrors.lan("permission_denied", "Local network access was refused.")
		"bad_input":
			_error = "bad_input"
			return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Local discovery refused the request.", {"reason": "bad_input"})
		"busy":
			_error = "busy"
			return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Already browsing.", {"reason": "busy"})
	_error = "unavailable"
	return PKeyConnectErrors.lan("not_listening", "Local discovery could not start.")


class Handle extends RefCounted:
	var _owner: PKeyAndroidMdns
	## "" for the browse; the native slot (a, v, p, c0 to c7) for an advert.
	var _slot: String
	var _gen: int

	func _init(owner: PKeyAndroidMdns, slot: String, gen: int) -> void:
		_owner = owner
		_slot = slot
		_gen = gen

	func _to_string() -> String:
		return "PKeyAndroidMdns.Handle()"

	func tracked() -> int:
		return _owner._up.size() if _owner != null and _slot.is_empty() else 0

	## Move the advert to a new name and TXT (the next epoch), on the same port. False when it is no longer running.
	func update(instance: String, txt: Array) -> bool:
		return _owner != null and not _slot.is_empty() and _owner._handle_update(_slot, _gen, instance, txt)

	func stop() -> void:
		if _owner == null:
			return
		var o := _owner
		_owner = null
		o._handle_stop(_slot, _gen)


func _handle_update(slot: String, gen: int, instance: String, txt: Array) -> bool:
	if not PKeyPeerAdvert.is_instance_name(instance):
		return false
	var s := _slot(slot)
	if int(s["gen"]) != gen or not bool(s["up"]):
		return false
	var clean: Array = []
	for t in txt:
		if t is String:
			clean.append(t)
	var r := _send_advert(slot, instance, int(s["port"]), clean)
	if not bool(r.get("ok", false)):
		return false
	s["instance"] = instance
	return true


## A handle that was replaced (a rotated advert) does nothing: the new name keeps running.
func _handle_stop(slot: String, gen: int) -> void:
	if not slot.is_empty():
		var s := _slot(slot)
		if gen != int(s["gen"]):
			return
		var body := {"op": "nsd_advertise_stop"}
		if slot != "a" or _caps_slots:
			body["slot"] = slot
		_android.call_sync(body)
		s["up"] = false
		s["port"] = 0
		s["instance"] = ""
	else:
		_android.call_sync({"op": "nsd_browse_stop"})
		_browsing = false
		_up = {}
		if not _tags.is_empty():
			_push_accept(_names, {})
