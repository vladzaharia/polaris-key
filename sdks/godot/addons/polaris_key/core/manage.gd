class_name PKeyManage
extends RefCounted
## Refusal links (PX-W8, WIRE-CONTRACT-V4 §5.3): the `manageUrl` the Worker puts on the
## `device_limit` (and, with Identity, `key_entry_limit`) refusal, and the two things a client may
## add to it.
##
## Pure functions: no I/O, no signing, no change to any result type. The link is never an auth
## failure, so nothing here wipes state or asks for a retry; a game opens it only behind a player
## action ("Replace a device"). Every SDK pins the same table of cases (client-core
## `test/manage.test.ts`), so the links each one builds are byte-identical.

## The longest `manageUrl` a client keeps (characters); a longer one is ignored.
const MAX_LENGTH := 2048

const _LOOPBACK := ["localhost", "127.0.0.1", "[::1]", "::1"]


## [scheme, host, path] of a link a client may show, or [] when it is not one: an absolute
## `https` URL (or `http` to a loopback host) with a host, no userinfo, no whitespace or control
## characters, at most MAX_LENGTH characters.
static func _parse(raw: String) -> Array:
	if raw.is_empty() or raw.length() > MAX_LENGTH:
		return []
	for i in raw.length():
		var c := raw.unicode_at(i)
		if c <= 0x20 or c == 0x7F or c == 0x85 or c == 0xA0 or c == 0x1680 or (c >= 0x2000 and c <= 0x200A) or c == 0x2028 or c == 0x2029 or c == 0x202F or c == 0x205F or c == 0x3000 or c == 0xFEFF:
			return []
	var sep := raw.find("://")
	if sep <= 0:
		return []
	var scheme := raw.substr(0, sep).to_lower()
	var rest := raw.substr(sep + 3)
	var end := rest.length()
	for d in ["/", "?", "#"]:
		var at := rest.find(d)
		if at != -1 and at < end:
			end = at
	var authority := rest.substr(0, end)
	if authority.contains("@") or authority.contains("\\"):
		return []
	var host := authority
	if host.begins_with("["):
		var close := host.find("]")
		if close == -1:
			return []
		host = host.substr(0, close + 1)
	elif host.contains(":"):
		host = host.substr(0, host.rfind(":"))
	host = host.to_lower()
	if host.is_empty():
		return []
	var tail := rest.substr(end)
	var path_end := tail.length()
	for d in ["?", "#"]:
		var at := tail.find(d)
		if at != -1 and at < path_end:
			path_end = at
	var path := tail.substr(0, path_end)
	if scheme == "https" or (scheme == "http" and host in _LOOPBACK):
		return [scheme, host, path]
	return []


## Is `raw` a link a client may show?
static func is_valid(raw: Variant) -> bool:
	return raw is String and not _parse(raw).is_empty()


## The `manageUrl` of a refusal body: the top-level member, else one nested under `error`, or
## null. Anything that is not a valid link is dropped, never repaired.
static func read(body: Variant) -> Variant:
	if not body is Dictionary:
		return null
	if is_valid(body.get("manageUrl")):
		return body["manageUrl"]
	var nested = body.get("error")
	if nested is Dictionary and is_valid(nested.get("manageUrl")):
		return nested["manageUrl"]
	return null


## `path?query` with every earlier `name` pair dropped and `name=value` appended; the other pairs
## are kept byte for byte.
static func _append_param(target: String, name: String, encoded: String) -> String:
	var q := target.find("?")
	var path := target if q == -1 else target.substr(0, q)
	var kept: Array[String] = []
	if q != -1:
		for p in target.substr(q + 1).split("&", false):
			if p != name and not p.begins_with(name + "="):
				kept.append(p)
	kept.append("%s=%s" % [name, encoded])
	return "%s?%s" % [path, "&".join(kept)]


## Add the app's return URL as `return=`: inside the fragment's query when the fragment holds a
## portal route (`#/…`), else in the URL's query. An earlier `return` is replaced. `url` comes
## back unchanged when it is not a valid link or `return_url` is empty.
static func with_return(url: String, return_url: String) -> String:
	if _parse(url).is_empty() or return_url.is_empty():
		return url
	var encoded := PKeyUri.form(return_url)
	var h := url.find("#")
	var base := url if h == -1 else url.substr(0, h)
	if h != -1:
		var fragment := url.substr(h + 1)
		if fragment.begins_with("/"):
			return "%s#%s" % [base, _append_param(fragment, "return", encoded)]
		return "%s#%s" % [_append_param(base, "return", encoded), fragment]
	return _append_param(base, "return", encoded)


## Add the licence key as the fragment `#key=<key>` on an `/activate` link. Any other link (the
## free-device route) or an invalid one comes back unchanged: the key is never put anywhere else,
## and a fragment never reaches a server.
static func with_key(url: String, key: String) -> String:
	var parsed := _parse(url)
	if parsed.is_empty() or key.is_empty():
		return url
	var path: String = parsed[2]
	while path.ends_with("/"):
		path = path.substr(0, path.length() - 1)
	if path != "/activate":
		return url
	var h := url.find("#")
	if h != -1 and url.substr(h + 1).begins_with("/"):
		return url
	var base := url if h == -1 else url.substr(0, h)
	return "%s#key=%s" % [base, PKeyUri.form(key)]
