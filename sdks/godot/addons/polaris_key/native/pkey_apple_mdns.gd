@tool
class_name PKeyAppleMdns
extends RefCounted
## The Apple discovery lane of Cloud Connect's LAN service (CC-14b.4, D-16): `advertise` and `browse`
## with the interface `PKeyMdns` has, over the Swift Bonjour ops on the binary entry (`bj_*`,
## PolarisKeyPlatform/BonjourHost.swift). Pass it to `PKeyConnectLan.start` as the `mdns` option.
##
## The OS resolves and registers the service, so a browse hit carries no address: the row is
## {instance, txt, hosts: [], port: 0, native: true}. Dialling and accepted sockets are CC-14b.5.
##
## The roster filter lives in Swift: `set_accepted(names)` is the list of instance names this device
## would accept (the LAN service pushes it whenever the epoch, K_disc or the roster changes), and
## everything else is dropped natively before it takes a table slot or an event. Until the first call
## nothing is accepted. `accept` of `browse` is applied again here, as a second check.
##
## Errors: a refused Local Network permission is `nearby-permission-denied` and a missing
## NSBonjourServices or NSLocalNetworkUsageDescription is `not-configured`, reported when the browse or
## the advert starts (L-11), never at launch. One browse and one advert at a time; a second advert
## replaces the first (`update` on the same port).
##
## Events are drained by `poll()`, once per frame from the SceneTree when one is given.

const BIN_OK := 1
const BIN_NONE := 0
const BIN_PERMISSION := 4
const BIN_NOT_CONFIGURED := 5
const MAX_ROWS := 256

var _apple: PKeyApple
var _tree: SceneTree = null
var _on_up := Callable()
var _on_down := Callable()
var _accept := Callable()
var _browsing := false
var _advert: Dictionary = {}
var _advertising := false
var _advert_gen := 0
var _port := 0
var _error := ""
var _names_sent := false
var _frames := false
## The instances reported up and not yet down, so a repeat is not a new peer and the table is bounded.
var _up: Dictionary = {}


## The lane over `apple` (a PKeyApple, or one over a fake native in tests), else the process's shared
## one. Null when the binary entry or the Bonjour ops are not in this build.
static func create(apple: PKeyApple = null, tree: SceneTree = null) -> PKeyAppleMdns:
	if apple == null:
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
	return out


func _to_string() -> String:
	return "PKeyAppleMdns()"


## {active, responder, querier, reason}, as `PKeyMdns.status()`: the OS is both.
func status() -> Dictionary:
	var up := _browsing or _advertising
	return {"active": up, "responder": up, "querier": up, "reason": _error}


## Register the advert (or move the running one to a new name). ok with a handle that has `stop()`.
func advertise(advert: Dictionary) -> PKeyResult:
	var instance := str(advert.get("instance", ""))
	if not PKeyPeerAdvert.is_instance_name(instance):
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Bad instance name.", {"reason": "instance_name"})
	var body := {"instance": instance, "txt": (advert.get("txt", []) as Array)}
	if _advertising:
		var r := _bin("bj_advertise_update", body)
		_advert = body
		if r != BIN_OK:
			return _failure(r)
		_advert_gen += 1
		return PKeyResult.success(Handle.new(self, true, _advert_gen))
	var r := _bin("bj_advertise_start", body)
	if r != BIN_OK:
		return _failure(r)
	_advertising = true
	_advert = body
	_advert_gen += 1
	_frame_on()
	return PKeyResult.success(Handle.new(self, true, _advert_gen))


## Browse for the roster. `on_up` gets {instance, txt, hosts, port, native}; `on_down` the instance name.
func browse(on_up: Callable, on_down := Callable(), accept := Callable()) -> PKeyResult:
	if _browsing:
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Already browsing.", {"reason": "busy"})
	var r := _bin("bj_browse_start", {"p2p": false})
	if r != BIN_OK:
		return _failure(r)
	_browsing = true
	_on_up = on_up
	_on_down = on_down
	_accept = accept
	_frame_on()
	return PKeyResult.success(Handle.new(self, false, 0))


## The instance names to report (current and previous epoch, every delivered key). Replaces the last set.
func set_accepted(names: Array) -> bool:
	var data := PackedByteArray()
	for n in names:
		data.append_array(str(n).to_utf8_buffer())
	var r := _apple.cmd_bin("bj_accept", data)
	_names_sent = not r.is_empty() and r[0] == BIN_OK
	return _names_sent


## Drain the native events and route them.
func poll() -> void:
	for e in _apple.poll_bin():
		var kind: String = e[0]
		if not kind.begins_with("bj_"):
			continue
		var j := JSON.new()
		if j.parse((e[1] as PackedByteArray).get_string_from_utf8()) != OK or not (j.data is Dictionary):
			continue
		_route(kind, j.data)


## End the browse, the advert and every native socket (sign-out, lock, stop).
func stop() -> void:
	_apple.cmd_bin("bj_stop_all", PackedByteArray())
	_browsing = false
	_advertising = false
	_advert = {}
	_port = 0
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
			if bool(d.get("ok", false)):
				_port = int(d.get("port", 0))
			else:
				_advertising = false
				_error = str(d.get("error", "unavailable"))
		"bj_error":
			_error = str(d.get("error", "unavailable"))


func _found(d: Dictionary) -> void:
	var name := str(d.get("instance", ""))
	if not _browsing or not PKeyPeerAdvert.is_instance_name(name) or not _on_up.is_valid():
		return
	if _accept.is_valid() and not bool(_accept.call(name)):
		return
	if not _up.has(name) and _up.size() >= MAX_ROWS:
		return
	var txt: Array = []
	for t in d.get("txt", []):
		if t is String and txt.size() < 8:
			txt.append(t)
	var fresh := not _up.has(name)
	_up[name] = true
	if fresh:
		_on_up.call({"instance": name, "txt": txt, "hosts": [], "host": "", "port": 0, "native": true})


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
	var _advert: bool
	var _gen: int

	func _init(owner: PKeyAppleMdns, advert: bool, gen: int) -> void:
		_owner = owner
		_advert = advert
		_gen = gen

	func _to_string() -> String:
		return "PKeyAppleMdns.Handle()"

	func tracked() -> int:
		return _owner._up.size() if _owner != null and not _advert else 0

	func stop() -> void:
		if _owner == null:
			return
		var o := _owner
		_owner = null
		o._handle_stop(_advert, _gen)


## A handle that was replaced (a rotated advert) does nothing: the new name keeps running.
func _handle_stop(advert: bool, gen: int) -> void:
	if advert:
		if gen != _advert_gen:
			return
		_apple.cmd_bin("bj_advertise_stop", PackedByteArray())
		_advertising = false
		_advert = {}
		_port = 0
	else:
		_apple.cmd_bin("bj_browse_stop", PackedByteArray())
		_browsing = false
		_up = {}
	if not _browsing and not _advertising:
		_frame_off()
