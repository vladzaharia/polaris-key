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
	_slots(t)
	_pipes(t)
	_fix_round(t)
	_export(t)
	_local(t)
	_consumers(t)
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
	var extra := lane.browse(Seen.new().on_up)
	t.check("browse: a second browse shares the native one", extra.ok and fake.ops().count("bj_browse_start") == 1)
	extra.detail.stop()
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
	# Tag-only rows are counted apart: a full tag partition leaves room for the roster, and the reverse.
	var mix := FakeBin.new()
	mix.queued = []
	mix.raw["bj_caps"] = '{"slots":1}'.to_utf8_buffer()
	var lane3 := _lane(mix)
	var rows3 := Seen.new()
	lane3.browse(rows3.on_up, Callable(), func(n: String) -> bool: return n.begins_with("p1-a"), {"v": ["0123456789abcdef"]})
	for i in PKeyAppleMdns.MAX_TAG_ROWS + 40:
		mix.event("bj_found", {"instance": "p1-b%s" % _name16(i).substr(0, 15), "txt": ["v=1", "m=v", "h=0123456789abcdef"]})
	lane3.poll()
	t.check("browse: tag-only rows are bounded apart", rows3.up.size() == PKeyAppleMdns.MAX_TAG_ROWS)
	mix.event("bj_found", {"instance": "p1-a%s" % _name16(1).substr(0, 15), "txt": []})
	lane3.poll()
	t.check("browse: a roster row still enters when the tag partition is full", rows3.up.size() == PKeyAppleMdns.MAX_TAG_ROWS + 1)
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
	t.check("advertise: starts with the instance and TXT, and no port (the OS listener has its own)", first.ok
			and fake.json_of("bj_advertise_start") == {"slot": "a", "instance": A, "txt": ["v=1", "m=a"]})
	var second := lane.advertise({"instance": B, "port": 1234, "txt": ["v=1", "m=a"]})
	t.check("advertise: the next name updates the same advert", second.ok and fake.ops().count("bj_advertise_start") == 1 and fake.json_of("bj_advertise_update")["instance"] == B)
	first.detail.stop()
	t.check("advertise: the replaced handle's stop() does not stop the new name (lan rotates this way)", not fake.ops().has("bj_advertise_stop") and lane.status()["active"])
	fake.event("bj_advertise", {"ok": true, "port": 5555})
	lane.poll()
	t.check("advertise: the started port is kept", lane.port_of("a") == 5555)
	second.detail.stop()
	t.check("advertise: the current handle stops it", fake.ops().has("bj_advertise_stop") and not lane.status()["active"])
	lane.advertise({"instance": A, "txt": []})
	fake.event("bj_advertise", {"ok": false, "error": "permission_denied"})
	lane.poll()
	t.check("advertise: a failed start is reported and the advert is not running", lane.last_error() == "permission_denied" and not lane.advertising("a"))


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
	# Another consumer's events are kept for it, not dropped.
	fake.queued.append(["transfer_chunk", PackedByteArray([1])])
	fake.queued.append(["bj_lost", JSON.stringify({"instance": A}).to_utf8_buffer()])
	lane.poll()
	var others: Array = lane._apple.poll_bin("transfer_")
	t.check("fix: discovery takes only bj_ events and leaves the rest for their consumer", others.size() == 1 and others[0][0] == "transfer_chunk")
	t.check("fix: and they are taken once", lane._apple.poll_bin("transfer_").is_empty() and lane._apple.poll_bin().is_empty())
	# A set that did not take must not leave the old one in force.
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
	# Local pairing (CC-29b.G4): slots q and l are listeners of the one `_pkeypeer._tcp` service, so the one entry covers them.
	t.check("export: the one Bonjour entry and usage sentence cover the local slots too", apple_export.BONJOUR_SERVICE == "_pkeypeer._tcp"
			and apple_export.bonjour_warning("<key>NSBonjourServices</key><string>_pkeypeer._tcp</string>") == "")
	t.check("export: a preset list without the peer service warns", other != "" and ours == "" and apple_export.bonjour_warning("") == "")


func _caps_lane(slots: bool) -> Array:
	var fake := FakeBin.new()
	if slots:
		fake.raw["bj_caps"] = '{"slots":1}'.to_utf8_buffer()
	return [fake, _lane(fake)]


func _slots(t: PKeyTestContext) -> void:
	# An older binding: no slots, no tags; slot a and a roster-only browse keep working.
	var old := _caps_lane(false)
	var of: FakeBin = old[0]
	var ol: PKeyAppleMdns = old[1]
	t.check("slots: an older binding answers no slots and no tags", ol.capabilities() == {"slots": false, "tags": false, "local": false})
	var refused := ol.advertise({"instance": A, "slot": "v", "txt": []})
	t.check("slots: slot v on an older binding is nearby-unsupported and never reaches slot a", not refused.ok and refused.code == PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED
			and not of.ops().has("bj_advertise_start") and not ol.advertise({"instance": A, "slot": "c", "txt": []}).ok)
	var no_tags := ol.browse(Callable(), Callable(), Callable(), {"v": ["0123456789abcdef"]})
	t.check("slots: tags on an older binding are nearby-unsupported before any browse starts", not no_tags.ok
			and no_tags.code == PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED and not of.ops().has("bj_browse_start"))
	t.check("slots: slot a and a plain browse still work", ol.advertise({"instance": A, "txt": []}).ok and ol.browse(Callable()).ok)

	var pair := _caps_lane(true)
	var fake: FakeBin = pair[0]
	var lane: PKeyAppleMdns = pair[1]
	t.check("slots: caps are read from bj_caps", lane.capabilities() == {"slots": true, "tags": true, "local": false} and fake.ops().count("bj_caps") == 1)
	lane.capabilities()
	t.check("slots: and asked once", fake.ops().count("bj_caps") == 1)
	t.check("slots: a bad slot is invalid-argument", lane.advertise({"instance": A, "slot": "x", "txt": []}).code == PKeyConstants.ErrorCode.INVALID_ARGUMENT)
	var a := lane.advertise({"instance": A, "txt": ["v=1", "m=a"]})
	var v := lane.advertise({"instance": B, "slot": "v", "port": 99, "txt": ["v=1", "m=v", "h=0123456789abcdef"]})
	var p := lane.advertise({"instance": C, "slot": "p", "txt": ["v=1", "m=p"]})
	var starts: Array = fake.calls.filter(func(c): return c[0] == "bj_advertise_start").map(func(c): return JSON.parse_string((c[1] as PackedByteArray).get_string_from_utf8()))
	t.check("slots: each slot starts its own advert and the port is not passed", a.ok and v.ok and p.ok and starts.size() == 3
			and starts.map(func(x): return x["slot"]) == ["a", "v", "p"] and not starts[1].has("port"))
	fake.event("bj_advertise", {"slot": "v", "ok": true, "port": 7001})
	fake.event("bj_advertise", {"slot": "a", "ok": true, "port": 7000})
	fake.event("bj_advertise", {"slot": "p", "ok": false, "error": "permission_denied"})
	lane.poll()
	t.check("slots: start results are routed by slot", lane.port_of("v") == 7001 and lane.port_of("a") == 7000
			and lane.advertising("v") and not lane.advertising("p") and lane.last_error() == "permission_denied")
	t.check("slots: update on a handle moves that slot only", v.detail.update(A.replace("aaaa", "dddd"), ["v=1"]) and fake.json_of("bj_advertise_update")["slot"] == "v"
			and lane.advertising("a"))
	v.detail.stop()
	var stop_body: Dictionary = JSON.parse_string((fake.calls[-1][1] as PackedByteArray).get_string_from_utf8())
	t.check("slots: stop names the slot and leaves the others", fake.calls[-1][0] == "bj_advertise_stop" and stop_body == {"slot": "v"} and lane.advertising("a") and not lane.advertising("v"))
	t.check("slots: a stopped handle cannot update", not v.detail.update(B, []))

	# Contact adverts: a whole set on slot a's port.
	var handles: Array = []
	for i in PKeyAppleMdns.MAX_CONTACTS:
		var r := lane.advertise({"instance": "p1-%s" % _name16(100 + i), "slot": "c", "txt": ["v=1", "m=c"]})
		handles.append(r.detail)
	var pushed: Dictionary = JSON.parse_string((fake.calls[-1][1] as PackedByteArray).get_string_from_utf8())
	t.check("slots: contacts push the whole set each time (8 at most)", fake.calls[-1][0] == "bj_contacts" and (pushed["adverts"] as Array).size() == 8 and handles.all(func(h): return h != null))
	var ninth := lane.advertise({"instance": "p1-%s" % _name16(200), "slot": "c", "txt": []})
	t.check("slots: a ninth contact is refused", not ninth.ok and fake.ops().count("bj_contacts") == 8)
	var first: Object = handles[0]
	t.check("slots: a contact moves by update", first.update("p1-%s" % _name16(300), ["v=1", "m=c"]) and fake.ops().count("bj_contacts") == 9)
	first.stop()
	pushed = JSON.parse_string((fake.calls[-1][1] as PackedByteArray).get_string_from_utf8())
	t.check("slots: stopping a contact pushes the rest", (pushed["adverts"] as Array).size() == 7)
	fake.event("bj_withdrawn", {"slot": "c", "requested": "p1-%s" % _name16(101), "got": ""})
	lane.poll()
	t.check("slots: a contact the daemon withdrew leaves the wanted set", lane._contacts.size() == 6)
	fake.reply["bj_contacts"] = 3
	t.check("slots: a contact the native side refuses is not kept", not lane.advertise({"instance": "p1-%s" % _name16(400), "slot": "c", "txt": []}).ok and lane._contacts.size() == 6)

	# Accepted pipes go to their slot's acceptor.
	var got: Dictionary = {"a": [], "v": [], "p": []}
	for slot in ["a", "v", "p"]:
		lane.set_acceptor(slot, func(pp: PKeyApplePipe) -> void: got[slot].append(pp))
	fake.queued.append(["bj_accepted", JSON.stringify({"id": 51, "remote": "10.0.0.1", "slot": "v"}).to_utf8_buffer()])
	fake.queued.append(["bj_accepted", JSON.stringify({"id": 52, "remote": "10.0.0.1", "slot": "p"}).to_utf8_buffer()])
	fake.queued.append(["bj_accepted", JSON.stringify({"id": 53, "remote": "10.0.0.1"}).to_utf8_buffer()])
	lane.poll()
	t.check("slots: accepted pipes are routed by slot, a missing slot is a", got["v"].size() == 1 and got["v"][0].id() == 51 and got["p"].size() == 1 and got["p"][0].id() == 52
			and got["a"].size() == 1 and got["a"][0].id() == 53)
	lane.set_acceptor("p", Callable())
	fake.queued.append(["bj_accepted", JSON.stringify({"id": 54, "remote": "10.0.0.1", "slot": "p"}).to_utf8_buffer()])
	lane.poll()
	t.check("slots: a slot with no acceptor aborts the socket", fake.calls[-1][0] == "bj_close" and fake.calls[-1][1] == PackedByteArray([0, 0, 0, 54, 1]))
	lane.stop()
	t.check("slots: stop() forgets every slot, contact and acceptor", not lane.advertising("a") and lane._contacts.is_empty() and lane._acceptors.is_empty() and not lane.status()["active"])
	_tags(t)


func _tags(t: PKeyTestContext) -> void:
	var pair := _caps_lane(true)
	var fake: FakeBin = pair[0]
	var lane: PKeyAppleMdns = pair[1]
	var seen := Seen.new()
	var h := "0123456789abcdef"
	var h2 := "fedcba9876543210"
	var r := lane.browse(seen.on_up, seen.on_down, func(n: String) -> bool: return n == A, {"v": [h, h2, "extra"], "p": [], "x": [h]})
	t.check("tags: browse pushes the cleaned tags (two per kind, v and p only)", r.ok and fake.json_of("bj_accept_tags") == {"v": [h, h2]})
	fake.event("bj_found", {"instance": A, "txt": ["v=1", "m=a"]})
	fake.event("bj_found", {"instance": B, "txt": ["v=1", "m=v", "h=" + h]})
	fake.event("bj_found", {"instance": C, "txt": ["v=1", "m=p", "h=" + h]})
	fake.event("bj_found", {"instance": "p1-dddddddddddddddd", "txt": ["v=1", "m=v", "h=ffffffffffffffff"]})
	lane.poll()
	t.check("tags: a refused name enters only on m and h; a roster name always", seen.up.map(func(x): return x["instance"]) == [A, B])
	t.check("tags: replacing them is one call", lane.set_tags({"p": [h]}) and fake.json_of("bj_accept_tags") != {} and lane._tags == {"p": [h]})
	fake.event("bj_found", {"instance": C, "txt": ["v=1", "m=p", "h=" + h]})
	lane.poll()
	t.check("tags: and the new kind is admitted", seen.up.size() == 3)
	r.detail.stop()
	var body: Dictionary = JSON.parse_string((fake.calls[-1][1] as PackedByteArray).get_string_from_utf8())
	t.check("tags: ending the browse clears them natively", fake.calls[-1][0] == "bj_accept_tags" and body == {} and lane._tags.is_empty())
	var refuse := _caps_lane(true)
	(refuse[0] as FakeBin).reply["bj_accept_tags"] = 3
	var bad: PKeyAppleMdns = refuse[1]
	bad.browse(Callable(), Callable(), Callable(), {"v": [h]})
	t.check("tags: a refused set leaves none in force", bad._tags.is_empty() and (refuse[0] as FakeBin).ops().count("bj_accept_tags") == 2)


func _local_lane() -> Array:
	var fake := FakeBin.new()
	fake.raw["bj_caps"] = '{"slots":1,"local":1}'.to_utf8_buffer()
	return [fake, _lane(fake)]


func _body(fake: FakeBin, op: String, nth := -1) -> Dictionary:
	var hits: Array = fake.calls.filter(func(c): return c[0] == op)
	if hits.is_empty():
		return {}
	var c: Array = hits[nth]
	return JSON.parse_string((c[1] as PackedByteArray).get_string_from_utf8())


# Local pairing (CC-29b.G4): slots q and l, the q tag kind, and the m=l set on slot l.
func _local(t: PKeyTestContext) -> void:
	var old := _caps_lane(true)
	var refused: PKeyResult = (old[1] as PKeyAppleMdns).advertise({"instance": A, "slot": "q", "txt": ["v=1", "m=q"]})
	t.check("local: a binding without the local ops refuses q and l", not refused.ok and refused.detail.get("reason") == "local"
			and not (old[1] as PKeyAppleMdns).advertise({"instance": A, "slot": "l", "txt": []}).ok
			and not (old[1] as PKeyAppleMdns).browse(Callable(), Callable(), Callable(), {"q": ["0123456789abcdef"]}).ok)
	var pair := _local_lane()
	var fake: FakeBin = pair[0]
	var lane: PKeyAppleMdns = pair[1]
	t.check("local: capabilities say so", lane.capabilities()["local"] and not (old[1] as PKeyAppleMdns).capabilities()["local"])
	var q := lane.advertise({"instance": A, "slot": "q", "txt": ["v=1", "m=q", "n=12"]})
	t.check("local: slot q is a listener of its own", q.ok and _body(fake, "bj_advertise_start") == {"slot": "q", "instance": A, "txt": ["v=1", "m=q", "n=12"]})
	t.check("local: and it rotates like the others", q.detail.update(B, ["v=1", "m=q"]) and _body(fake, "bj_advertise_update")["slot"] == "q")
	q.detail.stop()
	t.check("local: and stops by slot", _body(fake, "bj_advertise_stop") == {"slot": "q"})

	# Slot l: the first name is the listener's own advert, the rest ride bj_locals.
	var handles: Array = []
	for i in PKeyAppleMdns.MAX_LOCALS:
		var r := lane.advertise({"instance": "p1-%s" % _name16(500 + i), "slot": "l", "txt": ["v=1", "m=l"]})
		handles.append(r.detail)
	var starts := fake.calls.filter(func(c): return c[0] == "bj_advertise_start" and JSON.parse_string((c[1] as PackedByteArray).get_string_from_utf8())["slot"] == "l")
	t.check("local: slot l starts once, with the first name", starts.size() == 1 and _body(fake, "bj_advertise_start", -1)["slot"] == "l"
			and handles.all(func(h): return h != null))
	t.check("local: the other seven ride bj_locals", (_body(fake, "bj_locals", 0)["adverts"] as Array).size() == 0 and (_body(fake, "bj_locals", -1)["adverts"] as Array).size() == 7)
	t.check("local: a ninth is refused", not lane.advertise({"instance": "p1-%s" % _name16(600), "slot": "l", "txt": []}).ok and lane._locals.size() == 8)
	t.check("local: a repeat of a running name is refused", not lane.advertise({"instance": "p1-%s" % _name16(500), "slot": "l", "txt": []}).ok)
	(handles[0] as Object).stop()
	t.check("local: stopping the first moves the listener's advert to the next name", _body(fake, "bj_advertise_update", -1) == {"slot": "l", "instance": "p1-%s" % _name16(501), "txt": ["v=1", "m=l"]}
			and (_body(fake, "bj_locals", -1)["adverts"] as Array).size() == 6)
	t.check("local: a name moves by update", (handles[1] as Object).update("p1-%s" % _name16(700), ["v=1", "m=l"]) and _body(fake, "bj_advertise_update", -1)["instance"] == "p1-%s" % _name16(700))
	fake.event("bj_withdrawn", {"slot": "l", "requested": "p1-%s" % _name16(502), "got": ""})
	lane.poll()
	t.check("local: a name the daemon withdrew leaves the wanted set", lane._locals.size() == 6)
	for i in range(2, 8):
		(handles[i] as Object).stop()
	t.check("local: the last name takes the listener down", (handles[1] as Object).update("p1-%s" % _name16(701), []) and lane._locals.size() == 1)
	(handles[1] as Object).stop()
	t.check("local: no names, no listener", _body(fake, "bj_advertise_stop", -1) == {"slot": "l"} and lane._locals.is_empty() and not lane.advertising("l"))
	fake.reply["bj_advertise_start"] = 3
	t.check("local: a refused start keeps no name", not lane.advertise({"instance": A, "slot": "l", "txt": []}).ok and lane._locals.is_empty())
	fake.reply.erase("bj_advertise_start")

	# Accepted sockets go to the slot's acceptor.
	var got: Dictionary = {"q": [], "l": []}
	for slot in ["q", "l"]:
		lane.set_acceptor(slot, func(pp: PKeyApplePipe) -> void: got[slot].append(pp))
	fake.queued.append(["bj_accepted", JSON.stringify({"id": 61, "remote": "10.0.0.2", "slot": "q"}).to_utf8_buffer()])
	fake.queued.append(["bj_accepted", JSON.stringify({"id": 62, "remote": "10.0.0.2", "slot": "l"}).to_utf8_buffer()])
	lane.poll()
	t.check("local: accepted pipes of q and l reach their own acceptor", got["q"].size() == 1 and got["q"][0].id() == 61 and got["l"].size() == 1 and got["l"][0].id() == 62)
	lane.stop()
	t.check("local: stop forgets the local set", lane._locals.is_empty() and lane._acceptors.is_empty())

	# The q tag kind: a joiner finds the window by its tag.
	var tag := "0123456789abcdef"
	var seen := Seen.new()
	var b := lane.browse(seen.on_up, seen.on_down, func(_n: String) -> bool: return false, {"q": [tag], "x": [tag]})
	t.check("local: q is a tag kind", b.ok and _body(fake, "bj_accept_tags", -1) == {"q": [tag]})
	fake.event("bj_found", {"instance": B, "txt": ["v=1", "m=q", "h=" + tag, "n=12"]})
	fake.event("bj_found", {"instance": C, "txt": ["v=1", "m=q", "h=ffffffffffffffff"]})
	lane.poll()
	t.check("local: a q advert with the tag enters, another does not", seen.up.size() == 1 and seen.up[0]["instance"] == B and seen.up[0]["native"])


# Several browses share the native one: each gets what its own filter admits.
func _consumers(t: PKeyTestContext) -> void:
	var pair := _local_lane()
	var fake: FakeBin = pair[0]
	var lane: PKeyAppleMdns = pair[1]
	var tag := "0123456789abcdef"
	var account := Seen.new()
	var locals := Seen.new()
	var a := lane.browse(account.on_up, account.on_down, func(n: String) -> bool: return n == A)
	var want_l := [B]
	fake.event("bj_found", {"instance": A, "txt": ["v=1", "m=a"]})
	fake.event("bj_found", {"instance": B, "txt": ["v=1", "m=l"]})
	lane.poll()
	t.check("share: the first browse sees its own roster only", account.up.size() == 1 and account.up[0]["instance"] == A)
	var l := lane.browse(locals.on_up, locals.on_down, func(n: String) -> bool: return want_l.has(n))
	t.check("share: a second browse starts nothing natively", l.ok and fake.ops().count("bj_browse_start") == 1)
	t.check("share: and is told what is already up that it accepts", locals.up.size() == 1 and locals.up[0]["instance"] == B)
	t.check("share: names are the union of both browses", a.detail.set_accepted([A]) and l.detail.set_accepted([B])
			and (fake.calls[-1][1] as PackedByteArray).get_string_from_ascii() == A + B)
	want_l.append(C)
	t.check("share: a browse replaces only its own names", l.detail.set_accepted([C]) and (fake.calls[-1][1] as PackedByteArray).get_string_from_ascii() == A + C)
	fake.event("bj_found", {"instance": C, "txt": ["v=1", "m=l"]})
	lane.poll()
	t.check("share: a name goes to the browse that accepts it", locals.up.size() == 2 and account.up.size() == 1)
	fake.event("bj_lost", {"instance": A})
	lane.poll()
	t.check("share: a loss reaches the browse that had the name", account.down == [A] and locals.down.is_empty())
	var pairs := Seen.new()
	var p := lane.browse(pairs.on_up, pairs.on_down, func(_n: String) -> bool: return false, {"q": [tag]})
	t.check("share: tags of a third browse are sent as the union", p.ok and fake.json_of("bj_accept_tags") != {} and lane._tags == {"q": [tag]})
	fake.event("bj_found", {"instance": B, "txt": ["v=1", "m=q", "h=" + tag]})
	lane.poll()
	t.check("share: a tag admits a row for the browse that holds it only", pairs.up.size() == 1 and locals.up.size() == 2 and account.up.size() == 1)
	p.detail.stop()
	t.check("share: ending it takes its tags back", _body(fake, "bj_accept_tags", -1) == {} and lane._tags.is_empty() and not fake.ops().has("bj_browse_stop"))
	a.detail.stop()
	t.check("share: the native browse runs while one is left", not fake.ops().has("bj_browse_stop") and (fake.calls[-1][1] as PackedByteArray).get_string_from_ascii() == C)
	l.detail.stop()
	t.check("share: the last one stops it", fake.ops().count("bj_browse_stop") == 1 and not lane.status()["active"])
