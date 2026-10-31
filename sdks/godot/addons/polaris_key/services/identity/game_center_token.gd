class_name PKeyGameCenterToken
extends RefCounted
## The `gc1.` Game Center token (WIRE-CONTRACT-V5 §12.11.7, I-48.6b): the exchange's subject token for
## kind `gamecenter`, built here from the raw parts the Game Center extension returns (Q-5), so the
## transcripts prove the encoder that ships.
##
##   gc1.<publicKeyUrl>.<signature>.<salt>.<timestamp>.<teamPlayerId>.<bundleId>
##
## Every field but the timestamp is base64url without padding over its bytes (the URL, the team player
## id and the bundle id as UTF-8; `signature` and `salt` arrive as canonical base64url already). The
## timestamp is plain decimal, as Game Center returns it (milliseconds). The whole token is at most
## 4096 characters. The token is bearer material for two minutes: never print it.

const PREFIX := "gc1"
const MAX_LENGTH := 4096


## The token for `fields` ({publicKeyUrl, signature, salt, timestamp, teamPlayerId, bundleId}), or ""
## when a field is missing, empty, not canonical base64url (`signature`, `salt`), not a whole
## non-negative number (`timestamp`: a decimal string or a number), or the token is too long.
static func encode(fields: Dictionary) -> String:
	var url = fields.get("publicKeyUrl")
	var team = fields.get("teamPlayerId")
	var bundle = fields.get("bundleId")
	if not (url is String) or not (team is String) or not (bundle is String) or url == "" or team == "" or bundle == "":
		return ""
	var signature = fields.get("signature")
	var salt = fields.get("salt")
	for part in [signature, salt]:
		if not (part is String) or part == "" or not PKeyB64Url.is_canonical(part):
			return ""
	var stamp := _timestamp(fields.get("timestamp"))
	if stamp == "":
		return ""
	var token := ".".join([
		PREFIX, _text(url), signature, salt, stamp, _text(team), _text(bundle),
	])
	return token if token.length() <= MAX_LENGTH else ""


static func _text(value: String) -> String:
	return PKeyB64Url.encode(value.to_utf8_buffer())


## The decimal spelling of a timestamp (a string of digits, or a whole non-negative number), else "".
static func _timestamp(value: Variant) -> String:
	if value is String:
		return value if value.is_valid_int() and not value.begins_with("-") and not value.begins_with("+") and (value == "0" or not value.begins_with("0")) else ""
	if value is int:
		return str(value) if value >= 0 else ""
	if value is float and value >= 0.0 and value == floorf(value) and value < 9007199254740992.0:
		return str(int(value))
	return ""
