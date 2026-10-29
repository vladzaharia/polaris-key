@tool
class_name PKeyPeerNoise
extends RefCounted
## WIRE-CONTRACT-V5 sections 15.5 and 15.6: the Noise engine of `pkey-peer/1` (CC-14.2).
##
## The Noise Protocol Framework revision 34, patterns XX and XXpsk0 over 25519, AESGCM and SHA256.
## The engine is synchronous and pure: bytes in, bytes out, no I/O and no clock. The primitives come
## through a `PKeyPeerCrypto` port (X25519 and AES-256-GCM), HMAC and SHA-256 are the engine's.
##
## Errors are values. Every step that can refuse answers a PKeyResult whose `code` is one of
## `NOISE_ERROR_CODES` and whose `detail` is the bytes on success; a code is all a caller may show or
## log, and nothing here puts a key, payload or ciphertext in a message or `str()`. After any
## failure a handshake is dead and refuses further use.
##
## The static key is 32 raw bytes, or a key port with `public_key()` and `dh(remote)` (G1): the
## device key store's agreement key never leaves the store (`StoreStatic`). A handshake is not
## thread safe: the session engine touches it from the main thread or from its one busy task (D-2).
## Secrets are held in `PackedByteArray`s and filled with zeros when replaced or when the handshake
## ends (best effort: a copy-on-write copy elsewhere is a recorded residual, CC-13).
##
## Counters are GDScript ints, so the nonce 2^64 - 1 is the signed value -1 (eight 0xFF bytes) and
## is never written as a positive int.

## `decrypt` (a tag fails: wrong key, PSK, prologue or tampering), `dh_zero` (a DH output is all zeros
## or refused), `malformed` (too short or too long), `state` (a call out of order, after a failure, or
## an engine that refused), `nonce_exhausted`, `bad_key` (a key or PSK of the wrong length).
const NOISE_ERROR_CODES := [&"decrypt", &"dh_zero", &"malformed", &"state", &"nonce_exhausted", &"bad_key"]
## A Noise message is at most 65,535 bytes (Noise section 3), and a TCP frame carries one (15.6).
const MAX_MESSAGE := 65535
const TAG_BYTES := 16
## The nonce counter value 2^64 - 1, as a signed GDScript int: the counter is exhausted, and REKEY
## encrypts under it.
const MAX_NONCE := -1

const _PROTOCOL_PATTERN := "\\ANoise_XX(psk0)?_25519_AESGCM_SHA256\\z"
## The token lists of XX, initiator first.
const _XX := [["e"], ["e", "ee", "s", "es"], ["s", "se"]]

static var _protocol_re: RegEx


static func _static_init() -> void:
	_protocol_re = RegEx.create_from_string(_PROTOCOL_PATTERN)


## The Noise protocol name of a mode: XXpsk0 for `a`, plain XX for `v` and `p`.
static func protocol_name(mode: String) -> String:
	return "Noise_XXpsk0_25519_AESGCM_SHA256" if mode == "a" else "Noise_XX_25519_AESGCM_SHA256"


## `"pkey-peer/1" || 0x00 || slug || 0x00 || mode || 0x00`.
static func prologue(slug: String, mode: String) -> PackedByteArray:
	var out := "pkey-peer/1".to_utf8_buffer()
	out.append(0)
	out.append_array(slug.to_utf8_buffer())
	out.append(0)
	out.append_array(mode.to_utf8_buffer())
	out.append(0)
	return out


## The mode-a PSK: HKDF-SHA256, empty salt, the 32-byte discovery key as input keying material and
## `"pkey-peer/1 psk" || 0x00 || slug` as info, 32 bytes out. Empty when `disc_key` is not 32 bytes.
static func psk(disc_key: PackedByteArray, slug: String) -> PackedByteArray:
	if disc_key.size() != 32:
		return PackedByteArray()
	var info := "pkey-peer/1 psk".to_utf8_buffer()
	info.append(0)
	info.append_array(slug.to_utf8_buffer())
	return PKeySyncHkdf.hkdf(disc_key, PackedByteArray(), info, 32)


## A handshake in `role` ("initiator" or "responder"). ok, detail a `Handshake`; a refusal is `state`
## (an unknown role or protocol) or `bad_key` (a PSK that does not match the protocol, or a key or
## PSK of the wrong length). `psk_bytes` is null for XX. `ephemeral_key` fixes the ephemeral private
## key (known-answer tests only); the default is random. `crypto` null is the platform port.
static func start(
		role: String, protocol: String, prologue_bytes: PackedByteArray, static_key: Variant,
		psk_bytes: Variant = null, ephemeral_key: Variant = null, crypto: PKeyPeerCrypto = null) -> PKeyResult:
	var m := _protocol_re.search(protocol)
	if m == null or (role != "initiator" and role != "responder"):
		return PKeyResult.failure(&"state")
	var uses_psk := m.get_string(1) != ""
	if uses_psk != (psk_bytes != null):
		return PKeyResult.failure(&"bad_key")
	if psk_bytes != null and not (psk_bytes is PackedByteArray and (psk_bytes as PackedByteArray).size() == 32):
		return PKeyResult.failure(&"bad_key")
	if static_key is PackedByteArray:
		if (static_key as PackedByteArray).size() != 32:
			return PKeyResult.failure(&"bad_key")
	elif not (static_key is Object and (static_key as Object).has_method("public_key") and (static_key as Object).has_method("dh")):
		return PKeyResult.failure(&"bad_key")
	if ephemeral_key != null and not (ephemeral_key is PackedByteArray and (ephemeral_key as PackedByteArray).size() == 32):
		return PKeyResult.failure(&"bad_key")
	return PKeyResult.success(Handshake.new(role, protocol, uses_psk, prologue_bytes, static_key, psk_bytes, ephemeral_key, crypto if crypto != null else PKeyPeerCrypto.for_platform()))


## HMAC-SHA256. The engine's HMACContext refuses an empty update, and Noise's split hashes an empty
## input, so the update is skipped then (the same MAC).
static func hmac_sha256(key: PackedByteArray, data: PackedByteArray) -> PackedByteArray:
	var c := HMACContext.new()
	if key.is_empty() or c.start(HashingContext.HASH_SHA256, key) != OK:
		return PackedByteArray()
	if not data.is_empty() and c.update(data) != OK:
		return PackedByteArray()
	return c.finish()


static func sha256(data: PackedByteArray) -> PackedByteArray:
	return PKeySyncHkdf.sha256(data)


## The 12-byte AES-GCM nonce of a counter: four zero bytes then the counter as eight bytes, big endian.
static func nonce_of(n: int) -> PackedByteArray:
	var out := PackedByteArray()
	out.resize(12)
	for i in 8:
		out[4 + i] = (n >> (56 - 8 * i)) & 0xff
	return out


static func _wipe(b: PackedByteArray) -> void:
	b.fill(0)


## One direction of the transport, or the handshake's cipher. A failed read does not advance the
## counter (Noise section 5.1).
class CipherState extends RefCounted:
	## The next nonce, as a signed int (see MAX_NONCE). Public so a test can park it near the end.
	var n := 0
	var _crypto: PKeyPeerCrypto
	var _k := PackedByteArray()


	func _init(key: PackedByteArray, crypto: PKeyPeerCrypto) -> void:
		_crypto = crypto
		_k = key.duplicate()


	func _to_string() -> String:
		return "CipherState()"


	func has_key() -> bool:
		return not _k.is_empty()


	func set_key(key: PackedByteArray) -> void:
		PKeyPeerNoise._wipe(_k)
		_k = key.duplicate()
		n = 0


	## ok, detail the ciphertext (a copy of `plain` while there is no key).
	func encrypt(ad: PackedByteArray, plain: PackedByteArray) -> PKeyResult:
		if _k.is_empty():
			return PKeyResult.success(plain.duplicate())
		if n == PKeyPeerNoise.MAX_NONCE:
			return PKeyResult.failure(&"nonce_exhausted")
		if plain.size() + PKeyPeerNoise.TAG_BYTES > PKeyPeerNoise.MAX_MESSAGE:
			return PKeyResult.failure(&"malformed")
		var sealed := _crypto.aes_gcm_seal(_k, PKeyPeerNoise.nonce_of(n), ad, plain)
		if sealed.is_empty():
			return PKeyResult.failure(&"state")
		n += 1
		return PKeyResult.success(sealed)


	## ok, detail the plaintext (a copy of `ciphertext` while there is no key).
	func decrypt(ad: PackedByteArray, ciphertext: PackedByteArray) -> PKeyResult:
		if _k.is_empty():
			return PKeyResult.success(ciphertext.duplicate())
		if n == PKeyPeerNoise.MAX_NONCE:
			return PKeyResult.failure(&"nonce_exhausted")
		if ciphertext.size() < PKeyPeerNoise.TAG_BYTES or ciphertext.size() > PKeyPeerNoise.MAX_MESSAGE:
			return PKeyResult.failure(&"malformed")
		var plain: Variant = _crypto.aes_gcm_open(_k, PKeyPeerNoise.nonce_of(n), ad, ciphertext)
		if plain == null:
			return PKeyResult.failure(&"decrypt")
		n += 1
		return PKeyResult.success(plain)


	## REKEY (Noise section 4.2): `k = ENCRYPT(k, 2^64 - 1, "", zeros(32))[0..32]`. The counter stays.
	func rekey() -> PKeyResult:
		if _k.is_empty():
			return PKeyResult.failure(&"state")
		var zeros := PackedByteArray()
		zeros.resize(32)
		var out := _crypto.aes_gcm_seal(_k, PKeyPeerNoise.nonce_of(PKeyPeerNoise.MAX_NONCE), PackedByteArray(), zeros)
		if out.size() < 32:
			return PKeyResult.failure(&"state")
		PKeyPeerNoise._wipe(_k)
		_k = out.slice(0, 32)
		PKeyPeerNoise._wipe(out)
		return PKeyResult.success()


	func wipe() -> void:
		PKeyPeerNoise._wipe(_k)
		_k = PackedByteArray()


## The two directions of a finished handshake.
class Transport extends RefCounted:
	var send: CipherState
	var receive: CipherState


	func _init(p_send: CipherState, p_receive: CipherState) -> void:
		send = p_send
		receive = p_receive


	func _to_string() -> String:
		return "Transport()"


## The device key store's agreement key as a Noise static key port: the private key stays in the
## store and only `dh` crosses (G1).
class StoreStatic extends RefCounted:
	var _store: PKeyDeviceKeyStore


	func _init(store: PKeyDeviceKeyStore) -> void:
		_store = store


	func _to_string() -> String:
		return "StoreStatic()"


	## The 32-byte agreement public key; empty when the store holds no keys.
	func public_key() -> PackedByteArray:
		var r := _store.public_keys()
		if not r.ok or not (r.detail is Dictionary):
			return PackedByteArray()
		var raw: Variant = PKeyB64Url.decode_strict(str(r.detail.get("agree_key", "")))
		return raw if raw != null else PackedByteArray()


	## The shared secret, or null when the store refuses (a low-order point, no keys, a fault).
	func dh(remote: PackedByteArray) -> Variant:
		var r := _store.dh(remote)
		return r.detail if r.ok and r.detail is PackedByteArray else null


## One handshake. Alternate `write_message` and `read_message` as the role dictates (the initiator
## writes first); after the third message `transport()` yields the two ciphers. Make one with
## `PKeyPeerNoise.start`.
class Handshake extends RefCounted:
	var _crypto: PKeyPeerCrypto
	var _initiator: bool
	var _uses_psk: bool
	var _static: Variant
	var _psk := PackedByteArray()
	var _e := PackedByteArray()
	var _re := PackedByteArray()
	var _rs := PackedByteArray()
	var _s_pub := PackedByteArray()
	var _s_raw := PackedByteArray()
	var _h := PackedByteArray()
	var _ck := PackedByteArray()
	var _cs: CipherState
	var _index := 0
	var _dead := false


	func _init(role: String, protocol: String, uses_psk: bool, prologue_bytes: PackedByteArray, static_key: Variant, psk_bytes: Variant, ephemeral_key: Variant, crypto: PKeyPeerCrypto) -> void:
		_crypto = crypto
		_initiator = role == "initiator"
		_uses_psk = uses_psk
		if static_key is PackedByteArray:
			_s_raw = (static_key as PackedByteArray).duplicate()
		else:
			_static = static_key
		if psk_bytes != null:
			_psk = (psk_bytes as PackedByteArray).duplicate()
		if ephemeral_key != null:
			_e = (ephemeral_key as PackedByteArray).duplicate()
		_cs = CipherState.new(PackedByteArray(), crypto)
		var name := protocol.to_ascii_buffer()
		if name.size() <= 32:
			_h = name.duplicate()
			_h.resize(32)
		else:
			_h = PKeyPeerNoise.sha256(name)
		_ck = _h.duplicate()
		_mix_hash(prologue_bytes)


	func _to_string() -> String:
		return "Handshake()"


	## True once all three messages are written and read.
	func finished() -> bool:
		return _index == _XX.size()


	func dead() -> bool:
		return _dead


	## The peer's static public key once its `s` token has been read; empty before.
	func remote_static() -> PackedByteArray:
		return _rs.duplicate()


	## The handshake hash `h`, the channel binding, once finished; empty before.
	func handshake_hash() -> PackedByteArray:
		return _h.duplicate() if finished() and not _dead else PackedByteArray()


	## Writes the next handshake message carrying `payload`. ok, detail the wire bytes.
	func write_message(payload: PackedByteArray) -> PKeyResult:
		if _dead or finished() or not _my_turn(true):
			return PKeyResult.failure(&"state")
		var wire := PackedByteArray()
		var err := &""
		for tok in _tokens():
			err = _write_token(tok, wire)
			if err != &"":
				break
		if err == &"":
			err = _write_payload(payload, wire)
		if err != &"":
			return _kill(err)
		_index += 1
		return PKeyResult.success(wire)


	## Reads the next handshake message. ok, detail its payload.
	func read_message(message: PackedByteArray) -> PKeyResult:
		if _dead or finished() or not _my_turn(false):
			return PKeyResult.failure(&"state")
		var err := &""
		var off := [0]
		if message.size() > PKeyPeerNoise.MAX_MESSAGE:
			err = &"malformed"
		for tok in _tokens():
			if err != &"":
				break
			err = _read_token(tok, message, off)
		var payload := PKeyResult.failure(err) if err != &"" else _decrypt_and_hash(message.slice(off[0]))
		if not payload.ok:
			return _kill(payload.code)
		_index += 1
		return PKeyResult.success(payload.detail)


	## The transport ciphers of a finished handshake: `send` for this side's writes, `receive` for its
	## reads. The handshake is spent afterwards.
	func transport() -> PKeyResult:
		if _dead or not finished():
			return PKeyResult.failure(&"state")
		var ks := _kdf(PackedByteArray(), 2)
		var a := CipherState.new(ks[0], _crypto)
		var b := CipherState.new(ks[1], _crypto)
		for k in ks:
			PKeyPeerNoise._wipe(k)
		var out := Transport.new(a, b) if _initiator else Transport.new(b, a)
		_kill(&"")
		return PKeyResult.success(out)


	# -- tokens ------------------------------------------------------------------------------

	## One token of a message being written; appends to `wire`. The error code, or empty.
	func _write_token(tok: String, wire: PackedByteArray) -> StringName:
		if tok == "psk":
			_mix_key_and_hash(_psk)
		elif tok == "e":
			if _e.is_empty():
				_e = _crypto.random_bytes(32)
			var pub := _crypto.x25519_public(_e)
			if pub.size() != 32:
				return &"state"
			wire.append_array(pub)
			_mix_hash(pub)
			if _uses_psk:
				_mix_key(pub)
		elif tok == "s":
			var spub := _static_public()
			if spub.size() != 32:
				return &"bad_key"
			var ct := _encrypt_and_hash(spub)
			if not ct.ok:
				return ct.code
			wire.append_array(ct.detail)
		else:
			return _dh(tok)
		return &""


	## The payload of a message being written, then the size bound.
	func _write_payload(payload: PackedByteArray, wire: PackedByteArray) -> StringName:
		var body := _encrypt_and_hash(payload)
		if not body.ok:
			return body.code
		wire.append_array(body.detail)
		return &"malformed" if wire.size() > PKeyPeerNoise.MAX_MESSAGE else &""


	## One token of a message being read; `off` is a one-element array holding the read offset.
	func _read_token(tok: String, message: PackedByteArray, off: Array) -> StringName:
		if tok == "psk":
			_mix_key_and_hash(_psk)
		elif tok == "e":
			if message.size() < off[0] + 32:
				return &"malformed"
			_re = message.slice(off[0], off[0] + 32)
			off[0] += 32
			_mix_hash(_re)
			if _uses_psk:
				_mix_key(_re)
		elif tok == "s":
			var n := 32 + PKeyPeerNoise.TAG_BYTES if _cs.has_key() else 32
			if message.size() < off[0] + n:
				return &"malformed"
			var rs := _decrypt_and_hash(message.slice(off[0], off[0] + n))
			if not rs.ok:
				return rs.code
			_rs = rs.detail
			off[0] += n
		else:
			return _dh(tok)
		return &""


	# -- symmetric state ---------------------------------------------------------------------

	func _my_turn(writing: bool) -> bool:
		return (_index % 2 == 0) == (_initiator == writing)


	func _tokens() -> Array:
		var t: Array = (_XX[_index] as Array).duplicate()
		if _index == 0 and _uses_psk:
			t.insert(0, "psk")
		return t


	func _mix_hash(data: PackedByteArray) -> void:
		var joined := _h.duplicate()
		joined.append_array(data)
		_h = PKeyPeerNoise.sha256(joined)


	## HKDF-SHA256 as Noise defines it: `outputs` (2 or 3) blocks keyed by `ck` over `ikm`.
	func _kdf(ikm: PackedByteArray, outputs: int) -> Array:
		var temp := PKeyPeerNoise.hmac_sha256(_ck, ikm)
		var o1 := PKeyPeerNoise.hmac_sha256(temp, PackedByteArray([1]))
		var in2 := o1.duplicate()
		in2.append(2)
		var o2 := PKeyPeerNoise.hmac_sha256(temp, in2)
		var out := [o1, o2]
		if outputs == 3:
			var in3 := o2.duplicate()
			in3.append(3)
			out.append(PKeyPeerNoise.hmac_sha256(temp, in3))
		PKeyPeerNoise._wipe(temp)
		return out


	func _mix_key(ikm: PackedByteArray) -> void:
		var ks := _kdf(ikm, 2)
		_ck = ks[0]
		_cs.set_key(ks[1])
		PKeyPeerNoise._wipe(ks[1])


	func _mix_key_and_hash(ikm: PackedByteArray) -> void:
		var ks := _kdf(ikm, 3)
		_ck = ks[0]
		_mix_hash(ks[1])
		_cs.set_key(ks[2])
		PKeyPeerNoise._wipe(ks[1])
		PKeyPeerNoise._wipe(ks[2])


	func _encrypt_and_hash(plain: PackedByteArray) -> PKeyResult:
		var r := _cs.encrypt(_h, plain)
		if r.ok:
			_mix_hash(r.detail)
		return r


	func _decrypt_and_hash(ciphertext: PackedByteArray) -> PKeyResult:
		var r := _cs.decrypt(_h, ciphertext)
		if r.ok:
			_mix_hash(ciphertext)
		return r


	func _static_public() -> PackedByteArray:
		if _s_pub.is_empty():
			if _static != null:
				var pub: Variant = (_static as Object).call("public_key")
				_s_pub = pub if pub is PackedByteArray else PackedByteArray()
			else:
				_s_pub = _crypto.x25519_public(_s_raw)
		return _s_pub


	## One DH token: this side's private key of the kind against the peer's public key. A refusal is
	## the error code; an empty code is success.
	func _dh(token: String) -> StringName:
		var mine_e := (token[0] == "e") if _initiator else (token[1] == "e")
		var theirs_e := (token[1] == "e") if _initiator else (token[0] == "e")
		var remote := _re if theirs_e else _rs
		if remote.size() != 32:
			return &"state"
		# The backend may refuse a low-order point or return zeros; both abort (section 15.5).
		if PKeyCurve25519.is_low_order(remote):
			return &"dh_zero"
		var out: Variant
		if mine_e:
			out = _crypto.x25519(_e, remote)
		elif _static != null:
			out = (_static as Object).call("dh", remote)
		else:
			out = _crypto.x25519(_s_raw, remote)
		if not (out is PackedByteArray) or (out as PackedByteArray).size() != 32:
			return &"dh_zero"
		var any := 0
		for b in (out as PackedByteArray):
			any |= b
		if any == 0:
			return &"dh_zero"
		_mix_key(out)
		PKeyPeerNoise._wipe(out)
		return &""


	## Kills the handshake and answers `code` (an empty code is a clean end, answering success).
	func _kill(code: StringName) -> PKeyResult:
		_dead = true
		_cs.wipe()
		PKeyPeerNoise._wipe(_e)
		PKeyPeerNoise._wipe(_psk)
		PKeyPeerNoise._wipe(_s_raw)
		return PKeyResult.failure(code) if code != &"" else PKeyResult.success()
