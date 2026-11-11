@tool
class_name PKeyPeerLocal
extends RefCounted
## WIRE-CONTRACT-V5 section 15.12: local links (account-free pairing), ported from
## `packages/client-core/src/peer/local.ts`. Pure functions over bytes, with the clock passed in; nothing here
## does I/O. The vectors are `peer-matrix.json` `local`. The machines are in `PKeyPeerLocalWindow` (the pairing
## window), `PKeyPeerLocalJoin` (the joiner and its dial budget), `PKeyPeerLocalExchange` (the order guard),
## `PKeyPeerLocalGate` (the operator gate) and `PKeyPeerLocalMemory` (the nameplate memory and the renewal floor).
##
## What lives here: the code and its nameplate, the QR, the adverts (the `m=q` instance, the `m=l` instance and
## its browse, the `m=l` TXT), the `LOCAL_LINK` body, the link secret, the handshake capabilities, the pin and
## the shared listener's trial order. A password, a QR secret and a link secret are key material: nothing here
## prints one or returns one inside an error.
##
## A random source is a Callable taking a byte count and returning a PackedByteArray, or null when it cannot
## supply that many (a stream of fixed bytes in a vector). Verdicts are Dictionaries with snake_case members.

## A pairing window stays open at most this long.
const LOCAL_PAIR_SECONDS := 300
## A code is 8 digits: a 2-digit nameplate and a 6-digit password.
const LOCAL_CODE_DIGITS := 8
## The fifth failed guess closes the window.
const LOCAL_PAIR_FAILURES := 5
const LOCAL_QR_SECRET_BYTES := 16
const LOCAL_JOIN_CANDIDATES := 2
const LOCAL_JOIN_BROWSE_SECONDS := 15
## Local links one device holds for one product.
const MAX_LOCAL_LINKS := 32
const MAX_LIVE_LOCAL_ADVERTS := 8
## `PKeyPeerContact.MAX_CONTACT_SECRETS` plus `MAX_LOCAL_LINKS`.
const MAX_LINK_SECRETS := 104
const LOCAL_LINK_BODY_MAX := 4096
## The mandatory capability of mode `q`.
const LOCAL_CAP := "local/1"
## The trials a full miss costs: two account keys, 72 contact secrets and 32 local-link secrets.
const TRIAL_TOTAL := 106

const _B32 := "abcdefghijklmnopqrstuvwxyz234567"

static var _slug_re: RegEx
static var _instance_body_re: RegEx
static var _secret_re: RegEx
static var _code_re: RegEx


static func _static_init() -> void:
	_slug_re = PKeyClaims.whole("[a-z0-9][a-z0-9-]{0,63}")
	_instance_body_re = PKeyClaims.whole("[a-z2-7]{16}")
	_secret_re = PKeyClaims.whole("[a-z2-7]{26}")
	_code_re = PKeyClaims.whole("[0-9]{8}")


static func _two(n: int) -> String:
	return "%02d" % n


# -- the code ---------------------------------------------------------------------------------

## The nameplate: one byte at a time, 200 or more drawn again, then mod 100, and a nameplate in `in_use`
## drawn again unless all 100 are in use (then any is taken). "" when the source runs out.
static func draw_nameplate(source: Callable, in_use: Array = []) -> String:
	var used := {}
	for n in in_use:
		used[String(n)] = true
	var all := true
	for i in 100:
		if not used.has(_two(i)):
			all = false
			break
	while true:
		var b: Variant = source.call(1)
		if b == null:
			return ""
		var v: int = (b as PackedByteArray)[0]
		if v >= 200:
			continue
		var n := _two(v % 100)
		if not all and used.has(n):
			continue
		return n
	return ""


## The password: a u32be of 4 bytes, drawn again at 4 294 000 000 or more, then mod 10^6, written with
## leading zeros. "" when the source runs out.
static func draw_password(source: Callable) -> String:
	while true:
		var b: Variant = source.call(4)
		if b == null:
			return ""
		var p: PackedByteArray = b
		var n: int = (p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]
		if n >= 4294000000:
			continue
		return "%06d" % (n % 1000000)
	return ""


## `4812 3456`: two groups of four, one space. "" unless both parts make 8 ASCII digits.
static func display_code(nameplate: String, password: String) -> String:
	var digits := nameplate + password
	if not PKeyClaims.matches_whole_re(_code_re, digits):
		return ""
	return digits.substr(0, 4) + " " + digits.substr(4)


## A typed code: ASCII spaces and hyphens removed, then exactly 8 ASCII digits. {ok = true, nameplate,
## password} or {ok = false}.
static func parse_code(text: String) -> Dictionary:
	var digits := text.replace(" ", "").replace("-", "")
	if not PKeyClaims.matches_whole_re(_code_re, digits):
		return {"ok": false}
	return {"ok": true, "nameplate": digits.substr(0, 2), "password": digits.substr(2)}


# -- the QR -----------------------------------------------------------------------------------

## `PKP1:<SLUG>:<INSTANCE>:<SECRET>` in upper case. "" for a slug, instance or secret the format refuses.
static func make_qr(slug: String, instance: String, secret: PackedByteArray) -> String:
	if not PKeyClaims.matches_whole_re(_slug_re, slug) or not PKeyPeerAdvert.is_instance_name(instance):
		return ""
	if secret.size() != LOCAL_QR_SECRET_BYTES:
		return ""
	return ("PKP1:%s:%s:%s" % [slug, instance.substr(3), PKeyPeerAdvert.base32_lower(secret)]).to_upper()


## The 16 bytes of 26 canonical base32 characters; empty when the two unused low bits are set.
static func _decode_secret(chars: String) -> PackedByteArray:
	var out := PackedByteArray()
	var acc := 0
	var bits := 0
	for c in chars:
		acc = (acc << 5) | _B32.find(c)
		bits += 5
		if bits >= 8:
			out.append((acc >> (bits - 8)) & 0xff)
			bits -= 8
			acc &= (1 << bits) - 1
	return out if acc == 0 else PackedByteArray()


static func _ascii_fold(s: String) -> String:
	var out := ""
	for i in s.length():
		var c := s.unicode_at(i)
		out += char(c + 32) if c >= 65 and c <= 90 else s[i]
	return out


## Read a scanned QR: ASCII case folded, four fields split at `:`. {result = "ok", slug, instance, secret},
## {result = "other-app"} for a well-formed slug that is not `own`, else {result = "invalid"}.
static func parse_qr(text: String, own: String) -> Dictionary:
	var invalid := {"result": "invalid"}
	var f := _ascii_fold(text).split(":")
	if f.size() != 4 or f[0] != "pkp1":
		return invalid
	if not PKeyClaims.matches_whole_re(_slug_re, f[1]) or not PKeyClaims.matches_whole_re(_instance_body_re, f[2]):
		return invalid
	if not PKeyClaims.matches_whole_re(_secret_re, f[3]):
		return invalid
	var bytes := _decode_secret(f[3])
	if bytes.is_empty():
		return invalid
	if f[1] != own:
		return {"result": "other-app"}
	return {"result": "ok", "slug": f[1], "instance": "p1-" + f[2], "secret": bytes}


# -- the adverts ------------------------------------------------------------------------------

## The `m=q` instance: `p1-` and the 16 base32 characters of the window's 10 random bytes. "" for any
## other length.
static func pairing_instance(sid: PackedByteArray) -> String:
	return "p1-" + PKeyPeerAdvert.base32_lower(sid) if sid.size() == 10 else ""


## The `m=l` instance of an advertiser in one epoch: `p1-` and the first 16 characters of the lower-case
## base32 of `HMAC-SHA256(secret, "pkey-peer/1 ldisc" || 0x00 || u64be(epoch) || advertiser_link_key)`, with the
## advertiser's own link key so the two devices of a link differ.
static func local_instance(secret: PackedByteArray, advertiser_link_key: PackedByteArray, epoch: int) -> String:
	if secret.is_empty():
		return ""
	var data := "pkey-peer/1 ldisc".to_utf8_buffer()
	data.append(0)
	data.append_array(PKeyPeerContact.u64be(epoch))
	data.append_array(advertiser_link_key)
	var mac := PKeySyncHkdf.hmac(secret, data)
	return "p1-" + PKeyPeerAdvert.base32_lower(mac).substr(0, 16) if not mac.is_empty() else ""


## Which held link an instance belongs to: the first of the first `MAX_LOCAL_LINKS`, in held order, that
## matches in the current or the previous epoch. `links` holds {secret, peer_key} (raw bytes). At most 64
## HMACs. {link: index, epoch_back: 0 | 1}, or {} for none.
static func browse_local_instance(instance_name: String, links: Array, now_seconds: int) -> Dictionary:
	if not PKeyPeerAdvert.is_instance_name(instance_name):
		return {}
	var epoch := PKeyPeerAdvert.advert_epoch(now_seconds)
	for i in mini(links.size(), MAX_LOCAL_LINKS):
		for epoch_back in 2:
			if epoch - epoch_back < 0:
				continue
			var l: Dictionary = links[i]
			if local_instance(l["secret"], l["peer_key"], epoch - epoch_back) == instance_name:
				return {"link": i, "epoch_back": epoch_back}
	return {}


## `v=1` and `m=l`; `h` and `n` are not read. {ok = true, mode = "l"} or {ok = false, reason}.
static func parse_local_txt(entries: Array) -> Dictionary:
	var kv := PKeyPeerAdvert.txt_entries(entries)
	if kv == null:
		return {"ok": false, "reason": "duplicate"}
	if kv.get("v") != "1":
		return {"ok": false, "reason": "version"}
	if kv.get("m") != "l":
		return {"ok": false, "reason": "mode"}
	return {"ok": true, "mode": "l"}


# -- the LOCAL_LINK body ----------------------------------------------------------------------

## The bytes of a `LOCAL_LINK` body: a failure for a body the peer would refuse. `o`: `cats` and `label`
## (optional).
static func build_local_link(o: Dictionary) -> PKeyResult:
	var cats: Variant = o.get("cats")
	if not cats is Array or not PKeyPeerContact.valid_cats(cats):
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "LocalLink: bad categories.")
	var body := {"v": 1}
	var raw: Variant = o.get("label")
	if raw is String:
		var label := PKeyPeerPayload.clean_label(raw)
		if label != "":
			body["label"] = label
	body["cats"] = (cats as Array).duplicate()
	var bytes := PKeyJson.stringify(body).to_utf8_buffer()
	if bytes.size() > LOCAL_LINK_BODY_MAX:
		return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "LocalLink: bad size.")
	return PKeyResult.success(bytes)


## Judge one `LOCAL_LINK` body: strict JSON of at most 4 KiB, `v` the integer 1, an optional label cleaned as a
## HELLO label (dropped when nothing is left), `cats` required. Unknown members are ignored. {ok = true,
## label?, cats} or {ok = false}.
static func parse_local_link(body: PackedByteArray) -> Dictionary:
	var no := {"ok": false}
	if body.size() > LOCAL_LINK_BODY_MAX:
		return no
	var scanned: Variant = PKeyPeerPayload.parse_object_scanned(body)
	if scanned == null:
		return no
	var o: Dictionary = scanned["value"]
	if not PKeyClaims.is_wire_integer(o.get("v"), "/v", 1, scanned["non_wire_integers"]) or float(o["v"]) != 1.0:
		return no
	var cats: Variant = o.get("cats")
	if not cats is Array or not PKeyPeerContact.valid_cats(cats):
		return no
	var out := {"ok": true}
	if o.has("label"):
		if not o["label"] is String:
			return no
		var label := PKeyPeerPayload.clean_label(o["label"])
		if label != "":
			out["label"] = label
	out["cats"] = (cats as Array).duplicate()
	return out


# -- the link secret --------------------------------------------------------------------------

## `HKDF-SHA256(salt = h, ikm = isk, info = "pkey-peer/1 local" || 0x00 || lo || hi)`, 32 bytes: `h` is the
## mode-`q` handshake hash, `isk` the CPace ISK (64 bytes) and `lo`, `hi` the two link public keys by unsigned
## byte order. Empty when a key is not 32 bytes.
static func local_link_secret(
		h: PackedByteArray, isk: PackedByteArray, key_a: PackedByteArray, key_b: PackedByteArray) -> PackedByteArray:
	if key_a.size() != 32 or key_b.size() != 32:
		return PackedByteArray()
	var lo := key_a
	var hi := key_b
	if PKeyPeerContact.byte_compare(key_a, key_b) > 0:
		lo = key_b
		hi = key_a
	var info := "pkey-peer/1 local".to_utf8_buffer()
	info.append(0)
	info.append_array(lo)
	info.append_array(hi)
	return PKeySyncHkdf.hkdf(isk, h, info, 32)


## A link's categories: the entries both sides listed, once each, in byte order.
static func local_categories(a: Array, b: Array) -> Array:
	return PKeyPeerContact.categories(a, b)


# -- handshake capabilities -------------------------------------------------------------------

## The session's capabilities of a mode-`q` or mode-`l` handshake: {caps} and, in mode `q` without
## `local/1`, {close = "peer_not_allowed"}.
static func negotiate_local_caps(mode: String, local: Array, remote: Array) -> Dictionary:
	var caps := PKeyPeerPayload.caps_intersection(local, remote)
	if mode == "q" and not caps.has(LOCAL_CAP):
		return {"caps": caps, "close": "peer_not_allowed"}
	return {"caps": caps}


# -- the pin ----------------------------------------------------------------------------------

## Mode l: the remote static key must be the peer link key of the link whose secret opened the session.
## The initiator asks after message 2, the responder after message 3; a `false` ends the session as
## `peer_revoked` with nothing sent.
static func local_pin(held: PackedByteArray, remote_static: PackedByteArray) -> bool:
	return held == remote_static


## Mode q: a remote static key equal to this side's own link key ends the handshake silently, before the
## transport (a reflected handshake). `true` means the key is another's.
static func pairing_remote_ok(own: PackedByteArray, remote_static: PackedByteArray) -> bool:
	return own != remote_static


# -- the listener's trial order ---------------------------------------------------------------

## Dummy trials after a miss behind the limiter, so a silent close costs `TRIAL_TOTAL` trials.
static func trial_padding(tried: int) -> int:
	return maxi(0, TRIAL_TOTAL - tried)


## The order a shared listener tries message 1 in: the account's keys (a null one is skipped, an absent one
## keeps its slot), then the contact secrets (at most `MAX_CONTACT_SECRETS`), then the local-link secrets in
## held order (at most `MAX_LOCAL_LINKS`). Each entry is {kind = "a" | "c" | "l", index}. `account` null is none.
static func listener_trial_order(account: Variant, contacts: int, locals: int) -> Array:
	var out: Array = []
	if account is Array:
		for i in mini((account as Array).size(), 2):
			if account[i] != null:
				out.append({"kind": "a", "index": i})
	for i in mini(contacts, PKeyPeerContact.MAX_CONTACT_SECRETS):
		out.append({"kind": "c", "index": i})
	for i in mini(locals, MAX_LOCAL_LINKS):
		out.append({"kind": "l", "index": i})
	return out
