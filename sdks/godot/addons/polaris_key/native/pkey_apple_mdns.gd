@tool
class_name PKeyAppleMdns
extends RefCounted
## The Apple discovery lane of Cloud Connect's LAN service (CC-14b.4, D-16): `advertise` and `browse`
## with the interface `PKeyMdns` has, over the Swift Bonjour ops on the binary entry (`bj_*`,
## PolarisKeyPlatform/BonjourHost.swift). Pass it to `PKeyConnectLan.start` as the `mdns` option.
##
## The OS resolves and registers the service, so a browse hit carries no address: the row is
## {instance, txt, hosts: [], port: 0, native: true}. `dial(instance)` and the acceptor callback
## (`set_acceptor`) give `PKeyApplePipe`s (CC-14b.5); this object routes their events and is the only
## consumer of the `bj_*` binary events.
##
## The roster filter lives in Swift: `set_accepted(names)` is the list of instance names this device
## would accept (the LAN service pushes it whenever the epoch, K_disc or the roster changes), and
## everything else is dropped natively before it takes a table slot or an event. Until the first call
## nothing is accepted. `accept` of `browse` is applied again here, as a second check.
##
## Errors: a refused Local Network permission is `nearby-permission-denied` and a missing
## NSBonjourServices or NSLocalNetworkUsageDescription is `not-configured`, reported when the browse or
## the advert starts (L-11), never at launch. One browse at a time. One advert per slot: a second advert
## on a slot replaces the first (`update` on the same port).
##
## Slots (CC-15b.GA): `advertise({.., slot})` takes `a` (the account advert, the default), `v` (an approver),
## `p` (a pairing advert) or `c` (a contact advert, up to 8, all on slot a's port). Slots v and p open their
## own native listener and ignore `port`; their accepted sockets arrive through `set_acceptor(slot, fn)`.
## `capabilities()` says whether the binding has slots and tags; with an older binding only slot a and a
## roster-only browse work, and a request for more answers `nearby-unsupported` here, never a silent
## reuse of slot a. `browse(.., tags)` also lets in a `p1-` result whose TXT is `m=<k>` with an `h` in
## `tags[k]` (k is `v` or `p`); the consumer checks the TXT again.
##
## One instance serves the process (`create()` with no argument): every `bj_*` event is routed here by slot.
##
## Events are drained by `poll()`, once per frame from the SceneTree when one is given.

const BIN_OK := 1
const BIN_NONE := 0
const BIN_PERMISSION := 4
const BIN_NOT_CONFIGURED := 5
const MAX_ROWS := 256
## Rows admitted only by a nearby tag are counted apart and never take a roster row's room.
const MAX_TAG_ROWS := 32
const MAX_PIPES := 64
const MAX_CONTACTS := 8
const MAX_TAGS := 2
const SLOTS := ["a", "v", "p"]

## The one instance of this process (`create()` with no `apple`).
static var _shared: PKeyAppleMdns = null

var _apple: PKeyApple
var _tree: SceneTree = null
var _on_up := Callable()
var _on_down := Callable()
var _accept := Callable()
var _browsing := false
## The a, v and p adverts: slot -> {advert, up, gen, port}.
var _slots: Dictionary = {}
## The contact adverts, in order: {id, instance, txt}. The native side holds the same set on slot a's port.
var _contacts: Array = []
var _contact_seq := 0
## The tags of the open browse: kind -> [h, h].
var _tags: Dictionary = {}
var _caps: Variant = null
var _error := ""
var _names_sent := false
var _frames := false
## The instances reported up and not yet down, so a repeat is not a new peer and the table is bounded.
var _up: Dictionary = {}
## The native pipes by id, each live until it closes or is released. At most MAX_PIPES.
var _pipes: Dictionary = {}
## Where accepted pipes go, per slot.
var _acceptors: Dictionary = {}


## The lane over `apple` (a PKeyApple, or one over a fake native in tests), else the process's one
## shared lane. Null when the binary entry or the Bonjour ops are not in this build.
static func create(apple: PKeyApple = null, tree: SceneTree = null) -> PKeyAppleMdns:
	var process_wide := apple == null
	if process_wide:
		if _shared != null:
			return _shared
		if OS.get_name() != "iOS" and OS.get_name() != "macOS":
			return null
		if not ClassDB.class_exists(PKeyApple.NATIVE_CLASS):
			return null
		apple = PKeyApple.shared()
	if not apple.binary_available():
		return null
	var out := PKeyAppleMdns.new()
	out._apple = apple
	out._tree = tree if tree != null else (Engine.get_main_loop() as SceneTree)
	if process_wide:
		_shared = out
	return out


## The process's shared lane (see `create`).
static func shared(tree: SceneTree = null) -> PKeyAppleMdns:
	return create(null, tree)


func _to_string() -> String:
	return "PKeyAppleMdns()"


## {active, responder, querier, reason}, as `PKeyMdns.status()`: the OS is both.
func status() -> Dictionary:
	var up := _browsing or not _contacts.is_empty() or _slots.values().any(func(s): return bool(s["up"]))
	return {"active": up, "responder": up, "querier": up, "reason": _error}


## What the native binding offers: {slots, tags}, both false for an older binding (which has slot a only).
func capabilities() -> Dictionary:
	if _caps == null:
		var ok := false
		var r := _apple.cmd_bin("bj_caps", PackedByteArray())
		if not r.is_empty():
			var j := JSON.new()
			if j.parse(r.get_string_from_utf8()) == OK and j.data is Dictionary:
				ok = int((j.data as Dictionary).get("slots", 0)) >= 1
		_caps = {"slots": ok, "tags": ok}
	return (_caps as Dictionary).duplicate()


func _slot(slot: String) -> Dictionary:
	if not _slots.has(slot):
		_slots[slot] = {"advert": {}, "up": false, "gen": 0, "port": 0}
	return _slots[slot]


## Whether the advert of `slot` (a, v or p) is running.
func advertising(slot := "a") -> bool:
	return bool(_slot(slot)["up"])


## The port the native listener of `slot` reported (0 until it has).
func port_of(slot := "a") -> int:
	return int(_slot(slot)["port"])


func _unsupported(what: String) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, "Nearby discovery is not available here.", {"reason": what})


## Register the advert (or move the running one to a new name). ok with a handle that has `stop()` and
## `update(instance, txt)`. `slot` is a (default), v, p or c; the others need `capabilities().slots`.
func advertise(advert: Dictionary) -> PKeyResult:
	var instance := str(advert.get("instance", ""))
	var slot := str(advert.get("slot", "a"))
	var refused := _advert_refusal(instance, slot)
	if refused != null:
		return refused
	var txt: Array = advert.get("txt", []) as Array
	if slot == "c":
		return _advertise_contact(instance, txt)
	var body := {"slot": slot, "instance": instance, "txt": txt}
	var s := _slot(slot)
	var running := bool(s["up"])
	var r := _bin("bj_advertise_update" if running else "bj_advertise_start", body)
	s["advert"] = body
	if r != BIN_OK:
		return _failure(r)
	s["up"] = true
	s["gen"] = int(s["gen"]) + 1
	if not running:
		_frame_on()
	return PKeyResult.success(Handle.new(self, slot, int(s["gen"])))


## The failure for an advert that cannot be asked for, or null.
func _advert_refusal(instance: String, slot: String) -> PKeyResult:
	if not PKeyPeerAdvert.is_instance_name(instance):
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Bad instance name.", {"reason": "instance_name"})
	if slot != "c" and not SLOTS.has(slot):
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Bad slot.", {"reason": "slot"})
	if slot != "a" and not bool(capabilities()["slots"]):
		return _unsupported("slots")
	return null


func _advertise_contact(instance: String, txt: Array) -> PKeyResult:
	if _contacts.size() >= MAX_CONTACTS:
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Too many contact adverts.", {"reason": "contacts"})
	for c: Dictionary in _contacts:
		if c["instance"] == instance:
			return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "That contact advert is running.", {"reason": "instance_name"})
	_contact_seq += 1
	_contacts.append({"id": _contact_seq, "instance": instance, "txt": txt})
	var r := _push_contacts()
	if r != BIN_OK:
		_contacts.pop_back()
		return _failure(r)
	_frame_on()
	return PKeyResult.success(Handle.new(self, "c", _contact_seq))


## Replace the native contact set with `_contacts`.
func _push_contacts() -> int:
	var list: Array = []
	for c: Dictionary in _contacts:
		list.append({"instance": c["instance"], "txt": c["txt"]})
	return _bin("bj_contacts", {"adverts": list})


## Browse for the roster. `on_up` gets {instance, txt, hosts, port, native}; `on_down` the instance name.
## `tags` is {"v": [h, h_prev], "p": [h, h_prev]}: a `p1-` name that `accept` refuses still enters when its
## TXT is `m=<k>` and its `h` is in `tags[k]`. Tags need `capabilities().tags`.
func browse(on_up: Callable, on_down := Callable(), accept := Callable(), tags := {}) -> PKeyResult:
	if _browsing:
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Already browsing.", {"reason": "busy"})
	var clean := _clean_tags(tags)
	if not clean.is_empty() and not bool(capabilities()["tags"]):
		return _unsupported("tags")
	var r := _bin("bj_browse_start", {"p2p": false})
	if r != BIN_OK:
		return _failure(r)
	_browsing = true
	_on_up = on_up
	_on_down = on_down
	_accept = accept
	if not clean.is_empty():
		set_tags(clean)
	_frame_on()
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


## Replace the tags of the open browse (the current and previous `h` of each kind). False when the native
## side refused them; it then holds none.
func set_tags(tags: Dictionary) -> bool:
	var clean := _clean_tags(tags)
	if clean.is_empty() and _tags.is_empty():
		return true
	var r := _bin("bj_accept_tags", clean)
	_tags = clean if r == BIN_OK else {}
	if r != BIN_OK and not clean.is_empty():
		_bin("bj_accept_tags", {})
	return r == BIN_OK


## The instance names to report (current and previous epoch, every delivered key). Replaces the last set.
func set_accepted(names: Array) -> bool:
	var data := PackedByteArray()
	for n in names:
		data.append_array(str(n).to_utf8_buffer())
	var r := _apple.cmd_bin("bj_accept", data)
	_names_sent = not r.is_empty() and r[0] == BIN_OK
	if not _names_sent:
		# A set that did not take must not leave the old, possibly larger one in force.
		_apple.cmd_bin("bj_accept", PackedByteArray())
	return _names_sent


## Drain the native events and route them.
func poll() -> void:
	for e in _apple.poll_bin("bj_"):
		var kind: String = e[0]
		if kind == "bj_data":
			_data(e[1])
			continue
		var j := JSON.new()
		if j.parse((e[1] as PackedByteArray).get_string_from_utf8()) != OK or not (j.data is Dictionary):
			continue
		_route(kind, j.data)


## End the browse, the advert and every native socket (sign-out, lock, stop).
func stop() -> void:
	_apple.cmd_bin("bj_stop_all", PackedByteArray())
	for id: int in _pipes.keys():
		(_pipes[id] as PKeyApplePipe)._on_closed("closed")
	_pipes = {}
	_acceptors = {}
	_browsing = false
	_slots = {}
	_contacts = []
	_tags = {}
	_on_up = Callable()
	_on_down = Callable()
	_accept = Callable()
	_up = {}
	_frame_off()


func _route(kind: String, d: Dictionary) -> void:
	match kind:
		"bj_found":
			_found(d)
		"bj_lost":
			var name := str(d.get("instance", ""))
			if _up.erase(name) and _on_down.is_valid():
				_on_down.call(name)
		"bj_advertise":
			var slot := str(d.get("slot", "a"))
			if not SLOTS.has(slot):
				return
			var s := _slot(slot)
			if bool(d.get("ok", false)):
				s["port"] = int(d.get("port", 0))
			else:
				s["up"] = false
				s["port"] = 0
				_error = str(d.get("error", "unavailable"))
		"bj_withdrawn":
			# The daemon refused or removed a contact name: it is no longer registered, nor wanted.
			if str(d.get("slot", "")) == "c":
				var gone_name := str(d.get("requested", ""))
				_contacts = _contacts.filter(func(c): return c["instance"] != gone_name)
		"bj_error":
			_error = str(d.get("error", "unavailable"))
		"bj_accepted":
			_accepted(d)
		"bj_open":
			var opened: PKeyApplePipe = _pipes.get(int(d.get("id", 0)))
			if opened != null:
				opened._on_open()
		"bj_closed":
			var id := int(d.get("id", 0))
			var gone: PKeyApplePipe = _pipes.get(id)
			if gone != null:
				gone._on_closed(str(d.get("reason", "error")))
				_pipes.erase(id)


func _data(payload: PackedByteArray) -> void:
	if payload.size() < 4:
		return
	var id := (payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]
	var pipe: PKeyApplePipe = _pipes.get(id)
	if pipe != null:
		pipe._on_data(payload.slice(4))


func _accepted(d: Dictionary) -> void:
	var id := int(d.get("id", 0))
	var acceptor: Callable = _acceptors.get(str(d.get("slot", "a")), Callable())
	if id <= 0 or _pipes.has(id) or _pipes.size() >= MAX_PIPES or not acceptor.is_valid():
		if id > 0 and not _pipes.has(id):
			close_pipe(id, true)
		return
	var pipe := PKeyApplePipe.new(self, id, str(d.get("remote", "")), true)
	_pipes[id] = pipe
	acceptor.call(pipe)


## Where the pipes accepted on `slot` (a, v or p) go: Callable(pipe: PKeyApplePipe). With none, accepted
## sockets are closed. One argument, a Callable, sets slot a (the form mode a's service uses).
func set_acceptor(slot: Variant, acceptor := Callable()) -> void:
	if slot is Callable:
		_acceptors["a"] = slot
		return
	if acceptor.is_valid():
		_acceptors[str(slot)] = acceptor
	else:
		_acceptors.erase(str(slot))


## Dial a browse hit by its instance name. A PKeyApplePipe that is connecting (it takes writes, which
## wait natively), or null when the instance is not in the native table, the table is full or the lane
## cannot dial. The result arrives as `is_connected_native()`, or the pipe finishes.
func dial(instance: String) -> PKeyApplePipe:
	if not PKeyPeerAdvert.is_instance_name(instance) or _pipes.size() >= MAX_PIPES:
		return null
	var r := _apple.cmd_bin("bj_dial", JSON.stringify({"instance": instance}).to_utf8_buffer())
	if r.size() != 5 or r[0] != BIN_OK:
		return null
	var id := (r[1] << 24) | (r[2] << 16) | (r[3] << 8) | r[4]
	var pipe := PKeyApplePipe.new(self, id, "", false)
	_pipes[id] = pipe
	_frame_on()
	return pipe


func send(id: int, bytes: PackedByteArray) -> bool:
	var r := _apple.cmd_bin("bj_send", _id_bytes(id) + bytes)
	return not r.is_empty() and r[0] == BIN_OK


func credit(id: int, n: int) -> void:
	var tail := PackedByteArray([(n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF])
	_apple.cmd_bin("bj_credit", _id_bytes(id) + tail)


func admit(id: int) -> void:
	_apple.cmd_bin("bj_admit", _id_bytes(id))


func close_pipe(id: int, abort: bool) -> void:
	_apple.cmd_bin("bj_close", _id_bytes(id) + PackedByteArray([1 if abort else 0]))


## Forget a pipe the host closed itself (no event follows).
func release(id: int) -> void:
	_pipes.erase(id)


## Abort every native pipe now (sign-out, lock). Browse and advert are stopped by their handles.
func close_pipes() -> void:
	for id: int in _pipes.keys():
		(_pipes[id] as PKeyApplePipe).abort()
	_pipes = {}


func pipe_count() -> int:
	return _pipes.size()


static func _id_bytes(id: int) -> PackedByteArray:
	return PackedByteArray([(id >> 24) & 0xFF, (id >> 16) & 0xFF, (id >> 8) & 0xFF, id & 0xFF])


func _found(d: Dictionary) -> void:
	var name := str(d.get("instance", ""))
	if not _browsing or not PKeyPeerAdvert.is_instance_name(name) or not _on_up.is_valid():
		return
	var txt: Array = []
	for t in d.get("txt", []):
		if t is String and txt.size() < 8:
			txt.append(t)
	var tag_only := false
	if _accept.is_valid() and not bool(_accept.call(name)):
		if not _tag_admits(txt):
			return
		tag_only = true
	if not _up.has(name) and _row_count(tag_only) >= (MAX_TAG_ROWS if tag_only else MAX_ROWS):
		return
	var fresh := not _up.has(name)
	_up[name] = tag_only
	if fresh:
		_on_up.call({"instance": name, "txt": txt, "hosts": [], "host": "", "port": 0, "native": true})


## How many rows are tag-only (`true`) or roster rows (`false`).
func _row_count(tag_only: bool) -> int:
	var n := 0
	for k in _up:
		if bool(_up[k]) == tag_only:
			n += 1
	return n


## Whether a TXT is `m=<k>` with an `h` in `_tags[k]`.
func _tag_admits(txt: Array) -> bool:
	for k: String in _tags.keys():
		if txt.has("m=" + k):
			for h: String in _tags[k]:
				if txt.has("h=" + h):
					return true
	return false


## The last error the native side reported ("" when none): permission_denied, not_configured or unavailable.
func last_error() -> String:
	return _error


func _bin(op: String, body: Dictionary) -> int:
	var r := _apple.cmd_bin(op, JSON.stringify(body).to_utf8_buffer())
	return r[0] if not r.is_empty() else -1


func _failure(code: int) -> PKeyResult:
	match code:
		BIN_PERMISSION:
			_error = "permission_denied"
			return PKeyConnectErrors.lan("permission_denied", "Local network access was refused.")
		BIN_NOT_CONFIGURED:
			_error = "not_configured"
			return PKeyResult.failure(PKeyConstants.ErrorCode.NOT_CONFIGURED, "The app's Info.plist lacks the Bonjour entries.", {"reason": "plist"})
	_error = "unavailable"
	return PKeyConnectErrors.lan("not_listening", "Local discovery could not start.")


func _frame_on() -> void:
	if _tree == null or _frames:
		return
	_frames = true
	_tree.process_frame.connect(poll)


func _frame_off() -> void:
	if _tree != null and _frames and _tree.process_frame.is_connected(poll):
		_tree.process_frame.disconnect(poll)
	_frames = false


class Handle extends RefCounted:
	var _owner: PKeyAppleMdns
	## "" for the browse; a, v, p or c for an advert.
	var _slot: String
	## An advert's generation, or a contact's id.
	var _gen: int

	func _init(owner: PKeyAppleMdns, slot: String, gen: int) -> void:
		_owner = owner
		_slot = slot
		_gen = gen

	func _to_string() -> String:
		return "PKeyAppleMdns.Handle()"

	func tracked() -> int:
		return _owner._up.size() if _owner != null and _slot.is_empty() else 0

	## Move the advert to a new name and TXT (the next epoch). False when it is no longer running.
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
	if slot == "c":
		for c: Dictionary in _contacts:
			if int(c["id"]) == gen:
				c["instance"] = instance
				c["txt"] = txt
				return _push_contacts() == BIN_OK
		return false
	var s := _slot(slot)
	if int(s["gen"]) != gen or not bool(s["up"]):
		return false
	var body := {"slot": slot, "instance": instance, "txt": txt}
	s["advert"] = body
	return _bin("bj_advertise_update", body) == BIN_OK


## A handle that was replaced (a rotated advert) does nothing: the new name keeps running.
func _handle_stop(slot: String, gen: int) -> void:
	if slot == "c":
		var before := _contacts.size()
		_contacts = _contacts.filter(func(c): return int(c["id"]) != gen)
		if _contacts.size() != before:
			_push_contacts()
	elif not slot.is_empty():
		var s := _slot(slot)
		if gen != int(s["gen"]):
			return
		_bin("bj_advertise_stop", {"slot": slot})
		_slots[slot] = {"advert": {}, "up": false, "gen": gen, "port": 0}
	else:
		_apple.cmd_bin("bj_browse_stop", PackedByteArray())
		_browsing = false
		_up = {}
		if not _tags.is_empty():
			_tags = {}
			_bin("bj_accept_tags", {})
	if not _browsing and not status()["active"]:
		_frame_off()
