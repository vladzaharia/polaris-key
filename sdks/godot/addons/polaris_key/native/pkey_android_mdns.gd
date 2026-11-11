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
##
## Local pairing (CC-29b.G4): slot `q` is the pairing window's advert (the window's own `TCPServer` port, `m=q`) and
## slot `l` the `m=l` adverts of the reachable local links (up to 8, the plugin's `l0` to `l7`, all on the local
## service's port). Both need `capabilities().local`. `q` is a tag kind of `browse`; the `m=l` names come through
## `set_accepted`. Any number of `browse` calls may be open at once: the plugin runs one, and every call gets the
## rows its own `accept` or tags admit (see `PKeyMdnsConsumers`).

const MAX_ROWS := 256
const MAX_HOSTS := 8
const MAX_ACCEPTED := 1024
const MAX_CONTACTS := 8
const MAX_TAGS := 2
const SLOTS := ["a", "v", "p", "q"]
const TAG_KINDS := ["v", "p", "q"]
const MAX_LOCALS := 8

var _android: PKeyAndroid
var _consumers := PKeyMdnsConsumers.new()
## The rows last reported by the plugin, so a browse that opens later is told what is already up.
var _last: Dictionary = {}
## The native slots (a, v, p, c0 to c7) -> {up, gen, port, instance}.
var _slots: Dictionary = {}
var _caps_slots := false
var _caps_local := false
## The names and tags last pushed with `nsd_accept` (one op sets both): the union of the browses'.
var _names: Array = []
var _tags: Dictionary = {}
var _error := ""
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
	out._caps_local = out._caps_slots and bool(st.get("local", false))
	out._request = request if request.is_valid() else Callable(PKeyAndroidMdns, "_os_request")
	android.nsd_event.connect(out._on_event)
	return out


static func _os_request(permission: String) -> void:
	OS.request_permission(permission)


func _to_string() -> String:
	return "PKeyAndroidMdns()"


## {active, responder, querier, reason}, as `PKeyMdns.status()`: the OS is both.
func status() -> Dictionary:
	var up := not _consumers.is_empty() or _slots.values().any(func(s): return bool(s["up"]))
	return {"active": up, "responder": up, "querier": up, "reason": _error}


## What the plugin offers: {slots, tags, local}, all false for an older plugin (which has slot a only); `local` is
## slots q and l and the q tag kind.
func capabilities() -> Dictionary:
	return {"slots": _caps_slots, "tags": _caps_slots, "local": _caps_local}


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
	if kind == "c" or kind == "l":
		name = _free_multi(kind, instance)
		if name.is_empty() or name == "dup":
			return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "No advert place.", {"reason": ("contacts" if kind == "c" else "locals") if name.is_empty() else "instance_name"})
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
	if kind != "c" and kind != "l" and not SLOTS.has(kind):
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Bad slot.", {"reason": "slot"})
	if kind != "a" and not _caps_slots:
		return _unsupported("slots")
	if (kind == "q" or kind == "l") and not _caps_local:
		return _unsupported("local")
	return null


func _send_advert(name: String, instance: String, port: int, txt: Array) -> Dictionary:
	var body := {"op": "nsd_advertise", "instance": instance, "port": port, "txt": txt}
	# Slot a is the plugin's default, so an older plugin is asked the way it always was.
	if name != "a" or _caps_slots:
		body["slot"] = name
	return _android.call_sync(body)


## The first slot of a set (`c` or `l`: c0 to c7, l0 to l7) that is not running, "" when all 8 are, "dup" when
## `instance` runs.
func _free_multi(prefix: String, instance: String) -> String:
	var free := ""
	for i in MAX_CONTACTS:
		var n := "%s%d" % [prefix, i]
		var s := _slot(n)
		if bool(s["up"]):
			if s["instance"] == instance:
				return "dup"
		elif free.is_empty():
			free = n
	return free


## Browse for the roster. `on_up` gets {instance, txt, hosts, host, port} (again when the addresses or
## port change); `on_down` the instance name. `tags` is {"v": [h, h_prev], "p": [h, h_prev], "q": [h, h_prev]}; it
## needs `capabilities().tags`, and q `.local`. Several browses may be open: each is told only what its own `accept`
## and tags admit. The handle also has `set_accepted(names)` and `set_tags(tags)` for this browse alone.
func browse(on_up: Callable, on_down := Callable(), accept := Callable(), tags := {}) -> PKeyResult:
	var clean := _clean_tags(tags)
	if not clean.is_empty() and not _caps_slots:
		return _unsupported("tags")
	if clean.has("q") and not _caps_local:
		return _unsupported("local")
	if _consumers.is_empty():
		var r := _android.call_sync({"op": "nsd_browse_start"})
		if not bool(r.get("ok", false)):
			return _failure(r)
	var c := _consumers.add(on_up, on_down, accept, {})
	if not clean.is_empty():
		c.tags = clean
		_push_union()
	for d: Dictionary in _last.values():
		_found_for(c, d)
	return PKeyResult.success(Handle.new(self, "", 0, c))


static func _clean_tags(tags: Dictionary) -> Dictionary:
	var out := {}
	for k in TAG_KINDS:
		var list: Array = []
		for h in tags.get(k, []):
			if h is String and not (h as String).is_empty() and list.size() < MAX_TAGS:
				list.append(h)
		if not list.is_empty():
			out[k] = list
	return out


## Replace the tags of the browse that holds those kinds (else the newest) with `tags` (the current and previous
## `h` of each kind). False when the plugin refused them (it then holds neither tags nor names; push the names
## again) or has no tags.
func set_tags(tags: Dictionary, owner: PKeyMdnsConsumers.Consumer = null) -> bool:
	var clean := _clean_tags(tags)
	if clean.is_empty() and _tags.is_empty():
		return true
	if not _caps_slots:
		return clean.is_empty()
	var c := owner if owner != null else _consumers.owner_of(clean)
	if c == null:
		return _push_accept(_names, clean)
	c.tags = clean
	return _push_union()


## Send the names and tags every browse wants. A refused push clears them all.
func _push_union() -> bool:
	return _push_accept(_consumers.names(), _consumers.tags())


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
	if not ok:
		for c: PKeyMdnsConsumers.Consumer in _consumers.all():
			c.names = []
			c.tags = {}
	return ok


## The instance names to report (current and previous epoch, every delivered key). Replaces the last set of the
## browse it is for (`owner`, else the first); the plugin gets the names of every browse.
func set_accepted(names: Array, owner: PKeyMdnsConsumers.Consumer = null) -> bool:
	var list: Array = []
	if names.size() <= MAX_ACCEPTED:
		for n in names:
			var s := str(n)
			if not PKeyPeerAdvert.is_instance_name(s):
				list = []
				break
			list.append(s)
	var c := owner if owner != null else _consumers.first()
	# A set that did not take is cleared natively too: it must not leave the old, possibly larger one in force.
	if c == null:
		return _push_accept(list, _tags) and list.size() == names.size()
	c.names = list
	return _push_union() and list.size() == names.size()


## Drain the plugin's events by hand (the facade also does it once per frame). The number drained.
func poll() -> int:
	return _android.poll()


## End the browse and the advert (sign-out, lock, stop).
func stop() -> void:
	_android.call_sync({"op": "nsd_stop_all"})
	if _android.nsd_event.is_connected(_on_event):
		_android.nsd_event.disconnect(_on_event)
	_consumers.clear()
	_slots = {}
	_names = []
	_tags = {}
	_last = {}


func _on_event(e: Dictionary) -> void:
	match str(e.get("ev", "")):
		"nsd_found":
			_found(e)
		"nsd_lost":
			var name := str(e.get("instance", ""))
			_last.erase(name)
			for c: PKeyMdnsConsumers.Consumer in _consumers.all():
				if c.rows.erase(name) and c.on_down.is_valid():
					c.on_down.call(name)
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
	if _consumers.is_empty() or not PKeyPeerAdvert.is_instance_name(name):
		return
	var txt: Array = []
	for t in d.get("txt", []):
		if t is String and txt.size() < 8:
			txt.append(t)
	var port := int(d.get("port", 0))
	var hosts: Array = []
	for h in d.get("hosts", []):
		if h is String and (h as String).length() <= 64 and hosts.size() < MAX_HOSTS and not hosts.has(h):
			hosts.append(h)
	if port < 1 or port > 65535 or hosts.is_empty():
		# Nothing dialable is left: the name is lost, not kept at its old address.
		_last.erase(name)
		for c: PKeyMdnsConsumers.Consumer in _consumers.all():
			if c.rows.erase(name) and c.on_down.is_valid():
				c.on_down.call(name)
		return
	var row := {"instance": name, "txt": txt, "hosts": hosts, "host": hosts[0], "port": port}
	if _last.has(name) or _last.size() < MAX_ROWS:
		_last[name] = row
	for c: PKeyMdnsConsumers.Consumer in _consumers.all():
		_found_for(c, row)


## Report a row to one browse if its own filter or tags admit it (again when the addresses or port change).
func _found_for(c: PKeyMdnsConsumers.Consumer, row: Dictionary) -> void:
	var name: String = row["instance"]
	if not c.on_up.is_valid():
		return
	if not c.accepts(name) and not c.tag_admits(row["txt"]):
		return
	if not c.rows.has(name) and c.rows.size() >= MAX_ROWS:
		return
	var sig := "%d|%s" % [row["port"], ",".join(PackedStringArray(row["hosts"]))]
	if c.rows.get(name, "") == sig:
		return
	c.rows[name] = sig
	c.on_up.call(row.duplicate(true))


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
	## "" for the browse; the native slot (a, v, p, q, c0 to c7, l0 to l7) for an advert.
	var _slot: String
	var _gen: int
	## The browse's consumer (browse handles only).
	var _consumer: PKeyMdnsConsumers.Consumer

	func _init(owner: PKeyAndroidMdns, slot: String, gen: int, consumer: PKeyMdnsConsumers.Consumer = null) -> void:
		_owner = owner
		_slot = slot
		_gen = gen
		_consumer = consumer

	func _to_string() -> String:
		return "PKeyAndroidMdns.Handle()"

	func tracked() -> int:
		return _consumer.rows.size() if _owner != null and _consumer != null else 0

	## Replace the names this browse accepts (see `PKeyAndroidMdns.set_accepted`).
	func set_accepted(names: Array) -> bool:
		return _owner != null and _consumer != null and _owner.set_accepted(names, _consumer)

	## Replace the tags of this browse (see `PKeyAndroidMdns.set_tags`).
	func set_tags(tags: Dictionary) -> bool:
		return _owner != null and _consumer != null and _owner.set_tags(tags, _consumer)

	## Move the advert to a new name and TXT (the next epoch), on the same port. False when it is no longer running.
	func update(instance: String, txt: Array) -> bool:
		return _owner != null and not _slot.is_empty() and _owner._handle_update(_slot, _gen, instance, txt)

	func stop() -> void:
		if _owner == null:
			return
		var o := _owner
		_owner = null
		if _consumer != null:
			o._handle_stop_browse(_consumer)
		else:
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


## End one browse. The last one stops the plugin's browse and clears its tags; another leaves the rest as they were,
## with the names and tags the others still want.
func _handle_stop_browse(c: PKeyMdnsConsumers.Consumer) -> void:
	if not _consumers.has(c):
		return
	_consumers.remove(c)
	c.rows = {}
	if _consumers.is_empty():
		_android.call_sync({"op": "nsd_browse_stop"})
		_last = {}
		if not _tags.is_empty():
			_push_accept(_names, {})
	elif not c.tags.is_empty() or not c.names.is_empty():
		_push_union()
