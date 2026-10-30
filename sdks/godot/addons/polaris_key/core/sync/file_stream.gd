@tool
class_name PKeySyncFileStream
extends RefCounted
## `pkey-sync-file/1` (WIRE-CONTRACT-V5 §13.10.4): a file sealed as a stream of segments.
##
##   header, 64 bytes little-endian: "PKSYNCF1", version u16 (1), flags u16 (0),
##     segmentBytes u32 (1 MiB), kid (16 bytes), salt (32 bytes)
##   segment i: AES-256-GCM(K_file, nonce = u8(last) | 0x00 0x00 0x00 | u64be(i), aad = header,
##     the segment's plaintext), so 16 bytes longer than its plaintext
##
## K_file comes from K_coll and the header's salt (`PKeySyncHkdf.derive_file_key`). Every segment
## but the last holds exactly 1 MiB of plaintext; the last holds 1..1 MiB, except that an empty
## file is one empty last segment. The end of the stream says which segment is last, so a
## truncated stream, a dropped or reordered segment and a missing last flag all fail the tag.
##
## Nothing here holds a whole file unless the caller asks for it (`seal_file` / `open_file`): the
## `Sealer` and the `Opener` keep at most one segment and the bytes in hand, and `open_range`
## reads and decrypts only the segments it needs.
##
## The Godot lane is GDScript AES-GCM (about 1.6 MB/s, `PKeySyncAesGcm`), so a whole file sealed or
## opened here is at most `LANE_MAX_BYTES` (32 MiB, D-10): over that the reason is `unsupported`
## (this engine's own reason, never a wire code; the engine maps it to the typed "unsupported"
## result). Native lanes lift the cap (U-23.GM). A ranged open reads only the segments in the
## range and has no cap.
##
## Refusals are `{"ok": false, "reason": r}`; r is one of `shape`, `magic`, `version`, `flags`,
## `segmentSize`, `kid` (the header, in that order), then the body: `shape` (no segment, or a
## tail shorter than a tag), `size` (an empty last segment after others, or a short ranged read),
## `auth` (a segment fails its tag: truncation, reordering, a missing last flag, a tampered
## header), `range` (a ranged open outside the file), `plainSize` and `plainSha256` (a
## `Reassembly`), and `unsupported` (the lane cap).

const MAGIC := "PKSYNCF1"
const VERSION := 1
const HEADER_BYTES := 64
## The only segment size `pkey-sync-file/1` defines.
const SEGMENT_BYTES := 1048576
const TAG_BYTES := 16
const KID_BYTES := 16
const SALT_BYTES := 32
## The most plaintext one GDScript-lane file holds (D-10, Q9: the saves default).
const LANE_MAX_BYTES := 33554432


## The 64-byte header, or an empty array for a kid that is not 16 bytes or a salt that is not 32.
static func header(kid: PackedByteArray, salt: PackedByteArray) -> PackedByteArray:
	if kid.size() != KID_BYTES or salt.size() != SALT_BYTES:
		return PackedByteArray()
	var h := PackedByteArray()
	h.resize(HEADER_BYTES)
	h.fill(0)
	var magic := MAGIC.to_ascii_buffer()
	for i in 8:
		h[i] = magic[i]
	h.encode_u16(8, VERSION)
	h.encode_u16(10, 0)
	h.encode_u32(12, SEGMENT_BYTES)
	for i in KID_BYTES:
		h[16 + i] = kid[i]
	for i in SALT_BYTES:
		h[32 + i] = salt[i]
	return h


## The sealed size of a plaintext of `plain_size` bytes (-1 for a negative size).
static func sealed_size(plain_size: int) -> int:
	if plain_size < 0:
		return -1
	var segments := maxi(1, (plain_size + SEGMENT_BYTES - 1) / SEGMENT_BYTES)
	return HEADER_BYTES + plain_size + segments * TAG_BYTES


## The plaintext size a sealed size implies, or -1 when no stream has that size.
static func plain_size_of(sealed: int) -> int:
	var body := sealed - HEADER_BYTES
	var whole := SEGMENT_BYTES + TAG_BYTES
	if body < TAG_BYTES:
		return -1
	var full := body / whole
	var rest := body - full * whole
	if rest == 0:
		return full * SEGMENT_BYTES
	if rest < TAG_BYTES:
		return -1
	# An empty last segment is only the empty file.
	if rest == TAG_BYTES and full > 0:
		return -1
	return full * SEGMENT_BYTES + (rest - TAG_BYTES)


## True when a whole file of `plain_size` bytes fits the GDScript lane.
static func fits_lane(plain_size: int) -> bool:
	return plain_size >= 0 and plain_size <= LANE_MAX_BYTES


## The 12-byte nonce of segment `index`: the last flag, three zero bytes, the index big-endian.
static func _nonce(index: int, last: bool) -> PackedByteArray:
	var n := PackedByteArray()
	n.resize(12)
	n.fill(0)
	n[0] = 1 if last else 0
	for i in 8:
		n[4 + i] = (index >> (56 - 8 * i)) & 0xFF
	return n


## Seals `plain` as one stream (header and segments). `{"ok": true, "sealed": bytes}`, or a
## refusal: `unsupported` over the lane cap, `invalid` for a key, kid or salt of the wrong length.
## `fixed_salt` is for known-answer vectors only; a seal draws a fresh random salt.
static func seal_file(coll_key: PackedByteArray, kid: PackedByteArray, plain: PackedByteArray, fixed_salt: Variant = null) -> Dictionary:
	var s := Sealer.new(coll_key, kid, fixed_salt)
	if s.error != "":
		return _bad(s.error)
	var out := s.header.duplicate()
	for seg in s.push(plain):
		out.append_array(seg)
	if s.error != "":
		return _bad(s.error)
	out.append_array(s.finish())
	if s.error != "":
		return _bad(s.error)
	return {"ok": true, "sealed": out}


## Opens a whole stream. `{"ok": true, "plain": bytes}` or a refusal.
static func open_file(coll_key: PackedByteArray, kid: PackedByteArray, sealed: PackedByteArray) -> Dictionary:
	var o := Opener.new(coll_key, kid)
	var out := PackedByteArray()
	for seg in o.push(sealed):
		out.append_array(seg)
	if o.error != "":
		return _bad(o.error)
	var last := o.finish()
	if o.error != "":
		return _bad(o.error)
	out.append_array(last)
	return {"ok": true, "plain": out}


## Opens bytes `[start, end)` of the plaintext of a stored stream of `sealed_len` bytes.
## `read` is a `Callable(offset, length) -> PackedByteArray`; a short answer is a `size` refusal.
## It reads the header and then only the segments that overlap the range, each verified as a
## whole; the last-segment flag comes from `sealed_len`, so a server that lies about the size or
## drops a tail fails the tag. An `end` past the plaintext is `range`.
static func open_range(coll_key: PackedByteArray, kid: PackedByteArray, read: Callable, sealed_len: int, start: int, end: int) -> Dictionary:
	var plain_len := plain_size_of(sealed_len)
	if plain_len < 0:
		return _bad("shape")
	if start < 0 or start > end or end > plain_len:
		return _bad("range")
	var hdr: Variant = _fetch(read, 0, HEADER_BYTES)
	if hdr == null:
		return _bad("size")
	var parsed := _parse_header(hdr, kid)
	if not parsed["ok"]:
		return parsed
	if start == end:
		return {"ok": true, "plain": PackedByteArray()}
	var key := PKeySyncHkdf.derive_file_key(coll_key, parsed["salt"])
	if key.is_empty():
		return _bad("invalid")
	var whole := SEGMENT_BYTES + TAG_BYTES
	var segments := maxi(1, (plain_len + SEGMENT_BYTES - 1) / SEGMENT_BYTES)
	var first := start / SEGMENT_BYTES
	var last_index := (end - 1) / SEGMENT_BYTES
	var out := PackedByteArray()
	for i in range(first, last_index + 1):
		var is_last := i == segments - 1
		var seg_len := plain_len - i * SEGMENT_BYTES if is_last else SEGMENT_BYTES
		var sealed: Variant = _fetch(read, HEADER_BYTES + i * whole, seg_len + TAG_BYTES)
		if sealed == null:
			return _bad("size")
		var plain: Variant = PKeySyncAesGcm.open(key, _nonce(i, is_last), sealed, parsed["header"])
		if plain == null:
			return _bad("auth")
		var from := maxi(start, i * SEGMENT_BYTES) - i * SEGMENT_BYTES
		var to := mini(end, i * SEGMENT_BYTES + seg_len) - i * SEGMENT_BYTES
		out.append_array((plain as PackedByteArray).slice(from, to))
	return {"ok": true, "plain": out}


## A read of exactly `length` bytes, or null when the reader answers any other size.
static func _fetch(read: Callable, offset: int, length: int) -> Variant:
	var b: Variant = read.call(offset, length)
	if not (b is PackedByteArray) or (b as PackedByteArray).size() != length:
		return null
	return b


## `{"ok": true, "header": the 64 bytes, "salt": 32 bytes}` or the first header refusal.
static func _parse_header(b: PackedByteArray, kid: PackedByteArray) -> Dictionary:
	if b.size() < HEADER_BYTES:
		return _bad("shape")
	var magic := MAGIC.to_ascii_buffer()
	for i in 8:
		if b[i] != magic[i]:
			return _bad("magic")
	if b.decode_u16(8) != VERSION:
		return _bad("version")
	if b.decode_u16(10) != 0:
		return _bad("flags")
	if b.decode_u32(12) != SEGMENT_BYTES:
		return _bad("segmentSize")
	if not PKeySyncAesGcm.equal_constant_time(b.slice(16, 16 + KID_BYTES), kid):
		return _bad("kid")
	return {"ok": true, "header": b.slice(0, HEADER_BYTES), "salt": b.slice(32, HEADER_BYTES)}


static func _bad(reason: String) -> Dictionary:
	return {"ok": false, "reason": reason}


## Seals a file as it arrives. `push` returns the sealed segments that the bytes complete; `finish`
## returns the last one. The header is `header` (send it first). One byte is held back until
## more arrives, so the final segment is known to be the last. `error` is "" until a refusal
## (`unsupported` over the lane cap, `invalid` for a bad key, kid or salt), after which every
## call answers nothing.
class Sealer:
	extends RefCounted
	var header := PackedByteArray()
	var error := ""
	var _key := PackedByteArray()
	var _index := 0
	var _buf := PackedByteArray()
	var _total := 0

	## `fixed_salt` is for known-answer vectors only; null draws a fresh random 32-byte salt.
	func _init(coll_key: PackedByteArray, kid: PackedByteArray, fixed_salt: Variant = null) -> void:
		var salt: PackedByteArray = Crypto.new().generate_random_bytes(PKeySyncFileStream.SALT_BYTES) if fixed_salt == null else fixed_salt
		header = PKeySyncFileStream.header(kid, salt)
		if header.is_empty() or coll_key.size() != 32:
			error = "invalid"
			return
		_key = PKeySyncHkdf.derive_file_key(coll_key, salt)
		if _key.is_empty():
			error = "invalid"

	func push(data: PackedByteArray) -> Array:
		var out := []
		if error != "":
			return out
		_total += data.size()
		if _total > PKeySyncFileStream.LANE_MAX_BYTES:
			error = "unsupported"
			_buf = PackedByteArray()
			return out
		_buf.append_array(data)
		while _buf.size() > PKeySyncFileStream.SEGMENT_BYTES:
			var seg := _seal(_buf.slice(0, PKeySyncFileStream.SEGMENT_BYTES), false)
			if seg.is_empty():
				return []
			out.append(seg)
			_buf = _buf.slice(PKeySyncFileStream.SEGMENT_BYTES)
		return out

	## The last sealed segment (an empty file is one empty last segment). Empty once `error` is set.
	func finish() -> PackedByteArray:
		if error != "":
			return PackedByteArray()
		var seg := _seal(_buf, true)
		_buf = PackedByteArray()
		return seg

	func _seal(plain: PackedByteArray, last: bool) -> PackedByteArray:
		var sealed := PKeySyncAesGcm.seal(_key, PKeySyncFileStream._nonce(_index, last), plain, header)
		if sealed.is_empty():
			error = "invalid"
			return PackedByteArray()
		_index += 1
		return sealed


## Opens a sealed stream as it arrives. `push` returns the plaintext of each segment whose tag has
## verified; `finish` returns the last one. Truncation is only known at `finish`, so a caller that
## writes the plaintext out treats it as provisional until `finish` leaves `error` empty.
## `error` is the first refusal (see the file comment), after which every call answers nothing.
class Opener:
	extends RefCounted
	var error := ""
	var _coll_key := PackedByteArray()
	var _kid := PackedByteArray()
	var _key := PackedByteArray()
	var _header := PackedByteArray()
	var _have_header := false
	var _index := 0
	var _buf := PackedByteArray()
	var _total := 0

	func _init(coll_key: PackedByteArray, kid: PackedByteArray) -> void:
		_coll_key = coll_key
		_kid = kid

	func push(data: PackedByteArray) -> Array:
		var out := []
		if error != "":
			return out
		_total += data.size()
		if _total > PKeySyncFileStream.sealed_size(PKeySyncFileStream.LANE_MAX_BYTES):
			error = "unsupported"
			_buf = PackedByteArray()
			return out
		_buf.append_array(data)
		if not _have_header and not _read_header():
			return out
		var whole := PKeySyncFileStream.SEGMENT_BYTES + PKeySyncFileStream.TAG_BYTES
		# One byte beyond a whole segment proves the segment is not the last.
		while _buf.size() > whole:
			var plain: Variant = PKeySyncAesGcm.open(_key, PKeySyncFileStream._nonce(_index, false), _buf.slice(0, whole), _header)
			if plain == null:
				error = "auth"
				return out
			out.append(plain)
			_index += 1
			_buf = _buf.slice(whole)
		return out

	## Parses the header once 64 bytes are in; false while more is needed or after a refusal.
	func _read_header() -> bool:
		if _buf.size() < PKeySyncFileStream.HEADER_BYTES:
			return false
		var parsed := PKeySyncFileStream._parse_header(_buf.slice(0, PKeySyncFileStream.HEADER_BYTES), _kid)
		if not parsed["ok"]:
			error = parsed["reason"]
			return false
		_header = parsed["header"]
		_key = PKeySyncHkdf.derive_file_key(_coll_key, parsed["salt"])
		if _key.is_empty():
			error = "invalid"
			return false
		_have_header = true
		_buf = _buf.slice(PKeySyncFileStream.HEADER_BYTES)
		return true

	## The plaintext of the last segment, once the input has ended. Empty when `error` is set.
	func finish() -> PackedByteArray:
		if error != "":
			return PackedByteArray()
		if not _have_header or _buf.size() < PKeySyncFileStream.TAG_BYTES:
			error = "shape"
			return PackedByteArray()
		if _buf.size() == PKeySyncFileStream.TAG_BYTES and _index > 0:
			error = "size"
			return PackedByteArray()
		var plain: Variant = PKeySyncAesGcm.open(_key, PKeySyncFileStream._nonce(_index, true), _buf, _header)
		_buf = PackedByteArray()
		if plain == null:
			error = "auth"
			return PackedByteArray()
		return plain


## Passes the plaintext of a reassembled file through while hashing it, and at the end checks the
## length and SHA-256 the chunk manifest declared (`plain_size` / `plain_sha256` of
## `PKeySyncManifest`). `push` and `finish` answer "" or the reason: `plainSize` for a source that
## overruns (before it can write the rest of a runaway file), falls short or declares more than
## `SYNC_FILE_MAX_BYTES`, `plainSha256` for a digest that differs. The caller discards what it
## wrote when either answers a reason: a file is not usable until `finish` answers "". It never
## holds the file.
class Reassembly:
	extends RefCounted
	var error := ""
	var _expected_size := 0
	var _expected_sha := PackedByteArray()
	var _n := 0
	var _ctx := HashingContext.new()

	func _init(plain_size: int, plain_sha256: PackedByteArray) -> void:
		_expected_size = plain_size
		_expected_sha = plain_sha256
		if plain_size < 0 or plain_size > PKeyConstants.SYNC_FILE_MAX_BYTES:
			error = "plainSize"
		_ctx.start(HashingContext.HASH_SHA256)

	func push(part: PackedByteArray) -> String:
		if error != "":
			return error
		_n += part.size()
		if _n > _expected_size:
			error = "plainSize"
			return error
		if not part.is_empty():
			_ctx.update(part)
		return ""

	func finish() -> String:
		if error != "":
			return error
		if _n != _expected_size:
			error = "plainSize"
			return error
		if not PKeySyncAesGcm.equal_constant_time(_ctx.finish(), _expected_sha):
			error = "plainSha256"
		return error
