extends RefCounted
# @pkey-feature license.signedinuser
# SP-54b: PolarisKey.license.get_license_user() reads `profile.user` off the verified document with
# client-core's total rule. The corpus rows replay in suite_conformance (licenseUserCases); these
# pin the reader's totality over any value and the key-activated case.

const SUBJECT := "ps_aaaaaaaaaaaaaaaaaaaaaa"


func run(t: PKeyTestContext) -> void:
	t.check("a valid subject is read", PKeyLicense.license_user_of({"profile": {"user": {"subject": SUBJECT, "extra": 1}}}) == {"subject": SUBJECT})
	var bad: Array = [
		null, "x", [], {}, {"profile": null}, {"profile": "x"}, {"profile": {}},
		{"profile": {"user": null}}, {"profile": {"user": []}}, {"profile": {"user": SUBJECT}},
		{"profile": {"user": {}}}, {"profile": {"user": {"subject": 7}}},
		{"profile": {"user": {"subject": "ps_aaaaaaaaaaaaaaaaaaaaa"}}},
		{"profile": {"user": {"subject": "ps_aaaaaaaaaaaaaaaaaaaaaaa"}}},
		{"profile": {"user": {"subject": SUBJECT + "\n"}}},
		{"profile": {"user": {"subject": "ps_" + "é".repeat(22)}}},
		{"profile": {"user": {"subject": "us_aaaaaaaaaaaaaaaaaaaaaa"}}},
	]
	for i in bad.size():
		t.check("malformed or absent reads null (%d)" % i, PKeyLicense.license_user_of(bad[i]) == null)
	# A key-activated device: the holder's email, no user.
	t.check("holder email without user is not signed in", PKeyLicense.license_user_of({"profile": {"name": "N", "email": "holder@x.io"}}) == null)
