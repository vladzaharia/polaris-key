@tool
class_name PKeyPeerXfer
extends RefCounted
## WIRE-CONTRACT-V5 section 15.11: Direct Transfer (`xfer/1`), CC-20b.G1. The control-body codecs,
## the partial file's name and `Machine`, one side of one session as a state machine. Ported from
## `packages/client-core/src/peer/xfer.ts`; Python `core/peer_xfer.py` is the closest idiom
## (synchronous, Dictionary outputs). `peer-matrix.json` `xfer` is the conformance check.
##
## A machine does no I/O. It reads records, the host's calls and a clock (`at`, seconds), and
## answers each call with an output Dictionary (see `Machine.blank`): records to send, a question
## for the host, and effects on the kept partial files. The endpoint (a later slice) applies them in
## order: effects, then records, then events. Nothing here touches the file system, a key or a
## socket; SHA-256 is the engine's (`HashingContext`), so the code is the same on every runtime,
## the web included.
##
## Effects on partial files (a store applies them in order):
##   {create = ref, meta = {id, sha256, size, chunk}}   a new, empty partial
##   {truncate = ref, to = offset}                      keep the first `to` bytes (a resume)
##   {write = ref, offset, data}                        bytes for the partial
##   {keep = ref}  {discard = ref}  {evict = ref}  {delete = ref}
##   {finalize = ref}                                   the content is complete and verified
## A kept partial is read as {ref, id, sha256, size, chunk, bytes, writtenAt, held?, reread?}.
##
## Delivered content. The `delivered` option (`PKeyPeerXferDelivered.for_peer`) lets a receiver answer a
## re-offer of content it already delivered to the same peer (the sender never saw the last `DONE`):
## no consent and no room are needed, `ACCEPT` goes out at the last chunk boundary, the tail is read
## and dropped, `DONE` answers, and the result is `delivered` with `again = true`. No partial is
## made and no content is stored.

const MAX_CONTROL_BYTES := 4096
const MAX_SIZE := 1099511627776  # 2^40
const DEFAULT_CHUNK := 61440
const MAX_CHUNK := 65492
const WINDOW := 16
const ACK_EVERY := 8
const MAX_TRANSFERS := 4
const CONSENT_SECONDS := 120
const IDLE_SECONDS := 60
const PARTIAL_SECONDS := 86400
const MAX_PARTIALS_PER_PEER := 8
const ENDED_IDS := 64
const CHUNK_HEAD := 24
const CAP := "xfer/1"
## How long a receiver remembers a delivered (id, sha256, size) of one peer, and how many it keeps.
const DELIVERED_SECONDS := 86400
const MAX_DELIVERED_PER_PEER := 64
const MAX_DELIVERED_PEERS := 256

const OFFER := 0x0020
const ACCEPT := 0x0021
const CHUNK := 0x0022
const ACK := 0x0023
const DONE := 0x0024
const CANCEL := 0x0025

const REASONS: Array[String] = [
	"declined", "cancelled", "hash", "size", "category", "busy", "quota", "timeout",
]

static var _sha_re: RegEx
static var _cat_re: RegEx
static var _type_re: RegEx
static var _id_re: RegEx


static func _static_init() -> void:
	_sha_re = PKeyClaims.whole("[0-9a-f]{64}")
	_cat_re = PKeyClaims.whole("[a-z0-9-]{1,32}")
	_type_re = PKeyClaims.whole("[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*")
	_id_re = PKeyClaims.whole("[A-Za-z0-9_-]{22}")


## True for the six xfer record types.
static func is_xfer_type(type: int) -> bool:
	return type >= OFFER and type <= CANCEL


## A lower-case hex SHA-256.
static func is_sha(v: Variant) -> bool:
	return PKeyClaims.matches_whole_re(_sha_re, v)


## A transfer id: 22 canonical base64url characters of 16 bytes.
static func is_xfer_id(v: Variant) -> bool:
	return PKeyClaims.matches_whole_re(_id_re, v) and PKeyB64Url.is_canonical(v)


# Control bodies

## `{o = Dictionary, ni = PointerSet}` for a strict JSON object of at most 4 KiB, else null.
static func _control(body: PackedByteArray) -> Variant:
	if body.size() > MAX_CONTROL_BYTES:
		return null
	var r := PKeyJson.parse_bytes(body)
	if not r["ok"] or not r["value"] is Dictionary:
		return null
	return {"o": r["value"], "ni": r["non_wire_integers"]}


## An integer token in [lo, hi]: a number not written with a fraction or an exponent. -1 when it is
## not (every caller's lower bound is 0 or more).
static func _int_of(c: Dictionary, name: String, lo: int, hi: int) -> int:
	var o: Dictionary = c["o"]
	if not PKeyClaims.is_wire_integer(o.get(name), "/" + name, lo, c["ni"]):
		return -1
	var f := float(o[name])
	return int(f) if f <= float(hi) else -1


## An `OFFER` body; `max_message` is the reader's own HELLO value. {ok = true, offer = {...}} with
## only the members present, or {ok = false} (a `peer_bad_frame`).
static func parse_offer(body: PackedByteArray, max_message: int) -> Dictionary:
	var no := {"ok": false}
	var c: Variant = _control(body)
	if c == null:
		return no
	var o: Dictionary = c["o"]
	if not is_xfer_id(o.get("id")):
		return no
	var out := {"id": o["id"]}
	if o.has("name"):
		if not o["name"] is String or (o["name"] as String).to_utf8_buffer().size() > 255:
			return no
		out["name"] = o["name"]
	if o.has("type"):
		var ty: Variant = o["type"]
		if not ty is String or (ty as String).to_utf8_buffer().size() > 127 \
				or not PKeyClaims.matches_whole_re(_type_re, ty):
			return no
		out["type"] = ty
	var size := _int_of(c, "size", 0, MAX_SIZE)
	if size < 0:
		return no
	out["size"] = size
	if not is_sha(o.get("sha256")):
		return no
	out["sha256"] = o["sha256"]
	if o.has("cat"):
		if not PKeyClaims.matches_whole_re(_cat_re, o["cat"]):
			return no
		out["cat"] = o["cat"]
	var chunk := _int_of(c, "chunk", 1, MAX_CHUNK)
	if chunk < 0 or chunk + CHUNK_HEAD > max_message:
		return no
	out["chunk"] = chunk
	return {"ok": true, "offer": out}


## The sender's `OFFER` body. Members are `id`, `size`, `sha256`, `chunk` and, when set, `name`,
## `type`, `cat`.
static func offer_body(o: Dictionary) -> PackedByteArray:
	var d := {"id": o["id"]}
	for k in ["name", "type"]:
		if o.get(k) != null:
			d[k] = o[k]
	d["size"] = int(o["size"])
	d["sha256"] = o["sha256"]
	if o.get("cat") != null:
		d["cat"] = o["cat"]
	d["chunk"] = int(o["chunk"])
	return PKeyJson.stringify(d).to_utf8_buffer()


static func offset_body(id: String, offset: int) -> PackedByteArray:
	return PKeyJson.stringify({"id": id, "offset": offset}).to_utf8_buffer()


## `sha256` "" sends a `DONE` toward the sender (no hash).
static func done_body(id: String, sha256 := "") -> PackedByteArray:
	var d := {"id": id}
	if sha256 != "":
		d["sha256"] = sha256
	return PKeyJson.stringify(d).to_utf8_buffer()


static func cancel_body(id: String, reason: String) -> PackedByteArray:
	return PKeyJson.stringify({"id": id, "reason": reason}).to_utf8_buffer()


## A `CHUNK` body: `id(16) || u64be offset || data`. The big-endian is written by hand
## (`encode_u64` is little-endian).
static func chunk_body(id: String, offset: int, data: PackedByteArray) -> PackedByteArray:
	var b: PackedByteArray = PKeyB64Url.decode_strict(id)
	for shift in range(56, -1, -8):
		b.append((offset >> shift) & 0xFF)
	b.append_array(data)
	return b


static func _parse_id(c: Variant) -> String:
	if c == null:
		return ""
	var id: Variant = (c["o"] as Dictionary).get("id")
	return id if is_xfer_id(id) else ""


static func _offset_ok(v: int, size: int, chunk: int, ack: bool) -> bool:
	return v >= 0 and v <= size and (v % chunk == 0 or (ack and v == size))


## An `ACCEPT` or `ACK` body (`kind` "ACCEPT" or "ACK"), `{id, offset}`, judged against its
## `OFFER`'s `size` and `chunk`. {ok = true, id, offset} or {ok = false}.
static func parse_offset(kind: String, body: PackedByteArray, size: int, chunk: int) -> Dictionary:
	var c: Variant = _control(body)
	var id := _parse_id(c)
	if c == null or id == "":
		return {"ok": false}
	var off := _int_of(c, "offset", 0, MAX_SIZE)
	if off >= 0 and _offset_ok(off, size, chunk, kind == "ACK"):
		return {"ok": true, "id": id, "offset": off}
	return {"ok": false}


## A `DONE` body (`toward` "receiver" or "sender"): `{id, sha256}` toward the receiver, `{id}`
## toward the sender. {ok = true, id, sha256?} or {ok = false}.
static func parse_done(body: PackedByteArray, toward: String) -> Dictionary:
	var c: Variant = _control(body)
	var id := _parse_id(c)
	if c == null or id == "":
		return {"ok": false}
	var o: Dictionary = c["o"]
	if toward == "sender":
		return {"ok": true, "id": id} if not o.has("sha256") else {"ok": false}
	return {"ok": true, "id": id, "sha256": o["sha256"]} if is_sha(o.get("sha256")) else {"ok": false}


static func reason_of(r: String) -> String:
	return r if REASONS.has(r) else "cancelled"


## A `CANCEL` body. A string outside the eight reasons reads as `cancelled`. {ok = true, id,
## reason} or {ok = false}.
static func parse_cancel(body: PackedByteArray) -> Dictionary:
	var c: Variant = _control(body)
	var id := _parse_id(c)
	if c == null or id == "" or not (c["o"] as Dictionary).get("reason") is String:
		return {"ok": false}
	return {"ok": true, "id": id, "reason": reason_of(c["o"]["reason"])}


## A `CHUNK` body judged against its offer (`size`, `chunk`) and the next offset the receiver
## expects. {ok = true, id, offset, length} or {ok = false}.
static func parse_chunk(body: PackedByteArray, size: int, chunk: int, expect: int) -> Dictionary:
	var no := {"ok": false}
	if body.size() < CHUNK_HEAD:
		return no
	var id := PKeyB64Url.encode(body.slice(0, 16))
	var hi := (body[16] << 24) | (body[17] << 16) | (body[18] << 8) | body[19]
	var lo := (body[20] << 24) | (body[21] << 16) | (body[22] << 8) | body[23]
	# An offset at or past 2^52 can never be the next one; this also keeps the join below exact.
	if hi >= (1 << 20) or ((hi << 32) | lo) != expect:
		return no
	var length := body.size() - CHUNK_HEAD
	if length == 0 or length > chunk or expect + length > size:
		return no
	if length < chunk and expect + length != size:
		return no
	return {"ok": true, "id": id, "offset": expect, "length": length}


## The partial file's name (section 15.11, "The name is display data"): hex SHA-256 of
## `pkey-xfer/1 partial` || 0x00 || key (32 raw bytes) || id (16 bytes) || sha256 (32 bytes). It
## derives from the resume key only, so a peer-chosen `name` never reaches a path.
static func partial_path(key: PackedByteArray, id: String, sha256: String) -> String:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	h.update("pkey-xfer/1 partial".to_utf8_buffer())
	h.update(PackedByteArray([0]))
	h.update(key)
	h.update(PKeyB64Url.decode_strict(id))
	h.update(sha256.hex_decode())
	return h.finish().hex_encode()


## A fresh SHA-256 hasher.
static func new_hasher() -> HashingContext:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	return h


## The machine. One per (peer key, session); `new_session` reuses it across sessions so the kept
## partials survive.
class Machine extends RefCounted:
	const CLOSE_BAD_FRAME := &"peer_bad_frame"
	const CLOSE_NOT_ALLOWED := &"peer_not_allowed"

	var _mode: String
	var _caps: Array
	var _max_message: int
	var _peer_key: PackedByteArray
	var _handler: Callable
	var _host_limit := -1
	var _free: Callable
	var _cats: Array
	var _rehash: Callable
	var _new_ref: Callable
	var _delivered: Object = null
	var _withhold := false
	var _tr := {}
	var _ended: Array = []
	var _closed := false
	var _parts: Array = []
	var _clock := 0.0
	var _out: Dictionary = {}

	## `o`: `mode`, `caps` (the session's, both payloads intersected), `max_message` (this side's
	## own HELLO value), `peer_key` (32 raw bytes of the remote static key), `handler`
	## (Callable(ask: Dictionary) -> "accept" | "decline" | "ask"; invalid = decline every offer),
	## `host_limit` (bytes, -1 none), `free` (Callable() -> bytes still free, -1 unlimited),
	## `categories` (mode c), `partials` (the kept partials of this peer key), `rehash`
	## (Callable(ref, offset) -> a started HashingContext fed with the first `offset` bytes the store
	## re-read, or null when it could not), `new_ref` (Callable(id, sha256) -> a partial's name;
	## default `partial_path`), `withhold_acks` and `delivered` (this peer's view of a
	## `PKeyPeerXferDelivered`; none: every re-offer is received again).
	func _init(o: Dictionary) -> void:
		_peer_key = o.get("peer_key", PackedByteArray())
		assert(_peer_key.size() == 32, "peer_key")
		_mode = o.get("mode", "")
		_caps = o.get("caps", [])
		_max_message = int(o.get("max_message", PKeyPeerPayload.DEFAULT_MAX_MESSAGE))
		_handler = o.get("handler", Callable())
		_host_limit = int(o.get("host_limit", -1))
		_free = o.get("free", Callable())
		_cats = o.get("categories", [])
		_rehash = o.get("rehash", Callable())
		_new_ref = o.get("new_ref", Callable())
		_withhold = o.get("withhold_acks", false) == true
		_delivered = o.get("delivered", null) as Object
		for p in o.get("partials", []):
			_parts.append((p as Dictionary).duplicate())
		_out = blank()

	func _to_string() -> String:
		return "PKeyPeerXfer.Machine()"

	## The shape of every output. `close` is a peer_* code or &""; `ask` is null or the host's
	## question {id, name?, type?, size, cat?}; `refused` is "" or "busy" (the host's own send was
	## refused: too many live transfers; "invalid" and "id-used" for a bad `offer` call).
	static func blank() -> Dictionary:
		return {
			"send": [], "close": &"", "ask": null, "withdraw": [], "results": [],
			"partial": [], "refused": "", "drop": false,
			"delivered": [],
		}

	## Record content in the delivered memory once its `finalize` has been performed. A failed delivery
	## records nothing, so the next offer of it goes through consent again.
	func remember_delivered(entries: Array, at: float) -> void:
		if _delivered == null:
			return
		for d: Dictionary in entries:
			_delivered.add(d["id"], d["sha"], d["size"], at)

	## The kept partials now.
	func partials() -> Array:
		var out: Array = []
		for p in _parts:
			out.append((p as Dictionary).duplicate())
		return out

	## The number of live transfers.
	func live() -> int:
		return _tr.size()

	## The clock value at which the next wait runs out, or -1.0 when none is running.
	func next_deadline() -> float:
		var best := -1.0
		for t in _tr.values():
			var lim := _limit(t)
			if lim < 0.0:
				continue
			var at: float = t.since + lim
			if best < 0.0 or at < best:
				best = at
		return best

	# events

	## Only the clock moves.
	func tick(at: float) -> Dictionary:
		_begin(at)
		return _out

	## A record the session read: one of the six xfer types, `more` its flag.
	func receive(at: float, type: int, body: PackedByteArray, more := false) -> Dictionary:
		if _begin(at):
			_on_record(type, body, more)
		return _out

	## The host sends: `OFFER`. `a`: `id`, `size`, `chunk`, `sha256`, and optionally `cat`, `name`,
	## `type`, `seekable` (false when the source cannot restart at an offset above 0).
	func offer(at: float, a: Dictionary) -> Dictionary:
		var size: Variant = a.get("size")
		var chunk: Variant = a.get("chunk")
		if not PKeyPeerXfer.is_xfer_id(a.get("id")) or not size is int or size < 0 \
				or size > PKeyPeerXfer.MAX_SIZE or not chunk is int or chunk < 1 \
				or chunk > PKeyPeerXfer.MAX_CHUNK or not PKeyPeerXfer.is_sha(a.get("sha256")):
			_out = blank()
			_out["refused"] = "invalid"
			return _out
		var id: String = a["id"]
		if _tr.has(id) or _was_ended(id):
			_out = blank()
			_out["refused"] = "id-used"
			return _out
		if not _begin(at):
			return _out
		if _tr.size() >= PKeyPeerXfer.MAX_TRANSFERS:
			_out["refused"] = "busy"
			return _out
		var t := _new_tr(id, "out", size, chunk, a["sha256"])
		t.st = "offered"
		t.seekable = a.get("seekable", true) != false
		_tr[id] = t
		var s := {"t": "OFFER", "id": id, "size": size, "chunk": chunk, "sha256": a["sha256"]}
		for k in ["cat", "name", "type"]:
			if a.get(k) != null:
				s[k] = a[k]
		_out["send"].append(s)
		return _out

	## The host's answer ("accept" or "decline") to an `ask`.
	func consent(at: float, id: String, answer: String) -> Dictionary:
		if not _begin(at):
			return _out
		var t = _tr.get(id)
		if t == null or t.st != "asking":
			return _out
		if answer == "decline":
			_out["send"].append({"t": "CANCEL", "id": id, "reason": "declined"})
			_end(t, true)
			return _out
		_accept(t)
		return _out

	## The host's room check failed when the person accepted: `CANCEL quota` for that one transfer and
	## the session stays. A partial this transfer made at 0 bytes goes; one with bytes kept stays.
	func no_room(at: float, id: String) -> Dictionary:
		if not _begin(at):
			return _out
		var t = _tr.get(id)
		if t == null or t.dir != "in" or (t.st != "asking" and not t.accepted):
			return _out
		_out["send"].append({"t": "CANCEL", "id": id, "reason": "quota"})
		for p in _parts:
			if p["ref"] == t.partial and int(p["bytes"]) == 0:
				_eff({"discard": p["ref"]})
				_parts = _parts.filter(func(x: Dictionary) -> bool: return x != p)
				break
		_end(t, true)
		return _out

	## The host cancels a transfer.
	func cancel(at: float, id: String) -> Dictionary:
		if not _begin(at):
			return _out
		var t = _tr.get(id)
		if t == null:
			return _out
		# After its DONE a sender sends no CANCEL other than timeout.
		if t.dir == "out" and t.st == "doneSent":
			return _out
		_out["send"].append({"t": "CANCEL", "id": id, "reason": "cancelled"})
		if t.st == "asking":
			_out["withdraw"].append(id)
		elif t.dir == "in" and t.partial != "":
			_eff({"delete": t.partial})
		_result(t, {"id": id, "outcome": "cancelled", "reason": "cancelled"})
		_end(t, true)
		return _out

	## The host's source failed before the transfer's `DONE` went out: cancel an outgoing transfer
	## in any state (`cancel` refuses once the `DONE` is sent).
	func fail(at: float, id: String) -> Dictionary:
		if not _begin(at):
			return _out
		var t = _tr.get(id)
		if t == null or t.dir != "out":
			return _out
		_out["send"].append({"t": "CANCEL", "id": id, "reason": "cancelled"})
		_result(t, {"id": id, "outcome": "cancelled", "reason": "cancelled"})
		_end(t, true)
		return _out

	## The session ended. Does nothing when a fault already ended it; see `abandon`.
	func close(at: float) -> Dictionary:
		if _closed:
			_out = blank()
			return _out
		if _begin(at):
			_shutdown()
		return _out

	## The session closed (for any reason): report every live transfer `closed` and keep the
	## partials. Idempotent, and it also answers after a fault the machine itself raised.
	func abandon(at: float) -> Dictionary:
		_out = blank()
		_clock = at
		_shutdown()
		_closed = true
		return _out

	## A new session on the same machine keeps the partials, none held and none re-read.
	func new_session(at: float) -> Dictionary:
		_out = blank()
		_clock = at
		_tr.clear()
		_ended = []
		_closed = false
		for p in _parts:
			p.erase("reread")
			p["held"] = false
		return _out

	# internals

	func _begin(at: float) -> bool:
		_out = blank()
		if _closed:
			return false
		_clock = at
		_expire(at)
		return true

	func _shutdown() -> void:
		for t in _tr.values():
			if t.st == "asking":
				_out["withdraw"].append(t.id)
			elif t.dir == "in" and t.partial != "":
				_eff({"keep": t.partial})
			_result(t, {"id": t.id, "outcome": "closed"})
		_tr.clear()
		_closed = true

	func _eff(e: Dictionary) -> void:
		_out["partial"].append(e)
		var gone: Variant = e.get("delete", e.get("finalize"))
		if gone != null:
			_parts = _parts.filter(func(p: Dictionary) -> bool: return p["ref"] != gone)

	func _fault() -> void:
		_out["close"] = CLOSE_BAD_FRAME
		_closed = true

	## A transfer the host was never told about (still asking) reports no result.
	func _result(t: _Tr, r: Dictionary) -> void:
		if t.st == "asking":
			return
		# A re-offer answered from the memory reports only its own `delivered`, flagged.
		if t.again and r["outcome"] != "delivered":
			return
		_out["results"].append(r)

	func _remember(id: String, dir: String, cancelled_here: bool) -> void:
		_ended.append({"id": id, "dir": dir, "cancelled_here": cancelled_here})
		while _ended.size() > PKeyPeerXfer.ENDED_IDS:
			_ended.pop_front()

	func _was_ended(id: String) -> bool:
		for e in _ended:
			if e["id"] == id:
				return true
		return false

	func _end(t: _Tr, cancelled_here: bool) -> void:
		_tr.erase(t.id)
		_remember(t.id, t.dir, cancelled_here)

	func _new_tr(id: String, dir: String, size: int, chunk: int, sha: String) -> _Tr:
		var t := _Tr.new()
		t.id = id
		t.dir = dir
		t.size = size
		t.chunk = chunk
		t.sha = sha
		t.since = _clock
		return t

	# the clock

	## Seconds this transfer may wait in its current state; -1.0 while nothing is awaited.
	func _limit(t: _Tr) -> float:
		if t.dir == "in":
			return float(PKeyPeerXfer.CONSENT_SECONDS if t.st == "asking" else PKeyPeerXfer.IDLE_SECONDS)
		if t.st == "offered":
			return float(PKeyPeerXfer.CONSENT_SECONDS + PKeyPeerXfer.IDLE_SECONDS)
		if t.st == "doneSent":
			return float(PKeyPeerXfer.IDLE_SECONDS)
		return float(PKeyPeerXfer.IDLE_SECONDS) if t.full else -1.0

	## Every wait that ran out by `at` ends with `CANCEL timeout`; the partial is kept.
	func _expire(at: float) -> void:
		for t in _tr.values():
			var lim := _limit(t)
			if lim < 0.0 or at - t.since < lim:
				continue
			_out["send"].append({"t": "CANCEL", "id": t.id, "reason": "timeout"})
			if t.st == "asking":
				_out["withdraw"].append(t.id)
			elif t.dir == "in" and t.partial != "":
				_eff({"keep": t.partial})
			_result(t, {"id": t.id, "outcome": "cancelled", "reason": "timeout"})
			_end(t, true)

	# records

	func _on_record(type: int, body: PackedByteArray, more: bool) -> void:
		# Step 1: the mode and the capability.
		if (_mode != "a" and _mode != "c") or not _caps.has(PKeyPeerXfer.CAP):
			_out["close"] = CLOSE_NOT_ALLOWED
			_closed = true
		elif more or not PKeyPeerXfer.is_xfer_type(type):
			_fault()
		elif type == PKeyPeerXfer.OFFER:
			_on_offer(body)
		elif type == PKeyPeerXfer.CHUNK:
			_on_chunk(body)
		else:
			_on_control(type, body)

	## ACCEPT, ACK, DONE and CANCEL: the generic member checks, before the id is looked up.
	func _on_control(type: int, body: PackedByteArray) -> void:
		var c: Variant = PKeyPeerXfer._control(body)
		var id := PKeyPeerXfer._parse_id(c)
		if c == null or id == "":
			return _fault()
		var o: Dictionary = c["o"]
		var offset := 0
		var sha := ""
		var reason := "cancelled"
		if type == PKeyPeerXfer.ACCEPT or type == PKeyPeerXfer.ACK:
			offset = PKeyPeerXfer._int_of(c, "offset", 0, PKeyPeerXfer.MAX_SIZE)
			if offset < 0:
				return _fault()
		elif type == PKeyPeerXfer.DONE:
			if o.has("sha256"):
				if not PKeyPeerXfer.is_sha(o["sha256"]):
					return _fault()
				sha = o["sha256"]
		else:
			if not o.get("reason") is String:
				return _fault()
			reason = PKeyPeerXfer.reason_of(o["reason"])
		var t = _tr.get(id)
		if t == null:
			_late(id, type, sha)
		elif type == PKeyPeerXfer.ACCEPT:
			_on_accept(t, offset)
		elif type == PKeyPeerXfer.ACK:
			_on_ack(t, offset)
		elif type == PKeyPeerXfer.DONE:
			_on_done(t, sha)
		else:
			_on_cancel(t, reason)

	## A record for an id that is not live: dropped when remembered, else a fault. `sha` "" is none.
	func _late(id: String, type: int, sha: String) -> void:
		var e: Variant = null
		for x in _ended:
			if x["id"] == id:
				e = x
				break
		if e == null:
			return _fault()
		if type == PKeyPeerXfer.DONE and e["dir"] == "out" and e["cancelled_here"] and sha == "":
			_out["results"].append({"id": id, "outcome": "delivered"})
			e["cancelled_here"] = false
			return
		_out["drop"] = true

	func _on_offer(body: PackedByteArray) -> void:
		var parsed := PKeyPeerXfer.parse_offer(body, _max_message)
		if not parsed["ok"]:
			return _fault()
		var f: Dictionary = parsed["offer"]
		var id: String = f["id"]
		if _tr.has(id) or _was_ended(id):
			return _fault()
		var verdict := _screen(f)
		if verdict == "again":
			# Content this device already delivered to this peer needs no room and no new consent: it
			# is answered as done, reading at most the last chunk again.
			var again := _new_tr(id, "in", f["size"], f["chunk"], f["sha256"])
			again.again = true
			return _accept_again(again)
		if verdict != "":
			return _refuse(id, verdict)
		# Step 7: consent.
		var ask := {"id": id, "size": f["size"]}
		var shown: Variant = PKeyDeviceLabel.clean_name(f["name"]) if f.has("name") else null
		if shown != null:
			ask["name"] = shown
		if f.has("type"):
			ask["type"] = f["type"]
		if f.has("cat"):
			ask["cat"] = f["cat"]
		var answer: String = String(_handler.call(ask)) if _handler.is_valid() else "decline"
		if answer == "decline":
			return _refuse(id, "declined")
		var t := _new_tr(id, "in", f["size"], f["chunk"], f["sha256"])
		_tr[id] = t
		if answer == "ask":
			_out["ask"] = ask
		else:
			_accept(t)

	## Steps 4 to 6 and the delivered memory: the reason an offer is refused, "again" for delivered content
	## offered once more, or "" when the person is to be asked.
	func _screen(f: Dictionary) -> String:
		var reason := _refusal(f)
		if reason != "":
			return reason
		if _delivered != null and _delivered.has(f["id"], f["sha256"], f["size"], _clock):
			return "again"
		return _room_refusal(f)

	## Steps 4 and 5, in order: the reason an offer is refused before anything else, or "".
	func _refusal(f: Dictionary) -> String:
		var kept: Variant = null
		for p in _parts:
			if p["id"] == f["id"] and p["sha256"] == f["sha256"]:
				kept = p
				break
		# Step 4: busy.
		var asking := false
		for x in _tr.values():
			if x.st == "asking":
				asking = true
		if _tr.size() >= PKeyPeerXfer.MAX_TRANSFERS or asking \
				or (kept != null and kept.get("held", false) == true):
			return "busy"
		# Step 5: the category, before the person is asked.
		if _mode == "c" and (not f.has("cat") or not _cats.has(f["cat"])):
			return "category"
		return ""

	## Step 6: size and quota; a resume counts only the bytes still to come.
	func _room_refusal(f: Dictionary) -> String:
		var kept: Variant = null
		for p in _parts:
			if p["id"] == f["id"] and p["sha256"] == f["sha256"]:
				kept = p
				break
		if _host_limit >= 0 and f["size"] > _host_limit:
			return "size"
		var free := int(_free.call()) if _free.is_valid() else -1
		var need: int = f["size"] - (int(kept["bytes"]) if kept != null and _resumable(f, kept) else 0)
		return "quota" if free >= 0 and need > free else ""

	## `ACCEPT` at the last chunk boundary of delivered content; the tail is read and dropped.
	func _accept_again(t: _Tr) -> void:
		@warning_ignore("integer_division")
		var offset: int = (t.size / t.chunk) * t.chunk
		_tr[t.id] = t
		t.recv = offset
		t.acked_end = offset
		t.st = "active"
		t.accepted = true
		t.since = _clock
		_out["send"].append({"t": "ACCEPT", "id": t.id, "offset": offset})

	## A refusal `CANCEL` ends that id at once.
	func _refuse(id: String, reason: String) -> void:
		_out["send"].append({"t": "CANCEL", "id": id, "reason": reason})
		_remember(id, "in", true)

	func _resumable(f: Dictionary, p: Dictionary) -> bool:
		return p["size"] == f["size"] and p["chunk"] == f["chunk"] \
				and _clock - float(p["writtenAt"]) <= PKeyPeerXfer.PARTIAL_SECONDS

	## Step 8: the resume lookup, then `ACCEPT`.
	func _accept(t: _Tr) -> void:
		var m: Variant = null
		for p in _parts:
			if p["id"] == t.id and p["sha256"] == t.sha:
				m = p
				break
		var offset := 0
		var h: HashingContext = null
		var resume: bool = m != null and _resumable({"size": t.size, "chunk": t.chunk}, m)
		if resume:
			var read: int = mini(int(m.get("reread", m["bytes"])), int(m["bytes"]))
			@warning_ignore("integer_division")
			var want := mini((read / t.chunk) * t.chunk, t.size)
			if _rehash.is_valid() and want > 0:
				# The store could not re-read the kept bytes (the file is gone or short): no
				# resume, a fresh start at 0 over a new partial.
				var rehashed: Variant = _rehash.call(m["ref"], want)
				if rehashed is HashingContext:
					h = rehashed
					offset = want
				else:
					resume = false
		if resume:
			t.partial = m["ref"]
			_eff({"truncate": m["ref"], "to": offset})
			m["bytes"] = offset
			m["writtenAt"] = _clock
			m.erase("reread")
		else:
			if m != null:
				_eff({"discard": m["ref"]})
				_parts = _parts.filter(func(p: Dictionary) -> bool: return p != m)
			if t.size > 0:
				if _parts.size() >= PKeyPeerXfer.MAX_PARTIALS_PER_PEER:
					# The oldest partial no live transfer holds; a held one only when all are.
					var pool: Array = _parts.filter(func(p: Dictionary) -> bool: return not p.get("held", false))
					if pool.is_empty():
						pool = _parts
					var oldest: Dictionary = pool[0]
					for p in pool:
						if float(p["writtenAt"]) < float(oldest["writtenAt"]):
							oldest = p
					_eff({"evict": oldest["ref"]})
					_parts = _parts.filter(func(p: Dictionary) -> bool: return p != oldest)
				var ref: String
				if _new_ref.is_valid():
					ref = String(_new_ref.call(t.id, t.sha))
				else:
					ref = PKeyPeerXfer.partial_path(_peer_key, t.id, t.sha)
				_eff({"create": ref, "meta": {
					"id": t.id, "sha256": t.sha, "size": t.size, "chunk": t.chunk}})
				_parts.append({
					"ref": ref, "id": t.id, "sha256": t.sha, "size": t.size,
					"chunk": t.chunk, "bytes": 0, "writtenAt": _clock,
				})
				t.partial = ref
		t.hash = h if h != null else PKeyPeerXfer.new_hasher()
		t.recv = offset
		t.acked_end = offset
		t.st = "active"
		t.accepted = true
		t.since = _clock
		_out["send"].append({"t": "ACCEPT", "id": t.id, "offset": offset})

	func _on_accept(t: _Tr, offset: int) -> void:
		if t.dir != "out" or t.accepted or t.st != "offered":
			return _fault()
		if not PKeyPeerXfer._offset_ok(offset, t.size, t.chunk, false):
			return _fault()
		t.accepted = true
		if offset > 0 and not t.seekable:
			_out["send"].append({"t": "CANCEL", "id": t.id, "reason": "cancelled"})
			_result(t, {"id": t.id, "outcome": "cancelled", "reason": "cancelled"})
			_end(t, true)
			return
		t.st = "active"
		t.sent_end = offset
		t.ack_end = offset
		t.since = _clock
		_pump(t, true)

	## The sender sends what the window allows, then `DONE` once the last byte is out.
	func _pump(t: _Tr, first: bool) -> void:
		var start := t.sent_end
		var room: int = PKeyPeerXfer.WINDOW * t.chunk - (t.sent_end - t.ack_end)
		var up_to := mini(t.size, t.sent_end + maxi(0, room))
		var end := t.sent_end
		while end < up_to:
			end = mini(t.size, end + t.chunk)
		if end > start:
			_out["send"].append({"t": "CHUNKS", "id": t.id, "offset": start, "bytes": end - start})
			t.sent_end = end
		if t.sent_end == t.size:
			_out["send"].append({"t": "DONE", "id": t.id, "sha256": t.sha})
			t.st = "doneSent"
			t.full = false
			t.since = _clock
			return
		# The idle wait for an `ACK` starts when the window fills, and again on progress.
		var full: bool = t.sent_end - t.ack_end >= PKeyPeerXfer.WINDOW * t.chunk
		if full and (not t.full or end > start or first):
			t.since = _clock
		t.full = full

	func _on_ack(t: _Tr, offset: int) -> void:
		if t.dir != "out" or not t.accepted:
			return _fault()
		if offset < t.ack_end or offset > t.sent_end \
				or not PKeyPeerXfer._offset_ok(offset, t.size, t.chunk, true):
			return _fault()
		t.ack_end = offset
		if t.st == "active":
			_pump(t, false)

	func _on_chunk(body: PackedByteArray) -> void:
		if body.size() < PKeyPeerXfer.CHUNK_HEAD:
			return _fault()
		var id := PKeyB64Url.encode(body.slice(0, 16))
		var t = _tr.get(id)
		if t == null:
			return _late(id, PKeyPeerXfer.CHUNK, "")
		if t.dir != "in" or t.st != "active":
			return _fault()
		var v := PKeyPeerXfer.parse_chunk(body, t.size, t.chunk, t.recv)
		if not v["ok"]:
			return _fault()
		# The window: more than `WINDOW` chunks past the last `ACK` this side sent.
		if v["offset"] + v["length"] - t.acked_end > PKeyPeerXfer.WINDOW * t.chunk:
			return _fault()
		var data := body.slice(PKeyPeerXfer.CHUNK_HEAD)
		var end: int = v["offset"] + v["length"]
		if t.hash != null:
			t.hash.update(data)
		var offset: int = t.recv
		t.recv = end
		t.since_ack += 1
		t.since = _clock
		for p in _parts:
			if t.partial != "" and p["ref"] == t.partial:
				p["bytes"] = end
				p["writtenAt"] = _clock
				_out["partial"].append({"write": p["ref"], "offset": offset, "data": data})
				break
		if t.since_ack >= PKeyPeerXfer.ACK_EVERY or end == t.size:
			t.since_ack = 0
			if not _withhold:
				_out["send"].append({"t": "ACK", "id": t.id, "offset": end})
				t.acked_end = end

	## `sha` "" is none.
	func _on_done(t: _Tr, sha: String) -> void:
		if t.dir == "out":
			_on_done_out(t, sha)
		else:
			_on_done_in(t, sha)

	func _on_done_out(t: _Tr, sha: String) -> void:
		# A DONE toward the sender carries no hash, and only follows its own DONE.
		if sha != "" or t.st != "doneSent":
			return _fault()
		_result(t, {"id": t.id, "outcome": "delivered"})
		_end(t, false)

	func _on_done_in(t: _Tr, sha: String) -> void:
		if sha == "" or t.st != "active":
			return _fault()
		if t.recv < t.size:
			return _cancel_in(t, "size")
		if t.again:
			if sha != t.sha:
				return _cancel_in(t, "hash")
			_out["send"].append({"t": "DONE", "id": t.id})
			_result(t, {"id": t.id, "outcome": "delivered", "again": true})
			_end(t, false)
			return
		if sha != t.sha or t.hash.finish().hex_encode() != t.sha:
			return _cancel_in(t, "hash")
		_out["send"].append({"t": "DONE", "id": t.id})
		if t.partial != "":
			_eff({"finalize": t.partial})
		# Remembered by the endpoint only once the host's delivery succeeded (`remember_delivered`).
		if t.partial != "":
			_out["delivered"].append({"id": t.id, "sha": t.sha, "size": t.size})
		_result(t, {"id": t.id, "outcome": "delivered"})
		_end(t, false)

	func _cancel_in(t: _Tr, reason: String) -> void:
		_out["send"].append({"t": "CANCEL", "id": t.id, "reason": reason})
		if t.partial != "":
			_eff({"delete": t.partial})
		_result(t, {"id": t.id, "outcome": "cancelled", "reason": reason})
		_end(t, true)

	func _on_cancel(t: _Tr, reason: String) -> void:
		if t.st == "asking":
			_out["withdraw"].append(t.id)
		elif t.dir == "in" and t.partial != "":
			_eff({"keep": t.partial} if reason == "timeout" else {"delete": t.partial})
		_result(t, {"id": t.id, "outcome": "cancelled", "reason": reason})
		_end(t, false)


	## One live transfer.
	class _Tr extends RefCounted:
		var id := ""
		var dir := ""
		var st := "asking"
		var size := 0
		var chunk := 0
		var sha := ""
		## When the current wait began.
		var since := 0.0
		var recv := 0
		var since_ack := 0
		var acked_end := 0
		var hash: HashingContext
		var partial := ""
		var accepted := false
		var sent_end := 0
		var ack_end := 0
		var seekable := true
		var full := false
		## A re-offer of delivered content answered from the memory.
		var again := false
