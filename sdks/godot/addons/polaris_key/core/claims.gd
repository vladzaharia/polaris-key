class_name PKeyClaims
extends RefCounted
## Wire constants (WIRE-CONTRACT-V3 §1–§3; client-core `claims.ts`, shared-protocol `core.ts`).
## Normative: identical in every implementation.

const PROTOCOL_VERSION := 3
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
