@tool
class_name PKeyConnectLocalState
extends RefCounted
## The local-link store, `pkey.connect.local.v1` (CC-29b.G3; WIRE-CONTRACT-V5 section 15.12, "What each side stores"),
## ported from sdk-node `connect/localState.ts`: the links this device holds for one product, each with its own link
## private key and the link secret. It rests in a file of its own beside the Cloud Connect record, in the same
## keyring-backed store and sealed the same way (`PKeyConnectState.sibling`), or in memory when that store is. It is
## not account data: a sign-out, a licence deactivation and an account deletion leave it alone.
##
## Rules this file keeps:
##  - the record is parsed strictly (no unknown member, no duplicate id, canonical keys, the cap of 32); one that
##    exists but is unusable answers `device-keys-unreadable` and is never replaced (replacing it would forget the
##    held links);
##  - removing the last link clears the store: the record and its key go. It is never rewritten empty;
##  - a private key and a secret are fields of the record and of nothing else here: `info()` carries neither, and no
##    result or `str()` names one;
##  - the cap of 32 and the reachable cap of 8 are judged in the same step as the write;
##  - a link in use (`live()`) carries its decoded key and secret: the user of one wipes it with `wipe_live`.
## Every call answers a PKeyResult. Main thread only.

const SCHEMA := "pkey.connect.local.v1"
const FILE := "connect.local.v1"
const CONTEXT := "pkey-connect/1 local/"
const MEMBERS := [
	"id",
	"ownKey",
	"ownPublic",
	"peerKey",
	"secret",
	"label",
	"cats",
	"platform",
	"createdAt",
	"lastSeen",
	"reachable"
]

static var _id_re: RegEx
static var _cat_re: RegEx

var product: String

var _state: PKeyConnectState


static func _static_init() -> void:
	_id_re = PKeyClaims.whole("[A-Za-z0-9_-]{16}")
	_cat_re = PKeyClaims.whole("[a-z0-9-]{1,32}")


## `state` is the Cloud Connect record's store: this one rests beside it.
func _init(state: PKeyConnectState) -> void:
	product = state.product
	_state = state.sibling(FILE, CONTEXT)


func _to_string() -> String:
	return "PKeyConnectLocalState(%s)" % _state.protection()


## "durable", or "memory" when the record dies with the process.
func persistence() -> String:
	return _state.persistence()


## The rows with their keys and secrets (they stay inside the SDK). ok with an Array of Dictionaries, empty for none; a
## failure `device-keys-unreadable` for a record that cannot be used.
func rows() -> PKeyResult:
	var raw := _state.read_bytes()
	if not raw.ok:
		return raw
	if raw.detail == null:
		return PKeyResult.success([])
	var bytes: PackedByteArray = raw.detail
	var parsed: Variant = _parse(bytes)
	bytes.fill(0)
	if parsed == null:
		return PKeyResult.failure(
			PKeyDeviceKeyStore.KEYS_UNREADABLE, "The local links record is unreadable."
		)
	return PKeyResult.success(parsed)


## How many links are held.
func count() -> PKeyResult:
	var r := rows()
	return r if not r.ok else PKeyResult.success((r.detail as Array).size())


## What the host sees of each link: [{id, label, categories, created_at, last_seen, reachable, platform}], no key and no
## secret.
func info() -> PKeyResult:
	var r := rows()
	if not r.ok:
		return r
	var out: Array = []
	for row: Dictionary in r.detail:
		(
			out
			. append(
				{
					"id": row["id"],
					"label": row.get("label"),
					"categories": (row["cats"] as Array).duplicate(),
					"created_at": row["createdAt"],
					"last_seen": row.get("lastSeen"),
					"reachable": row["reachable"],
					"platform": row["platform"] if row.has("platform") else null,
				}
			)
		)
		_wipe_row(row)
	return PKeyResult.success(out)


## Change the rows in one step. `fn` takes the rows (Array of Dictionaries) and answers the new rows, or null for no
## change. ok, or the failure of the read or the write. An empty result clears the store. The rows are wiped after.
func update(fn: Callable) -> PKeyResult:
	var loaded := rows()
	if not loaded.ok:
		return loaded
	var base: Array = loaded.detail
	var next: Variant = fn.call(base)
	var written := _write(next as Array) if next != null else PKeyResult.success()
	_wipe_rows(base)
	if next != null:
		_wipe_rows(next as Array)
	return written


func _write(next: Array) -> PKeyResult:
	if next.is_empty():
		return _state.clear()
	var bytes := (
		PKeyJson.stringify({"schema": SCHEMA, "product": product, "links": next}).to_utf8_buffer()
	)
	var r := _state.write_bytes(bytes)
	bytes.fill(0)
	return r


## Add a link, unless the device already holds the most. `link`: {own_key, own_public, peer_key, secret (32 bytes
## each), label?, platform, cats, now, allowed? (Callable() -> bool, judged in the same step: false stores nothing)}.
## ok with {stored: true, id}, {stored: false} at the cap, or {stored: false, off: true} when the gate went off.
func add(link: Dictionary) -> PKeyResult:
	var id := PKeyConnectLocalCommon.link_id(link["peer_key"])
	var verdict := {"full": false, "off": false}
	var done := update(
		func(held: Array) -> Variant:
			var allowed: Variant = link.get("allowed")
			if (
				allowed is Callable
				and (allowed as Callable).is_valid()
				and not bool((allowed as Callable).call())
			):
				verdict["off"] = true
				return null
			if held.size() >= PKeyPeerLocal.MAX_LOCAL_LINKS:
				verdict["full"] = true
				return null
			var others: Array = held.filter(func(r: Dictionary) -> bool: return r["id"] != id)
			var live := others.filter(func(r: Dictionary) -> bool: return r["reachable"]).size()
			# Reachable by default; with the live-advert limit already reached the new link is stored off.
			var row := {
				"id": id,
				"ownKey": PKeyB64Url.encode(link["own_key"]),
				"ownPublic": PKeyB64Url.encode(link["own_public"]),
				"peerKey": PKeyB64Url.encode(link["peer_key"]),
				"secret": PKeyB64Url.encode(link["secret"]),
				"cats": (link["cats"] as Array).duplicate(),
				"createdAt": int(link["now"]),
				"reachable": live < PKeyPeerLocal.MAX_LIVE_LOCAL_ADVERTS,
			}
			if link.get("label") is String:
				row["label"] = link["label"]
			if str(link.get("platform", "")) != "":
				row["platform"] = link["platform"]
			others.append(row)
			return others
	)
	if not done.ok:
		return done
	if verdict["off"]:
		return PKeyResult.success({"stored": false, "off": true})
	if verdict["full"]:
		return PKeyResult.success({"stored": false})
	return PKeyResult.success({"stored": true, "id": id})


## A link in use: the row with its key and secret decoded. ok with {id, own_key, own_public, peer_key, secret, label,
## cats, reachable, tag}, or `link-unknown`. The caller wipes it with `wipe_live`.
func live(id: String) -> PKeyResult:
	var r := rows()
	if not r.ok:
		return r
	var found: Variant = null
	for row: Dictionary in r.detail:
		if row["id"] == id:
			found = live_of(row)
		_wipe_row(row)
	if found == null:
		return PKeyResult.failure(PKeyConstants.ErrorCode.LINK_UNKNOWN, "No such link.")
	return PKeyResult.success(found)


## Every link in use, in held order. ok with an Array of `live` Dictionaries.
func live_all() -> PKeyResult:
	var r := rows()
	if not r.ok:
		return r
	var out: Array = []
	for row: Dictionary in r.detail:
		out.append(live_of(row))
		_wipe_row(row)
	return PKeyResult.success(out)


static func live_of(row: Dictionary) -> Dictionary:
	var secret: PackedByteArray = PKeyB64Url.decode_strict(row["secret"])
	return {
		"id": row["id"],
		"own_key": PKeyB64Url.decode_strict(row["ownKey"]),
		"own_public": PKeyB64Url.decode_strict(row["ownPublic"]),
		"peer_key": PKeyB64Url.decode_strict(row["peerKey"]),
		"secret": secret,
		"label": row.get("label"),
		"cats": (row["cats"] as Array).duplicate(),
		"reachable": row["reachable"],
		"tag": PKeyConnectLocalCommon.link_tag(secret),
	}


static func wipe_live(list_of: Array) -> void:
	for c in list_of:
		if c is Dictionary:
			for k in ["secret", "own_key"]:
				if (c as Dictionary).get(k) is PackedByteArray:
					var zeros := PackedByteArray()
					zeros.resize(((c as Dictionary)[k] as PackedByteArray).size())
					(c as Dictionary)[k] = zeros


## Change the label of `id` (this device only). ok with true, or false for no such link.
func rename(id: String, label: String) -> PKeyResult:
	return _change(
		id,
		func(r: Dictionary, _rows: Array) -> Dictionary:
			var next := r.duplicate()
			next["label"] = label
			return next
	)


## Mark `id` reachable or not. ok with true, false for no such link, or `local-links-full` (cap `reachable`) for a
## ninth.
func set_reachable(id: String, reachable: bool) -> PKeyResult:
	var refused := [false]
	var done := _change(
		id,
		func(r: Dictionary, held: Array) -> Dictionary:
			if (
				reachable
				and not r["reachable"]
				and (
					held.filter(func(x: Dictionary) -> bool: return x["reachable"]).size()
					>= PKeyPeerLocal.MAX_LIVE_LOCAL_ADVERTS
				)
			):
				refused[0] = true
				return r
			var next := r.duplicate()
			next["reachable"] = reachable
			return next
	)
	return PKeyConnectLocalCommon.reachable_full() if refused[0] else done


## A link was seen on the network at `now` (Unix seconds). ok with true when the row changed.
func seen(id: String, now: int) -> PKeyResult:
	return _change(
		id,
		func(r: Dictionary, _rows: Array) -> Dictionary:
			var next := r.duplicate()
			next["lastSeen"] = now
			return next
	)


func _change(id: String, f: Callable) -> PKeyResult:
	var hit := [false]
	var done := update(
		func(held: Array) -> Variant:
			hit[0] = held.any(func(r: Dictionary) -> bool: return r["id"] == id)
			if not hit[0]:
				return null
			return held.map(
				func(r: Dictionary) -> Dictionary: return f.call(r, held) if r["id"] == id else r
			)
	)
	return done if not done.ok else PKeyResult.success(hit[0])


## Forget `id`: its keys and secret leave the record. ok with the peer's link key (32 bytes), or `link-unknown`. The
## last link clears the store.
func remove(id: String) -> PKeyResult:
	var gone := [PackedByteArray()]
	var done := update(
		func(held: Array) -> Variant:
			var hit: Variant = null
			for r: Dictionary in held:
				if r["id"] == id:
					hit = r
			if hit == null:
				return null
			gone[0] = PKeyB64Url.decode_strict(hit["peerKey"])
			return held.filter(func(r: Dictionary) -> bool: return r["id"] != id)
	)
	if not done.ok:
		return done
	if (gone[0] as PackedByteArray).is_empty():
		return PKeyResult.failure(PKeyConstants.ErrorCode.LINK_UNKNOWN, "No such link.")
	return PKeyResult.success(gone[0])


## Drop the whole record (a forget): the record and its key go.
func clear() -> PKeyResult:
	return _state.clear()


# -- the record ----------------------------------------------------------------------------------


static func _wipe_row(row: Dictionary) -> void:
	row["secret"] = ""
	row["ownKey"] = ""


static func _wipe_rows(held: Array) -> void:
	for r: Dictionary in held:
		_wipe_row(r)


## The rows of a record, or null when it is unusable.
func _parse(raw: PackedByteArray) -> Variant:
	var parsed := PKeyJson.parse_bytes(raw)
	if not parsed["ok"] or not parsed["value"] is Dictionary:
		return null
	var v: Dictionary = parsed["value"]
	var nw: PKeyJson.PointerSet = parsed["non_wire_integers"]
	if (
		v.size() != 3
		or v.get("schema") != SCHEMA
		or v.get("product") != product
		or not v.get("links") is Array
	):
		return null
	var links: Array = v["links"]
	if links.is_empty() or links.size() > PKeyPeerLocal.MAX_LOCAL_LINKS:
		return null
	var out: Array = []
	var seen := {}
	for i in links.size():
		var row: Variant = _parse_row(links[i], nw, "/links/%d/" % i)
		if row == null or seen.has(row["id"]):
			return null
		seen[row["id"]] = true
		out.append(row)
	return out


static func _parse_row(r: Variant, nw: PKeyJson.PointerSet, at: String) -> Variant:
	if not r is Dictionary:
		return null
	var d: Dictionary = r
	for k in d:
		if not MEMBERS.has(k):
			return null
	if not d.get("id") is String or not PKeyClaims.matches_whole_re(_id_re, d["id"]):
		return null
	for k in ["ownKey", "ownPublic", "peerKey", "secret"]:
		if not d.get(k) is String or not PKeyConnectState.Record._canonical_key(d[k]):
			return null
	var cats: Variant = d.get("cats")
	if not cats is Array or (cats as Array).size() > PKeyPeerContact.MAX_CONTACT_CATS:
		return null
	var seen_cat := {}
	for c in cats:
		if not c is String or not PKeyClaims.matches_whole_re(_cat_re, c) or seen_cat.has(c):
			return null
		seen_cat[c] = true
	if d.has("label") and not d["label"] is String:
		return null
	if (
		not PKeyClaims.is_wire_integer(d.get("createdAt"), at + "createdAt", 0, nw)
		or not d.get("reachable") is bool
	):
		return null
	if d.has("lastSeen") and not PKeyClaims.is_wire_integer(d["lastSeen"], at + "lastSeen", 0, nw):
		return null
	var row := {
		"id": d["id"],
		"ownKey": d["ownKey"],
		"ownPublic": d["ownPublic"],
		"peerKey": d["peerKey"],
		"secret": d["secret"],
		"cats": (cats as Array).duplicate(),
		"createdAt": int(d["createdAt"]),
		"reachable": d["reachable"],
	}
	if d.has("label"):
		row["label"] = d["label"]
	# Display data: a member that is not a known spelling is dropped, never an error.
	var platform := PKeyConnectLocalCommon.platform_of(d.get("platform"))
	if platform != "":
		row["platform"] = platform
	if d.has("lastSeen"):
		row["lastSeen"] = int(d["lastSeen"])
	return row
