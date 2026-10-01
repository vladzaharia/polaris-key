extends RefCounted
# PKeySemver against client-core/src/semver.ts.

const ORDER := [
	["1.0.0", "1.0.1", -1],
	["1.10.0", "1.9.9", 1],
	["2.0.0", "2.0.0", 0],
	["1.0.0-alpha", "1.0.0", -1],
	["1.0.0", "1.0.0-rc.1", 1],
	["1.0.0-alpha", "1.0.0-alpha.1", -1],
	["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
	["1.0.0-beta.2", "1.0.0-beta.11", -1],
	["1.0.0-rc.1", "1.0.0-beta.11", 1],
	["1.0.0+build.5", "1.0.0+build.9", 0],
	["not-semver", "1.0.0", 0],
	["01.2.3", "1.2.3", 0],
]


func run(t: PKeyTestContext) -> void:
	for row in ORDER:
		t.check("semver compare %s %s" % [row[0], row[1]], PKeySemver.compare(row[0], row[1]) == row[2], "got %d" % PKeySemver.compare(row[0], row[1]))
	for bad in ["1.0", "v1.0.0", "1.0.0-", "1.0.0 ", "1.0.0\n", "", "1.0.0-a_b"]:
		t.check("semver refuses %s" % JSON.stringify(bad), not PKeySemver.is_valid(bad))
	t.check("semver parses a prerelease", PKeySemver.parse("1.2.3-rc.1+b") == {"major": 1.0, "minor": 2.0, "patch": 3.0, "prerelease": PackedStringArray(["rc", "1"])})
	var channels := {"1.0.0": "stable", "0.0.0-dev.3": "dev", "0.0.0-staging.1": "beta", "0.0.0-beta.2": "beta", "0.0.0-beta": "beta", "0.0.0-pr-12": "pr", "0.0.0-pr12": "pr", "0.0.0-prx": "stable"}
	for v in channels:
		t.check("semver channel %s" % v, PKeySemver.channel_for_version(v) == channels[v], PKeySemver.channel_for_version(v))
	t.check("semver dev build", PKeySemver.is_dev_build("0.0.0-dev") and not PKeySemver.is_dev_build("1.0.0-dev"))
