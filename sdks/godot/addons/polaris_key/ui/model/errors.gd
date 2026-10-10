extends RefCounted
## Error → copy key mapping over the core copy (`core.*` in the kit tables): the port of
## ui-core's `errors.ts`. A view names the keys; the copy layer formats them and, for a code the
## catalog does not describe, shows the catalog's fallback sentence (DL7), never a raw code.

## The fallback pair for an error the catalog does not name.
const FALLBACK_COPY := ["core.fallback.title", "core.fallback.message"]

## The activation results `core.activation` describes (copy.en.json `activation`).
const ACTIVATION_KINDS := [
	"ok", "device-limit", "fingerprint-required", "hardware-mismatch", "enroll-claimed",
	"license-disabled", "license-expired", "attestation-required", "rate-limited", "unauthorized",
	"enroll-disabled", "key-entry-limit", "refused", "error",
]

## Wire codes whose refusal `core.activation` describes under another name.
const CODE_KIND := {"key_entry_limit": "key-entry-limit", "device_limit": "device-limit"}


## The title and message of a `core.codes` code, or the fallback pair without one.
static func code_copy(code: Variant) -> Array:
	if code is String and not (code as String).is_empty():
		return ["core.codes.%s.title" % code, "core.codes.%s.message" % code]
	return FALLBACK_COPY.duplicate()


## The copy for an activation result: a `refused` or `error` result that carries a code takes the
## code's own copy (`license_owned` never names the holder, S-16); every other result its
## `core.activation` pair.
static func activation_copy(result: String, code: Variant = null) -> Array:
	if (result == "refused" or result == "error") and code is String and not (code as String).is_empty():
		var kind = CODE_KIND.get(code)
		if kind != null:
			return ["core.activation.%s.title" % kind, "core.activation.%s.message" % kind]
		return code_copy(code)
	if ACTIVATION_KINDS.has(result):
		return ["core.activation.%s.title" % result, "core.activation.%s.message" % result]
	return FALLBACK_COPY.duplicate()


## The title and message of a license status (`core.gate`).
static func gate_copy(status: String) -> Array:
	return ["core.gate.%s.title" % status, "core.gate.%s.message" % status]
