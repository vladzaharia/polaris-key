class_name PKeyClaims
extends RefCounted
## Wire constants (WIRE-CONTRACT-V4 §1–§3; client-core `claims.ts`, shared-protocol `core.ts`).
## Normative: identical in every implementation.

const PROTOCOL_VERSION := 4
## The fixed issuer (Amendment A1) — never derived from a base URL.
const ISSUER := "key.plrs.im"
## Tolerance on every clock comparison, in seconds.
const CLOCK_SKEW_SECONDS := 300
## `graceUntil <= issuedAt + MAX_GRACE_SECONDS` (365 days).
const MAX_GRACE_SECONDS := 31536000
## A 304 past `expiresAt - REFRESH_MARGIN_SECONDS` is re-asked unconditionally (§5).
const REFRESH_MARGIN_SECONDS := 1800
## The raised payload cap that travels with `pkey-bundle+jws` (§1).
const MAX_BUNDLE_BYTES := 262144

const TYP_LICENSE := "pkey-license+jws"
const TYP_CONFIG := "pkey-config+jws"
const TYP_TRUST := "pkey-trust+jws"
const TYP_BUNDLE := "pkey-bundle+jws"
## Wire contract v4 §2.3: the channel feed, signed by the product key.
const TYP_FEED := "pkey-feed+jws"
## Wire contract v4 §2.4: the release record, signed by a CI-held release key.
const TYP_RELEASE := "pkey-release+jws"

## Wire contract v4 §3: the largest integer claim, 2^53 − 1.
const MAX_WIRE_INTEGER := 9007199254740991


## WIRE-CONTRACT-V4 §3: an integer claim. Its pointer is not in the verified payload's
## `non_wire_integers` (so its token had no fraction or exponent part and at most 2^53 − 1 in
## its digits), and its value is a finite whole number from `minimum` to 2^53 − 1. The minimum
## is the claim's own: 0 for every timestamp, 1 for `schemaVersion` and every `seq`. Godot's
## parser is not correctly rounded, so the token rule, not the float, is what decides.
static func is_wire_integer(v: Variant, pointer: String, minimum: int, non_wire_integers: Dictionary) -> bool:
	if non_wire_integers.has(pointer):
		return false
	if not (v is float or v is int):
		return false
	var f := float(v)
	if not is_finite(f) or f != floorf(f):
		return false
	return f >= float(minimum) and f <= float(MAX_WIRE_INTEGER)


## WIRE-CONTRACT-V4 §3: true when `pattern` matches the WHOLE of `value`, with nothing after
## the match (a line terminator included). The pattern is wrapped in `\A(?:…)\z`; every class
## in it must be ASCII. Python (`_full_match`) and Swift (`wholeMatches`) apply the same rule.
static func matches_whole(pattern: String, value: Variant) -> bool:
	if not (value is String):
		return false
	var re := RegEx.create_from_string("\\A(?:" + pattern + ")\\z")
	if re == null or not re.is_valid():
		return false
	var m := re.search(value)
	return m != null and m.get_start() == 0 and m.get_end() == (value as String).length()


## A JSON number. Godot's JSON makes every number a float; values this SDK built may be ints.
## Never test `typeof(v) == TYPE_INT` for a claim (notes/A2 §1.3).
static func is_number(v: Variant) -> bool:
	return v is float or v is int


## `v` is the boolean true. Never `v == true`: comparing a String with a bool is a runtime
## error in GDScript, and values read from JSON can be anything.
static func is_true(v: Variant) -> bool:
	return v is bool and v


## `v` is the boolean false.
static func is_false(v: Variant) -> bool:
	return v is bool and not v


## The current time in whole epoch seconds.
static func system_now() -> int:
	return int(floor(Time.get_unix_time_from_system()))
