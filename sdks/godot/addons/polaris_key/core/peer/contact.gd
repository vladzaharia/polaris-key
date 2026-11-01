@tool
class_name PKeyPeerContact
extends RefCounted
## WIRE-CONTRACT-V5 section 15.10: inter-account links (CC-19b.G1), ported from
## `packages/client-core/src/peer/contact.ts`. Pure functions over bytes and a clock; nothing here
## does I/O. The vectors are `peer-matrix.json` `contact`.
##
## What lives here: the contact secret, the `CONTACT` body, a link's categories, `Exchange` (the order
## guard over the records of the pairing), the contact list (`store`, `promote`, `drop_stale_pending`,
## `trial_order`), the pin, the contact advert (name, TXT, browse), the contact room (room id, alias,
## ticket body) and `listener_trial` (the order a shared responder tries keys in). What does not: the
## session, the sockets and the store on disk.
##
## Dictionaries use snake_case members. A verdict is {ok = true, ...} or {ok = false}. Key material
## lives in `StoredContact`, which redacts itself; no function here prints a key or returns one in a
## message.

const MAX_CONTACTS := 64
const MAX_CONTACT_CATS := 8
## Pairings with a peer the host already holds wait as pending contacts; the oldest goes first.
const MAX_PENDING_CONTACTS := 8
const PENDING_CONTACT_SECONDS := 86400
## The secrets a responder tries and a browser tests: the held contacts and the pending ones.
const MAX_CONTACT_SECRETS := MAX_CONTACTS + MAX_PENDING_CONTACTS
const MAX_LIVE_CONTACT_ADVERTS := 8
const CONTACT_BODY_MAX := 4096
const CONTACT_TICKET_BODY_MAX := 256
## The relay leases bytes to a contact room in steps of this many (section 15.7).
const CONTACT_LEASE_BYTES := 1048576
## A contact room with no socket for this long erases itself (section 15.7).
const CONTACT_ROOM_IDLE_SECONDS := 2592000
## From this side's `CONFIRM` to the peer's `CONTACT`.
const CONTACT_EXCHANGE_SECONDS := 30
## The account keys a shared responder tries before the contact secrets.
const MAX_ACCOUNT_TRIALS := 2

const CLOSE_TIMEOUT := &"peer_timeout"
const CLOSE_REVOKED := &"peer_revoked"
const CLOSE_BUSY := &"peer_busy"
const CLOSE_HANDSHAKE_FAILED := &"handshake_failed"

static var _cat_re: RegEx
static var _rid_re: RegEx


static func _static_init() -> void:
	_cat_re = PKeyClaims.whole("[a-z0-9-]{1,32}")
	_rid_re = PKeyClaims.whole("[A-Za-z0-9_-]{22}")


static func _invalid(why: String) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "Contact: bad input: %s." % why)


## A canonical base64url of 32 bytes, decoded, or null.
static func _key32(v: Variant) -> Variant:
	if not v is String or (v as String).length() != 43:
		return null
	var b: Variant = PKeyB64Url.decode_strict(v)
	if b == null or (b as PackedByteArray).size() != 32:
		return null
	return b


## Unsigned byte order of two equal-length byte strings.
static func _byte_compare(a: PackedByteArray, b: PackedByteArray) -> int:
	for i in a.size():
		if a[i] != b[i]:
			return a[i] - b[i]
	return 0


static func _u64be(n: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(8)
	for i in 8:
		b[i] = (n >> (56 - 8 * i)) & 0xff
	return b


# -- the contact secret -----------------------------------------------------------------------

## `HKDF-SHA256(salt = h, ikm = nD || nM, info = "pkey-peer/1 contact" || 0x00 || lo || hi)`, 32 bytes:
## `h` is the mode-p handshake hash, `nD` and `nM` the two SAS nonces and `lo`, `hi` the two devices'
## agreeKeys (32 raw bytes each) by unsigned byte order. Empty when a key is not 32 bytes.
static func contact_secret(
		h: PackedByteArray, n_d: PackedByteArray, n_m: PackedByteArray,
		agree_key_a: PackedByteArray, agree_key_b: PackedByteArray) -> PackedByteArray:
	if agree_key_a.size() != 32 or agree_key_b.size() != 32:
		return PackedByteArray()
	var lo := agree_key_a
	var hi := agree_key_b
	if _byte_compare(agree_key_a, agree_key_b) > 0:
		lo = agree_key_b
		hi = agree_key_a
	var ikm := n_d.duplicate()
	ikm.append_array(n_m)
	var info := "pkey-peer/1 contact".to_utf8_buffer()
	info.append(0)
	info.append_array(lo)
	info.append_array(hi)
	return PKeySyncHkdf.hkdf(ikm, h, info, 32)


# -- the CONTACT body -------------------------------------------------------------------------

static func _valid_cats(cats: Array) -> bool:
	if cats.size() > MAX_CONTACT_CATS:
		return false
	var seen := {}
	for c in cats:
		if not PKeyClaims.matches_whole_re(_cat_re, c) or seen.has(c):
			return false
		seen[c] = true
	return true


## The bytes of a `CONTACT` body. `o`: `agree_key` (43 characters), `label` (optional) and `cats`.
## A failure for a body the peer would refuse.
static func build_contact(o: Dictionary) -> PKeyResult:
	var key: Variant = _key32(o.get("agree_key"))
	if key == null or PKeyCurve25519.is_low_order(key):
		return _invalid("agree key")
	var cats: Variant = o.get("cats")
	if not cats is Array or not _valid_cats(cats):
		return _invalid("categories")
	var body := {"v": 1, "agreeKey": o["agree_key"]}
	var raw: Variant = o.get("label")
	if raw is String:
		var label := PKeyPeerPayload.clean_label(raw)
		if label != "":
			body["label"] = label
	body["cats"] = (cats as Array).duplicate()
	var bytes := PKeyJson.stringify(body).to_utf8_buffer()
	if bytes.size() > CONTACT_BODY_MAX:
		return _invalid("size")
	return PKeyResult.success(bytes)


## Judge one `CONTACT` body. `own` is the reader's own agreeKey ("" none): a body that carries it is
## no contact. The label is cleaned as a HELLO label and dropped when nothing is left. {ok = true,
## agree_key, label?, cats} or {ok = false}.
static func parse_contact(body: PackedByteArray, own := "") -> Dictionary:
	var no := {"ok": false}
	if body.size() > CONTACT_BODY_MAX:
		return no
	var scanned: Variant = PKeyPeerPayload.parse_object_scanned(body)
	if scanned == null:
		return no
	var o: Dictionary = scanned["value"]
	if not PKeyClaims.is_wire_integer(o.get("v"), "/v", 1, scanned["non_wire_integers"]) or float(o["v"]) != 1.0:
		return no
	var key: Variant = _key32(o.get("agreeKey"))
	if key == null or PKeyCurve25519.is_low_order(key):
		return no
	if own != "" and o["agreeKey"] == own:
		return no
	var cats: Variant = o.get("cats")
	if not cats is Array or not _valid_cats(cats):
		return no
	var out := {"ok": true, "agree_key": o["agreeKey"]}
	if o.has("label"):
		if not o["label"] is String:
			return no
		var label := PKeyPeerPayload.clean_label(o["label"])
		if label != "":
			out["label"] = label
	out["cats"] = (cats as Array).duplicate()
	return out


## A link's categories: the entries both sides list, once each, in byte order.
static func categories(a: Array, b: Array) -> Array:
	var out: Array = []
	for c in a:
		if b.has(c) and not out.has(c):
			out.append(c)
	out.sort()
	return out


# -- the pairing exchange ---------------------------------------------------------------------

## One side's order guard over the records of the exchange (section 15.10, "Order of checks"). A
## `CONTACT` goes out once this side has sent its `CONFIRM` and read the peer's; the peer's arrives
## only after both. After a close nothing happens. `step` answers {sends: Array of "CONFIRM" |
## "CONTACT", close?: StringName, stored?: {agree_key, label?, cats, pending}}; `stored` is the peer's
## `CONTACT`, valid and read in order, and `pending` is true when the host already holds that key (a
## re-pair; the new contact waits until a handshake under its secret passes the pin).
class Exchange extends RefCounted:
	const OWN_CONFIRM := "own-confirm"
	const PEER_CONFIRM := "peer-confirm"
	const PEER_CONTACT := "peer-contact"
	## `CONTACT_EXCHANGE_SECONDS` after this side's `CONFIRM`.
	const TIMEOUT := "timeout"

	var _own: String
	var _held: Array
	var _own_confirmed := false
	var _peer_confirmed := false
	var _contact_sent := false
	var _peer_contact := false
	var _dead := false


	## `own` is this device's agreeKey. `held` is the agreeKey of every active contact the host holds
	## for the product: a peer in it is a re-pair, accepted at any count; a peer not in it is refused
	## (`peer_not_allowed`, nothing stored) when the host already holds `MAX_CONTACTS`.
	func _init(own := "", held: Array = []) -> void:
		_own = own
		_held = held.duplicate()


	func _to_string() -> String:
		return "PKeyPeerContact.Exchange()"


	## This side's `CONFIRM` is out and the peer's `CONTACT` is still wanted.
	func waiting() -> bool:
		return not _dead and _own_confirmed and not _peer_contact


	func step(event: String, body := PackedByteArray()) -> Dictionary:
		var r := {"sends": []}
		if _dead:
			return r
		match event:
			OWN_CONFIRM:
				_own_confirmed = true
				(r["sends"] as Array).append("CONFIRM")
				_maybe_contact(r)
			PEER_CONFIRM:
				if _peer_confirmed:
					return _bad(r)
				_peer_confirmed = true
				_maybe_contact(r)
			PEER_CONTACT:
				if not _own_confirmed or not _peer_confirmed or _peer_contact:
					return _bad(r)
				var v := PKeyPeerContact.parse_contact(body, _own)
				if not v["ok"]:
					return _bad(r)
				var pending := _held.has(v["agree_key"])
				if not pending and _held.size() >= PKeyPeerContact.MAX_CONTACTS:
					_dead = true
					r["close"] = PKeyPeerRecord.CLOSE_NOT_ALLOWED
					return r
				_peer_contact = true
				var stored := {"agree_key": v["agree_key"], "cats": v["cats"], "pending": pending}
				if v.has("label"):
					stored["label"] = v["label"]
				r["stored"] = stored
			TIMEOUT:
				if _own_confirmed and not _peer_contact:
					_dead = true
					r["close"] = PKeyPeerContact.CLOSE_TIMEOUT
		return r


	func _maybe_contact(r: Dictionary) -> void:
		if _own_confirmed and _peer_confirmed and not _contact_sent:
			_contact_sent = true
			(r["sends"] as Array).append("CONTACT")


	func _bad(r: Dictionary) -> Dictionary:
		_dead = true
		r["close"] = PKeyPeerRecord.CLOSE_BAD_FRAME
		return r


# -- the contact list -------------------------------------------------------------------------

## A contact the host holds. `pending_since` (unix seconds) marks a pending one; -1 is an active one.
## The secret is zeroed by `wipe()`, best effort.
class StoredContact extends RefCounted:
	var agree_key: String
	var secret: PackedByteArray
	var label: String
	var cats: Array
	var pending_since: int


	func _init(p_agree_key := "", p_secret := PackedByteArray(), p_label := "", p_cats: Array = [], p_pending_since := -1) -> void:
		agree_key = p_agree_key
		secret = p_secret.duplicate()
		label = p_label
		cats = p_cats.duplicate()
		pending_since = p_pending_since


	func _to_string() -> String:
		return "PKeyPeerContact.StoredContact()"


	func is_pending() -> bool:
		return pending_since >= 0


	func copy(p_pending_since := -1) -> StoredContact:
		return StoredContact.new(agree_key, secret, label, cats, p_pending_since)


	func wipe() -> void:
		secret.fill(0)


static func _active(list: Array) -> Array:
	return list.filter(func(c: StoredContact) -> bool: return not c.is_pending())


## Store a contact the exchange produced. A peer whose agreeKey the host does not hold is added as an
## active contact, or refused (`full`) at `MAX_CONTACTS`. A peer it does hold is stored pending: the
## held contact stays as it is, one pending contact per key (a newer one replaces an older), at most
## `MAX_PENDING_CONTACTS` (the oldest goes first). The list in, a new list out: {ok = true, contacts,
## pending} or {ok = false, reason = "full"}.
static func store(list: Array, incoming: StoredContact, now_seconds: int) -> Dictionary:
	var held := false
	for c: StoredContact in _active(list):
		if c.agree_key == incoming.agree_key:
			held = true
			break
	if not held:
		if _active(list).size() >= MAX_CONTACTS:
			return {"ok": false, "reason": "full"}
		var added := list.duplicate()
		added.append(incoming.copy())
		return {"ok": true, "contacts": added, "pending": false}
	var next: Array = list.filter(func(c: StoredContact) -> bool: return not (c.is_pending() and c.agree_key == incoming.agree_key))
	next.append(incoming.copy(now_seconds))
	while true:
		var pend: Array = next.filter(func(c: StoredContact) -> bool: return c.is_pending())
		if pend.size() <= MAX_PENDING_CONTACTS:
			break
		# Oldest first; of equal age, the one stored earlier (lower in the list).
		var oldest: StoredContact = pend[0]
		for c: StoredContact in pend:
			if c.pending_since < oldest.pending_since:
				oldest = c
		next.remove_at(next.find(oldest))
	return {"ok": true, "contacts": next, "pending": true}


## A handshake under a pending contact's secret passed the pin: it replaces the held contact of that
## key, in the held one's place. A key with no pending contact leaves the list as it is.
static func promote(list: Array, agree_key: String) -> Array:
	var p: StoredContact = null
	for c: StoredContact in list:
		if c.is_pending() and c.agree_key == agree_key:
			p = c
			break
	if p == null:
		return list.duplicate()
	var fresh := p.copy()
	var out: Array = []
	for c: StoredContact in list:
		if c == p:
			continue
		out.append(fresh if (not c.is_pending() and c.agree_key == agree_key) else c)
	return out


## Drop the pending contacts stored `PENDING_CONTACT_SECONDS` ago or earlier.
static func drop_stale_pending(list: Array, now_seconds: int) -> Array:
	return list.filter(func(c: StoredContact) -> bool: return not c.is_pending() or now_seconds - c.pending_since < PENDING_CONTACT_SECONDS)


## The order a responder tries secrets and a browser tests contacts in: the active contacts in held
## order, then the pending ones in the order they were stored, at most `MAX_CONTACT_SECRETS`.
static func trial_order(list: Array) -> Array:
	var out := _active(list)
	out.append_array(list.filter(func(c: StoredContact) -> bool: return c.is_pending()))
	return out.slice(0, MAX_CONTACT_SECRETS)


# -- the pin ----------------------------------------------------------------------------------

## Mode c: the remote static key must be the agreeKey of the contact whose secret opened the session.
## The initiator asks after message 2, the responder after message 3; false ends the session as
## `peer_revoked` with nothing sent.
static func pin(held: String, remote_static: PackedByteArray) -> bool:
	return PKeyB64Url.encode(remote_static) == held


# -- the shared listener ----------------------------------------------------------------------

## The order a shared responder tries the keys of message 1 in (section 15.10): the account's keys
## first (at most two, an absent one skipped), then the contact secrets in the order given (at most
## `MAX_CONTACT_SECRETS`). The mode is only in the prologue, so the responder decides by trying.
## `admit` is Callable() -> bool, the contact-trial limiter's `begin()`; it is called once, after the
## account keys and before the first contact secret, and only when contacts are held. `try_open` is
## Callable(kind: "a" | "c", index: int) -> bool, whether the tag verifies under that key. Answers
## {tried: Array of "a:<i>" | "c:<i>", hit: String ("" none), slot: bool (the connection still holds
## the limiter slot: a contact hit does, until message 3), close: StringName ("" none)}.
static func listener_trial(account: Variant, contacts: int, admit: Callable, try_open: Callable) -> Dictionary:
	var tried: Array = []
	if account is Array:
		for i in mini((account as Array).size(), MAX_ACCOUNT_TRIALS):
			if (account as Array)[i] == null:
				continue
			tried.append("a:%d" % i)
			if try_open.call("a", i):
				return {"tried": tried, "hit": "a:%d" % i, "slot": false, "close": &""}
	var held := mini(contacts, MAX_CONTACT_SECRETS)
	if held > 0:
		if not admit.call():
			return {"tried": tried, "hit": "", "slot": false, "close": CLOSE_BUSY}
		for i in held:
			tried.append("c:%d" % i)
			if try_open.call("c", i):
				return {"tried": tried, "hit": "c:%d" % i, "slot": true, "close": &""}
	return {"tried": tried, "hit": "", "slot": false, "close": CLOSE_HANDSHAKE_FAILED}


# -- the LAN advert ---------------------------------------------------------------------------

## The contact instance name for an advertiser in one epoch: `p1-` and the first 16 characters of the
## lower-case base32 of `HMAC-SHA256(secret, "pkey-peer/1 cdisc" || 0x00 || u64be(epoch) || agreeKey)`,
## with the advertiser's own agreeKey (32 raw bytes) so the two devices of a link differ. "" for a
## secret or key of the wrong length.
static func instance(secret: PackedByteArray, advertiser_agree_key: PackedByteArray, epoch: int) -> String:
	if secret.is_empty() or advertiser_agree_key.size() != 32:
		return ""
	var data := "pkey-peer/1 cdisc".to_utf8_buffer()
	data.append(0)
	data.append_array(_u64be(epoch))
	data.append_array(advertiser_agree_key)
	var mac := PKeySyncHkdf.hmac(secret, data)
	if mac.is_empty():
		return ""
	return "p1-" + PKeyPeerAdvert.base32_lower(mac).substr(0, 16)


## `v=1` and `m=c`. An entry splits at its first `=`; one without `=` or with an empty key is
## ignored; a repeated key refuses; `h` is not read. {ok = true} or {ok = false, reason}.
static func parse_txt(entries: Array) -> Dictionary:
	var kv := {}
	for e in entries:
		if not e is String:
			continue
		var at: int = (e as String).find("=")
		if at < 1:
			continue
		var k: String = (e as String).substr(0, at)
		if kv.has(k):
			return {"ok": false, "reason": "duplicate"}
		kv[k] = (e as String).substr(at + 1)
	if kv.get("v") != "1":
		return {"ok": false, "reason": "version"}
	if kv.get("m") != "c":
		return {"ok": false, "reason": "mode"}
	return {"ok": true}


## Which contact an instance belongs to: the first of the first `MAX_CONTACT_SECRETS`, in the order of
## `trial_order`, that matches in the current or the previous epoch. `contacts` holds {secret,
## agree_key} (raw bytes). At most 144 HMACs. {contact: index, epoch_back: 0 | 1}, or {} for none.
static func browse(instance_name: String, contacts: Array, now_seconds: int) -> Dictionary:
	if not PKeyPeerAdvert.is_instance_name(instance_name):
		return {}
	var epoch := PKeyPeerAdvert.advert_epoch(now_seconds)
	for i in mini(contacts.size(), MAX_CONTACT_SECRETS):
		var c: Dictionary = contacts[i]
		for epoch_back in 2:
			if instance(c["secret"], c["agree_key"], epoch - epoch_back) == instance_name:
				return {"contact": i, "epoch_back": epoch_back}
	return {}


# -- the contact room -------------------------------------------------------------------------

## The room id: base64url of `HKDF-SHA256(salt = empty, ikm = secret, info = "pkey-peer/1 room")[0..16]`,
## 22 characters. "" for an empty secret.
static func rid(secret: PackedByteArray) -> String:
	var okm := PKeySyncHkdf.hkdf(secret, PackedByteArray(), "pkey-peer/1 room".to_utf8_buffer(), 32)
	return PKeyB64Url.encode(okm.slice(0, 16)) if okm.size() == 32 else ""


## The alias a room uses for a device: `SHA-256(rid || deviceId)[0..24]` over the 16 decoded rid bytes
## and the 24 decoded device-id bytes. Empty for a rid or a device id that is not canonical.
static func alias(rid_text: String, device_id: String) -> PackedByteArray:
	var id: Variant = PKeyPeerAdvert.device_id_bytes(device_id)
	var raw: Variant = _rid_bytes(rid_text)
	if id == null or raw == null:
		return PackedByteArray()
	var data: PackedByteArray = raw
	data.append_array(id)
	return PKeySyncHkdf.sha256(data).slice(0, 24)


## The ticket-request body for a contact room; "" for a rid that is not canonical.
static func ticket_body(rid_text: String) -> String:
	if _rid_bytes(rid_text) == null:
		return ""
	return PKeyJson.stringify({"room": "c", "rid": rid_text})


## Read a ticket-request body: strict JSON of at most 256 bytes with exactly `room` = "c" and a
## canonical `rid`. {ok = true, rid} or {ok = false}.
static func parse_ticket_body(bytes: PackedByteArray) -> Dictionary:
	var no := {"ok": false}
	if bytes.size() > CONTACT_TICKET_BODY_MAX:
		return no
	var o: Variant = PKeyPeerPayload.parse_strict_object(bytes)
	if o == null:
		return no
	var d: Dictionary = o
	if d.size() != 2 or not d.has("room") or not d.has("rid"):
		return no
	if not d["room"] is String or d["room"] != "c":
		return no
	if _rid_bytes(d["rid"]) == null:
		return no
	return {"ok": true, "rid": d["rid"]}


## The 16 bytes of a canonical 22-character room id, or null.
static func _rid_bytes(v: Variant) -> Variant:
	if not PKeyClaims.matches_whole_re(_rid_re, v):
		return null
	var b: Variant = PKeyB64Url.decode_strict(v)
	return b if b != null and (b as PackedByteArray).size() == 16 else null
