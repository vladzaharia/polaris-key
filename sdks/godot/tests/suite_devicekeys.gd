extends RefCounted
# @pkey-feature core.devicekeys
# The device key store, the pkey-proof/1 signer and the keys registration (CC-26.6): the CC-13
# curve vectors, the store's rules (mirroring client-core deviceKeys.test.ts and the Python,
# Kotlin, Swift and Node suites), device-proof.json through the strict verifier with every valid
# purpose signed through the store, and PolarisKey.devices.register_keys against a loopback
# server. Timing is INFO only (a shared machine): nothing here asserts a speed.

const CURVES := "res://tests/vectors/curves-cc13.json"
const CORPUS := "res://tests/corpus/v2/device-proof.json"
const DEVICE := "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
const TOKEN := "pkeyt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"


## A port that forwards to a store and lets a test interfere.
class WrapPort extends RefCounted:
	var inner: PKeyDeviceKeyStore
	var on_sign: Callable
	var flip_sig := false
	var hide_persistence := false

	func _init(p_inner: PKeyDeviceKeyStore) -> void:
		inner = p_inner

	func ensure() -> PKeyResult:
		return inner.ensure()

	func public_keys() -> PKeyResult:
		return inner.public_keys()

	func sign(msg: PackedByteArray) -> PKeyResult:
		var r := inner.sign(msg)
		if r.ok and flip_sig:
			var s: PackedByteArray = r.detail
			s[5] ^= 1
			r.detail = s
		if on_sign.is_valid():
			on_sign.call()
		return r

	func persistence() -> String:
		return inner.persistence()

var _plan := {}


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_curves(t)
	_low_order(t)
	_store(t)
	_unreadable(t)
	_faults(t)
	_files(t)
	_refused(t)
	_races(t)
	_reclaim(t)
	_weak_id_and_orphans(t)
	_signer(t)
	_corpus(t)
	await _register(t)
	return true


static func _dir(tag: String) -> String:
	return PKeyTestFixtures.scratch_dir("dk-" + tag)


static func _file_store(root: String, encrypted := true) -> PKeyDeviceKeyStore:
	# A plain-file store exists for the suites alone (`new(..., false)` is refused, see _refused).
	return PKeyDeviceKeyStore.new("djdl", root, false, true) if encrypted else PKeyDeviceKeyStore.for_tests("djdl", root)


static func _secret_free(t: PKeyTestContext, name: String, texts: Array, secrets: Array) -> void:
	var leaked := false
	for text in texts:
		for secret in secrets:
			var s: PackedByteArray = secret
			if s.is_empty():
				continue
			if String(text).contains(s.hex_encode()) or String(text).contains(PKeyB64Url.encode(s)):
				leaked = true
	t.check(name, not leaked)


# ── The CC-13 vectors ────────────────────────────────────────────────────────────────────

func _curves(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("curves: vectors parse", j.parse(FileAccess.get_file_as_string(CURVES)) == OK and j.data is Dictionary, CURVES):
		return
	var started := Time.get_ticks_usec()
	var n := 0
	for v in j.data["x25519"]:
		var got := PKeyCurve25519.x25519(String(v["sk"]).hex_decode(), String(v["u"]).hex_decode()).hex_encode()
		t.check("curves: x25519 %s %d" % [v["src"], n], got == v["out"], got)
		n += 1
	var after_x := Time.get_ticks_usec()
	n = 0
	for v in j.data["ed"]:
		var seed := String(v["seed"]).hex_decode()
		var msg := String(v["msg"]).hex_decode()
		var pub := PKeyCurve25519.ed25519_public(seed)
		t.check("curves: ed25519 public key %s %d" % [v["src"], n], pub.hex_encode() == v["pk"])
		var sig := PKeyCurve25519.ed25519_sign(seed, pub, msg)
		t.check("curves: ed25519 signature %s %d" % [v["src"], n], sig.hex_encode() == v["sig"])
		t.check("curves: the addon verifier accepts it %d" % n, PKeyEd25519.verify(sig, msg, pub))
		n += 1
	t.info("curves: %d x25519 in %.0f ms, %d ed25519 pub+sign+verify in %.0f ms (load-dependent)" % [j.data["x25519"].size(), (after_x - started) / 1000.0, n, \
			(Time.get_ticks_usec() - after_x) / 1000.0])
	# The key agreement is symmetric.
	var a := Crypto.new().generate_random_bytes(32)
	var b := Crypto.new().generate_random_bytes(32)
	t.check("curves: x25519 agreement is symmetric", PKeyCurve25519.x25519(a, PKeyCurve25519.x25519_public(b)) == PKeyCurve25519.x25519(b, PKeyCurve25519.x25519_public(a)))


func _low_order(t: PKeyTestContext) -> void:
	for h in PKeyCurve25519._LOW_ORDER_U:
		t.check("low order: %s refused" % h.substr(0, 8), PKeyCurve25519.is_low_order(h.hex_decode()))
		var hi := (h as String).hex_decode()
		hi[31] |= 0x80
		t.check("low order: %s with bit 255 set refused" % h.substr(0, 8), PKeyCurve25519.is_low_order(hi))
	t.check("low order: the base point is fine", not PKeyCurve25519.is_low_order(("09" + "00".repeat(31)).hex_decode()))
	t.check("low order: a wrong length is not low order (the caller refuses it)", not PKeyCurve25519.is_low_order(PackedByteArray([0])))


# ── The store ────────────────────────────────────────────────────────────────────────────

func _store(t: PKeyTestContext) -> void:
	var root := _dir("store")
	var s := _file_store(root)
	t.check("store: no keys yet", s.public_keys().ok and s.public_keys().detail == null)
	var sign_none := s.sign("x".to_utf8_buffer())
	t.check("store: sign before ensure fails with NO_KEYS", not sign_none.ok and sign_none.code == PKeyDeviceKeyStore.NO_KEYS, str(sign_none))
	var t0 := Time.get_ticks_usec()
	var e := s.ensure()
	t.info("store: first ensure (two public keys, self-test, write) %.0f ms" % ((Time.get_ticks_usec() - t0) / 1000.0))
	if not t.check("store: ensure ok", e.ok, str(e)):
		return
	var keys: Dictionary = e.detail
	t.check("store: 43-character base64url keys, generation 1", String(keys["sign_key"]).length() == 43 and String(keys["agree_key"]).length() == 43 and keys["generation"] == 1, str(keys))
	t.check("store: persistence durable, protection encrypted-file", s.persistence() == "durable" and s.protection() == "encrypted-file")
	t.check("store: ensure keeps the pair", s.ensure().detail == keys)
	t.check("store: public_keys never makes keys, and agrees", s.public_keys().detail == keys)
	var s2 := _file_store(root)
	t.check("store: a second store over the same directory (a restart) agrees", s2.ensure().detail == keys and s2.public_keys().detail == keys)

	var msg := "hello".to_utf8_buffer()
	var sig := s.sign(msg)
	t.check("store: sign answers 64 bytes", sig.ok and (sig.detail as PackedByteArray).size() == 64)
	var signkey: PackedByteArray = PKeyB64Url.decode_strict(keys["sign_key"])
	t.check("store: the signature verifies under the signing key", PKeyEd25519.verify(sig.detail, msg, signkey))
	t.check("store: and not for another message", not PKeyEd25519.verify(sig.detail, "hellp".to_utf8_buffer(), signkey))
	t.check("store: signing is deterministic", s.sign(msg).detail == sig.detail)

	# dh against a peer.
	var peer_priv := Crypto.new().generate_random_bytes(32)
	var peer_pub := PKeyCurve25519.x25519_public(peer_priv)
	var mine: PackedByteArray = PKeyB64Url.decode_strict(keys["agree_key"])
	var d := s.dh(peer_pub)
	t.check("store: dh matches the peer's secret", d.ok and d.detail is PackedByteArray and d.detail == PKeyCurve25519.x25519(peer_priv, mine), str(d))
	t.check("store: dh refuses a wrong length", s.dh(PackedByteArray([1, 2, 3])).detail == null and s.dh(PackedByteArray()).detail == null)
	var refused := 0
	for h in PKeyCurve25519._LOW_ORDER_U:
		var u := (h as String).hex_decode()
		if s.dh(u).ok and s.dh(u).detail == null:
			refused += 1
		u[31] |= 0x80
		if s.dh(u).ok and s.dh(u).detail == null:
			refused += 1
	t.check("store: dh refuses every low-order spelling", refused == PKeyCurve25519._LOW_ORDER_U.size() * 2, str(refused))
	t.check("store: dh with no keys answers null", _file_store(_dir("nokeys")).dh(peer_pub).detail == null)

	# Private halves are in no result, string or store text.
	var rec_mem := PKeyDeviceKeyStore.memory_only()
	var me := rec_mem.ensure()
	var secrets := [rec_mem._mem_record.slice(13, 45), rec_mem._mem_record.slice(77, 109)]
	var texts := [str(me), str(me.detail), str(rec_mem), str(rec_mem.sign(msg)), str(rec_mem.dh(peer_pub)), str(rec_mem.rotate()), str(rec_mem.public_keys())]
	var rec_mem2 := PKeyDeviceKeyStore.memory_only()
	rec_mem2.ensure()
	secrets.append(rec_mem2._mem_record.slice(13, 45))
	texts.append(str(rec_mem2))
	_secret_free(t, "store: no result, str() or error text carries a private half", texts, secrets)

	# rotate and wipe
	var r := s.rotate()
	t.check("store: rotate makes a new pair with the next generation", r.ok and r.detail["generation"] == 2 and r.detail["sign_key"] != keys["sign_key"] \
			and r.detail["agree_key"] != keys["agree_key"], str(r))
	t.check("store: public_keys shows the rotated pair", s.public_keys().detail == r.detail)
	t.check("store: wipe ok", s.wipe().ok)
	t.check("store: after wipe there are no keys", s.public_keys().ok and s.public_keys().detail == null)
	var again := s.ensure()
	t.check("store: ensure after wipe starts at generation 1 with a new pair", again.ok and again.detail["generation"] == 1 and again.detail["sign_key"] != keys["sign_key"], str(again))
	t.check("store: wipe with nothing stored is fine", _file_store(_dir("wipe0")).wipe().ok)

	# memory store
	var m := PKeyDeviceKeyStore.memory_only()
	t.check("memory: persistence memory", m.persistence() == "memory" and m.protection() == "memory")
	var mk := m.ensure()
	t.check("memory: keeps one pair", mk.ok and m.ensure().detail == mk.detail and m.rotate().detail["generation"] == 2)
	var refuse := PKeyDeviceKeys.sign_keys_proof(m, {"product": "djdl", "device_id": "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"})
	t.check("memory: registration is refused unless allow_ephemeral", not refuse.ok and refuse.code == &"unsupported" and refuse.message == "memory-only", str(refuse))
	var allowed := PKeyDeviceKeys.sign_keys_proof(m, {"product": "djdl", "device_id": "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH", "allow_ephemeral": true})
	t.check("memory: allow_ephemeral signs", allowed.ok, str(allowed))
	m.wipe()
	t.check("memory: wipe forgets", m.public_keys().detail == null)

	# The overwrite reaches the bytes the caller holds (packed arrays are shared, not copied).
	var held := Crypto.new().generate_random_bytes(32)
	var rec := {"seed": held, "agree_priv": held.duplicate(), "generation": 1}
	PKeyDeviceKeyStore._zero_record(rec)
	t.check("store: zeroing a record clears the caller's arrays", held.count(0) == 32 and (rec["agree_priv"] as PackedByteArray).count(0) == 32)
	t.check("store: best_effort is a bool", typeof(s.best_effort()) == TYPE_BOOL)
	PKeyTestFixtures.remove_tree(root)


# ── Unreadable records ───────────────────────────────────────────────────────────────────

static func _damage(name: String, b: PackedByteArray) -> PackedByteArray:
	match name:
		"empty":
			return PackedByteArray()
		"truncated":
			return b.slice(0, b.size() - 1)
		"oversize":
			b.append(0)
		"wrong magic":
			b[0] = 0x58
		"wrong version":
			b[4] = 2
		"generation zero":
			for i in 8:
				b[5 + i] = 0
		"public half does not match the seed":
			b[50] ^= 1
		"agree public does not match":
			b[120] ^= 1
		"json text":
			return "{\"v\":1}".to_utf8_buffer()
	return b


func _unreadable(t: PKeyTestContext) -> void:
	# Plain-file mode lets the test damage the record; the encrypted mode is covered below.
	var cases := ["empty", "truncated", "oversize", "wrong magic", "wrong version", "generation zero", "public half does not match the seed", "agree public does not match", "json text"]
	for name in cases:
		var root := _dir("unr")
		var s := _file_store(root, false)
		var keys: Dictionary = s.ensure().detail
		var path := root.path_join("djdl").path_join(PKeyDeviceKeyStore.RECORD_FILE)
		var good := FileAccess.get_file_as_bytes(path)
		var damaged := _damage(name, good.duplicate())
		var f := FileAccess.open(path, FileAccess.WRITE)
		f.store_buffer(damaged)
		f.close()
		var s2 := _file_store(root, false)
		var all_unreadable := true
		for r in [s2.ensure(), s2.public_keys(), s2.sign("x".to_utf8_buffer()), s2.rotate(), s2.dh(PKeyCurve25519.x25519_public(good.slice(77, 109)))]:
			if r.ok or r.code != PKeyDeviceKeyStore.KEYS_UNREADABLE:
				all_unreadable = false
		t.check("unreadable (%s): every member except wipe answers KEYS_UNREADABLE" % name, all_unreadable)
		t.check("unreadable (%s): the record is kept, never replaced" % name, FileAccess.get_file_as_bytes(path) == damaged)
		t.check("unreadable (%s): only wipe resets it" % name, s2.wipe().ok and s2.ensure().ok and s2.public_keys().detail["sign_key"] != keys["sign_key"] \
				and s2.public_keys().detail["generation"] == 1)
		PKeyTestFixtures.remove_tree(root)

	# Encrypted mode: a foreign file, a changed salt (a different install key) and a missing salt.
	var root2 := _dir("unr-enc")
	var e := _file_store(root2)
	e.ensure()
	var dir := root2.path_join("djdl")
	var rec := dir.path_join(PKeyDeviceKeyStore.RECORD_FILE)
	var salt := dir.path_join(PKeyDeviceKeyStore.SALT_FILE)
	var good_salt := FileAccess.get_file_as_bytes(salt)
	var bad := good_salt.duplicate()
	bad[0] ^= 1
	var f2 := FileAccess.open(salt, FileAccess.WRITE)
	f2.store_buffer(bad)
	f2.close()
	var changed := _file_store(root2)
	var cr := changed.ensure()
	t.check("unreadable: a record the install key cannot open is unreadable, not new keys", not cr.ok and cr.code == PKeyDeviceKeyStore.KEYS_UNREADABLE, str(cr))
	t.check("unreadable: and it is not replaced (salt still the changed one)", FileAccess.get_file_as_bytes(salt) == bad)
	DirAccess.remove_absolute(salt)
	var missing := _file_store(root2).ensure()
	t.check("unreadable: a record whose salt is gone is unreadable", not missing.ok and missing.code == PKeyDeviceKeyStore.KEYS_UNREADABLE, str(missing))
	t.check("unreadable: the salt is not recreated over it", not FileAccess.file_exists(salt))
	var plain := FileAccess.open(rec, FileAccess.WRITE)
	plain.store_string("not an encrypted file at all")
	plain.close()
	var foreign := _file_store(root2).sign("x".to_utf8_buffer())
	t.check("unreadable: a plain file where the encrypted record should be", not foreign.ok and foreign.code == PKeyDeviceKeyStore.KEYS_UNREADABLE, str(foreign))
	t.check("unreadable: wipe resets the encrypted store", _file_store(root2).wipe().ok and _file_store(root2).ensure().ok)
	PKeyTestFixtures.remove_tree(root2)


# ── Unsupported and transient faults ─────────────────────────────────────────────────────

func _faults(t: PKeyTestContext) -> void:
	# A runtime whose curve code fails its self-test is unsupported, never unreadable.
	var saved_checked := PKeyDeviceKeyStore._curve_checked
	var saved_ok := PKeyDeviceKeyStore._curve_ok
	PKeyDeviceKeyStore._curve_checked = true
	PKeyDeviceKeyStore._curve_ok = false
	var u := PKeyDeviceKeyStore.memory_only().ensure()
	t.check("unsupported: a failed self-test is unsupported", not u.ok and u.code == &"unsupported" and u.detail is Dictionary and u.detail["reason"] == "runtime", str(u))
	PKeyDeviceKeyStore._curve_checked = saved_checked
	PKeyDeviceKeyStore._curve_ok = saved_ok

	# A path outside user:// is refused, and nothing is written.
	var outside := PKeyDeviceKeyStore.new("djdl", "res://nope")
	var o := outside.ensure()
	t.check("faults: a store directory outside user:// is refused", not o.ok and o.code == PKeyDeviceKeyStore.STORE_FAULT \
			and outside.public_keys().code == PKeyDeviceKeyStore.STORE_FAULT, str(o))
	var climbs := PKeyDeviceKeyStore.new("..", "user://pkey").ensure().code == PKeyErrors.INVALID_OPTIONS
	climbs = climbs and PKeyDeviceKeyStore.new("a/b", "user://pkey").ensure().code == PKeyErrors.INVALID_OPTIONS
	t.check("faults: a product that climbs out is refused up front (invalid-options, CC-26.7)", climbs)

	# A busy lock is a store fault, never "no keys", and nothing changes.
	var root := _dir("busy")
	var s := _file_store(root)
	s.lock_wait_ms = 150
	DirAccess.make_dir_recursive_absolute(root.path_join("djdl").path_join(PKeyDeviceKeyStore.LOCK_DIR))
	var busy := s.ensure()
	t.check("faults: a held lock is a STORE_FAULT", not busy.ok and busy.code == PKeyDeviceKeyStore.STORE_FAULT, str(busy))
	t.check("faults: and no record was made", not FileAccess.file_exists(root.path_join("djdl").path_join(PKeyDeviceKeyStore.RECORD_FILE)))
	t.check("faults: reads do not take the lock", s.public_keys().ok)
	DirAccess.remove_absolute(root.path_join("djdl").path_join(PKeyDeviceKeyStore.LOCK_DIR))
	t.check("faults: the lock is released after an operation", s.ensure().ok and not DirAccess.dir_exists_absolute(root.path_join("djdl").path_join(PKeyDeviceKeyStore.LOCK_DIR)))

	# A record that cannot be replaced (a directory sits in its place) is a fault, and reads say fault.
	var root2 := _dir("dirrec")
	var s2 := _file_store(root2)
	s2.ensure()
	var rec := root2.path_join("djdl").path_join(PKeyDeviceKeyStore.RECORD_FILE)
	var keep := rec + ".moved"
	DirAccess.rename_absolute(rec, keep)
	DirAccess.make_dir_recursive_absolute(rec)
	var rr := s2.rotate()
	t.check("faults: a record path that cannot be written is a fault, not new keys", not rr.ok, str(rr))
	DirAccess.remove_absolute(rec)
	DirAccess.rename_absolute(keep, rec)
	t.check("faults: the old record is intact after a failed write", s2.public_keys().ok and s2.public_keys().detail != null)
	PKeyTestFixtures.remove_tree(root)
	PKeyTestFixtures.remove_tree(root2)


# ── Files ────────────────────────────────────────────────────────────────────────────────

func _files(t: PKeyTestContext) -> void:
	var root := _dir("files")
	var s := _file_store(root)
	var keys: Dictionary = s.ensure().detail
	s.rotate()
	var dir := root.path_join("djdl")
	var names := PackedStringArray(DirAccess.get_files_at(dir))
	names.sort()
	t.check("files: only the record and the salt remain (no temporary, no lock)", names == PackedStringArray([PKeyDeviceKeyStore.RECORD_FILE, PKeyDeviceKeyStore.SALT_FILE]) \
			and DirAccess.get_directories_at(dir).is_empty(), str(names))
	var raw := FileAccess.get_file_as_bytes(dir.path_join(PKeyDeviceKeyStore.RECORD_FILE))
	var pub: PackedByteArray = PKeyB64Url.decode_strict(s.public_keys().detail["sign_key"])
	t.check("files: the encrypted record starts with the engine magic", raw.slice(0, 4).get_string_from_ascii() == "GDEC", raw.slice(0, 4).hex_encode())
	t.check("files: and holds neither the public nor a readable key", raw.hex_encode().find(pub.hex_encode()) < 0)
	if OS.has_feature("macos") or OS.has_feature("linuxbsd"):
		var rp := FileAccess.get_unix_permissions(dir.path_join(PKeyDeviceKeyStore.RECORD_FILE))
		var dp := FileAccess.get_unix_permissions(dir)
		t.check("files: the record is 0600 and the directory 0700", (rp & 511) == 384 and (dp & 511) == 448, "%o %o" % [rp, dp])
	var plain_root := _dir("files-plain")
	var p := _file_store(plain_root, false)
	p.ensure()
	var praw := FileAccess.get_file_as_bytes(plain_root.path_join("djdl").path_join(PKeyDeviceKeyStore.RECORD_FILE))
	t.check("files: the plain mode is documented as such", p.protection() == "file" and praw.slice(0, 4).get_string_from_ascii() == "PKDK" and praw.size() == 141)
	# An encrypted store does not read a plain record (a downgrade).
	t.check("files: an encrypted store treats a plain record as unreadable", not _file_store(plain_root).ensure().ok)
	PKeyTestFixtures.remove_tree(root)
	PKeyTestFixtures.remove_tree(plain_root)


## `encrypted = false` outside `for_tests` is refused: the private keys are never written as a plain file.
func _refused(t: PKeyTestContext) -> void:
	var root := _dir("refused")
	var s := PKeyDeviceKeyStore.new("djdl", root, false, false)
	var peer := PKeyCurve25519.x25519_public(PackedByteArray([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]))
	var results := {
		"ensure": s.ensure(), "public_keys": s.public_keys(), "sign": s.sign("x".to_utf8_buffer()),
		"dh": s.dh(peer), "rotate": s.rotate(), "wipe": s.wipe(),
	}
	for name in results:
		var r: PKeyResult = results[name]
		t.check("refused: %s answers invalid-options" % name, not r.ok and r.code == PKeyErrors.INVALID_OPTIONS, str(r))
	t.check("refused: protection says so", s.protection() == "refused" and str(s) == "PKeyDeviceKeyStore(refused)")
	t.check("refused: nothing is written, not even the directory or the lock", not DirAccess.dir_exists_absolute(root.path_join("djdl")))
	# The refusal is not a way round the check on an existing plain record: it is never read either.
	var plain := PKeyDeviceKeyStore.for_tests("djdl", root)
	t.check("refused: for_tests keeps a plain file", plain.ensure().ok and plain.protection() == "file" and FileAccess.file_exists(root.path_join("djdl").path_join(PKeyDeviceKeyStore.RECORD_FILE)))
	t.check("refused: a refused store does not read it back", s.public_keys().code == PKeyErrors.INVALID_OPTIONS and s.sign("x".to_utf8_buffer()).code == PKeyErrors.INVALID_OPTIONS)
	t.check("refused: a memory store ignores the flag (nothing is written)", PKeyDeviceKeyStore.new("djdl", root, true, false).ensure().ok)
	t.check("refused: the default store is not refused", _file_store(_dir("refused-default")).protection() in ["encrypted-file", "file"])
	PKeyTestFixtures.remove_tree(root)
	PKeyTestFixtures.remove_tree(_dir("refused-default"))


func _races(t: PKeyTestContext) -> void:
	if not OS.has_feature("threads"):
		t.info("races: no thread support in this build; skipped")
		return
	var root := _dir("race")
	var results := []
	results.resize(4)
	var ids := []
	for i in 4:
		ids.append(WorkerThreadPool.add_task(func() -> void: results[i] = _file_store(root).ensure(), false, "pkey-test dk ensure"))
	for id in ids:
		WorkerThreadPool.wait_for_task_completion(id)
	var same := true
	var gens := true
	for r in results:
		if r == null or not r.ok or r.detail["sign_key"] != results[0].detail["sign_key"]:
			same = false
		elif r.detail["generation"] != 1:
			gens = false
	t.check("races: four stores racing ensure agree on one pair", same and gens, str(results))
	var rot := []
	rot.resize(3)
	ids.clear()
	for i in 3:
		ids.append(WorkerThreadPool.add_task(func() -> void: rot[i] = _file_store(root).rotate(), false, "pkey-test dk rotate"))
	for id in ids:
		WorkerThreadPool.wait_for_task_completion(id)
	var seen := []
	for r in rot:
		if r != null and r.ok:
			seen.append(r.detail["generation"])
	seen.sort()
	t.check("races: concurrent rotates never repeat a generation", seen == [2, 3, 4], str(seen))
	PKeyTestFixtures.remove_tree(root)


# ── The signer ───────────────────────────────────────────────────────────────────────────

func _signer(t: PKeyTestContext) -> void:
	var s := PKeyDeviceKeyStore.memory_only()
	var keys: Dictionary = s.ensure().detail
	for purpose in PKeyDeviceProof.PURPOSES:
		if purpose == "keys":
			continue
		var r := PKeyDeviceKeys.sign_device_proof(s, {"purpose": purpose, "product": "djdl", "device_id": DEVICE, "value": "abc", "now": 1700000000})
		t.check("signer: %s signs and verifies" % purpose, r.ok and PKeyDeviceProof.verify(r.detail, 1700000000) and r.detail["sign_key"] == keys["sign_key"], str(r))
	var th := PKeyDeviceKeys.sign_device_proof(s, {"purpose": "restore", "product": "djdl", "device_id": DEVICE, "value": "abc", "token_hash": "tokenhash_-43", "now": 1})
	t.check("signer: a token hash is carried in line 6", th.ok and th.detail["token_hash"] == "tokenhash_-43")
	var moved: Dictionary = th.detail.duplicate()
	moved["purpose"] = "link"
	t.check("signer: the signature is for its purpose only", not PKeyDeviceProof.verify(moved, 1))

	var kp := PKeyDeviceKeys.sign_device_proof(s, {"purpose": "keys", "product": "djdl", "device_id": DEVICE, "value": "x"})
	t.check("signer: keys cannot go through the general signer", not kp.ok and kp.code == PKeyDeviceKeys.PROOF_INVALID)
	for bad in [{"value": ""}, {"value": "a b"}, {"value": "a\nb"}, {"device_id": ""}, {"product": "dj dl"}, {"token_hash": "é"}]:
		var o := {"purpose": "nonce", "product": "djdl", "device_id": DEVICE, "value": "abc"}
		o.merge(bad, true)
		var r := PKeyDeviceKeys.sign_device_proof(s, o)
		t.check("signer: a field that breaks the line format is refused %s" % str(bad), not r.ok and r.code == PKeyDeviceKeys.PROOF_INVALID, str(r))

	# The keys change while signing.
	var w := WrapPort.new(s)
	w.on_sign = func() -> void: s.rotate()
	var changed := PKeyDeviceKeys.sign_device_proof(w, {"purpose": "nonce", "product": "djdl", "device_id": DEVICE, "value": "abc"})
	t.check("signer: refuses when the keys change while signing", not changed.ok and changed.code == PKeyDeviceKeys.PROOF_INVALID, str(changed))
	var w2 := WrapPort.new(s)
	w2.flip_sig = true
	var flipped := PKeyDeviceKeys.sign_device_proof(w2, {"purpose": "nonce", "product": "djdl", "device_id": DEVICE, "value": "abc"})
	t.check("signer: refuses a port whose signature does not verify", not flipped.ok and flipped.code == PKeyDeviceKeys.PROOF_INVALID, str(flipped))
	var seam := PKeyDeviceKeys.sign_device_proof(s, {"purpose": "nonce", "product": "djdl", "device_id": DEVICE, "value": "abc", "verify": func(_sig, _msg, _key) -> bool: return false})
	t.check("signer: the verify seam can refuse", not seam.ok)

	# The keys proof and body.
	var cur: Dictionary = s.public_keys().detail
	var req := PKeyDeviceKeys.build_keys_request(s, {"product": "djdl", "device_id": DEVICE, "issued_at": 1700000000, "allow_ephemeral": true})
	if t.check("signer: builds the keys request", req.ok, str(req)):
		var body: Dictionary = req.detail["body"]
		t.check("signer: path and body fields", req.detail["path"] == "/djdl/devices/keys" and body.keys() == ["signKey", "agreeKey", "issuedAt", "sig"] \
				and body["signKey"] == cur["sign_key"] and body["agreeKey"] == cur["agree_key"] and body["issuedAt"] == 1700000000, str(body.keys()))
		var proof := {"purpose": "keys", "product": "djdl", "device_id": DEVICE, "value": PKeyDeviceProof.keys_value(body["signKey"], body["agreeKey"], body["issuedAt"]), \
				"token_hash": "-", "sign_key": body["signKey"], "sig": body["sig"]}
		t.check("signer: the body's sig is a keys proof the verifier accepts", PKeyDeviceProof.verify(proof, 1700000000))
		t.check("signer: and not outside the skew window", not PKeyDeviceProof.verify(proof, 1700000000 + 301) and PKeyDeviceProof.verify(proof, 1700000000 + 300))
	var rot: Dictionary = s.rotate().detail
	var req2 := PKeyDeviceKeys.build_keys_request(s, {"product": "djdl", "device_id": DEVICE, "issued_at": 1700000000, "allow_ephemeral": true})
	t.check("signer: a rotated pair is named by the new request", req2.ok and req2.detail["body"]["signKey"] == rot["sign_key"] and req2.detail["body"]["agreeKey"] == rot["agree_key"])
	for bad_product in ["", "UPPER", "a b", "-x", "x".repeat(65), "a/b"]:
		var bp := PKeyDeviceKeys.build_keys_request(s, {"product": bad_product, "device_id": DEVICE, "allow_ephemeral": true})
		t.check("signer: bad product %s refused" % bad_product.substr(0, 8), not bp.ok and bp.code == PKeyDeviceKeys.PROOF_INVALID)
	t.check("signer: a bad issued_at is refused", not PKeyDeviceKeys.sign_keys_proof(s, {"product": "djdl", "device_id": DEVICE, "issued_at": -1, "allow_ephemeral": true}).ok)
	var nop := PKeyDeviceKeys.sign_keys_proof(WrapPort.new(PKeyDeviceKeyStore.memory_only()), {"product": "djdl", "device_id": DEVICE})
	t.check("signer: a wrapped memory port is still refused", not nop.ok and nop.code == &"unsupported")


# ── device-proof.json ────────────────────────────────────────────────────────────────────

func _corpus(t: PKeyTestContext) -> void:
	var j := JSON.new()
	if not t.check("corpus: device-proof.json parses", j.parse(FileAccess.get_file_as_string(CORPUS)) == OK and j.data is Dictionary, CORPUS):
		return
	var c: Dictionary = j.data
	t.check("corpus: version, line 1, purposes and skew", int(c["deviceProofVersion"]) == 1 and c["line1"] == PKeyDeviceProof.VERSION and c["purposes"] == PKeyDeviceProof.PURPOSES \
			and int(c["skewSeconds"]) == PKeyDeviceProof.KEYS_SKEW_SECONDS)
	for k in c["keyValueCases"]:
		t.check("corpus: key value %s" % String(k["value"]).substr(0, 8), PKeyDeviceProof.keys_value(k["signKey"], k["agreeKey"], int(k["issuedAt"])) == k["value"])
	var ok_purposes := {}
	var valid := []
	for row in c["cases"]:
		var proof := {"purpose": row["purpose"], "product": row["product"], "device_id": row["deviceId"], "value": row["value"], "token_hash": row["tokenHash"], \
				"sign_key": row["signKey"], "sig": row["sig"]}
		var m = PKeyDeviceProof.message(proof)
		if row["messageHex"] == null:
			t.check("corpus %s: no message" % row["id"], m == null)
		else:
			t.check("corpus %s: message bytes" % row["id"], m != null and (m as PackedByteArray).hex_encode() == row["messageHex"])
		var verdict := PKeyDeviceProof.verify(proof, int(row["now"]))
		t.check("corpus %s: verdict %s" % [row["id"], row["verdict"]], verdict == (row["verdict"] == "ok"), str(verdict))
		if row["verdict"] == "ok":
			ok_purposes[row["purpose"]] = true
			valid.append(row)
	t.check("corpus: a valid row for every purpose", ok_purposes.keys().size() == PKeyDeviceProof.PURPOSES.size())
	for row in valid:
		var s := PKeyDeviceKeyStore.memory_only()
		var keys: Dictionary = s.ensure().detail
		var expected := String(row["messageHex"]).hex_decode()
		var proof: Dictionary
		var message: PackedByteArray
		if row["purpose"] == "keys":
			var r := PKeyDeviceKeys.sign_keys_proof(s, {"product": row["product"], "device_id": row["deviceId"], "issued_at": int(row["now"]), "allow_ephemeral": true})
			if not t.check("corpus sign %s: signs" % row["id"], r.ok, str(r)):
				continue
			proof = r.detail["proof"]
			var value := "%s.%s.%d" % [keys["sign_key"], keys["agree_key"], int(row["now"])]
			message = ("pkey-proof/1\nkeys\n%s\n%s\n%s\n-" % [row["product"], row["deviceId"], value]).to_ascii_buffer()
			var lines := expected.get_string_from_ascii().split("\n")
			t.check("corpus sign %s: the row's message has the same shape" % row["id"], lines.size() == 6 and lines.slice(0, 4) == message.get_string_from_ascii().split("\n").slice(0, \
					4) and lines[5] == "-")
		else:
			var r := PKeyDeviceKeys.sign_device_proof(s, {"purpose": row["purpose"], "product": row["product"], "device_id": row["deviceId"], "value": row["value"], \
					"token_hash": row["tokenHash"], "now": int(row["now"])})
			if not t.check("corpus sign %s: signs" % row["id"], r.ok, str(r)):
				continue
			proof = r.detail
			message = expected
			t.check("corpus sign %s: the exact message bytes" % row["id"], PKeyDeviceProof.message(proof) == expected)
		var sig = PKeyB64Url.decode_strict(proof["sig"])
		t.check("corpus sign %s: 64-byte signature over exactly those bytes by the store's key" % row["id"], sig != null and (sig as PackedByteArray).size() == 64 \
				and PKeyEd25519.verify(sig, message, PKeyB64Url.decode_strict(keys["sign_key"])))
		t.check("corpus sign %s: the strict verifier accepts it" % row["id"], proof["sign_key"] == keys["sign_key"] and PKeyDeviceProof.verify(proof, int(row["now"])))


# ── register_keys ────────────────────────────────────────────────────────────────────────

func _answer(req: Dictionary) -> Dictionary:
	var path := String(req["path"])
	for suffix in _plan:
		if path.ends_with(suffix):
			var a = _plan[suffix]
			return a.call(req) if a is Callable else a
	return {"status": 404, "body": "{\"error\":{\"code\":\"not_found\"}}"}


func _register(t: PKeyTestContext) -> void:
	var fx := PKeyTestFixtures.sync_docs()
	if not t.check("register_keys: fixtures present", not fx.is_empty()):
		return
	var server := PKeyTestFixtures.new_server(_answer)
	var store := PKeyMemoryStore.new(fx["device_id"])
	store.token = TOKEN
	var sdk := PKeyTestFixtures.new_sdk()
	var clock := [fx["now"]]
	var opts := PKeyTestFixtures.options(server.base_url(), store, clock, fx["product"], fx["trust"], fx["version"])
	opts.expected_services = PackedStringArray(["config"])
	sdk.configure(opts)
	await sdk.start()
	var keys_store := PKeyDeviceKeyStore.memory_only()

	_plan = {"/devices/keys": {"status": 200, "headers": {"Content-Type": "application/json"}, "body": "{\"keySeq\":3}"}}
	var denied: PKeyResult = await sdk.devices.register_keys(keys_store)
	t.check("register_keys: a memory-only port is refused before anything is sent", not denied.ok and denied.code == &"unsupported" and server.requests.is_empty(), str(denied))
	var r: PKeyResult = await sdk.devices.register_keys(keys_store, true)
	t.check("register_keys: ok with the key_seq", r.ok and r.detail == {"key_seq": 3}, str(r))
	var reqs: Array = server.requests.filter(func(q): return q["method"] == "PUT" and String(q["path"]).ends_with("/devices/keys"))
	if t.check("register_keys: one PUT /devices/keys", reqs.size() == 1, str(server.requests.size())):
		var q: Dictionary = reqs[0]
		t.check("register_keys: the device bearer and X-PKey-Device", q["headers"].get("authorization") == "Bearer " + TOKEN and q["headers"].get("x-pkey-device") == fx["device_id"])
		var body := PKeyJson.parse((q["body"] as PackedByteArray).get_string_from_utf8())
		var b: Dictionary = body["value"]
		var pk: Dictionary = keys_store.public_keys().detail
		t.check("register_keys: the body names the port's keys", body["ok"] and b.keys().size() == 4 and b["signKey"] == pk["sign_key"] and b["agreeKey"] == pk["agree_key"])
		var proof := {"purpose": "keys", "product": fx["product"], "device_id": fx["device_id"], "value": PKeyDeviceProof.keys_value(b["signKey"], b["agreeKey"], int(b["issuedAt"])), \
				"token_hash": "-", "sign_key": b["signKey"], "sig": b["sig"]}
		t.check("register_keys: the sig is a keys proof for this product and device", PKeyDeviceProof.verify(proof, int(b["issuedAt"])))
	_secret_free(t, "register_keys: no private half in the result", [str(r), str(keys_store)], [keys_store._mem_record.slice(13, 45), keys_store._mem_record.slice(77, 109)])

	_plan = {"/devices/keys": {"status": 200, "headers": {"Content-Type": "application/json"}, "body": "{}"}}
	var nokeyseq: PKeyResult = await sdk.devices.register_keys(keys_store, true)
	t.check("register_keys: an answer without a keySeq is invalid-response", not nokeyseq.ok and nokeyseq.code == PKeyErrors.INVALID_RESPONSE, str(nokeyseq))
	for bad in ["{\"keySeq\":0}", "{\"keySeq\":1.5}", "{\"keySeq\":\"3\"}"]:
		_plan = {"/devices/keys": {"status": 200, "headers": {"Content-Type": "application/json"}, "body": bad}}
		var br: PKeyResult = await sdk.devices.register_keys(keys_store, true)
		t.check("register_keys: %s is invalid-response" % bad, not br.ok and br.code == PKeyErrors.INVALID_RESPONSE)
	_plan = {"/devices/keys": {"status": 409, "headers": {"Content-Type": "application/json"}, "body": "{\"error\":{\"code\":\"device_keys_invalid\",\"message\":\"no\"}}"}}
	var refused: PKeyResult = await sdk.devices.register_keys(keys_store, true)
	t.check("register_keys: a refusal keeps the server's code", not refused.ok and refused.code == &"device_keys_invalid", str(refused))
	store.token = ""
	sdk.core.tokens.clear()
	var notoken: PKeyResult = await sdk.devices.register_keys(keys_store, true)
	t.check("register_keys: without a credential it says so", not notoken.ok and notoken.code == PKeyErrors.DEVICE_MANAGEMENT_UNSUPPORTED, str(notoken))
	server.queue_free()
	sdk.queue_free()


# ── Stale lock reclaim, an empty unique id, orphaned temporaries ─────────────────────────

func _reclaim(t: PKeyTestContext) -> void:
	if not OS.has_feature("threads"):
		t.info("reclaim: no thread support in this build; skipped")
		return
	var root := _dir("reclaim")
	var dir := root.path_join("djdl")
	var lock := dir.path_join(PKeyDeviceKeyStore.LOCK_DIR)
	DirAccess.make_dir_recursive_absolute(lock)
	var tok := FileAccess.open(lock.path_join("token"), FileAccess.WRITE)
	tok.store_string("dead holder")
	tok.close()
	OS.delay_msec(2300)
	var results := []
	results.resize(5)
	var ids := []
	for i in 5:
		ids.append(WorkerThreadPool.add_task(_reclaim_job.bind(i, root, results), false, "pkey-test dk reclaim"))
	for id in ids:
		WorkerThreadPool.wait_for_task_completion(id)
	var ok := true
	for r in results:
		if r == null or not r.ok:
			ok = false
	t.check("reclaim: five stores racing over a pre-aged lock all succeed", ok, str(results))
	if ok:
		var gens := []
		for r in results:
			gens.append(r.detail["generation"])
		gens.sort()
		# Three ensures and two rotates in some order: the record's generation moves one at a
		# time, never repeating, so the final generation is 1 + the rotates that ran after a pair.
		var final: Dictionary = _file_store(root).public_keys().detail
		t.check("reclaim: one pair, no generation repeated by a rotate", final["generation"] >= 2 and final["generation"] <= 3, str(gens))
		var rot_gens := []
		for i in [3, 4]:
			rot_gens.append(results[i].detail["generation"])
		t.check("reclaim: the two rotates saw distinct generations", rot_gens[0] != rot_gens[1], str(rot_gens))
	t.check("reclaim: no lock or claimed directory is left", DirAccess.get_directories_at(dir).is_empty(), str(DirAccess.get_directories_at(dir)))
	# A lock that is not old, and an unreadable mtime, are never reclaimed.
	var s2 := _file_store(root)
	s2.lock_wait_ms = 100
	DirAccess.make_dir_recursive_absolute(lock)
	t.check("reclaim: a fresh lock is not reclaimed", s2.ensure().code == PKeyDeviceKeyStore.STORE_FAULT)
	# A lost token: the write aborts and writes nothing.
	DirAccess.remove_absolute(lock)
	var s3 := _file_store(root)
	s3.wipe()
	s3._lock_token = "ours"
	var lost := s3._write_file("device-keys", PackedByteArray([1]), false)
	t.check("reclaim: a write without our token is refused", lost != OK and not FileAccess.file_exists(dir.path_join("device-keys")))
	PKeyTestFixtures.remove_tree(root)


func _reclaim_job(i: int, root: String, results: Array) -> void:
	var s := _file_store(root)
	s.lock_stale_seconds = 1
	s.lock_wait_ms = 8000
	results[i] = s.ensure() if i < 3 else s.rotate()


func _weak_id_and_orphans(t: PKeyTestContext) -> void:
	var root := _dir("weak")
	var s := _file_store(root)
	s.unique_id = ""
	t.check("weak id: an empty unique id reports file protection and best effort", s.protection() == "file" and s.best_effort())
	var k := s.ensure()
	t.check("weak id: the store still works", k.ok)
	var strong := _file_store(_dir("strong"))
	strong.unique_id = "device-1"
	t.check("weak id: a non-empty id is encrypted-file", strong.protection() == "encrypted-file")
	PKeyTestFixtures.remove_tree(root)

	var root2 := _dir("orphan")
	var p := _file_store(root2, false)
	p.ensure()
	var dir := root2.path_join("djdl")
	var names := ["device-keys.tmp-aaaa", "device-keys.salt.tmp-bbbb"]
	for n in names:
		var f := FileAccess.open(dir.path_join(n), FileAccess.WRITE)
		f.store_string("secret-looking bytes")
		f.close()
	p.rotate()
	var left := false
	for n in names:
		if FileAccess.file_exists(dir.path_join(n)):
			left = true
	t.check("orphans: leftover temporaries are swept on the next locked operation", not left)
	var f2 := FileAccess.open(dir.path_join("device-keys.tmp-cccc"), FileAccess.WRITE)
	f2.store_string("x")
	f2.close()
	p.wipe()
	t.check("orphans: wipe sweeps them too", DirAccess.get_files_at(dir).is_empty(), str(DirAccess.get_files_at(dir)))
	PKeyTestFixtures.remove_tree(root2)
