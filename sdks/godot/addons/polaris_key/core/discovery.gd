class_name PKeyDiscovery
extends RefCounted
## Product discovery, `GET /<product>/.well-known/polaris.json` (sdk-node `discovery.ts`), and
## the capability map it feeds.
##
## Fail-closed (D-21): a slug the document omits reads as DISABLED; `enabled` must be the boolean
## `true`; a malformed `services` value rejects the document rather than falling back to a
## permissive default. Capability precedence is: discovery loaded this session, else
## PKeyOptions.expected_services, else licence and config only (PKeyServices.DEFAULT_ENABLED).
##
## The document may grow: the fields read here are validated and the rest is kept verbatim.
## Never pin from `trust.pinnedKeys`: pins come only from PKeyOptions.pinned_trust_keys.


## A full map, every slug in canonical order: slug -> {"enabled": bool}.
static func services_where(enabled: Callable) -> Dictionary:
	var out := {}
	for slug in PKeyServices.SLUGS:
		out[slug] = {"enabled": PKeyClaims.is_true(enabled.call(slug))}
	return out


static func default_services() -> Dictionary:
	return services_where(func(slug): return PKeyServices.DEFAULT_ENABLED.has(slug))


static func services_from_list(slugs: PackedStringArray) -> Dictionary:
	return services_where(func(slug): return slugs.has(slug))


## Parse a discovery body for `expected_product`.
## {kind: "ok", services, manifest} or {kind: "invalid", message}.
static func parse(value: Variant, expected_product: String) -> Dictionary:
	if not (value is Dictionary):
		return _invalid("Discovery document must be a JSON object.")
	var doc: Dictionary = value
	var product := ""
	if _nonempty(doc.get("product")):
		product = doc["product"]
	elif doc.get("product") is Dictionary and _nonempty(doc["product"].get("slug")):
		product = doc["product"]["slug"]
	elif _nonempty(doc.get("slug")):
		product = doc["slug"]
	if product == "":
		return _invalid("Discovery document is missing product.")
	if product != expected_product:
		return _invalid("Discovery document product %s does not match %s." % [product, expected_product])
	if not (doc.get("services") is Dictionary):
		return _invalid("Discovery services must be a map of service fragments.")
	var services := {}
	var fragments := {}
	for slug in PKeyServices.SLUGS:
		var raw = doc["services"].get(slug)
		if raw == null and not doc["services"].has(slug):
			services[slug] = {"enabled": false}
			fragments[slug] = {"enabled": false}
			continue
		if not (raw is Dictionary):
			return _invalid("Discovery services must be a map of service fragments.")
		var on := PKeyClaims.is_true(raw.get("enabled"))
		var fragment: Dictionary = raw.duplicate(true)
		fragment["enabled"] = on
		fragments[slug] = fragment
		services[slug] = {"enabled": on}
	if doc.has("trust") and not (doc["trust"] is Dictionary):
		return _invalid("Discovery trust must be an object.")
	var manifest := doc.duplicate(true)
	manifest["product"] = product
	manifest["services"] = fragments
	return {"kind": "ok", "services": services, "manifest": manifest}


static func _nonempty(v: Variant) -> bool:
	return v is String and v != ""


static func _invalid(message: String) -> Dictionary:
	return {"kind": "invalid", "message": message}


## The absolute appcast URL in Update's published fragment (sdk-node `appcastUrlFrom`), or ""
## when the manifest has no enabled Update fragment with an `endpoints.appcast` http(s) URL. The
## host is never string-built here: §R1 moved these paths, and the document is the product's own
## statement of where its feed lives. `arch` is a query parameter (`?arch=`, form-encoded as
## URLSearchParams does); a channel other than `stable` is a PATH segment, the stable feed's
## sibling (`…/update/<channel>/appcast.xml`). The caller passes a canonical channel name.
static func appcast_url_from(manifest: Variant, channel := "", arch := "") -> String:
	if not (manifest is Dictionary) or not (manifest.get("services") is Dictionary):
		return ""
	var update = manifest["services"].get("update")
	if not (update is Dictionary) or not PKeyClaims.is_true(update.get("enabled")):
		return ""
	var endpoints = update.get("endpoints")
	var base = endpoints.get("appcast") if endpoints is Dictionary else null
	if not _nonempty(base) or not (base.begins_with("https://") or base.begins_with("http://")):
		return ""
	var url: String = base
	var fragment := ""
	var at := url.find("#")
	if at >= 0:
		fragment = url.substr(at)
		url = url.substr(0, at)
	var query := ""
	var q := url.find("?")
	if q >= 0:
		query = url.substr(q + 1)
		url = url.substr(0, q)
	if channel != "" and channel != PKeyConstants.CHANNEL_STABLE and url.ends_with("/appcast.xml"):
		url = url.trim_suffix("/appcast.xml") + "/%s/appcast.xml" % PKeyUri.component(channel)
	if arch != "":
		query = _set_param(query, "arch", PKeyUri.form(arch))
	return url + ("?" + query if query != "" else "") + fragment


## URLSearchParams.set over a raw query: the first `name` pair takes the value, later ones go,
## and a missing one is appended. Other pairs are kept as written (the Worker publishes none).
static func _set_param(query: String, name: String, encoded: String) -> String:
	var out := PackedStringArray()
	var done := false
	for pair in query.split("&", false):
		if pair.get_slice("=", 0) == name:
			if not done:
				out.append("%s=%s" % [name, encoded])
				done = true
			continue
		out.append(pair)
	if not done:
		out.append("%s=%s" % [name, encoded])
	return "&".join(out)
