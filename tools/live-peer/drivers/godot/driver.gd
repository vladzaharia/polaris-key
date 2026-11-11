extends SceneTree
## The Godot live-peer driver (CC-29X.3): the addon's local links behind the JSON-lines contract in
## tools/live-peer/README.md. One core, no account, local pairing on; discovery is answered by the manifest set below,
## mDNS by the harness's broker (the `Broker` lane); every dial is real TCP on 127.0.0.1. Run headless with
## `--script res://driver.gd` over this project (run.mjs does).
##
## stdin is read by a thread (`OS.read_string_from_stdin` blocks) and handed to the main loop; stdout is the protocol, so
## the driver prints nothing else (the engine's own banner is not JSON and the harness ignores it).

const PRODUCT := "djdl"
const CATEGORIES: Array = ["notes"]
const LOOPBACK := "127.0.0.1"
const STDIN_BUFFER := 1048576
const OPEN_WAIT_SECONDS := 20.0
const JOIN_BROWSE_SECONDS := 4.0
const SHOW_WAIT_SECONDS := 5.0
const SEND_WAIT_SECONDS := 120.0

var _broker: Broker
var _host: Node
var _core: PKeyCore
var _connect: PKeyCloudConnect
var _links: PKeyCloudLocalLinks
var _root := ""
var _window: PKeyCloudLocalLinks.Handle = null
var _code: Dictionary = {}
var _events: Array = []
var _received: Array = []
var _offers := 0
var _reader: Thread
var _lines: Array = []
var _lock := Mutex.new()
var _quitting := false


## A stoppable thing the lane hands back (an advert or a browse).
class Handle:
	extends RefCounted
	var _stop: Callable

	func _init(stop: Callable) -> void:
		_stop = stop

	func stop() -> void:
		var f := _stop
		_stop = Callable()
		if f.is_valid():
			f.call()


## The mDNS lane: this device's adverts go to the harness, the other device's come back from it. The lane contract is the
## one `PKeyMdns` has (advertise and browse answer a PKeyResult holding a handle); found hosts are always 127.0.0.1.
class Broker:
	extends RefCounted
	var send: Callable
	var _found: Dictionary = {}
	var _browsers: Array = []

	func capabilities() -> Dictionary:
		return {"slots": true, "tags": true}

	func status() -> Dictionary:
		return {"active": true, "responder": true, "querier": true, "reason": ""}

	func advertise(advert: Dictionary) -> PKeyResult:
		var instance := str(advert["instance"])
		(
			send
			. call(
				{
					"mdns": "advertise",
					"advert":
					{
						"instance": instance,
						"port": int(advert.get("port", 0)),
						"txt": advert.get("txt", []),
					},
				}
			)
		)
		return PKeyResult.success(Handle.new(Callable(self, "_withdraw").bind(instance)))

	func browse(
		on_up: Callable, on_down := Callable(), accept := Callable(), _tags := {}
	) -> PKeyResult:
		var entry := {"up": on_up, "down": on_down, "accept": accept}
		_browsers.append(entry)
		for found: Dictionary in _found.values():
			_offer(entry, found)
		return PKeyResult.success(Handle.new(Callable(self, "_unbrowse").bind(entry)))

	func remote_up(advert: Dictionary) -> void:
		var instance := str(advert["instance"])
		var found := {
			"instance": instance,
			"host": LOOPBACK,
			"hosts": [LOOPBACK],
			"port": int(advert.get("port", 0)),
			"txt": advert.get("txt", []),
			"native": false,
		}
		_found[instance] = found
		for entry: Dictionary in _browsers.duplicate():
			_offer(entry, found)

	func remote_down(instance: String) -> void:
		if not _found.erase(instance):
			return
		for entry: Dictionary in _browsers.duplicate():
			var down: Callable = entry["down"]
			if down.is_valid():
				down.call(instance)

	func _offer(entry: Dictionary, found: Dictionary) -> void:
		var accept: Callable = entry["accept"]
		if accept.is_valid() and not accept.call(found["instance"]):
			return
		(entry["up"] as Callable).call(found)

	func _withdraw(instance: String) -> void:
		send.call({"mdns": "withdraw", "instance": instance})

	func _unbrowse(entry: Dictionary) -> void:
		_browsers.erase(entry)


func _initialize() -> void:
	_root = "user://pkey-live-%s" % Crypto.new().generate_random_bytes(6).hex_encode()
	DirAccess.make_dir_recursive_absolute(_root.path_join("recv"))
	_broker = Broker.new()
	_broker.send = Callable(self, "_send")
	_host = Node.new()
	root.add_child(_host)
	var opts := PKeyOptions.new()
	opts.product_slug = PRODUCT
	opts.base_url = "https://k.test"
	opts.version = "1.0.0"
	opts.store = PKeyMemoryStore.new("", "pkeyt_live")
	opts.build_stamp_path = ""
	opts.persist_settings = false
	opts.device_name = "live-godot"
	var made := PKeyCore.create(opts, _host, "0.0.0")
	if not made.ok:
		printerr("core: %s" % made.message)
		quit(1)
		return
	_core = made.detail
	_core.discovery_manifest = {
		"services":
		{"connect": {"enabled": true, "lan": true, "relay": false, "localPairing": true}}
	}
	var state := PKeyConnectState.new(PRODUCT, _root, true)
	var client := PKeyConnectClient.new(_core, state, null)
	_connect = (
		PKeyCloudConnect
		. new(
			_core,
			client,
			{
				"store_root": _root,
				"local_links":
				{
					"lane": Callable(self, "_lane"),
					"allow_loopback": true,
					"host": LOOPBACK,
				},
			}
		)
	)
	_links = _connect.local_links
	_links.on_change(Callable(self, "_on_change"))
	_links.on_link(Callable(self, "_on_inbound"))
	_connect.transfer.on_offer(Callable(self, "_on_offer"))
	_connect.transfer.result.connect(_on_result)
	_reader = Thread.new()
	_reader.start(_read_stdin)
	_send({"ready": true, "driver": "godot"})


func _process(_delta: float) -> bool:
	_lock.lock()
	var batch := _lines.duplicate()
	_lines.clear()
	_lock.unlock()
	for line: String in batch:
		_dispatch(line)
	return false


func _lane() -> Object:
	return _broker


# -- the control channel ---------------------------------------------------------------------------


func _read_stdin() -> void:
	while true:
		var line := OS.read_string_from_stdin(STDIN_BUFFER)
		# A line is never empty; an empty read is the end of stdin.
		_lock.lock()
		_lines.append(line)
		_lock.unlock()
		if line == "":
			return


func _send(m: Dictionary) -> void:
	print(JSON.stringify(m))


func _dispatch(line: String) -> void:
	if line == "":
		_finish()
		return
	var parsed: Variant = JSON.parse_string(line)
	if not parsed is Dictionary:
		return
	var m: Dictionary = parsed
	var mdns := str(m.get("mdns", ""))
	if mdns == "up":
		_broker.remote_up(m["advert"])
	elif mdns == "down":
		_broker.remote_down(str(m["instance"]))
	elif mdns == "":
		_run(m)


func _run(m: Dictionary) -> void:
	var out := {}
	match str(m.get("cmd", "")):
		"show":
			out = await _cmd_show(m)
		"join":
			out = await _cmd_join(m)
		"list":
			out = _cmd_list()
		"open":
			out = await _cmd_open(m)
		"send":
			out = await _cmd_send(m)
		"recv":
			out = await _cmd_recv()
		"forget":
			out = _cmd_forget(m)
		"events":
			out = _cmd_events()
		"quit":
			out = {}
			_send({"seq": int(m.get("seq", 0)), "ok": true})
			_finish()
			return
		_:
			out = {"ok": false, "error": {"message": "unknown command %s" % m.get("cmd")}}
	var answer := {"seq": int(m.get("seq", 0)), "ok": true}
	answer.merge(out, true)
	_send(answer)


func _finish() -> void:
	if _quitting:
		return
	_quitting = true
	if _window != null:
		_window.stop()
	_links.stop_all()
	_connect.stop()
	_remove_dir(ProjectSettings.globalize_path(_root))
	# The reader ends when the harness closes stdin, right after `quit`; a thread still blocked is left to the exit.
	var until := _now() + 2.0
	while _reader.is_alive() and _now() < until:
		await process_frame
	if not _reader.is_alive():
		_reader.wait_to_finish()
	quit(0)


static func _remove_dir(path: String) -> void:
	for sub in DirAccess.get_directories_at(path):
		_remove_dir(path.path_join(sub))
	for file in DirAccess.get_files_at(path):
		DirAccess.remove_absolute(path.path_join(file))
	DirAccess.remove_absolute(path)


# -- the commands ----------------------------------------------------------------------------------


func _cmd_show(a: Dictionary) -> Dictionary:
	if a.get("fresh", false):
		await _until(
			func() -> bool: return _window == null or not _window.is_open(), SHOW_WAIT_SECONDS
		)
	if _window == null or not _window.is_open():
		_code = {}
		var r: PKeyResult = await _links.pair(_options({"on_code": Callable(self, "_on_code")}))
		if not r.ok:
			return _failed(r)
		_window = r.detail
	var c := _window.code()
	if c.is_empty():
		c = _code
	return {"code": c.get("code", ""), "qr": c.get("qr", "")}


func _cmd_join(a: Dictionary) -> Dictionary:
	var how := {"browse_seconds": JOIN_BROWSE_SECONDS}
	var code: Variant = a.get("code")
	if code != null:
		how["code"] = str(code)
	else:
		how["qr"] = str(a.get("qr", ""))
	var r: PKeyResult = await _links.join(_options(how))
	var left: Variant = _links.dials_left(str(code)) if code != null else null
	if not r.ok:
		var failed := _failed(r)
		failed["dialsLeft"] = left
		return failed
	return {"link": str(r.detail["id"]), "dialsLeft": left}


func _cmd_list() -> Dictionary:
	var r := _links.list()
	var links: Array = []
	for row: Dictionary in r.detail if r.ok else []:
		(
			links
			. append(
				{
					"id": row["id"],
					"label": row["label"],
					"platform": row["platform"],
					"categories": row["categories"],
					"reachable": row["reachable"],
				}
			)
		)
	return {"links": links}


func _cmd_open(a: Dictionary) -> Dictionary:
	var id := str(a["id"])
	var wait: bool = a.get("wait", true)
	var until := _now() + (OPEN_WAIT_SECONDS if wait else 0.0)
	while true:
		var r: PKeyResult = await _links.open(id)
		if r.ok:
			_track(r.detail, "out")
			return {"link": id}
		# Not seen on the network yet is not an attempt: keep looking until the hang guard.
		if PKeyConnectErrors.reason_of(r) != "unknown_peer" or _now() >= until:
			return _failed(r)
		await _wait(0.05)
	return {}


func _cmd_send(a: Dictionary) -> Dictionary:
	var data := _pattern(int(a["bytes"]))
	var sha := _sha256(data)
	if sha != str(a["sha256"]):
		return _failed_text("the sender's pattern hashes differently")
	var until := _now() + OPEN_WAIT_SECONDS
	var handle: PKeyTransferHandle = null
	while handle == null:
		var r: PKeyResult = await (_connect.transfer.send(
			{"link": str(a["id"])}, data, {"name": "live.bin", "category": CATEGORIES[0]}
		))
		if r.ok:
			handle = r.detail
		elif PKeyConnectErrors.reason_of(r) != "unknown_peer" or _now() >= until:
			return _failed(r)
		else:
			await _wait(0.05)
	var done: PKeyResult = await handle.wait()
	if not done.ok:
		return _failed_text("transfer %s" % str(done.detail))
	return {"sha256": sha, "bytes": data.size()}


func _cmd_recv() -> Dictionary:
	await _until(func() -> bool: return not _received.is_empty(), SEND_WAIT_SECONDS)
	if _received.is_empty():
		return _failed_text("nothing was delivered")
	return _received.pop_front()


func _cmd_forget(a: Dictionary) -> Dictionary:
	var r := _links.remove(str(a["id"]))
	return {"removed": r.ok}


func _cmd_events() -> Dictionary:
	var out := _events.duplicate()
	_events.clear()
	return {"events": out}


# -- what the client tells the host ----------------------------------------------------------------


func _options(extra: Dictionary) -> Dictionary:
	return (
		{
			"categories": CATEGORIES,
			"label": "godot",
			"on_confirm": Callable(self, "_on_confirm"),
			"allow_loopback": true,
			"host": LOOPBACK,
		}
		. merged(extra, true)
	)


func _on_code(c: Dictionary) -> void:
	_code = c


func _on_confirm(offer: PKeyConnectLocalCommon.Offer) -> void:
	offer.confirm()


func _on_change() -> void:
	_events.append({"kind": "change"})


func _on_inbound(session: PKeyConnectSession) -> void:
	_track(session, "in")
	_events.append({"kind": "link", "id": session.local.get("id")})


func _track(session: PKeyConnectSession, direction: String) -> void:
	var id: Variant = session.local.get("id")
	session.closed.connect(
		func(code: StringName, by_peer: bool) -> void:
			_events.append(
				{
					"kind": "session-end",
					"dir": direction,
					"id": id,
					"code": str(code),
					"byPeer": by_peer
				}
			)
	)


func _on_offer(offer: PKeyTransferOffer) -> void:
	_offers += 1
	offer.accept(_root.path_join("recv").path_join("%d.bin" % _offers), true)


func _on_result(r: Dictionary) -> void:
	if r.get("direction") != "in" or not r.get("delivered", false) or not r.has("path"):
		return
	var path := str(r["path"])
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return
	_received.append({"sha256": FileAccess.get_sha256(path), "bytes": file.get_length()})
	file.close()
	DirAccess.remove_absolute(path)


# -- helpers ---------------------------------------------------------------------------------------


static func _failed(r: PKeyResult) -> Dictionary:
	var detail: Variant = r.detail
	var d: Dictionary = detail if detail is Dictionary else {}
	return {
		"ok": false,
		"error":
		{
			"code": str(r.code),
			"reason": d.get("reason"),
			"cap": d.get("cap"),
			"message": r.message,
		},
	}


static func _failed_text(message: String) -> Dictionary:
	return {"ok": false, "error": {"message": message}}


static func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0


static func _pattern(n: int) -> PackedByteArray:
	var block := PackedByteArray()
	block.resize(256)
	for i in 256:
		block[i] = (i * 7 + 13) & 0xff
	var out := PackedByteArray()
	while out.size() < n:
		out.append_array(block)
	out.resize(n)
	return out


static func _sha256(data: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(data)
	return ctx.finish().hex_encode()


func _wait(seconds: float) -> void:
	await create_timer(seconds).timeout


## Frames pass until `cond` holds or `seconds` (a hang guard) run out.
func _until(cond: Callable, seconds: float) -> void:
	var until := _now() + seconds
	while not cond.call() and _now() < until:
		await process_frame
