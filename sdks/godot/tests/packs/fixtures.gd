class_name PKeyPacksFixtures
extends RefCounted
## Pack fixtures for the engine groups (client-core test/packFixtures.ts, ported): pack records
## signed with the corpus's own TEST release key (`djdl-release-test-2026`, never a production
## key) by PKeyTestSigner; `files.tree` packs whose objects are stored raw; the kaykit `godot.pck`
## v1/v2 packs and objects packages/cli/test/godotFixtures.test.ts wrote; a fake transport with
## Range/If-Range and interruptions; content stamps and markers.

const CASES := "res://tests/corpus/v2/cases.json"
const UPDATE := "res://tests/fixtures/packs/update"
const PRODUCT := "djdl"
const RELEASE_KID := "djdl-release-test-2026"
const PRODUCT_KID := "pkey-test-prod-2026"

## The probe vector (zstd 1.5.7 `--patch-from`): base, frame and target (client-core fixtures).
const PROBE_FRAME_HEX := "28b52ffd64d500150200540230736c65657079206361740a313278797a357461696c20616464656420666f70726f62650a0a00db6bf840c481b4bbab0c04d021809e01ca9ab04cf0c8b204205fff9e32"

static var _keys: Dictionary = {}
static var _seed := PackedByteArray()
static var _signed := {}


static func _load_keys() -> void:
	if not _keys.is_empty():
		return
	var j := JSON.new()
	j.parse(FileAccess.get_file_as_string(CASES))
	for k in j.data["keys"]:
		_keys[k["kid"]] = k
	_seed = PKeyTestSigner.seed_from_pem(_keys[RELEASE_KID]["privateKeyPkcs8Pem"])


static func release_keys() -> Dictionary:
	_load_keys()
	return {RELEASE_KID: _keys[RELEASE_KID]["publicKeyRaw"]}


static func product_trust() -> Dictionary:
	_load_keys()
	return {PRODUCT_KID: _keys[PRODUCT_KID]["publicKeyRaw"]}


static func sha(b: PackedByteArray) -> String:
	return PKeyPackClaims.sha256_hex(b)


## Whole floats (what Godot's JSON gives back) as ints, so a re-serialised record keeps integer
## tokens (WIRE-CONTRACT-V4 §3: `1.0` is not a wire integer).
static func ints(v: Variant) -> Variant:
	match typeof(v):
		TYPE_FLOAT:
			return int(v) if v == floor(v) else v
		TYPE_DICTIONARY:
			var out := {}
			for k in v:
				out[k] = ints(v[k])
			return out
		TYPE_ARRAY:
			var out: Array = []
			for x in v:
				out.append(ints(x))
			return out
	return v


## A signed pack record: {jws, sha256, record}. Signatures are cached by kid and payload text.
## `signer`: {seed, kid} to sign with another key (a delegated content key, plans/P4-19.md §2.2);
## the release key by default.
static func sign_record(record: Dictionary, signer: Variant = null) -> Dictionary:
	_load_keys()
	var text := JSON.stringify(ints(record))
	var seed: PackedByteArray = signer["seed"] if signer is Dictionary else _seed
	var kid: String = signer["kid"] if signer is Dictionary else RELEASE_KID
	var key := kid + " " + text
	if not _signed.has(key):
		_signed[key] = PKeyTestSigner.sign_jws(text, seed, kid, "pkey-release+jws")
	var jws: String = _signed[key]
	return {"jws": jws, "sha256": sha(jws.to_utf8_buffer()), "record": record}


## TEST ONLY: the corpus generator's deterministic content key `label` (tools/sign-corpus.ts
## `contentKey`: the seed is SHA-256 of `pkey-corpus-content-key:<label>`): {seed, publicKey}.
static func content_key(label: String) -> Dictionary:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(("pkey-corpus-content-key:%s" % label).to_utf8_buffer())
	var seed := ctx.finish()
	return {"seed": seed, "publicKey": PKeyB64Url.encode(PKeyTestSigner.public_key(seed))}


## A `kind: delegation` record (plans/P4-19.md §2.2) granting `key` (content_key's) the scope root
## `root` for `types`, signed with the release key: {jws, sha256, signer: {seed, kid: pkd1-<sha256>}}.
## `opts`: issuedAt, expiresAt, seq, kid (the signing release key).
static func delegation_for(key: Dictionary, root: String, types: Array, opts: Dictionary = {}) -> Dictionary:
	var doc := {
		"schemaVersion": 1, "aud": PRODUCT, "deliverable": root, "kind": "delegation", "version": str(int(opts.get("seq", 1))),
		"seq": int(opts.get("seq", 1)), "issuedAt": int(opts.get("issuedAt", 1759000000)), "expiresAt": int(opts.get("expiresAt", 1769000000)),
		"delegate": {"publicKey": key["publicKey"]}, "types": types,
	}
	var jws := sign_with(doc, String(opts.get("kid", RELEASE_KID)), "pkey-release+jws")
	var h := sha(jws.to_utf8_buffer())
	return {"jws": jws, "sha256": h, "doc": doc, "signer": {"seed": key["seed"], "kid": "pkd1-" + h}}


## Any document signed with the corpus's TEST key `kid` (a release or product key) and `typ`.
static func sign_with(doc: Dictionary, kid: String, typ: String) -> String:
	_load_keys()
	var seed := PKeyTestSigner.seed_from_pem(_keys[kid]["privateKeyPkcs8Pem"])
	return PKeyTestSigner.sign_jws(JSON.stringify(ints(doc)), seed, kid, typ)


## A `kind: revocation` record (plans/P4-13.md §2.3) revoking `target` (a tree_pack), signed with
## the release key (or `opts.kid`'s), and its feed entry: {jws, record, entry}. `opts`:
## replacement (a tree_pack), issuedAt, reason, kid.
static func revocation_for(target: Dictionary, opts: Dictionary = {}) -> Dictionary:
	var doc := {
		"schemaVersion": 1, "aud": PRODUCT, "deliverable": target["packId"], "kind": "revocation",
		"version": target["version"], "seq": target["seq"], "issuedAt": int(opts.get("issuedAt", 1759350000)),
		"revokes": target["recordSha256"],
	}
	var rep = opts.get("replacement")
	if rep is Dictionary:
		doc["replacement"] = {"sha256": rep["recordSha256"], "seq": rep["seq"], "version": rep["version"]}
	doc["reason"] = String(opts.get("reason", "Withdrawn in a test."))
	var jws := sign_with(doc, String(opts.get("kid", RELEASE_KID)), "pkey-release+jws")
	var record := sha(jws.to_utf8_buffer())
	return {"jws": jws, "record": record, "entry": {"record": record, "pack": target["packId"], "target": target["recordSha256"], "version": target["version"], "seq": target["seq"]}}


static func probe_base() -> PackedByteArray:
	var s := ""
	for i in 6:
		s += "polaris key probe line %03d: the quick brown fox jumps over the lazy dog\n" % i
	return s.to_utf8_buffer()


static func probe_target() -> PackedByteArray:
	var s := ""
	for i in 6:
		s += "polaris key probe line %s: the quick brown fox jumps over the sleepy cat\n" % ("xyz" if i == 3 else "%03d" % i)
	return (s + "tail added for the probe\n").to_utf8_buffer()


## A `files.tree` pack release over `files` (path → bytes or text), every object raw; with
## `from` (an earlier tree pack) a `files` delta set whose entries are `delta` (the probe frame,
## when the base file is the probe base and the new one the probe target) or raw `blob` entries.
static func tree_pack(pack_id: String, version: String, seq: int, files: Dictionary, from: Variant = null, opts: Dictionary = {}) -> Dictionary:
	var bytes := {}
	for p in files:
		bytes[p] = files[p] if files[p] is PackedByteArray else String(files[p]).to_utf8_buffer()
	var paths: Array = bytes.keys()
	paths.sort_custom(func(a, b): return PKeyPackClaims.compare_bytes(a, b) < 0)
	var entries: Array = []
	var full := PackedByteArray()
	var objects := {}
	for p in paths:
		var b: PackedByteArray = bytes[p]
		entries.append({"path": p, "size": b.size(), "sha256": sha(b), "blob": {"sha256": sha(b), "bytes": b.size(), "codec": "none"}})
		full.append_array(b)
		objects[sha(b)] = b
	var digest := PKeyPackFiles.tree_digest(entries)
	var index := JSON.stringify({"format": "pkey-files/1", "layout": "tree", "payload": {"size": full.size(), "sha256": digest}, "files": entries}).to_utf8_buffer()
	objects[sha(index)] = index
	objects[sha(full)] = full
	var deltas: Array = []
	if from is Dictionary:
		var base_files: Dictionary = from["files"]
		var base_hashes := {}
		for p in base_files:
			base_hashes[sha(base_files[p])] = true
		var data := PackedByteArray()
		var pe: Array = []
		var mem := 1
		for e in entries:
			if base_hashes.has(e["sha256"]):
				continue
			var b: PackedByteArray = bytes[e["path"]]
			var base = base_files.get(e["path"])
			if base is PackedByteArray and sha(base) == sha(probe_base()) and sha(b) == sha(probe_target()):
				var frame := PROBE_FRAME_HEX.hex_decode()
				pe.append({"path": e["path"], "op": "delta", "from": sha(base), "to": e["sha256"], "size": e["size"], "offset": data.size(), "length": frame.size()})
				data.append_array(frame)
				mem = maxi(mem, base.size() + b.size())
			else:
				pe.append({"path": e["path"], "op": "blob", "to": e["sha256"], "size": e["size"], "codec": "none", "offset": data.size(), "length": b.size()})
				data.append_array(b)
				mem = maxi(mem, b.size())
		if data.size() > 0:
			var patch := JSON.stringify({"format": "pkey-patch/1", "scope": "files", "method": "zstd-patch-from", "from": from["treeDigest"], "to": digest, "data": {"sha256": sha(data), "bytes": data.size()}, "entries": pe}).to_utf8_buffer()
			objects[sha(patch)] = patch
			objects[sha(data)] = data
			deltas.append({"method": "zstd-patch-from", "scope": "files", "from": from["treeDigest"], "memBytes": mem, "patch": {"sha256": sha(patch), "bytes": patch.size(), "size": patch.size(), "codec": "none"}, "data": {"sha256": sha(data), "bytes": data.size()}})
	var variant := {
		"variant": opts.get("variant", {}), "payload": {"size": full.size(), "sha256": digest},
		"full": {"sha256": sha(full), "bytes": full.size(), "size": full.size(), "codec": "none"},
		"files": {"format": "pkey-files/1", "layout": "tree", "sha256": sha(index), "bytes": int(opts.get("indexBytes", index.size())), "size": int(opts.get("indexBytes", index.size())), "codec": "none"},
	}
	if not deltas.is_empty():
		variant["deltas"] = deltas
	var record := {
		"schemaVersion": 1, "aud": PRODUCT, "deliverable": pack_id, "kind": "pack", "version": version, "seq": seq,
		"issuedAt": 1759300000 + seq, "type": String(opts.get("type", "files.tree")), "formatVersion": int(opts.get("formatVersion", 1)),
		"handler": {"activation": String(opts.get("activation", "hot"))}, "variants": [variant],
	}
	if opts.get("entitlement", "") != "":
		record["entitlement"] = opts["entitlement"]
	if opts.get("extra") is Dictionary:
		record.merge(opts["extra"], true)
	var s := sign_record(record, opts.get("signer"))
	return {"packId": pack_id, "version": version, "seq": seq, "jws": s["jws"], "recordSha256": s["sha256"], "record": record,
		"treeDigest": digest, "size": full.size(), "objects": objects, "files": bytes, "indexSha256": sha(index), "fullSha256": sha(full)}


static func manifest() -> Dictionary:
	var j := JSON.new()
	j.parse(FileAccess.get_file_as_string(UPDATE.path_join("manifest.json")))
	return j.data


static func object(h: String) -> PackedByteArray:
	return FileAccess.get_file_as_bytes(UPDATE.path_join("objects").path_join(h))


## The kaykit `godot.pck` release `which` ("v1" or "v2"), as P4-03's publish would sign it.
## `tweak(record)` may edit the record before signing.
static func kaykit_pack(which: String, seq: int, tweak := Callable()) -> Dictionary:
	var m := manifest()
	var variant: Dictionary = ints(m[which]["variant"])
	var record := {
		"schemaVersion": 1, "aud": PRODUCT, "deliverable": "diceroll.core3d", "kind": "pack",
		"version": "1.%d.0" % seq, "seq": seq, "issuedAt": 1759400000 + seq, "type": "godot.pck", "formatVersion": 1,
		"handler": {"mountOrder": 2, "prefixes": m["prefixes"], "activation": "restart"}, "variants": [variant],
	}
	if tweak.is_valid():
		tweak.call(record)
	var s := sign_record(record)
	var objects := {}
	for h in m["objects"]:
		objects[h] = object(h)
	var payload := FileAccess.get_file_as_bytes(UPDATE.path_join(m[which]["pck"]))
	return {"packId": "diceroll.core3d", "version": record["version"], "seq": seq, "jws": s["jws"], "recordSha256": s["sha256"],
		"record": record, "objects": objects, "payload": payload, "payloadSha256": sha(payload)}


## A content stamp's `content` pinning these releases (all required and essential by default).
static func stamp_for(packs: Array, expects: Array = []) -> Dictionary:
	var pins: Array = []
	var ex: Array = []
	for p in packs:
		pins.append({"pack": p["packId"], "release": {"sha256": p["recordSha256"], "seq": p["seq"], "version": p["version"]}})
		ex.append({"pack": p["packId"], "required": true, "delivery": "essential"})
	return {"contentApi": 1, "pins": pins, "expects": expects if not expects.is_empty() else ex}


## The stamp file's text (`pkey-content/1`).
static func stamp_text(content: Dictionary) -> String:
	var doc := {"format": "pkey-content/1"}
	doc.merge(content)
	return JSON.stringify(ints(doc))


static func marker_for(pack: Dictionary) -> String:
	return JSON.stringify({"format": "pkey-marker/1", "packId": pack["packId"], "version": pack["version"], "release": pack["jws"]})


## A fake transport over every pack's records and objects (client-core `byteServer`): a ranged
## request with the strong ETag gets 206, anything else 200; `cut` makes the next object GET stop
## after that many bytes (an interrupted download); `moved` answers a resume with a 200 (the
## validator moved); `missing` lists objects answered 404.
class FakeTransport extends PKeyPackTransport:
	var records := {}
	var objects := {}
	var calls: Array = []
	var record_calls: Array = []
	var cut := -1
	## Only this object's GET is cut ("" cuts the next GET whatever it is).
	var cut_for := ""
	var moved := false
	var missing := {}

	func add(pack: Dictionary) -> FakeTransport:
		records[pack["recordSha256"]] = pack["jws"]
		for h in pack["objects"]:
			objects[h] = pack["objects"][h]
		return self

	func id() -> String:
		return "pkey-cdn"

	func fetch_record(sha256: String) -> Dictionary:
		record_calls.append(sha256)
		if records.has(sha256):
			return {"ok": true, "body": String(records[sha256]).to_utf8_buffer()}
		return {"ok": false, "code": "network-error"}

	func fetch_object(req: Dictionary, on_response: Callable, on_chunk: Callable) -> Dictionary:
		calls.append(req.duplicate())
		var h: String = req["sha256"]
		if not objects.has(h) or missing.has(h):
			on_response.call(404, "")
			return {"status": 404, "content_range": "", "error": ""}
		var b: PackedByteArray = objects[h]
		var off := int(req.get("offset", 0))
		var ranged: bool = off > 0 and req.get("if_range") == "\"%s\"" % h and not moved
		var body := b.slice(off) if ranged else b
		var status := 206 if ranged else 200
		var cr := "bytes %d-%d/%d" % [off, b.size() - 1, b.size()] if ranged else ""
		if not on_response.call(status, cr):
			return {"status": status, "content_range": cr, "error": "aborted"}
		var limit := -1
		if cut_for == "" or cut_for == h:
			limit = cut
			cut = -1
			cut_for = ""
		var at := 0
		while at < body.size():
			if limit >= 0 and at >= limit:
				return {"status": status, "content_range": cr, "error": "network-error"}
			var n := mini(4096, body.size() - at)
			if limit >= 0:
				n = mini(n, limit - at)
			if not on_chunk.call(body.slice(at, at + n)):
				return {"status": status, "content_range": cr, "error": "aborted"}
			at += n
		return {"status": status, "content_range": cr, "error": ""}


## An engine over `root` with the test keys, the fake transport and `stamp`.
static func engine(root: String, transport: PKeyPackTransport, stamp: Variant) -> PKeyPackEngine:
	var e := PKeyPackEngine.new(PKeyPackStorage.new(root))
	e.product = PRODUCT
	e.release_keys = release_keys()
	var trust := product_trust()
	e.product_trust = func() -> Dictionary: return trust
	e.stamp = stamp
	var v := Engine.get_version_info()
	e.prefs = {"engine": "godot-%d.%d" % [v["major"], v["minor"]], "axes": {}}
	e.patch_methods = ["zstd-patch-from"] if e.zstd.patch_from_available() else []
	e.transport = transport
	e.offload = false
	var t := [1759500000]
	e.now = func() -> int:
		t[0] += 1
		return t[0]
	var n := [0]
	e.new_plan_id = func() -> String:
		n[0] += 1
		return "plan%d" % n[0]
	return e
