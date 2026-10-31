extends RefCounted
# @pkey-feature connect.lan
# The Apple discovery lane (CC-14b.4): PKeyAppleMdns over a fake binary entry that records the
# bj_* ops and plays back events. The Swift side is tested by BonjourHostTests; the real glue
# runs in the live test (PKEY_LIVE_BONJOUR=1 swift test) and in the suite_native_apple real group.

const A := "p1-aaaaaaaaaaaaaaaa"
const B := "p1-bbbbbbbbbbbbbbbb"
const C := "p1-cccccccccccccccc"


class FakeBin:
	extends RefCounted
	var calls: Array = []
	var queued: Array = []
	var reply := {}

	var raw := {}

	func cmd_bin(op: String, data: PackedByteArray) -> PackedByteArray:
		calls.append([op, data])
		if raw.has(op):
			return raw[op]
		return PackedByteArray([int(reply.get(op, 1))])

	func poll_bin() -> Array:
		var out := queued
		queued = []
		return out

	func event(kind: String, body: Dictionary) -> void:
		queued.append([kind, JSON.stringify(body).to_utf8_buffer()])

	func ops() -> Array:
		return calls.map(func(c): return c[0])

	func json_of(op: String) -> Dictionary:
		for c in calls:
			if c[0] == op:
				return JSON.parse_string((c[1] as PackedByteArray).get_string_from_utf8())
		return {}


class Seen:
	extends RefCounted
	var up: Array = []
	var down: Array = []

	func on_up(p: Dictionary) -> void:
		up.append(p)

	func on_down(n: String) -> void:
		down.append(n)


var _apples: Array[PKeyApple] = []


func run(t: PKeyTestContext) -> void:
	_create(t)
	_browse(t)
	_errors(t)
	_advertise(t)
	_pipes(t)
	_fix_round(t)
	_export(t)
	for a in _apples:
		a.free()


func _lane(fake: FakeBin) -> PKeyAppleMdns:
	var apple := PKeyApple.new()
	apple.platform = "ios"
	apple.native = fake
	_apples.append(apple)
	return PKeyAppleMdns.create(apple, null)


func _create(t: PKeyTestContext) -> void:
	var a := PKeyApple.new()
	a.platform = "ios"
	a.native = RefCounted.new()
	t.check("create: no binary entry, no lane", PKeyAppleMdns.create(a, null) == null)
	a.free()
	var lane := _lane(FakeBin.new())
	t.check("create: a native with the binary entry gives a lane", lane != null and str(lane) == "PKeyAppleMdns()")


func _browse(t: PKeyTestContext) -> void:
	var fake := FakeBin.new()
	var lane := _lane(fake)
	var seen := Seen.new()
	var b := lane.browse(seen.on_up, seen.on_down, func(n: String) -> bool: return n != C)
	t.check("browse: starts", b.ok and fake.ops() == ["bj_browse_start"] and fake.json_of("bj_browse_start") == {"p2p": false})
	t.check("browse: a second browse is refused", not lane.browse(seen.on_up).ok)
	t.check("browse: nothing is accepted until the names are pushed (the bytes are the concatenated names)", lane.set_accepted([A, B])
			and fake.calls[-1][0] == "bj_accept" and (fake.calls[-1][1] as PackedByteArray).get_string_from_ascii() == A + B)
	fake.event("bj_found", {"instance": A, "txt": ["v=1", "m=a"]})
	fake.event("bj_found", {"instance": A, "txt": ["v=1", "m=a"]})
	fake.event("bj_found", {"instance": C, "txt": []})
	fake.event("bj_found", {"instance": "p1-short", "txt": []})
	fake.event("bj_found", {"instance": B, "txt": ["a", "b", "c", "d", "e", "f", "g", "h", "i", 5]})
	fake.queued.append(["selftest", PackedByteArray([1])])
	fake.queued.append(["bj_found", PackedByteArray([0xFF, 0xFE])])
	lane.poll()
	t.check("browse: a hit is reported once, in the lan shape", seen.up.size() == 2 and seen.up[0] == {"instance": A, "txt": ["v=1", "m=a"], "hosts": [], "host": "", "port": 0, "native": true})
	t.check("browse: the accept callback is a second check, a bad name and bad payloads are dropped", not seen.up.any(func(p): return p["instance"] == C or p["instance"] == "p1-short"))
	t.check("browse: TXT is cut to 8 text entries", (seen.up[1]["txt"] as Array).size() == 8)
	fake.event("bj_lost", {"instance": A})
	fake.event("bj_lost", {"instance": A})
	fake.event("bj_lost", {"instance": C})
	lane.poll()
	t.check("browse: a loss is reported once and only for what was up", seen.down == [A])
	fake.event("bj_found", {"instance": A, "txt": []})
	lane.poll()
	t.check("browse: a peer that returned is found again", seen.up.size() == 3)
	var rows := Seen.new()
	var big := _lane(FakeBin.new())
	big.browse(rows.on_up)
	var many := FakeBin.new()
	many.queued = []
	var lane2 := _lane(many)
	lane2.browse(rows.on_up)
	for i in PKeyAppleMdns.MAX_ROWS + 50:
		many.event("bj_found", {"instance": "p1-%s" % _name16(i), "txt": []})
	lane2.poll()
	t.check("browse: the reported table is bounded", rows.up.size() == PKeyAppleMdns.MAX_ROWS)
	b.detail.stop()
	t.check("browse: stop ends the browse", fake.ops().has("bj_browse_stop"))
	lane.stop()
	t.check("browse: stop() ends everything natively", fake.ops().has("bj_stop_all"))


func _name16(i: int) -> String:
	var alphabet := "abcdefghijklmnopqrstuvwxyz234567"
	var s := ""
	var n := i
	for k in 16:
		s += alphabet[n % 32]
		n /= 32
	return s


func _errors(t: PKeyTestContext) -> void:
	var fake := FakeBin.new()
	fake.reply = {"bj_browse_start": 4}
	var lane := _lane(fake)
	var denied := lane.browse(Callable())
	t.check("errors: a refused permission is nearby-permission-denied", not denied.ok and denied.code == PKeyConstants.ErrorCode.NEARBY_PERMISSION_DENIED and lane.last_error() == "permission_denied")
	fake.reply = {"bj_browse_start": 5, "bj_advertise_start": 5}
	var plist := lane.browse(Callable())
	t.check("errors: a missing plist is not-configured", not plist.ok and plist.code == PKeyConstants.ErrorCode.NOT_CONFIGURED and lane.last_error() == "not_configured")
	var ad := lane.advertise({"instance": A, "txt": ["v=1", "m=a"]})
	t.check("errors: the same for an advert", not ad.ok and ad.code == PKeyConstants.ErrorCode.NOT_CONFIGURED)
	fake.reply = {"bj_browse_start": 6}
	t.check("errors: any other failure is a registered code", not lane.browse(Callable()).ok)
	t.check("errors: a failed start leaves the lane idle", not lane.status()["active"])
	var live := _lane(FakeBin.new())
	var f2: FakeBin = live._apple.native
	live.browse(Callable())
	f2.event("bj_error", {"scope": "browse", "error": "permission_denied"})
	live.poll()
	t.check("errors: a late refusal is kept", live.last_error() == "permission_denied")
	t.check("errors: a bad instance name never reaches the native side", not live.advertise({"instance": "x", "txt": []}).ok and not f2.ops().has("bj_advertise_start"))


func _advertise(t: PKeyTestContext) -> void:
	var fake := FakeBin.new()
	var lane := _lane(fake)
	var first := lane.advertise({"instance": A, "port": 1234, "txt": ["v=1", "m=a"]})
	t.check("advertise: starts with the instance and TXT, and no port (the OS listener has its own)", first.ok and fake.json_of("bj_advertise_start") == {"instance": A, "txt": ["v=1", "m=a"]})
	var second := lane.advertise({"instance": B, "port": 1234, "txt": ["v=1", "m=a"]})
	t.check("advertise: the next name updates the same advert", second.ok and fake.ops().count("bj_advertise_start") == 1 and fake.json_of("bj_advertise_update")["instance"] == B)
	first.detail.stop()
	t.check("advertise: the replaced handle's stop() does not stop the new name (lan rotates this way)", not fake.ops().has("bj_advertise_stop") and lane.status()["active"])
	fake.event("bj_advertise", {"ok": true, "port": 5555})
	lane.poll()
	t.check("advertise: the started port is kept", lane._port == 5555)
	second.detail.stop()
	t.check("advertise: the current handle stops it", fake.ops().has("bj_advertise_stop") and not lane.status()["active"])
	lane.advertise({"instance": A, "txt": []})
	fake.event("bj_advertise", {"ok": false, "error": "permission_denied"})
	lane.poll()
	t.check("advertise: a failed start is reported and the advert is not running", lane.last_error() == "permission_denied" and not lane._advertising)


func _id_of(data: PackedByteArray) -> int:
	return (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]


func _data_event(fake: FakeBin, id: int, bytes: PackedByteArray) -> void:
	fake.queued.append(["bj_data", PackedByteArray([(id >> 24) & 0xFF, (id >> 16) & 0xFF, (id >> 8) & 0xFF, id & 0xFF]) + bytes])


func _pipes(t: PKeyTestContext) -> void:
	var fake := FakeBin.new()
	var lane := _lane(fake)
	fake.raw["bj_dial"] = PackedByteArray([1, 0, 0, 1, 2])
	var pipe := lane.dial(A)
	t.check("pipes: dial answers a connecting pipe by its native id", pipe != null and pipe.id() == 258 and not pipe.is_connected_native() and pipe.is_open() and not pipe.is_finished())
	t.check("pipes: the dial names the instance", fake.json_of("bj_dial") == {"instance": A})
	t.check("pipes: a write waits natively and is framed id then bytes", pipe.write(PackedByteArray([7, 8])) and fake.calls[-1][0] == "bj_send"
			and fake.calls[-1][1] == PackedByteArray([0, 0, 1, 2, 7, 8]))
	fake.queued.append(["bj_open", JSON.stringify({"id": 258}).to_utf8_buffer()])
	_data_event(fake, 258, PackedByteArray([1, 2, 3]))
	_data_event(fake, 999, PackedByteArray([9]))
	lane.poll()
	t.check("pipes: bj_open connects it and data reaches only its pipe", pipe.is_connected_native() and pipe.buffered() == 3)
	t.check("pipes: read hands the bytes over and returns the credit", pipe.read() == PackedByteArray([1, 2, 3]) and fake.calls[-1][0] == "bj_credit"
			and fake.calls[-1][1] == PackedByteArray([0, 0, 1, 2, 0, 0, 0, 3]))
	var credits := fake.ops().count("bj_credit")
	pipe.read()
	t.check("pipes: an empty read returns no credit", fake.ops().count("bj_credit") == credits)
	fake.reply["bj_send"] = 7
	t.check("pipes: a full native queue refuses the write", not pipe.write(PackedByteArray([1])))
	fake.reply["bj_send"] = 1
	t.check("pipes: an empty write is accepted without a call", pipe.write(PackedByteArray()) and fake.ops().count("bj_send") == 2)
	_data_event(fake, 258, PackedByteArray([5]))
	fake.queued.append(["bj_closed", JSON.stringify({"id": 258, "reason": "eof"}).to_utf8_buffer()])
	lane.poll()
	t.check("pipes: after eof it reads out what arrived, then is finished", pipe.is_open() and not pipe.is_finished() and not pipe.write(PackedByteArray([1])))
	pipe.read()
	t.check("pipes: and is closed once read", not pipe.is_open() and pipe.is_finished() and pipe.end_reason() == "eof" and lane.pipe_count() == 0)
	# A dial the native side refuses.
	fake.raw["bj_dial"] = PackedByteArray([0])
	t.check("pipes: an unknown instance is null", lane.dial(B) == null)
	fake.raw["bj_dial"] = PackedByteArray([7])
	t.check("pipes: a full native table is null", lane.dial(B) == null)
	t.check("pipes: a bad instance name never reaches the native side", lane.dial("x") == null and fake.ops().count("bj_dial") == 3)
	fake.raw.erase("bj_dial")
	# An error ends the pipe at once.
	fake.raw["bj_dial"] = PackedByteArray([1, 0, 0, 0, 5])
	var errored := lane.dial(A)
	fake.queued.append(["bj_closed", JSON.stringify({"id": 5, "reason": "error"}).to_utf8_buffer()])
	lane.poll()
	t.check("pipes: an error is final", errored.is_finished() and not errored.is_open() and errored.end_reason() == "error")
	# close and abort.
	fake.raw["bj_dial"] = PackedByteArray([1, 0, 0, 0, 6])
	var closing := lane.dial(A)
	closing.close()
	t.check("pipes: close lets the native queue drain (mode 0), and the pipe is done", fake.calls[-1][0] == "bj_close" and fake.calls[-1][1] == PackedByteArray([0, 0, 0, 6, 0])
			and closing.is_finished() and not closing.write(PackedByteArray([1])))
	fake.raw["bj_dial"] = PackedByteArray([1, 0, 0, 0, 7])
	var aborted := lane.dial(A)
	aborted.abort()
	t.check("pipes: abort drops it (mode 1)", fake.calls[-1][1] == PackedByteArray([0, 0, 0, 7, 1]) and aborted.is_finished() and lane.pipe_count() == 0)
	# Overflow aborts.
	fake.raw["bj_dial"] = PackedByteArray([1, 0, 0, 0, 8])
	var flood := lane.dial(A)
	flood._on_data(PackedByteArray([0]))
	var big := PackedByteArray()
	big.resize(PKeyApplePipe.MAX_IN)
	flood._on_data(big)
	t.check("pipes: more than MAX_IN unread aborts the pipe", flood.is_finished() and flood.end_reason() == "overflow")
	_accepted(t)


func _accepted(t: PKeyTestContext) -> void:
	var fake := FakeBin.new()
	var lane := _lane(fake)
	fake.queued.append(["bj_accepted", JSON.stringify({"id": 40, "remote": "192.168.1.9"}).to_utf8_buffer()])
	lane.poll()
	t.check("accepted: with no acceptor the socket is aborted natively", fake.calls[-1][0] == "bj_close" and fake.calls[-1][1] == PackedByteArray([0, 0, 0, 40, 1]) and lane.pipe_count() == 0)
	var got: Array = []
	lane.set_acceptor(func(p: PKeyApplePipe) -> void: got.append(p))
	fake.queued.append(["bj_accepted", JSON.stringify({"id": 41, "remote": "192.168.1.9"}).to_utf8_buffer()])
	fake.queued.append(["bj_accepted", JSON.stringify({"id": 41, "remote": "192.168.1.9"}).to_utf8_buffer()])
	fake.queued.append(["bj_accepted", JSON.stringify({"id": 0, "remote": "x"}).to_utf8_buffer()])
	lane.poll()
	var p: PKeyApplePipe = got[0]
	t.check("accepted: the acceptor gets one pipe, up already, with the remote address", got.size() == 1 and p.is_connected_native() and p.remote_address() == "192.168.1.9" and p.id() == 41)
	p.admit()
	t.check("accepted: admit tells the native side", fake.calls[-1][0] == "bj_admit" and fake.calls[-1][1] == PackedByteArray([0, 0, 0, 41]))
	for i in PKeyAppleMdns.MAX_PIPES + 10:
		fake.queued.append(["bj_accepted", JSON.stringify({"id": 100 + i, "remote": "10.0.0.1"}).to_utf8_buffer()])
	lane.poll()
	t.check("accepted: the pipe table is bounded; the surplus is aborted natively", lane.pipe_count() == PKeyAppleMdns.MAX_PIPES and fake.ops().count("bj_close") >= 11)
	lane.close_pipes()
	t.check("accepted: close_pipes aborts them all", lane.pipe_count() == 0 and p.is_finished())
	lane.set_acceptor(func(q: PKeyApplePipe) -> void: got.append(q))
	fake.queued.append(["bj_accepted", JSON.stringify({"id": 300, "remote": "10.0.0.1"}).to_utf8_buffer()])
	lane.poll()
	lane.stop()
	t.check("accepted: stop() ends the pipes and forgets the acceptor", lane.pipe_count() == 0 and got.back().is_finished() and fake.ops().has("bj_stop_all"))


func _fix_round(t: PKeyTestContext) -> void:
	var fake := FakeBin.new()
	var lane := _lane(fake)
	# R-6GN F3: another consumer's events are kept for it, not dropped.
	fake.queued.append(["transfer_chunk", PackedByteArray([1])])
	fake.queued.append(["bj_lost", JSON.stringify({"instance": A}).to_utf8_buffer()])
	lane.poll()
	var others: Array = lane._apple.poll_bin("transfer_")
	t.check("fix: discovery takes only bj_ events and leaves the rest for their consumer", others.size() == 1 and others[0][0] == "transfer_chunk")
	t.check("fix: and they are taken once", lane._apple.poll_bin("transfer_").is_empty() and lane._apple.poll_bin().is_empty())
	# R-6GN F7 (GDScript half): a set that did not take must not leave the old one in force.
	fake.reply["bj_accept"] = 3
	var before := fake.ops().count("bj_accept")
	t.check("fix: a refused accept set is reported and followed by an empty one", not lane.set_accepted([A]) and fake.ops().count("bj_accept") == before + 2
			and (fake.calls[-1][1] as PackedByteArray).is_empty())


func _export(t: PKeyTestContext) -> void:
	var apple_export := PKeyAppleExport
	var p := apple_export.local_network_plist("")
	t.check("export: Bonjour keys name the peer service and carry a usage sentence", p.contains("<key>NSBonjourServices</key>") and p.contains("<string>_pkeypeer._tcp</string>")
			and p.contains("<key>NSLocalNetworkUsageDescription</key>") and p.contains(apple_export.DEFAULT_LOCAL_NETWORK_USAGE))
	t.check("export: a key the preset already has is not doubled", not apple_export.local_network_plist("<key>NSBonjourServices</key>").contains("NSBonjourServices")
			and not apple_export.local_network_plist("<key>NSLocalNetworkUsageDescription</key>").contains("NSLocalNetworkUsageDescription")
			and apple_export.local_network_plist("<key>NSBonjourServices</key><key>NSLocalNetworkUsageDescription</key>") == "")
	var escaped := apple_export.local_network_plist("", "A & B")
	var blank := apple_export.local_network_plist("", "  ")
	t.check("export: a custom sentence is XML-escaped, an empty one falls back", escaped.contains("A &amp; B") and blank.contains(apple_export.DEFAULT_LOCAL_NETWORK_USAGE))
	var other := apple_export.bonjour_warning("<key>NSBonjourServices</key><string>_x._tcp</string>")
	var ours := apple_export.bonjour_warning("<key>NSBonjourServices</key><string>_pkeypeer._tcp</string>")
	t.check("export: a preset list without the peer service warns", other != "" and ours == "" and apple_export.bonjour_warning("") == "")
