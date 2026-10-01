extends RefCounted
# @pkey-feature license.channels license.gate
# PKeyChannel against WIRE-CONTRACT-V3 §5.1 (the Worker's core/channels.ts), and the
# X-PKey-Channel this SDK sends: the canonical name, `dev` for 0.0.0-dev* builds, `pr` for PR
# builds, never `staging`; configure refuses a malformed value.

## version -> the channel it implies (rule 2).
const IMPLIED := {
	"2.0.0": "stable",
	"2.0.0-beta.1": "stable",
	"0.0.0-dev+abc": "dev",
	"0.0.0-beta.3": "beta",
	"0.0.0-staging.1": "beta",
	"0.0.0-pr-42+sha": "pr-42",
	"0.0.0-pr7": "pr-7",
	"0.0.0-pr-12345678": "pr",
	"0.0.0-prfoo": "stable",
}

## [header, version, normalised or null] (rule 3).
const HEADERS := [
	["stable", "2.0.0", "stable"],
	["latest", "2.0.0", "stable"],
	["beta", "2.0.0", "beta"],
	["staging", "2.0.0", "beta"],
	["dev", "2.0.0", "dev"],
	["pr", "0.0.0-pr-42", "pr-42"],
	["pr", "2.0.0", "pr"],
	["pr-7", "2.0.0", "pr-7"],
	["pr7", "2.0.0", "pr-7"],
	["pr-12345678", "2.0.0", "pr"],
	["nightly", "2.0.0", "nightly"],
	["constructor", "2.0.0", "constructor"],
	["STAGING", "2.0.0", null],
	["beta\n", "2.0.0", null],
	[" beta", "2.0.0", null],
	["", "2.0.0", null],
	["-beta", "2.0.0", null],
	["a234567890123456789012345678901234567890123456789012345678901234", "2.0.0", "a234567890123456789012345678901234567890123456789012345678901234"],
	["a2345678901234567890123456789012345678901234567890123456789012345", "2.0.0", null],
]

## [granted, channel, entitled] (rule 4).
const ENTITLED := [
	[[], "stable", true],
	[["beta"], "beta", true],
	[["staging"], "beta", true],
	[["beta"], "staging", false],
	[["pr"], "pr-42", true],
	[["pr-42"], "pr-7", false],
	[["pr"], "pr", true],
	[["stable"], "dev", false],
	[["dev"], "dev", true],
	[["beta"], "nightly", false],
	[["nightly"], "nightly", true],
	[["beta"], "staging-manual", false],
]

## [default_channel, version, sent or null (refused)].
const SENT := [
	["", "1.0.0", "stable"],
	["", "0.0.0-dev.4", "dev"],
	["", "0.0.0-beta.2", "beta"],
	["", "0.0.0-staging.2", "beta"],
	["", "0.0.0-pr-42", "pr"],
	["staging", "1.0.0", "beta"],
	["latest", "1.0.0", "stable"],
	["pr", "0.0.0-pr-42", "pr"],
	["pr42", "1.0.0", "pr-42"],
	["beta", "1.0.0", "beta"],
	["nightly", "1.0.0", "nightly"],
	["dev", "1.0.0", "dev"],
	["Beta", "1.0.0", null],
	["beta ", "1.0.0", null],
	["be_ta", "1.0.0", null],
]


func run(t: PKeyTestContext) -> void:
	for v in IMPLIED:
		t.check("channel: %s implies %s" % [v, IMPLIED[v]], PKeyChannel.implied(v) == IMPLIED[v], PKeyChannel.implied(v))
	for row in HEADERS:
		var got = PKeyChannel.normalize_header(row[0], row[1])
		t.check("channel: header %s on %s -> %s" % [JSON.stringify(row[0]), row[1], str(row[2])], typeof(got) == typeof(row[2]) and got == row[2], str(got))
	for row in ENTITLED:
		t.check("channel: %s covers %s = %s" % [JSON.stringify(row[0]), row[1], row[2]], PKeyChannel.entitled(row[0], row[1]) == row[2])
	for row in SENT:
		var got = PKeyChannel.header_for(row[0], row[1])
		t.check("channel: default_channel %s on %s sends %s" % [JSON.stringify(row[0]), row[1], str(row[2])], typeof(got) == typeof(row[2]) and got == row[2], str(got))
	await _configure(t)


func _configure(t: PKeyTestContext) -> void:
	var h := PKeyLicenseTestSupport.new()
	if not t.check("channel: fixtures present", h.ready()):
		return
	var sdk = await h.sdk(PKeyMemoryStore.new(h.F["device_id"]), PackedStringArray(), func(o: PKeyOptions): o.default_channel = "STAGING")
	t.check("channel: configure refuses a malformed default_channel", sdk.core == null)
	var o := PKeyTestFixtures.options(h.server.base_url(), PKeyMemoryStore.new(), [0], "djdl", {}, "1.0.0")
	o.default_channel = "beta\n"
	var r: PKeyResult = sdk.configure(o)
	t.check("channel: configure's refusal is invalid-options", r.code == PKeyErrors.INVALID_OPTIONS, str(r))
	sdk.queue_free()
	for row in [["", "0.0.0-dev.4", "dev"], ["staging", "1.0.0", "beta"], ["", "0.0.0-staging.9", "beta"], ["", "0.0.0-pr-42+sha", "pr"]]:
		h.server.requests.clear()
		h.plan = {"/license/activate": [PKeyLicenseTestSupport.json(401, {"error": "unauthorized"})]}
		var s = await h.sdk(PKeyMemoryStore.new(h.F["device_id"]), PackedStringArray(), func(opts: PKeyOptions): opts.default_channel = row[0], row[1])
		await s.license.activate_with_key("pkey_djdl_key")
		var reqs: Array = h.requests("POST", "/license/activate")
		var sent: String = reqs[0]["headers"].get("x-pkey-channel", "") if reqs.size() == 1 else "<none>"
		t.check("channel: %s on %s sends X-PKey-Channel %s" % [JSON.stringify(row[0]), row[1], row[2]], sent == row[2], sent)
		s.queue_free()
	h.free_server()
