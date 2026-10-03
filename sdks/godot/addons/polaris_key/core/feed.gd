class_name PKeyFeed
extends RefCounted
## The channel feed, `pkey-feed+jws` (WIRE-CONTRACT-V4 §2.3; client steps 3–9 of
## plans/P3-01.md §2.5): a port of client-core `feed.ts`, pinned by the corpus `feedCases`.
##
##   feed_claims(payload, opts)       steps 4–6: null, or "claims" | "channel" | "selector"
##   verify_feed(jws, opts)           steps 3–8 (a coroutine): {ok: true, feed} or
##                                    {ok: false, reason, channel?}
##   feed_floor(feed)                 {seq, issuedAt}: the floor a committed feed sets
##   reload_feeds(cached, opts)       the reload path (a coroutine): {feeds, floors}
##   commit_feed(feeds, requested, claim, jws)   step 9's write over the `feeds` slice
##   bound_channels(requested)        the requested name and, for an alias, its target
##   feed_content(doc, nw)            the content members (plans/P4-13.md §2.2): {packSets,
##                                    packFloors, revocations}, each parsed or null, beside the
##                                    claims (a malformed member never refuses the feed)
##   with_feed_content(feed, content) the feed as the decision reads it
##
## The `channel` claim is the CANONICAL channel: once step 5 has bound it to the request (the
## requested name, or CHANNEL_ALIASES[requested]), it keys `feeds` and the floors, and step 8 reads
## `floors[claim]` only then. No function here resolves an alias to choose a key, a floor or a
## decision channel; `latest` is never a claim.
##
## Every pattern goes through PKeyClaims' whole-string helper, every bounded length counts UTF-8
## bytes, a required member must be present (`floor` and `live` may be null, never missing) and an
## optional member is absent or of its type (a present null is refused). Every integer field is an
## integer claim, decided at its RFC 6901 pointer from the verified payload's
## `non_wire_integers` (Godot reads `7.0000000000000001` as 7; the token decides). Nothing here
## throws; nothing does I/O.

const FEED_TTL_SECONDS := 900
const MAX_FEED_TTL_SECONDS := 3600
const ROLLOUT_BUCKETS := 10000
## `targets[].platform`: OUTLET_ID_PATTERN's shape (ASCII).
const FEED_PLATFORM_PATTERN := "[a-z][a-z0-9-]{0,63}"
## Product outlet ids and outlet kinds (P2b-02's OUTLET_ID_PATTERN).
const OUTLET_ID_PATTERN := "[a-z][a-z0-9-]{0,63}"
const MAX_LISTING_URL_BYTES := 2048

const REFUSED_CLAIMS := "claims"
const REFUSED_CHANNEL := "channel"
const REFUSED_SELECTOR := "selector"

static var _channel_re: RegEx
static var _platform_re: RegEx
static var _outlet_re: RegEx
static var _sha256_re: RegEx
static var _salt_re: RegEx
static var _cap_booleans := PackedStringArray(["codeUpdates", "dataUpdates", "channelSwitch", "downloadedScripts"])
static var _commerce := PackedStringArray(["own", "store-iap", "steam", "none"])
static var _binary_updates := PackedStringArray(["none", "store", "self"])


static func _static_init() -> void:
	_channel_re = PKeyClaims.whole(PKeyConstants.CHANNEL_NAME_PATTERN)
	_platform_re = PKeyClaims.whole(FEED_PLATFORM_PATTERN)
	_outlet_re = PKeyClaims.whole(OUTLET_ID_PATTERN)
	_sha256_re = PKeyClaims.whole("[0-9a-f]{64}")
	_salt_re = PKeyClaims.whole("[0-9a-f]{32}")


static func _ready_res() -> void:
	if _channel_re == null:
		_static_init()


## `listingUrl`: 1–2048 bytes, each 0x21–0x7E, so bytes and characters count alike.
static func _printable_ascii(v: String, max_bytes: int) -> bool:
	var bytes := v.to_utf8_buffer()
	if bytes.size() < 1 or bytes.size() > max_bytes:
		return false
	for b in bytes:
		if b < 0x21 or b > 0x7E:
			return false
	return true


static func _capabilities_ok(v: Variant) -> bool:
	if not (v is Dictionary):
		return false
	if v.has("binaryUpdates") and not (v["binaryUpdates"] is String and _binary_updates.has(v["binaryUpdates"])):
		return false
	for key in _cap_booleans:
		if v.has(key) and not (v[key] is bool):
			return false
	if v.has("commerce") and not (v["commerce"] is String and _commerce.has(v["commerce"])):
		return false
	return true


static func _version(scheme: String, v: Variant) -> bool:
	return v is String and PKeyVersion.parse_version(scheme, v) != null


## Step 4: every claim of §2.3. True when they all hold.
static func _claims_ok(doc: Dictionary, expected_aud: String, nw: PKeyJson.PointerSet) -> bool:
	var sv = doc.get("schemaVersion")
	if not PKeyClaims.is_wire_integer(sv, "/schemaVersion", 1, nw) or float(sv) != 1.0:
		return false
	if not (doc.get("iss") is String) or doc["iss"] != PKeyClaims.ISSUER:
		return false
	if not (doc.get("aud") is String) or doc["aud"] != expected_aud:
		return false
	if not PKeyClaims.matches_whole_re(_channel_re, doc.get("channel")):
		return false
	if not (doc.get("selector") is Dictionary):
		return false
	var selector: Dictionary = doc["selector"]
	if selector.has("platform") and not (selector["platform"] is String):
		return false
	if not PKeyClaims.is_wire_integer(doc.get("seq"), "/seq", 1, nw):
		return false
	if not PKeyClaims.is_wire_integer(doc.get("issuedAt"), "/issuedAt", 0, nw):
		return false
	if not PKeyClaims.is_wire_integer(doc.get("expiresAt"), "/expiresAt", 1, nw):
		return false
	var issued := float(doc["issuedAt"])
	var expires := float(doc["expiresAt"])
	if not (issued < expires) or expires > issued + MAX_FEED_TTL_SECONDS:
		return false

	if not (doc.get("app") is Dictionary):
		return false
	var app: Dictionary = doc["app"]
	if not (app.get("deliverable") is String) or app["deliverable"] != "app":
		return false
	if not (app.get("versionScheme") is String) or not PKeyVersion.SCHEMES.has(app["versionScheme"]):
		return false
	var scheme: String = app["versionScheme"]
	if not (app.get("targets") is Array):
		return false
	var targets: Array = app["targets"]

	var platforms := {}
	for i in targets.size():
		var at := "/app/targets/%d" % i
		var target = targets[i]
		if not (target is Dictionary):
			return false
		var platform = target.get("platform")
		if not PKeyClaims.matches_whole_re(_platform_re, platform):
			return false
		if platforms.has(platform):
			return false
		platforms[platform] = true
		if selector.has("platform") and platform != selector["platform"]:
			return false

		var release = target.get("release")
		if not (release is Dictionary):
			return false
		if not PKeyClaims.matches_whole_re(_sha256_re, release.get("sha256")):
			return false
		if not PKeyClaims.is_wire_integer(release.get("seq"), at + "/release/seq", 1, nw):
			return false
		if not _version(scheme, release.get("version")):
			return false

		if not target.has("floor"):
			return false
		if target["floor"] != null:
			if not (target["floor"] is Dictionary):
				return false
			var min_version = target["floor"].get("minVersion")
			if not _version(scheme, min_version):
				return false
			var c = PKeyVersion.compare_versions(scheme, min_version, release["version"])
			if c == null or int(c) > 0:
				return false
		if not (target.get("critical") is bool):
			return false

		if not (target.get("outlets") is Dictionary):
			return false
		var outlets: Dictionary = target["outlets"]
		for id in outlets:
			if not PKeyClaims.matches_whole_re(_outlet_re, id):
				return false
			var pointer := "%s/outlets/%s" % [at, String(id).replace("~", "~0").replace("/", "~1")]
			var entry = outlets[id]
			if not (entry is Dictionary):
				return false
			var kind = entry.get("kind")
			if not PKeyClaims.matches_whole_re(_outlet_re, kind) or kind == PKeyDecision.OUTLET_UNKNOWN:
				return false
			if not entry.has("live"):
				return false
			if entry["live"] != null:
				if not (entry["live"] is Dictionary):
					return false
				if not _version(scheme, entry["live"].get("version")):
					return false
				if not PKeyClaims.is_wire_integer(entry["live"].get("seq"), pointer + "/live/seq", 1, nw):
					return false
			if not (entry.get("halted") is bool):
				return false
			if entry.has("rollout"):
				var rollout = entry["rollout"]
				if not (rollout is Dictionary):
					return false
				if not PKeyClaims.is_wire_integer(rollout.get("bp"), pointer + "/rollout/bp", 0, nw):
					return false
				if float(rollout["bp"]) > ROLLOUT_BUCKETS:
					return false
				if not PKeyClaims.matches_whole_re(_salt_re, rollout.get("salt")):
					return false
			if entry.has("listingUrl"):
				var url = entry["listingUrl"]
				if not (url is String):
					return false
				if PKeyConstants.OUTLET_KIND_VALUES.has(kind):
					if not _printable_ascii(url, MAX_LISTING_URL_BYTES):
						return false
					var prefixed := false
					for p in PKeyDecision.listing_url_prefixes(kind):
						if (url as String).begins_with(p):
							prefixed = true
							break
					if not prefixed:
						return false
			if entry.has("capabilities") and not _capabilities_ok(entry["capabilities"]):
				return false
	return true


## Client steps 4–6 over a verified feed payload: the claims ("claims"), the channel binding
## ("channel": the claim is never `latest`, and equals the requested name or, when that name is
## an alias, CHANNEL_ALIASES[requested]) and the selector ("selector"). null when all three pass;
## the claim is then the canonical channel. `opts`: {expected_aud, channel (the REQUESTED name),
## platform?, non_wire_integers?}.
static func feed_claims(payload: Variant, opts: Dictionary) -> Variant:
	_ready_res()
	if not (payload is Dictionary):
		return REFUSED_CLAIMS
	var nw = opts.get("non_wire_integers")
	if not _claims_ok(payload, String(opts.get("expected_aud", "")), nw if nw is PKeyJson.PointerSet else null):
		return REFUSED_CLAIMS
	var claim: String = payload["channel"]
	var requested := String(opts.get("channel", ""))
	var alias = PKeyConstants.CHANNEL_ALIASES.get(requested)
	if claim == "latest":
		return REFUSED_CHANNEL
	if claim != requested and not (alias is String and claim == alias):
		return REFUSED_CHANNEL
	var selector: Dictionary = payload["selector"]
	for key in selector:
		if key != "platform":
			return REFUSED_SELECTOR
	if selector.has("platform") and opts.get("platform") is String and selector["platform"] != opts["platform"]:
		return REFUSED_SELECTOR
	return null


## Client steps 3–8 (a coroutine): verify the JWS with the EFFECTIVE product trust set and `typ`
## `pkey-feed+jws`, the claims, the channel binding, the selector, freshness on the network path,
## and the `seq` floor of the canonical channel. `opts`: {trust, expected_aud, channel (the
## REQUESTED name), platform, now (the effective clock), check_freshness (default true), floors?
## (canonical channel -> {seq, issuedAt}), offload? (run Ed25519 off the calling thread)}.
## Returns {ok: true, feed, content} or {ok: false, reason, channel?}; `content` is feed_content over
## the payload with its own `non_wire_integers` (plans/P4-13.md §2.5 step 10); `channel` (the
## canonical channel) is present only for a refusal after step 5, the first key of §2.5's fallback
## order.
static func verify_feed(jws: Variant, opts: Dictionary) -> Dictionary:
	if not (jws is String) or not (opts.get("trust") is Dictionary):
		return {"ok": false, "reason": "jws"}
	var v = await PKeyJws.verify_async(jws, opts["trust"], PKeyClaims.TYP_FEED, 0, PKeyClaims.is_true(opts.get("offload", false)))
	if v == null:
		return {"ok": false, "reason": "jws"}
	return check_verified(v, opts)


## Steps 4–8 over what PKeyJws returned (steps 1–3), so a caller that already verified the
## signature (the profile suite's timing split) reaches the same verdicts.
static func check_verified(v: Dictionary, opts: Dictionary) -> Dictionary:
	var refusal = feed_claims(v["payload"], {
		"expected_aud": opts.get("expected_aud", ""),
		"channel": opts.get("channel", ""),
		"platform": opts.get("platform", ""),
		"non_wire_integers": v["non_wire_integers"],
	})
	if refusal == REFUSED_CLAIMS or refusal == REFUSED_CHANNEL:
		return {"ok": false, "reason": refusal}
	var feed: Dictionary = v["payload"]
	# From here on the claim is the canonical channel (step 5).
	var channel: String = feed["channel"]
	if refusal == REFUSED_SELECTOR:
		return {"ok": false, "reason": refusal, "channel": channel}
	if not PKeyClaims.is_false(opts.get("check_freshness", true)):
		var now := float(opts.get("now", PKeyClaims.system_now()))
		var skew := float(PKeyClaims.CLOCK_SKEW_SECONDS)
		if float(feed["issuedAt"]) > now + skew or float(feed["expiresAt"]) <= now - skew:
			return {"ok": false, "reason": "freshness", "channel": channel}
	var floors = opts.get("floors")
	if floors is Dictionary and floors.has(channel) and floors[channel] is Dictionary:
		var floor_at: Dictionary = floors[channel]
		var seq := float(feed["seq"])
		var floor_seq := float(floor_at.get("seq", 0))
		if seq < floor_seq:
			return {"ok": false, "reason": "rollback", "channel": channel}
		if seq == floor_seq and float(feed["issuedAt"]) <= float(floor_at.get("issuedAt", 0)):
			return {"ok": false, "reason": "not-newer", "channel": channel}
	return {"ok": true, "feed": feed, "content": feed_content(feed, v["non_wire_integers"])}


## The floor a committed feed sets for its canonical channel.
static func feed_floor(feed: Dictionary) -> Dictionary:
	return {"seq": feed["seq"], "issuedAt": feed["issuedAt"]}


## The reload path (plans/P3-01.md §2.5, a coroutine): every `cached[k]` goes through steps 3–6
## with `k` as the requested name, no freshness and no floor, and its claim must equal `k`. Each
## survivor gives `floors[k]`; anything that fails is absent, so a committed feed whose key left
## the effective trust set is dropped with its floor. `opts`: {trust, expected_aud, platform}.
## Returns {feeds: {k: {jws, feed, content}}, floors: {k: {seq, issuedAt}}}. Floors are never
## persisted.
static func reload_feeds(cached: Variant, opts: Dictionary) -> Dictionary:
	var out := {"feeds": {}, "floors": {}}
	if not (cached is Dictionary):
		return out
	for k in cached:
		if not (k is String) or not (cached[k] is String):
			continue
		var r := await verify_feed(cached[k], {
			"trust": opts.get("trust", {}),
			"expected_aud": opts.get("expected_aud", ""),
			"channel": k,
			"platform": opts.get("platform", ""),
			"check_freshness": false,
			"offload": opts.get("offload", false),
		})
		if not r["ok"] or r["feed"]["channel"] != k:
			continue
		out["feeds"][k] = {"jws": cached[k], "feed": r["feed"], "content": r["content"]}
		out["floors"][k] = feed_floor(r["feed"])
	return out


## Step 9's write over the `feeds` slice: `feeds[claim] = jws`, and when the claim is not the
## requested name (an alias answer) the same write removes `feeds[requested]`. Every other entry
## stays. Returns a new Dictionary.
static func commit_feed(feeds: Dictionary, requested: String, claim: String, jws: String) -> Dictionary:
	var next := feeds.duplicate()
	if claim != requested:
		next.erase(requested)
	next[claim] = jws
	return next


## The keys a request binds to (step 5): the requested name and, when it is an alias, its
## target. Only step 2's comparison and §2.5's fallback order use this.
static func bound_channels(requested: String) -> PackedStringArray:
	var alias = PKeyConstants.CHANNEL_ALIASES.get(requested)
	if alias is String and alias != requested:
		return PackedStringArray([requested, alias])
	return PackedStringArray([requested])


# ── P4-13: the feed's content members (plans/P4-13.md §2.2, WIRE-CONTRACT-V4 §2.4.1) ─────────
#
# Parsed BESIDE the claims, never as a claim: an unusable member is null and never refuses the
# feed, so a malformed content member cannot stop app updates. Each member is independent.
# Unknown members are ignored at every level, and the parsed value carries the known ones only.
# Each parser returns null for "unusable" (GDScript has no exceptions), and every value read from
# the payload is type-checked before any comparison (a String against a number is a runtime
# error). Thread-safe: no const Array is indexed or iterated.

## RFC 6901 escaping of one reference token.
static func _token(key: String) -> String:
	return key.replace("~", "~0").replace("/", "~1")


static func _record_version(v: Variant) -> bool:
	return PKeyPackClaims.matches(PKeyPackClaims.VERSION_PATTERN, v)


static func _parse_variant(v: Variant) -> Variant:
	if not (v is Dictionary) or (v as Dictionary).size() > 4:
		return null
	var out := {}
	for name in v:
		var value = v[name]
		if not PKeyPackClaims.matches(PKeyPackClaims.VARIANT_AXIS_PATTERN, name):
			return null
		if not PKeyPackClaims.matches(PKeyPackClaims.VARIANT_VALUE_PATTERN, value):
			return null
		out[name] = value
	return out


static func _parse_pack_sets(v: Variant, selector: Variant, nw: PKeyJson.PointerSet) -> Variant:
	if not (v is Dictionary):
		return null
	var ps: Dictionary = v
	if not ps.has("releases") or not ps.has("sets") or not ps.has("rows"):
		return null

	if not (ps["releases"] is Dictionary):
		return null
	var releases := {}
	for h in ps["releases"]:
		var rel = ps["releases"][h]
		if not PKeyClaims.matches_whole_re(_sha256_re, h) or not (rel is Dictionary):
			return null
		if not PKeyPackClaims.is_pack_id(rel.get("pack")):
			return null
		if not _record_version(rel.get("version")):
			return null
		if not PKeyClaims.is_wire_integer(rel.get("seq"), "/packSets/releases/%s/seq" % h, 1, nw):
			return null
		releases[h] = {"pack": rel["pack"], "version": rel["version"], "seq": rel["seq"]}

	if not (ps["sets"] is Dictionary):
		return null
	var sets := {}
	for id in ps["sets"]:
		var members = ps["sets"][id]
		if not PKeyClaims.matches_whole_re(_sha256_re, id) or not (members is Array):
			return null
		var packs := {}
		var list: Array = []
		for m in members:
			if not (m is String) or not releases.has(m):
				return null
			var pack: String = releases[m]["pack"]
			if packs.has(pack):
				return null
			packs[pack] = true
			list.append(m)
		sets[id] = list

	if not (ps["rows"] is Array):
		return null
	var has_platform: bool = selector is Dictionary and (selector as Dictionary).has("platform")
	var platform = selector["platform"] if has_platform else null
	var rows: Array = []
	var keys := {}
	var rows_in: Array = ps["rows"]
	for i in rows_in.size():
		var row = rows_in[i]
		if not (row is Dictionary):
			return null
		if not PKeyClaims.is_wire_integer(row.get("contentApi"), "/packSets/rows/%d/contentApi" % i, 1, nw):
			return null
		if not PKeyClaims.matches_whole_re(_platform_re, row.get("platform")):
			return null
		if has_platform and not PKeyPackClaims.same(row["platform"], platform):
			return null
		var engine = row.get("engine")
		if not (engine is String) or (engine != "" and not PKeyPackClaims.matches(PKeyPackClaims.ENGINE_PATTERN, engine)):
			return null
		var variant = _parse_variant(row.get("variant"))
		if variant == null:
			return null
		if not (row.get("set") is String) or not sets.has(row["set"]):
			return null
		var key := JSON.stringify([float(row["contentApi"]), row["platform"], engine, PKeyPackClaims.variant_key(variant)])
		if keys.has(key):
			return null
		keys[key] = true
		rows.append({"contentApi": row["contentApi"], "platform": row["platform"], "engine": engine, "variant": variant, "set": row["set"]})

	var out := {"releases": releases, "sets": sets, "rows": rows}
	if ps.has("outlets"):
		if not (ps["outlets"] is Dictionary):
			return null
		var outlets := {}
		for id in ps["outlets"]:
			var entry = ps["outlets"][id]
			if not PKeyClaims.matches_whole_re(_outlet_re, id) or not (entry is Dictionary):
				return null
			var parsed := {}
			if entry.has("pinned"):
				if not (entry["pinned"] is Array):
					return null
				var seen := {}
				for p in entry["pinned"]:
					if not PKeyPackClaims.is_pack_id(p) or seen.has(p):
						return null
					seen[p] = true
				parsed["pinned"] = (entry["pinned"] as Array).duplicate()
			if entry.has("gates"):
				if not (entry["gates"] is Dictionary):
					return null
				var gates := {}
				for h in entry["gates"]:
					var gate = entry["gates"][h]
					if not (h is String) or not releases.has(h) or not (gate is Dictionary):
						return null
					if not (gate.get("halted") is bool):
						return null
					var at := "/packSets/outlets/%s/gates/%s" % [_token(String(id)), h]
					var pg := {"halted": gate["halted"], "fallback": null}
					if gate.has("rollout"):
						var ro = gate["rollout"]
						if not (ro is Dictionary):
							return null
						if not PKeyClaims.is_wire_integer(ro.get("bp"), at + "/rollout/bp", 0, nw):
							return null
						if float(ro["bp"]) > ROLLOUT_BUCKETS:
							return null
						if not PKeyClaims.matches_whole_re(_salt_re, ro.get("salt")):
							return null
						pg["rollout"] = {"bp": ro["bp"], "salt": ro["salt"]}
					if not gate.has("fallback"):
						return null
					if gate["fallback"] != null:
						if not (gate["fallback"] is String) or not releases.has(gate["fallback"]):
							return null
						pg["fallback"] = gate["fallback"]
					gates[h] = pg
				parsed["gates"] = gates
			outlets[id] = parsed
		out["outlets"] = outlets
	return out


static func _parse_pack_floors(v: Variant, nw: PKeyJson.PointerSet) -> Variant:
	if not (v is Array):
		return null
	var out: Array = []
	var keys := {}
	var floors: Array = v
	for i in floors.size():
		var f = floors[i]
		if not (f is Dictionary):
			return null
		if not PKeyPackClaims.is_pack_id(f.get("pack")):
			return null
		if not PKeyClaims.is_wire_integer(f.get("contentApi"), "/packFloors/%d/contentApi" % i, 1, nw):
			return null
		if not _record_version(f.get("minVersion")):
			return null
		if not (f.get("versionScheme") is String):
			return null
		var key := JSON.stringify([f["pack"], float(f["contentApi"])])
		if keys.has(key):
			return null
		keys[key] = true
		# A forward scheme makes that entry alone ignored.
		if not PKeyVersion.SCHEMES.has(f["versionScheme"]):
			continue
		out.append({"pack": f["pack"], "contentApi": f["contentApi"], "minVersion": f["minVersion"], "versionScheme": f["versionScheme"]})
	return out


static func _parse_revocations(v: Variant, nw: PKeyJson.PointerSet) -> Variant:
	if not (v is Array):
		return null
	var out: Array = []
	var records := {}
	var entries: Array = v
	for i in entries.size():
		var r = entries[i]
		if not (r is Dictionary):
			return null
		if not PKeyClaims.matches_whole_re(_sha256_re, r.get("record")):
			return null
		if not PKeyPackClaims.is_pack_id(r.get("pack")):
			return null
		if not PKeyClaims.matches_whole_re(_sha256_re, r.get("target")):
			return null
		if not _record_version(r.get("version")):
			return null
		if not PKeyClaims.is_wire_integer(r.get("seq"), "/revocations/%d/seq" % i, 1, nw):
			return null
		if records.has(r["record"]):
			return null
		records[r["record"]] = true
		# plans/P4-19.md §2.7: `kind` absent (a pack record target) or `delegation`; any other
		# vocabulary token is a forward value whose entry is dropped alone; anything else makes the
		# member unusable. (Godot acts on delegation entries from P4-26; until then step 11 skips
		# them.)
		var entry := {"record": r["record"], "pack": r["pack"], "target": r["target"], "version": r["version"], "seq": r["seq"]}
		if r.has("kind"):
			if not PKeyPackClaims.matches(PKeyPackClaims.VOCAB_TOKEN_PATTERN, r["kind"]):
				return null
			if r["kind"] != "delegation":
				continue
			entry["kind"] = "delegation"
		out.append(entry)
	return out


## The feed's content members (plans/P4-13.md §2.2): `packSets`, `packFloors` and `revocations`,
## each parsed, or null when absent or unusable. Integer members follow V4 §3.1's token rule at
## their RFC 6901 pointers (pass the verified payload's `non_wire_integers`; null when checking an
## object you built). An unusable member never refuses the feed and never affects the other two.
## A `packFloors` entry whose `versionScheme` is not a known scheme is dropped alone. Returns
## {packSets, packFloors, revocations}; nothing here fails by error.
static func feed_content(doc: Variant, nw: PKeyJson.PointerSet = null) -> Dictionary:
	_ready_res()
	var out := {"packSets": null, "packFloors": null, "revocations": null}
	if not (doc is Dictionary):
		return out
	if doc.has("packSets"):
		out["packSets"] = _parse_pack_sets(doc["packSets"], doc.get("selector"), nw)
	if doc.has("packFloors"):
		out["packFloors"] = _parse_pack_floors(doc["packFloors"], nw)
	if doc.has("revocations"):
		out["revocations"] = _parse_revocations(doc["revocations"], nw)
	return out


## The feed as the decision reads it: `feed` with each content member replaced by `content`'s
## parsed value, or removed when that is null. PKeyDecision re-reads the members without the
## token rule, so a caller holding a verified payload hands it this copy. Returns a new
## Dictionary.
static func with_feed_content(feed: Dictionary, content: Dictionary) -> Dictionary:
	var out := feed.duplicate()
	for key in PackedStringArray(["packSets", "packFloors", "revocations"]):
		out.erase(key)
		if content.get(key) != null:
			out[key] = content[key]
	return out
