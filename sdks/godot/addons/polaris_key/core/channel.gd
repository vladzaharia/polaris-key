class_name PKeyChannel
extends RefCounted
## The channel vocabulary (WIRE-CONTRACT-V3 §5.1), in one table built from the generated
## constants (PKeyConstants.CHANNEL_*, from `@polaris-key/protocol/core`). It mirrors the Worker's
## `core/channels.ts` function for function:
##
##   is_name(name)                  rule 1: `^[a-z0-9][a-z0-9-]{0,63}$`
##   implied(version)               rule 2: the build's channel, a PR build narrowed to `pr-<n>`
##   normalize_header(h, version)   rule 3: an `X-PKey-Channel` value as the gate reads it, or
##                                  null when malformed (the gate refuses it)
##   entitled(granted, channel)     rule 4: `stable` always; the exact name; `staging` also
##                                  covers `beta`; `pr` also covers every `pr-<n>`
##   granted(entitlements)          the `channels` entitlement's string values in order, raw, or
##                                  ["stable"] when absent or not an array (the Worker's
##                                  `entitledChannels`)
##   header_for(value, version)     what this SDK sends: the canonical name, never an alias
##
## Clients never compute the build gate (they record the Worker's 403); these exist so the
## header this SDK sends is one the server reads as intended, and so the conformance runner can
## port the server's gate over gate-matrix.json.

const LEGACY_BETA := "staging"

static var _name_re: RegEx
static var _pr_re: RegEx
static var _pr_n_re: RegEx
static var _pr_build_re: RegEx


static func _static_init() -> void:
	_name_re = RegEx.create_from_string(_anchored(PKeyConstants.CHANNEL_NAME_PATTERN))
	_pr_re = RegEx.create_from_string(_anchored(PKeyConstants.PR_CHANNEL_PATTERN))
	_pr_n_re = RegEx.create_from_string("\\Apr-[0-9]+\\z")
	_pr_build_re = RegEx.create_from_string("\\A0\\.0\\.0-pr-?([0-9]+)")


## A JS `^…$` pattern as PCRE `\A…\z`: PCRE's `$` also matches before a trailing newline, so
## "beta\n" would pass a literal port.
static func _anchored(js: String) -> String:
	var p := js
	if p.begins_with("^"):
		p = "\\A" + p.substr(1)
	if p.ends_with("$"):
		p = p.substr(0, p.length() - 1) + "\\z"
	return p


## §5.1 rule 1: the channel alphabet.
static func is_name(name: String) -> bool:
	return _name_re.search(name) != null


## `pr-<digits>`, or the `pr` family when the number is longer than PR_NUMBER_MAX_DIGITS.
static func _pr_channel(digits: String) -> String:
	return PKeyConstants.CHANNEL_PR if digits.length() > PKeyConstants.PR_NUMBER_MAX_DIGITS else "pr-%s" % digits


## §5.1 rule 2: PKeySemver.channel_for_version, with a PR build narrowed to its own `pr-<n>`.
static func implied(version: String) -> String:
	var family := PKeySemver.channel_for_version(version)
	if family != PKeyConstants.CHANNEL_PR:
		return family
	var m := _pr_build_re.search(version)
	return _pr_channel(m.get_string(1)) if m != null else PKeyConstants.CHANNEL_PR


## §5.1 rule 3: an `X-PKey-Channel` value as the gate reads it, or null when it is malformed.
static func normalize_header(header: String, version: String) -> Variant:
	if PKeyConstants.CHANNEL_ALIASES.has(header):
		return PKeyConstants.CHANNEL_ALIASES[header]
	if header == PKeyConstants.CHANNEL_PR:
		var narrowed := implied(version)
		return narrowed if _pr_n_re.search(narrowed) != null else PKeyConstants.CHANNEL_PR
	var pr := _pr_re.search(header)
	if pr != null:
		return _pr_channel(pr.get_string(1))
	return header if is_name(header) else null


## §5.1 rule 4: does the `channels` grant cover `channel`?
static func entitled(granted: Array, channel: String) -> bool:
	if channel == PKeyConstants.CHANNEL_STABLE:
		return true
	if granted.has(channel):
		return true
	if channel == PKeyConstants.CHANNEL_BETA and granted.has(LEGACY_BETA):
		return true
	return _pr_n_re.search(channel) != null and granted.has(PKeyConstants.CHANNEL_PR)


## The channels a signed `entitlements` map grants: the `channels` entry's string values, in
## order and as stored (not de-duplicated, aliases not rewritten), or ["stable"] when the entry
## is absent or its value is not an array. The Worker's `entitledChannels`.
static func granted(entitlements: Variant) -> Array:
	var e = entitlements.get("channels") if entitlements is Dictionary else null
	var value = e.get("value") if e is Dictionary else null
	if not (value is Array):
		return [PKeyConstants.CHANNEL_STABLE]
	var out: Array = []
	for v in value:
		if v is String:
			out.append(v)
	return out


## What this SDK sends as `X-PKey-Channel`: `value` (PKeyOptions.default_channel) when given,
## else the channel the version implies as a family (`dev`, `beta`, `pr`, `stable`; the server
## narrows a literal `pr` to the build's number). An alias is sent as its canonical name, so the
## SDK never sends `staging` or `latest`; `pr<n>` is sent as `pr-<n>`. Null when `value` is
## malformed, which `configure` refuses: the server would answer `channel-not-entitled`.
static func header_for(value: String, version: String) -> Variant:
	if value == "":
		return PKeySemver.channel_for_version(version)
	if value == PKeyConstants.CHANNEL_PR:
		return value
	return normalize_header(value, version)
