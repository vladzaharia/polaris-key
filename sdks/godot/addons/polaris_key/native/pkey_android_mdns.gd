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
## Events reach this object as the facade's `nsd_event` signal (the facade drains the plugin once per
## frame); `poll()` drains by hand.

const MAX_ROWS := 256
const MAX_HOSTS := 8
const MAX_ACCEPTED := 1024

var _android: PKeyAndroid
var _on_up := Callable()
var _on_down := Callable()
var _accept := Callable()
var _browsing := false
var _advertising := false
var _advert_gen := 0
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
	out._request = request if request.is_valid() else Callable(PKeyAndroidMdns, "_os_request")
	android.nsd_event.connect(out._on_event)
	return out


static func _os_request(permission: String) -> void:
	OS.request_permission(permission)


func _to_string() -> String:
	return "PKeyAndroidMdns()"


## {active, responder, querier, reason}, as `PKeyMdns.status()`: the OS is both.
func status() -> Dictionary:
	var up := _browsing or _advertising
	return {"active": up, "responder": up, "querier": up, "reason": _error}


## Register the advert (or move the running one to a new name). `advert.port` is the TCP listener's port.
## ok with a handle that has `stop()`.
func advertise(advert: Dictionary) -> PKeyResult:
	var instance := str(advert.get("instance", ""))
	if not PKeyPeerAdvert.is_instance_name(instance):
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Bad instance name.", {"reason": "instance_name"})
	var port := int(advert.get("port", 0))
	if port < 1 or port > 65535:
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Bad port.", {"reason": "port"})
	var txt: Array = []
	for t in advert.get("txt", []):
		if t is String:
			txt.append(t)
	var r := _android.call_sync({"op": "nsd_advertise", "instance": instance, "port": port, "txt": txt})
	if not bool(r.get("ok", false)):
		return _failure(r)
	_advertising = true
	_advert_gen += 1
	return PKeyResult.success(Handle.new(self, true, _advert_gen))


## Browse for the roster. `on_up` gets {instance, txt, hosts, host, port} (again when the addresses or
## port change); `on_down` the instance name.
func browse(on_up: Callable, on_down := Callable(), accept := Callable()) -> PKeyResult:
	if _browsing:
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "Already browsing.", {"reason": "busy"})
	var r := _android.call_sync({"op": "nsd_browse_start"})
	if not bool(r.get("ok", false)):
		return _failure(r)
	_browsing = true
	_on_up = on_up
	_on_down = on_down
	_accept = accept
	return PKeyResult.success(Handle.new(self, false, 0))


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
	var r := _android.call_sync({"op": "nsd_accept", "names": list})
	# A set that did not take is cleared natively too: it must not leave the old, possibly larger one in force.
	return bool(r.get("ok", false)) and list.size() == names.size()


## Drain the plugin's events by hand (the facade also does it once per frame). The number drained.
func poll() -> int:
	return _android.poll()


## End the browse and the advert (sign-out, lock, stop).
func stop() -> void:
	_android.call_sync({"op": "nsd_stop_all"})
	if _android.nsd_event.is_connected(_on_event):
		_android.nsd_event.disconnect(_on_event)
	_browsing = false
	_advertising = false
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
				_advertising = false
				_error = str(e.get("reason", "failed"))
		"nsd_error":
			_error = str(e.get("reason", "failed"))


func _found(d: Dictionary) -> void:
	var name := str(d.get("instance", ""))
	if not _browsing or not PKeyPeerAdvert.is_instance_name(name) or not _on_up.is_valid():
		return
	if _accept.is_valid() and not bool(_accept.call(name)):
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
	var txt: Array = []
	for t in d.get("txt", []):
		if t is String and txt.size() < 8:
			txt.append(t)
	if not _up.has(name) and _up.size() >= MAX_ROWS:
		return
	var sig := "%d|%s" % [port, ",".join(PackedStringArray(hosts))]
	if _up.get(name, "") == sig:
		return
	_up[name] = sig
	_on_up.call({"instance": name, "txt": txt, "hosts": hosts, "host": hosts[0], "port": port})


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
	var _advert: bool
	var _gen: int

	func _init(owner: PKeyAndroidMdns, advert: bool, gen: int) -> void:
		_owner = owner
		_advert = advert
		_gen = gen

	func _to_string() -> String:
		return "PKeyAndroidMdns.Handle()"

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
		_android.call_sync({"op": "nsd_advertise_stop"})
		_advertising = false
	else:
		_android.call_sync({"op": "nsd_browse_stop"})
		_browsing = false
		_up = {}
