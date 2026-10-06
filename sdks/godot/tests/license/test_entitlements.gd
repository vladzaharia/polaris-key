extends RefCounted
# @pkey-feature license.entitlements license.channels license.gate
# The reads off the verified licence document (is_entitled, get_entitlements, get_profile,
# get_license_id, entitled_channels), the activation source (token supersedes bundle), and the
# gate surface (status, is_licensed, not-applicable when License is off). The first half reads
# the real signed document recorded in sync-etag-304; the channel shapes no recording carries
# are staged into the in-memory cache, which is what the client reads.

const S := preload("res://tests/license/support.gd")

var h: PKeyLicenseTestSupport


func run(t: PKeyTestContext) -> void:
	h = PKeyLicenseTestSupport.new()
	if not t.check("entitlements: fixtures present", h.ready()):
		return
	await _verified(t)
	await _shapes(t)
	await _activation_source(t)
	h.free_server()


func _verified(t: PKeyTestContext) -> void:
	h.server.requests.clear()
	h.plan = {}
	h.serve_docs([h.F["token"]])
	var sdk := PKeyTestFixtures.new_sdk()
	t.check("entitlements: no license object before configure", sdk.license == null)
	var store := PKeyMemoryStore.new(h.F["device_id"], h.F["token"])
	sdk.queue_free()
	sdk = await h.sdk(store)
	t.check("entitlements: nothing is granted before a document verifies", not sdk.license.is_entitled("polarisVpn") and sdk.license.get_entitlements().is_empty() and sdk.license.get_profile() == null and sdk.license.get_license_id() == "")
	t.check("entitlements: entitled_channels is [stable] with no document", sdk.license.entitled_channels() == ["stable"])
	t.check("entitlements: a held token without a document needs activation", sdk.license.activation() == &"token" and sdk.license.status()["status"] == "needs-activation" and not sdk.license.is_licensed())
	await sdk.sync()
	t.check("entitlements: the verified document makes the licence ok", sdk.license.status()["status"] == "ok" and sdk.license.is_licensed() and sdk.is_licensed(), str(sdk.license.status()))
	t.check("entitlements: status() on the root and on license agree", sdk.status() == sdk.license.status())
	t.check("entitlements: is_entitled reads a true grant", sdk.license.is_entitled("polarisVpn"))
	t.check("entitlements: is_entitled is false for an absent grant", not sdk.license.is_entitled("nope"))
	t.check("entitlements: get_entitlements flattens to values", sdk.license.get_entitlements() == {"polarisVpn": true}, str(sdk.license.get_entitlements()))
	t.check("entitlements: get_license_id", sdk.license.get_license_id() == "lic_djdl_1")
	var profile = sdk.license.get_profile()
	t.check("entitlements: get_profile is the signed greeting block", profile is Dictionary and profile.get("name") == "Ada Lovelace" and profile.get("firstName") == "Ada" and profile.get("email") == "ada@example.com", str(profile))
	if profile is Dictionary:
		profile["name"] = "Mallory"
		t.check("entitlements: get_profile hands out a copy", sdk.license.get_profile()["name"] == "Ada Lovelace")
	t.check("entitlements: no channels grant -> [stable]", sdk.license.entitled_channels() == ["stable"])
	sdk.queue_free()

	# License disabled: not-applicable, usable, whatever is held.
	var off = await h.sdk(PKeyMemoryStore.new(h.F["device_id"]), PackedStringArray(["config"]))
	t.check("entitlements: License disabled -> not-applicable and usable", off.license.status() == {"status": "not-applicable"} and off.license.is_licensed())
	off.queue_free()


## A verified-looking licence document with `entitlements`, staged into the in-memory cache.
func _stage(sdk: Node, entitlements: Dictionary) -> void:
	sdk.core.cache.license = {"jws": "", "doc": {
		"iss": "key.plrs.im", "aud": "djdl", "deviceId": h.F["device_id"], "licenseId": "lic_staged",
		"issuedAt": h.F["now"], "expiresAt": h.F["now"] + 3600, "graceUntil": h.F["now"] + 86400,
		"entitlements": entitlements,
	}}


static func _ent(value: Variant) -> Dictionary:
	return {"state": "default", "value": value, "updatedAt": 1699990000}


func _shapes(t: PKeyTestContext) -> void:
	var sdk = await h.sdk(PKeyMemoryStore.new(h.F["device_id"], h.F["token"]))
	var channels := [
		["in order, as granted", ["beta", "stable", "nightly"], ["beta", "stable", "nightly"]],
		["raw: duplicates kept, staging not rewritten (the Worker's entitledChannels)", ["staging", "beta", "staging"], ["staging", "beta", "staging"]],
		["string members only", ["beta", 3, null, true, {"x": 1}, "pr-42"], ["beta", "pr-42"]],
		["an empty array is empty", [], []],
		["not an array -> [stable]", "beta", ["stable"]],
		["null -> [stable]", null, ["stable"]],
	]
	for c in channels:
		_stage(sdk, {"channels": _ent(c[1])})
		var got: Array = sdk.license.entitled_channels()
		t.check("entitlements: entitled_channels %s" % c[0], got == c[2], JSON.stringify(got))
	_stage(sdk, {"channels": "not an entry"})
	t.check("entitlements: entitled_channels with a malformed entry -> [stable]", sdk.license.entitled_channels() == ["stable"])
	_stage(sdk, {})
	t.check("entitlements: entitled_channels without the entry -> [stable]", sdk.license.entitled_channels() == ["stable"])

	var grants := {
		"yes": _ent(true), "no": _ent(false), "str": _ent("true"), "one": _ent(1), "onef": _ent(1.0),
		"arr": _ent([true]), "nul": _ent(null), "bare": true,
	}
	_stage(sdk, grants)
	var entitled: Array = []
	for k in grants:
		if sdk.license.is_entitled(k):
			entitled.append(k)
	t.check("entitlements: is_entitled is true only for the boolean value true", entitled == ["yes"], str(entitled))
	var flat: Dictionary = sdk.license.get_entitlements()
	t.check("entitlements: get_entitlements keeps every value and skips a malformed entry", flat.size() == 7 and flat["str"] == "true" and flat["arr"] == [true] and flat["nul"] == null and not flat.has("bare"), str(flat))
	# S-19 G11: a grant the last verified document lists is not an entitlement once the gate is
	# not usable (expired past grace here; revoked reads the same way through is_licensed()).
	_stage(sdk, {"yes": _ent(true)})
	t.check("entitlements: G11 a usable gate keeps the grant", sdk.license.is_entitled("yes") and sdk.license.is_licensed())
	sdk.core.cache.license["doc"]["issuedAt"] = h.F["now"] - 7200
	sdk.core.cache.license["doc"]["expiresAt"] = h.F["now"] - 3600
	sdk.core.cache.license["doc"]["graceUntil"] = h.F["now"] - 1800
	var gone: String = sdk.license.status()["status"]
	t.check("entitlements: G11 is_entitled is false once the gate is not usable", not sdk.license.is_licensed() and not sdk.license.is_entitled("yes"), gone)
	t.check("entitlements: G11 get_entitlements still reads the raw grant", sdk.license.get_entitlements() == {"yes": true})
	_stage(sdk, {"x": _ent(true)})
	sdk.core.cache.license["doc"]["profile"] = "not a block"
	t.check("entitlements: a non-object profile reads as null", sdk.license.get_profile() == null and sdk.license.get_license_id() == "lic_staged")
	sdk.queue_free()


func _activation_source(t: PKeyTestContext) -> void:
	var store := PKeyMemoryStore.new(h.F["device_id"])
	var sdk = await h.sdk(store)
	t.check("entitlements: nothing held -> activation is empty", sdk.license.activation() == &"" and sdk.license.status()["status"] == "needs-activation")
	sdk.core.cache.imported_bundle = {"bundleId": "b1", "importedAt": h.F["now"]}
	t.check("entitlements: a bundle without a verified licence document does not activate", sdk.license.activation() == &"")
	_stage(sdk, {})
	t.check("entitlements: a bundle with a verified licence document -> bundle", sdk.license.activation() == &"bundle" and sdk.license.status()["status"] == "ok")
	sdk.core.tokens.set_token("pkeyt_SUPERSEDES", PKeyTokenManager.SOURCE_ACTIVATE)
	t.check("entitlements: a token supersedes a bundle", sdk.license.activation() == &"token")
	sdk.queue_free()
