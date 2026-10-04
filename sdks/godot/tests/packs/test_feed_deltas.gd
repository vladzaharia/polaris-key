extends RefCounted
# @pkey-feature packs.delta.feed
# Feed-offered deltas in PKeyPackEngine (plans/P4-29.md §2.4; client-core packsFeedDelta.test.ts,
# case for case) over custom.blob container packs whose payloads are the zstd probe pair
# (F.PROBE_FRAME_HEX decodes the probe target from the probe base):
#
#   planned    the feed's delta for a record that carries none is planned and installed
#   cold       a 404 (a cold delta) falls back to the next candidate, with a `fallback` event
#   artifact   a stored artifact that is not the menu entry's falls back
#   output     a frame decoding to other bytes is checked against the RECORD (delta-apply-failed)
#   base       an installed base whose bytes changed is refused (delta-base-mismatch)
#   one        at most one feed-offered delta per install; the rest of the menu is skipped
#   tie        a record delta wins a cost tie and a menu entry naming it is not added twice
#   source     the menu is read at each plan; a source answering anything else is no menu
#   resume     a journal's own feedDelta is planned again though the feed no longer lists it
#   abandon    a journal whose delta neither the record nor its feedDelta names is re-planned
#
# Without the patch-from decode (engines outside PKeyPackZstd.PATCH_FROM_ENGINES) the SDK does not
# advertise the method, so the menu is never planned: that is checked instead.

const S := preload("res://tests/packs/support.gd")
const F := preload("res://tests/packs/fixtures.gd")
const PACK := "djdl.feedblob"

var base := PackedByteArray()
var target := PackedByteArray()
var frame := PackedByteArray()


func run(t: PKeyTestContext) -> void:
	base = F.probe_base()
	target = F.probe_target()
	frame = F.PROBE_FRAME_HEX.hex_decode()
	if not PKeyPackZstd.new().patch_from_available():
		await _unadvertised(t)
		return
	await _planned(t)
	await _cold(t)
	await _artifact(t)
	await _output(t)
	await _base(t)
	await _one(t)
	await _tie(t)
	await _source(t)
	await _resume(t)
	await _abandon(t)


## A feed menu entry to the probe target from `from`, whose artifact is `art`.
func _entry(from: PackedByteArray, art: PackedByteArray) -> Dictionary:
	return {"from": F.sha(from), "method": "zstd-patch-from", "scope": "payload", "memBytes": from.size() + target.size(),
		"artifact": {"sha256": F.sha(art), "bytes": art.size()}}


func _menu(entries: Array) -> Dictionary:
	return {F.sha(target): entries}


## One zstd frame of one raw block (RFC 8878 §3.1.1.2) with its content size (client-core `rawFrame`).
static func _raw_frame(content: PackedByteArray) -> PackedByteArray:
	var n := content.size()
	var h := (n << 3) | 1
	var out := PackedByteArray([0x28, 0xb5, 0x2f, 0xfd, 0xa0, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff])
	out.append_array(content)
	return out


## v1 (the probe base) and v2 (the probe target) with NO record delta; `extra` objects beside them.
func _pair(extra: Array = []) -> Array:
	var v1 := F.blob_pack(PACK, "1.0.0", 1, base)
	var v2 := F.blob_pack(PACK, "1.1.0", 2, target)
	for b in extra:
		v2["objects"][F.sha(b)] = b
	return [v1, v2]


static func _target(p: Dictionary) -> Dictionary:
	return {"pack": p["packId"], "release": {"sha256": p["recordSha256"], "seq": p["seq"], "version": p["version"]}}


## An engine over `root` pinning `stamp_pack`, with the blob handler and `menu` as its feed source
## (a Callable, or null for none); its progress events are collected in `events`.
func _engine(root: String, tr: F.FakeTransport, stamp_pack: Dictionary, menu: Variant, events: Array) -> PKeyPackEngine:
	var e := F.engine(root, tr, F.stamp_for([stamp_pack]))
	e.register_handler(F.BlobHandler.new())
	if menu is Callable:
		e.feed_deltas = menu
	e.progress.connect(func(ev: Dictionary) -> void: events.append(ev))
	return e


static func _fallbacks(events: Array) -> Array:
	return events.filter(func(ev): return ev.get("phase") == "fallback")


static func _payload_of(e: PKeyPackEngine) -> String:
	var a = e.state()["active"].get(PACK)
	return String(a.get("payloadSha256", "")) if a is Dictionary else ""


## v1 installed, then v2 ensured; returns {e, tr, events, r}.
func _v1_then_v2(t: PKeyTestContext, label: String, pair: Array, menu: Variant, before_v2 := Callable()) -> Dictionary:
	var root := S.scratch("feed-delta-" + label)
	var tr := F.FakeTransport.new().add(pair[0]).add(pair[1])
	var events: Array = []
	var e := _engine(root, tr, pair[0], menu, events)
	await e.load_state([])
	var r1 := await e.ensure_releases([_target(pair[0])])
	t.check("%s: v1 installs" % label, r1.ok, str(r1))
	if before_v2.is_valid():
		before_v2.call(e, tr)
	tr.calls.clear()
	events.clear()
	var started := Time.get_ticks_usec()
	var r := await e.ensure_releases([_target(pair[1])])
	t.info("%s: v2 in %.1f ms" % [label, (Time.get_ticks_usec() - started) / 1000.0])
	return {"e": e, "tr": tr, "events": events, "r": r, "root": root}


func _fetched(tr: F.FakeTransport) -> Array:
	return tr.calls.map(func(c): return c["sha256"])


func _planned(t: PKeyTestContext) -> void:
	var menu := _menu([_entry(base, frame)])
	var o := await _v1_then_v2(t, "planned", _pair([frame]), func() -> Variant: return menu)
	t.check("planned: the feed's delta installs a record that carries none", o["r"].ok and _payload_of(o["e"]) == F.sha(target), str(o["r"]))
	t.check("planned: …having fetched only the feed's artifact", _fetched(o["tr"]) == [F.sha(frame)], S.canon(_fetched(o["tr"])))
	t.check("planned: …with no fallback", _fallbacks(o["events"]).is_empty(), S.canon(o["events"]))
	S.remove_tree(o["root"])


func _cold(t: PKeyTestContext) -> void:
	var menu := _menu([_entry(base, frame)])
	var o := await _v1_then_v2(t, "cold", _pair(), func() -> Variant: return menu)
	var fb := _fallbacks(o["events"])
	t.check("cold: a 404 for the feed's delta falls back and installs by the next candidate", o["r"].ok and _payload_of(o["e"]) == F.sha(target), str(o["r"]))
	t.check("cold: …one fallback event {strategy: delta, error: network-error}", fb.size() == 1 and fb[0]["strategy"] == "delta" and fb[0]["error"] == String(PKeyErrors.NETWORK), S.canon(fb))
	t.check("cold: …and no journal is left", o["e"].state()["inflight"].is_empty())
	S.remove_tree(o["root"])


func _artifact(t: PKeyTestContext) -> void:
	var menu := _menu([_entry(base, frame)])
	var bad := frame.duplicate()
	bad[bad.size() - 1] = bad[bad.size() - 1] ^ 1
	var pair := _pair()
	pair[1]["objects"][F.sha(frame)] = bad
	var o := await _v1_then_v2(t, "artifact", pair, func() -> Variant: return menu)
	var fb := _fallbacks(o["events"])
	t.check("artifact: a stored artifact that is not the menu entry's falls back", o["r"].ok and _payload_of(o["e"]) == F.sha(target), str(o["r"]))
	t.check("artifact: …one delta fallback", fb.size() == 1 and fb[0]["strategy"] == "delta", S.canon(fb))
	S.remove_tree(o["root"])


func _output(t: PKeyTestContext) -> void:
	var other := "not the payload the record pins, but a valid frame all the same\n".to_utf8_buffer()
	var f := _raw_frame(other)
	var e := _entry(base, f)
	e["memBytes"] = base.size() + 4096
	var menu := _menu([e])
	var o := await _v1_then_v2(t, "output", _pair([f]), func() -> Variant: return menu)
	var fb := _fallbacks(o["events"])
	t.check("output: a frame decoding to other bytes is checked against the record and falls back", o["r"].ok and _payload_of(o["e"]) == F.sha(target), str(o["r"]))
	t.check("output: …fallback {strategy: delta, error: delta-apply-failed}", fb.size() == 1 and fb[0]["strategy"] == "delta" and fb[0]["error"] == PKeyPackApply.DELTA_APPLY_FAILED, S.canon(fb))
	S.remove_tree(o["root"])


func _base(t: PKeyTestContext) -> void:
	var menu := _menu([_entry(base, frame)])
	# The installed base's bytes change under the engine (a disk fault): its hash no longer equals
	# the entry's `from`.
	var corrupt := func(e: PKeyPackEngine, _tr) -> void:
		var path := e.storage.container_path(F.sha(base))
		var b := FileAccess.get_file_as_bytes(path)
		b[0] = b[0] ^ 1
		S.write_file(path, b)
	var o := await _v1_then_v2(t, "base", _pair([frame]), func() -> Variant: return menu, corrupt)
	var fb := _fallbacks(o["events"])
	t.check("base: a changed installed base is refused and falls back", o["r"].ok and _payload_of(o["e"]) == F.sha(target), str(o["r"]))
	t.check("base: …fallback {strategy: delta, error: delta-base-mismatch}", fb.size() == 1 and fb[0]["strategy"] == "delta" and fb[0]["error"] == PKeyPackApply.DELTA_BASE_MISMATCH, S.canon(fb))
	S.remove_tree(o["root"])


func _one(t: PKeyTestContext) -> void:
	# Two installed bases (A previous, the probe base active) and two feed entries: the cheap one
	# from the probe base 404s; the other, from A, is on the server but is never fetched.
	var a := "an older payload of the same pack\n".to_utf8_buffer()
	var second := _raw_frame(target)
	var v0 := F.blob_pack(PACK, "0.9.0", 1, a)
	var v1 := F.blob_pack(PACK, "1.0.0", 2, base)
	var v2 := F.blob_pack(PACK, "1.1.0", 3, target)
	v2["objects"][F.sha(second)] = second
	var root := S.scratch("feed-delta-one")
	var tr := F.FakeTransport.new().add(v0).add(v1).add(v2)
	var events: Array = []
	var menu := _menu([_entry(base, frame), _entry(a, second)])
	var e := _engine(root, tr, v0, func() -> Variant: return menu, events)
	await e.load_state([])
	await e.ensure_releases([_target(v0)])
	await e.ensure_releases([_target(v1)])
	tr.calls.clear()
	events.clear()
	var r := await e.ensure_releases([_target(v2)])
	var got := _fetched(tr)
	t.check("one: v2 installs", r.ok and _payload_of(e) == F.sha(target), str(r))
	t.check("one: the first feed delta is tried, the second never fetched", got.has(F.sha(frame)) and not got.has(F.sha(second)), S.canon(got))
	t.check("one: …one fallback", _fallbacks(events).size() == 1, S.canon(_fallbacks(events)))
	S.remove_tree(root)


func _tie(t: PKeyTestContext) -> void:
	var v1 := F.blob_pack(PACK, "1.0.0", 1, base)
	var v2 := F.blob_pack(PACK, "1.1.0", 2, target, {"delta": {"from": base, "frame": frame}})
	var menu := _menu([_entry(base, frame)])
	var merged := PKeyPackSelect.with_feed_deltas(v2["record"]["variants"][0], menu)
	t.check("tie: a menu entry naming the record delta's id is not added twice", (merged["feedIds"] as Array).is_empty() and (merged["variant"]["deltas"] as Array).size() == 1, S.canon(merged["feedIds"]))
	var o := await _v1_then_v2(t, "tie", [v1, v2], func() -> Variant: return menu)
	t.check("tie: the record delta installs, fetched once, with no fallback", o["r"].ok and _fetched(o["tr"]) == [F.sha(frame)] and _fallbacks(o["events"]).is_empty(), S.canon(_fetched(o["tr"])))
	S.remove_tree(o["root"])


func _source(t: PKeyTestContext) -> void:
	var calls := [0]
	var o := await _v1_then_v2(t, "source", _pair([frame]), func() -> Variant:
		calls[0] += 1
		return "no committed feed")
	t.check("source: the menu is read at each plan", calls[0] > 0, str(calls[0]))
	t.check("source: a source answering anything but a Dictionary is no menu", o["r"].ok and _payload_of(o["e"]) == F.sha(target) and not _fetched(o["tr"]).has(F.sha(frame)), S.canon(_fetched(o["tr"])))
	S.remove_tree(o["root"])


## v1 installed, then a crash after the journal of a v2 delta install was written (`feed_delta`:
## the journal's feedDelta, or null). Returns {root, tr, pair}.
func _crashed(t: PKeyTestContext, label: String, feed_delta: Variant) -> Dictionary:
	var pair := _pair([frame])
	var root := S.scratch("feed-delta-" + label)
	var tr := F.FakeTransport.new().add(pair[0]).add(pair[1])
	var first := _engine(root, tr, pair[0], null, [])
	await first.load_state([])
	var r1 := await first.ensure_releases([_target(pair[0])])
	t.check("%s: v1 installs" % label, r1.ok, str(r1))
	var j := JSON.new()
	j.parse(FileAccess.get_file_as_string(first.storage.state_path))
	var doc: Dictionary = j.data
	var journal := {
		"planId": label + "-plan", "packId": PACK, "record": pair[1]["jws"], "recordSha256": pair[1]["recordSha256"], "variant": "",
		"strategy": "delta", "delta": F.sha(frame), "objects": [{"sha256": F.sha(frame), "bytes": frame.size(), "done": 0}], "startedAt": 1759400000,
	}
	if feed_delta != null:
		journal["feedDelta"] = feed_delta
	doc["inflight"][PACK] = journal
	S.write_file(first.storage.state_path, JSON.stringify(F.ints(doc)).to_utf8_buffer())
	return {"root": root, "tr": tr, "pair": pair}


func _resume(t: PKeyTestContext) -> void:
	var c := await _crashed(t, "resume", _entry(base, frame))
	var tr: F.FakeTransport = c["tr"]
	var second := _engine(c["root"], tr, c["pair"][1], func() -> Variant: return null, [])
	var fresh := [0]
	second.new_plan_id = func() -> String:
		fresh[0] += 1
		return "fresh-plan"
	await second.load_state([])
	t.check("resume: the journal with feedDelta is kept at load", second.state()["inflight"].get(PACK, {}).get("planId") == "resume-plan", S.canon(second.state()["inflight"]))
	tr.calls.clear()
	var r := await second.ensure_releases([_target(c["pair"][1])])
	t.check("resume: the journal's own feed delta is planned again though the feed lists none", r.ok and _payload_of(second) == F.sha(target) and _fetched(tr) == [F.sha(frame)], "%s %s" % [r, S.canon(_fetched(tr))])
	t.check("resume: …under the journal's plan id (no fresh plan)", fresh[0] == 0, str(fresh[0]))
	S.remove_tree(c["root"])


func _abandon(t: PKeyTestContext) -> void:
	var c := await _crashed(t, "abandon", null)
	var tr: F.FakeTransport = c["tr"]
	var second := _engine(c["root"], tr, c["pair"][1], null, [])
	var fresh := [0]
	second.new_plan_id = func() -> String:
		fresh[0] += 1
		return "fresh-plan"
	await second.load_state([])
	tr.calls.clear()
	var r := await second.ensure_releases([_target(c["pair"][1])])
	t.check("abandon: a journal whose delta neither the record nor its feedDelta names is re-planned", r.ok and _payload_of(second) == F.sha(target) and fresh[0] > 0, "%s fresh=%d" % [r, fresh[0]])
	t.check("abandon: …and the frame is never fetched", not _fetched(tr).has(F.sha(frame)), S.canon(_fetched(tr)))
	S.remove_tree(c["root"])


func _unadvertised(t: PKeyTestContext) -> void:
	var menu := _menu([_entry(base, frame)])
	var o := await _v1_then_v2(t, "unadvertised", _pair([frame]), func() -> Variant: return menu)
	t.check("unadvertised: without zstd-patch-from the feed's delta is never planned (%s)" % Engine.get_version_info().string,
		o["r"].ok and _payload_of(o["e"]) == F.sha(target) and not _fetched(o["tr"]).has(F.sha(frame)) and _fallbacks(o["events"]).is_empty(), S.canon(_fetched(o["tr"])))
	S.remove_tree(o["root"])
