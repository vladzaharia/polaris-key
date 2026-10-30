extends RefCounted
# @pkey-feature sync.files sync.files.delta
# The synced-file stream and the transfer planner against the generator-owned mirror of
# conformance/corpus/v2/sync-vectors.json (WIRE-CONTRACT-V5 §13.8.1, §13.10.4; U-23.G2):
# fileStreamCases (seal, sizes, open, range) and transferPlanCases, plus what the corpus does not
# pin (the lane cap, a ranged read of the wrong size, the reassembly check).
# The other sections run in suite_sync_vectors.

const VECTORS := "res://tests/corpus/v2/sync-vectors.json"


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	var j := JSON.new()
	if not t.check("vectors parse", j.parse(FileAccess.get_file_as_string(VECTORS)) == OK and j.data is Dictionary, VECTORS):
		return true
	var d: Dictionary = j.data
	_transfer_plan(t, d["transferPlanCases"])
	_file_stream(t, d["fileStreamCases"])
	_file_extras(t)
	return true


func _hex(s: String) -> PackedByteArray:
	return s.hex_decode()


func _sha(b: PackedByteArray) -> String:
	return PKeySyncHkdf.sha256(b).hex_encode()


## The deterministic bytes of a vector row: SHA-256 counter blocks `sha256(prefix + label + u32be(n))`.
func _counter_bytes(prefix: String, label: String, length: int) -> PackedByteArray:
	var out := PackedByteArray()
	out.resize(length)
	var at := 0
	var n := 0
	while at < length:
		var ctr := PackedByteArray([(n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF])
		var block := PKeySyncHkdf.sha256((prefix + label).to_utf8_buffer() + ctr)
		for i in mini(32, length - at):
			out[at + i] = block[i]
		at += 32
		n += 1
	return out


## Filler bytes for the tests that need no corpus recipe.
func _gen(n: int, mul: int, shift: int, add: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(n)
	for j in n:
		b[j] = (add + j * mul + ((j >> shift) if shift > 0 else 0)) & 255
	return b


func _transfer_plan(t: PKeyTestContext, rows: Array) -> void:
	for c in rows:
		var p := PKeySyncTransferPlan.plan(int(c["size"]), bool(c["delta"]))
		var e: Dictionary = c["expect"]
		t.check("plan %s mode" % c["id"], p.get("mode") == e["mode"], str(p))
		t.check("plan %s part bytes" % c["id"], p.get("part_bytes") == (0 if e["partBytes"] == null else int(e["partBytes"])), str(p))
		t.check("plan %s parts" % c["id"], p.get("parts") == (0 if e["parts"] == null else int(e["parts"])), str(p))
		if e["mode"] == "multipart":
			# The parts tile the file: contiguous, every one full but the last, none empty.
			var size := int(c["size"])
			var at := 0
			var tiled := true
			for n in range(1, int(p["parts"]) + 1):
				var r := PKeySyncTransferPlan.part_range(p, size, n)
				tiled = tiled and r["start"] == at and r["end"] > r["start"] and (n == p["parts"] or r["end"] - r["start"] == p["part_bytes"])
				at = r["end"]
			t.check("plan %s parts tile the file" % c["id"], tiled and at == size)
			t.check("plan %s has no part 0" % c["id"], PKeySyncTransferPlan.part_range(p, size, 0).is_empty())
			t.check("plan %s has no part past the last" % c["id"], PKeySyncTransferPlan.part_range(p, size, int(p["parts"]) + 1).is_empty())
		else:
			t.check("plan %s has no part ranges" % c["id"], PKeySyncTransferPlan.part_range(p, int(c["size"]), 1).is_empty())
	t.check("a negative size has no plan", PKeySyncTransferPlan.plan(-1, false).is_empty())


## The bytes of a seal row (SHA-256 counter blocks, the same recipe as the Node runner's `filePlain`).
func _file_plain(label: String, length: int) -> PackedByteArray:
	return _counter_bytes("pkey-sync vector file ", label, length)


## Applies the corpus's byte mutations. Segment i of a stream is at 64 + i * (1 MiB + 16).
func _file_ops(stream: PackedByteArray, ops: Array) -> PackedByteArray:
	var b := stream.duplicate()
	var stride := PKeySyncFileStream.SEGMENT_BYTES + PKeySyncFileStream.TAG_BYTES
	for o in ops:
		match o["op"]:
			"truncate":
				b = b.slice(0, int(o["length"]))
			"dropSegment":
				var r := _file_seg(b, int(o["index"]), stride)
				b = b.slice(0, r[0]) + b.slice(r[1])
			"swapSegments":
				var lo := mini(int(o["a"]), int(o["b"]))
				var hi := maxi(int(o["a"]), int(o["b"]))
				var r1 := _file_seg(b, lo, stride)
				var r2 := _file_seg(b, hi, stride)
				b = b.slice(0, r1[0]) + b.slice(r2[0], r2[1]) + b.slice(r1[1], r2[0]) + b.slice(r1[0], r1[1]) + b.slice(r2[1])
			"appendSegment":
				var r := _file_seg(b, int(o["from"]), stride)
				b = b + b.slice(r[0], r[1])
			"xor":
				b[int(o["offset"])] ^= int(o["value"])
			"setHex":
				var h := _hex(o["hex"])
				for i in h.size():
					b[int(o["offset"]) + i] = h[i]
			"appendHex":
				b = b + _hex(o["hex"])
	return b


func _file_seg(s: PackedByteArray, i: int, stride: int) -> Array:
	var a := 64 + i * stride
	return [a, mini(s.size(), a + stride)]


func _file_stream(t: PKeyTestContext, rows: Array) -> void:
	var bases := {}
	for r in rows:
		if r["kind"] != "seal":
			continue
		var id: String = r["id"]
		var root := _hex(r["rootHex"])
		var coll_key := PKeySyncHkdf.derive_coll_key(root, r["collection"])
		var kid := PKeySyncHkdf.derive_kid(root)
		var salt := _hex(r["saltHex"])
		var plain := _file_plain(r["plain"]["label"], int(r["plain"]["length"]))
		var e: Dictionary = r["expect"]
		t.check("file %s plaintext" % id, _sha(plain) == e["plainSha256Hex"])
		var res := PKeySyncFileStream.seal_file(coll_key, kid, plain, salt)
		var sealed: PackedByteArray = res.get("sealed", PackedByteArray())
		t.check("file %s seals" % id, res["ok"], str(res.get("reason")))
		var size_ok := sealed.size() == int(e["sealedSize"])
		size_ok = size_ok and PKeySyncFileStream.sealed_size(plain.size()) == sealed.size()
		size_ok = size_ok and PKeySyncFileStream.plain_size_of(sealed.size()) == plain.size()
		t.check("file %s sealed size" % id, size_ok)
		t.check("file %s header" % id, sealed.slice(0, 64).hex_encode() == e["headerHex"])
		t.check("file %s sealed bytes" % id, _sha(sealed) == e["sealedSha256Hex"])
		if e.has("sealedHex"):
			t.check("file %s sealed hex" % id, sealed.hex_encode() == e["sealedHex"])
		# The same bytes from a source that arrives in awkward pieces (only where there is more than
		# one segment's worth of boundary to cross; the seal itself is the same code).
		if plain.size() > PKeySyncFileStream.SEGMENT_BYTES - 2:
			var sl := PKeySyncFileStream.Sealer.new(coll_key, kid, salt)
			var streamed := sl.header.duplicate()
			var at := 0
			while at < plain.size():
				for seg in sl.push(plain.slice(at, at + 100003)):
					streamed.append_array(seg)
				at += 100003
			streamed.append_array(sl.finish())
			t.check("file %s streams to the same bytes" % id, sl.error == "" and _sha(streamed) == e["sealedSha256Hex"])
		bases[id] = {"bytes": sealed, "root": root, "coll": r["collection"]}
	for r in rows:
		var id: String = r["id"]
		match r["kind"]:
			"seal":
				pass
			"sizes":
				var ok := true
				for p in r["plainToSealed"]:
					ok = ok and PKeySyncFileStream.sealed_size(int(p[0])) == int(p[1])
				for p in r["sealedToPlain"]:
					ok = ok and PKeySyncFileStream.plain_size_of(int(p[0])) == (-1 if p[1] == null else int(p[1]))
				t.check("file %s" % id, ok)
			"open":
				var base: Dictionary = bases[r["base"]]
				var bytes := _file_ops(base["bytes"], r["mutate"])
				var coll_key := PKeySyncHkdf.derive_coll_key(base["root"], r.get("openCollection", base["coll"]))
				var kid := PKeySyncHkdf.derive_kid(base["root"]) if not r.has("expectKidHex") else _hex(r["expectKidHex"])
				var whole := PKeySyncFileStream.open_file(coll_key, kid, bytes)
				var e: Dictionary = r["expect"]
				if e["result"] == "ok":
					t.check("file %s opens" % id, whole["ok"] and _sha(whole["plain"]) == e["plainSha256Hex"], str(whole.get("reason")))
				else:
					t.check("file %s is refused as %s" % [id, e["reason"]], not whole["ok"] and whole["reason"] == e["reason"], str(whole))
				# The verdict does not depend on how the bytes arrive.
				t.check("file %s gives the same verdict in pieces" % id, _open_in_pieces(coll_key, kid, bytes, 300007) == (e["plainSha256Hex"] if e["result"] == "ok" else "!" + String(e["reason"])))
			"range":
				var base: Dictionary = bases[r["base"]]
				var bytes := _file_ops(base["bytes"], r["mutate"])
				var coll_key := PKeySyncHkdf.derive_coll_key(base["root"], base["coll"])
				var kid := PKeySyncHkdf.derive_kid(base["root"])
				var reads := []
				var read := func(offset: int, length: int) -> PackedByteArray:
					reads.append([offset, length])
					return bytes.slice(offset, offset + length)
				var got := PKeySyncFileStream.open_range(coll_key, kid, read, bytes.size(), int(r["start"]), int(r["end"]))
				var e: Dictionary = r["expect"]
				if e["result"] == "ok":
					var plain: PackedByteArray = got.get("plain", PackedByteArray())
					t.check("file %s length" % id, got["ok"] and plain.size() == int(e["length"]), str(got.get("reason")))
					t.check("file %s bytes" % id, got["ok"] and _sha(plain) == e["sha256Hex"])
					var want := []
					for p in e["reads"]:
						want.append([int(p[0]), int(p[1])])
					t.check("file %s reads only what it needs" % id, reads == want, str(reads))
				else:
					t.check("file %s is refused as %s" % [id, e["reason"]], not got["ok"] and got["reason"] == e["reason"], str(got))
			_:
				t.check("file row kind %s is known" % r["kind"], false)


## The verdict of an `Opener` fed `piece` bytes at a time: the plaintext SHA-256, or "!" and the reason.
func _open_in_pieces(coll_key: PackedByteArray, kid: PackedByteArray, bytes: PackedByteArray, piece: int) -> String:
	var o := PKeySyncFileStream.Opener.new(coll_key, kid)
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	var at := 0
	while at < bytes.size() and o.error == "":
		for seg in o.push(bytes.slice(at, at + piece)):
			h.update(seg)
		at += piece
	var last := o.finish()
	if o.error != "":
		return "!" + o.error
	if not last.is_empty():
		h.update(last)
	return h.finish().hex_encode()


func _file_extras(t: PKeyTestContext) -> void:
	var root := _gen(32, 5, 0, 3)
	var coll_key := PKeySyncHkdf.derive_coll_key(root, "saves")
	var kid := PKeySyncHkdf.derive_kid(root)
	var plain := _gen(300000, 7, 3, 2)
	# A seal draws a fresh salt: two seals of the same file differ and both open.
	var a := PKeySyncFileStream.seal_file(coll_key, kid, plain)
	var b := PKeySyncFileStream.seal_file(coll_key, kid, plain)
	t.check("a seal draws a fresh salt", a["ok"] and b["ok"] and a["sealed"].slice(32, 64) != b["sealed"].slice(32, 64) and a["sealed"] != b["sealed"])
	t.check("a fresh seal opens", PKeySyncFileStream.open_file(coll_key, kid, a["sealed"]).get("plain") == plain)
	# Key and shape refusals.
	t.check("a header needs a 16-byte kid", PKeySyncFileStream.header(kid.slice(0, 15), _gen(32, 1, 0, 0)).is_empty())
	t.check("a header needs a 32-byte salt", PKeySyncFileStream.header(kid, _gen(31, 1, 0, 0)).is_empty())
	t.check("a short collection key is refused", PKeySyncFileStream.seal_file(coll_key.slice(0, 31), kid, plain).get("reason") == "invalid")
	t.check("a negative size has no sealed size", PKeySyncFileStream.sealed_size(-1) == -1)
	# The GDScript lane cap (D-10): over 32 MiB is `unsupported`, before any crypto.
	t.check("the lane holds 32 MiB", PKeySyncFileStream.fits_lane(33554432) and not PKeySyncFileStream.fits_lane(33554433) and not PKeySyncFileStream.fits_lane(-1))
	var sl := PKeySyncFileStream.Sealer.new(coll_key, kid)
	var over := PackedByteArray()
	over.resize(PKeySyncFileStream.LANE_MAX_BYTES + 1)
	t.check("a seal over the lane cap is unsupported", sl.push(over).is_empty() and sl.error == "unsupported" and sl.finish().is_empty())
	var op := PKeySyncFileStream.Opener.new(coll_key, kid)
	var over_sealed := PackedByteArray()
	over_sealed.resize(PKeySyncFileStream.sealed_size(PKeySyncFileStream.LANE_MAX_BYTES) + 1)
	t.check("an open over the lane cap is unsupported", op.push(over_sealed).is_empty() and op.error == "unsupported")
	# A ranged read that answers the wrong size is `size`; one that answers a non-array is too.
	var stream: PackedByteArray = a["sealed"]
	var short := func(offset: int, length: int) -> PackedByteArray:
		return stream.slice(offset, offset + length - 1)
	t.check("a short ranged read is size", PKeySyncFileStream.open_range(coll_key, kid, short, stream.size(), 0, 10).get("reason") == "size")
	var junk := func(_offset: int, _length: int) -> Variant:
		return null
	t.check("a ranged read of nothing is size", PKeySyncFileStream.open_range(coll_key, kid, junk, stream.size(), 0, 10).get("reason") == "size")
	var whole := func(offset: int, length: int) -> PackedByteArray:
		return stream.slice(offset, offset + length)
	t.check("a range inside the file reads those bytes", PKeySyncFileStream.open_range(coll_key, kid, whole, stream.size(), 1000, 2000).get("plain") == plain.slice(1000, 2000))
	t.check("a ranged open under another collection fails the tag", PKeySyncFileStream.open_range(PKeySyncHkdf.derive_coll_key(root, "other"), kid, whole, stream.size(), 0, 10).get("reason") == "auth")
	# Reassembly: the manifest's plain size and SHA-256 over the pieces.
	var digest := PKeySyncHkdf.sha256(plain)
	var ra := PKeySyncFileStream.Reassembly.new(plain.size(), digest)
	var verdict := ""
	for at in range(0, plain.size(), 70001):
		verdict = ra.push(plain.slice(at, at + 70001))
		if verdict != "":
			break
	t.check("a reassembly that matches is accepted", verdict == "" and ra.finish() == "")
	ra = PKeySyncFileStream.Reassembly.new(plain.size(), digest)
	t.check("a reassembly that overruns stops at the push", ra.push(plain) == "" and ra.push(PackedByteArray([1])) == "plainSize" and ra.finish() == "plainSize")
	ra = PKeySyncFileStream.Reassembly.new(plain.size(), digest)
	t.check("a reassembly that falls short is plainSize", ra.push(plain.slice(0, 100)) == "" and ra.finish() == "plainSize")
	var wrong := plain.duplicate()
	wrong[5] ^= 1
	ra = PKeySyncFileStream.Reassembly.new(plain.size(), digest)
	t.check("a reassembly of other bytes is plainSha256", ra.push(wrong) == "" and ra.finish() == "plainSha256")
	ra = PKeySyncFileStream.Reassembly.new(PKeyConstants.SYNC_FILE_MAX_BYTES + 1, digest)
	t.check("a declared size over 1 GiB is plainSize", ra.push(PackedByteArray()) == "plainSize")
	ra = PKeySyncFileStream.Reassembly.new(0, PKeySyncHkdf.sha256(PackedByteArray()))
	t.check("the empty file reassembles", ra.finish() == "")
