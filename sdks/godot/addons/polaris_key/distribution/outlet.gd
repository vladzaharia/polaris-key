class_name PKeyOutlet
extends RefCounted
## Outlet detection (plans/P3-01.md §2.9 "Detection", §4.7): a port of client-core `outlet.ts`,
## pinned row for row by `outlet-matrix.json` (the conformance suite's detection section).
##
##   detect_outlet(stamp, signals)   {kind, confidence, source, subkind}
##   detection_stamp(stamp)          the build stamp as detection reads it, or null
##
## "Where did this install come from?" The signals a runtime observed (PKeyOutletSignals reads
## them) and the build stamp map to an outlet kind with a confidence (attested, declared,
## heuristic, stamp) and the one signal that decided (`source`, or "stamp"). The result never
## goes straight into the decision: PKeyUpdate passes it to PKeyDecision.resolve_update_outlet as
## `detected` (§2.8), where PKeyOptions.update_outlet always wins. Detection chooses an outlet;
## it never widens what that outlet may do.
##
## PURE: no OS, file or network call, and nothing throws. A malformed signal value is no
## evidence. The tables are static vars, not consts (thread-reachable code never indexes a const
## Array; README "Writing GDScript here").

const UNKNOWN := "unknown"
const MARKETPLACE := "marketplace:"

## The 25 signals in vocabulary order, each [signal, confidence]; confidence null for the two
## diagnostic signals, which are recorded and never count (`outlet-matrix.json#/signals`).
static var OUTLET_SIGNALS := [
	["ios.appDistributor", "attested"],
	["ios.bundleIdRewrite", "declared"],
	["ios.provisioningProfile", "heuristic"],
	["macos.masReceipt", "attested"],
	["macos.receiptSandbox", "attested"],
	["macos.signingLeaf", "attested"],
	["macos.homebrewCask", "heuristic"],
	["macos.homebrewFormula", "heuristic"],
	["windows.packageIdentity", "attested"],
	["windows.signatureKind", "attested"],
	["windows.appInstallerUri", "attested"],
	["windows.externalLocation", "attested"],
	["windows.pathConvention", "heuristic"],
	["linux.flatpakInfo", "attested"],
	["linux.snapEnv", "declared"],
	["linux.appImageEnv", "declared"],
	["steam.libraryManifest", "declared"],
	["steam.appIdEnv", "heuristic"],
	["steam.appIdFile", null],
	["itch.receipt", "declared"],
	["itch.appEnv", null],
	["android.installSource", "declared"],
	["android.installerMismatch", "declared"],
	["web.displayMode", "heuristic"],
	["node.packageManager", "heuristic"],
]

## The platform facts detection reads (`outlet-matrix.json#/platformData`, less the listing
## prefixes, which are PKeyDecision.LISTING_URL_PREFIXES). The digest and marketplace lists stay
## empty until P5-06 and P5-05 record them.
static var PLATFORM_DATA := {
	"playStoreCertSha256s": [],
	"altStorePalMarketplaceIds": [],
	"playPackages": ["com.android.vending"],
	"obtainiumPackages": ["dev.imranr.obtainium", "dev.imranr.obtainium.fdroid"],
	"fdroidClientPackages": ["org.fdroid.fdroid", "com.looker.droidify", "com.machiav3lli.fdroid"],
	"systemInstallerPackages": ["com.google.android.packageinstaller", "com.android.packageinstaller"],
	"macosStoreLeaves": {
		"Apple Mac OS Application Signing": "app-store",
		"TestFlight Beta Distribution": "testflight",
	},
	"deadlineMs": 2000,
}

## The synthesised stamp of a Godot web export (§2.9): `web` by construction.
static var WEB_STAMP := {"outletKind": "web", "subkind": null, "outletIds": {}}

static var _windows_gated := PackedStringArray(["windows.packageIdentity", "windows.signatureKind", "windows.appInstallerUri", "windows.externalLocation"])


## `{kind: "unknown", confidence: null, source: null, subkind: null}`, fresh each time.
static func unknown() -> Dictionary:
	return {"kind": UNKNOWN, "confidence": null, "source": null, "subkind": null}


## The detection stamp of a build stamp (P1-11's {outlet, outletKind?, outletSubkind?,
## outletIds?}): the kind as resolve_update_outlet reads it (outletKind, else outlet; a kind
## outside the 17 is no kind), the subkind when it is one of the 8, and the string identities.
## null when the stamp names no kind.
static func detection_stamp(stamp: Variant) -> Variant:
	if not (stamp is Dictionary):
		return null
	var raw_kind = stamp["outletKind"] if stamp.has("outletKind") else stamp.get("outlet")
	if not PKeyDecision.is_kind(raw_kind):
		return null
	var ids := {}
	var raw_ids = stamp.get("outletIds")
	if raw_ids is Dictionary:
		for k in raw_ids:
			if k is String and raw_ids[k] is String:
				ids[k] = raw_ids[k]
	var sub = stamp["outletSubkind"] if stamp.has("outletSubkind") else stamp.get("subkind")
	return {"outletKind": raw_kind, "subkind": sub if PKeyDecision.is_subkind(sub) else null, "outletIds": ids}


static func _field(signals: Dictionary, s: String, key: String) -> Variant:
	var o = signals.get(s)
	return o.get(key) if o is Dictionary else null


static func _has_field(signals: Dictionary, s: String, key: String) -> bool:
	var o = signals.get(s)
	return o is Dictionary and o.has(key)


## True when the stamp declares identity `key` and `value` is that string. A missing identity
## never matches (null == null is not a match).
static func _names(ids: Dictionary, key: String, value: Variant) -> bool:
	var want = ids.get(key)
	return want is String and value is String and value == want


static func _identity_holds(s: String, signals: Dictionary, ids: Dictionary) -> bool:
	match s:
		"ios.bundleIdRewrite":
			return _names(ids, "bundleId", _field(signals, s, "altBundleIdentifier"))
		"macos.receiptSandbox":
			return signals.get("macos.masReceipt") is bool and signals["macos.masReceipt"] == true
		"macos.homebrewCask":
			return _names(ids, "caskToken", signals.get(s))
		"macos.homebrewFormula":
			return _names(ids, "homebrewFormula", signals.get(s))
		"linux.flatpakInfo":
			return _names(ids, "flatpakId", signals.get(s))
		"linux.snapEnv":
			return _names(ids, "snapName", _field(signals, s, "name"))
		"linux.appImageEnv":
			var exe = _field(signals, s, "exePath")
			var dir = _field(signals, s, "appDir")
			return exe is String and dir is String and exe.begins_with(dir)
		"steam.libraryManifest":
			return _names(ids, "steamAppId", signals.get(s))
		"steam.appIdEnv":
			return _names(ids, "steamAppId", _field(signals, s, "appId"))
		"itch.receipt":
			return _names(ids, "itchGameId", signals.get(s))
		"android.installSource":
			if not (_has_field(signals, s, "installer") and _has_field(signals, s, "initiator")):
				return false
			var installer = _field(signals, s, "installer")
			var initiator = _field(signals, s, "initiator")
			if installer == null and initiator == null:
				return true
			return installer is String and initiator is String and installer == initiator
		"node.packageManager":
			var m = _field(signals, s, "packageMatch")
			return m is bool and m == true
	if _windows_gated.has(s):
		return _names(ids, "msixFamilyName", signals.get("windows.packageIdentity"))
	return true


static func _is_true(v: Variant) -> bool:
	return v is bool and v == true


## `binaryUpdates`'s width of a kind narrowed by a subkind (no platform): 0 none, 1 store, 2 self.
static func _width(kind: String, subkind: Variant) -> int:
	var caps := PKeyDecision.effective_capabilities(kind, {"platform": "", "subkind": subkind})
	return PKeyDecision.BINARY_UPDATES_ORDER.find(caps["binaryUpdates"])


## Detect the outlet from the build stamp (a detection stamp, or null) and the observed signals,
## in §2.9's five steps: filter (identity conditions, diagnostics), attested naming, the stamp,
## vetoes, then the restricting declared and heuristic signals.
static func detect_outlet(stamp: Variant, signals: Variant) -> Dictionary:
	var st = stamp if stamp is Dictionary and PKeyDecision.is_kind(stamp.get("outletKind")) else null
	var sig: Dictionary = signals if signals is Dictionary else {}
	var ids: Dictionary = st["outletIds"] if st != null and st.get("outletIds") is Dictionary else {}
	var data := PLATFORM_DATA
	var evidence: Array = []
	# 1. Filter, and read each surviving signal's effect.
	for spec in OUTLET_SIGNALS:
		var signal_name: String = spec[0]
		var confidence = spec[1]
		if confidence == null or not sig.has(signal_name) or not _identity_holds(signal_name, sig, ids):
			continue
		var value = sig[signal_name]
		var e := {"signal": signal_name, "confidence": confidence, "names": null, "vetoes": []}
		match signal_name:
			"ios.appDistributor":
				if value is String:
					if value == "appStore":
						e["names"] = ["app-store", null]
					elif value == "testFlight":
						e["names"] = ["testflight", null]
					elif value == "web":
						e["names"] = ["direct", null]
					elif value.begins_with(MARKETPLACE):
						if (data["altStorePalMarketplaceIds"] as Array).has(value.substr(MARKETPLACE.length())):
							e["names"] = ["altstore-pal", null]
						else:
							e["vetoes"] = ["app-store", "testflight"]
			"ios.bundleIdRewrite":
				e["names"] = ["altstore", null]
			"ios.provisioningProfile":
				if _is_true(value):
					e["vetoes"] = ["app-store"]
			"macos.masReceipt":
				if _is_true(value):
					e["names"] = ["testflight" if _is_true(sig.get("macos.receiptSandbox")) else "app-store", null]
			"macos.signingLeaf":
				var leaves: Dictionary = data["macosStoreLeaves"]
				if value is String and leaves.has(value):
					e["names"] = [leaves[value], null]
				else:
					e["vetoes"] = ["app-store", "testflight"]
			"macos.homebrewCask", "macos.homebrewFormula":
				e["names"] = ["direct", "homebrew"]
			"windows.signatureKind":
				if value is String:
					if value == "Store":
						e["names"] = ["ms-store", null]
					elif value == "Developer" or value == "Enterprise":
						e["vetoes"] = ["ms-store"]
			"windows.appInstallerUri":
				if value != null:
					e["names"] = ["app-installer", null]
			"windows.pathConvention":
				if value is String:
					if value == "winget":
						e["names"] = ["winget", null]
					elif value == "scoop" or value == "chocolatey":
						e["names"] = ["direct", value]
			"linux.flatpakInfo":
				if st != null and st["outletKind"] == "direct" and st.get("subkind") is String and st["subkind"] == "flatpak":
					e["names"] = ["direct", "flatpak"]
				else:
					e["names"] = ["flathub", null]
			"linux.snapEnv":
				var rev = _field(sig, signal_name, "revision")
				if rev is String and rev.begins_with("x"):
					e["vetoes"] = ["snap"]
				else:
					e["names"] = ["snap", null]
			"linux.appImageEnv":
				e["names"] = ["direct", "appimage"]
			"steam.libraryManifest", "steam.appIdEnv":
				e["names"] = ["steam", null]
			"itch.receipt":
				e["names"] = ["itch", null]
			"android.installSource":
				var installer = _field(sig, signal_name, "installer")
				if installer is String and (data["playPackages"] as Array).has(installer):
					e["names"] = ["play", null]
					var digest = _field(sig, signal_name, "initiatorCertSha256")
					if digest is String and (data["playStoreCertSha256s"] as Array).has(digest):
						e["confidence"] = "attested"
				elif installer is String and (data["obtainiumPackages"] as Array).has(installer):
					e["names"] = ["obtainium", null]
				elif installer is String and (data["fdroidClientPackages"] as Array).has(installer):
					e["names"] = ["fdroid-repo", null]
				elif installer == null or (installer is String and (installer == "com.android.shell" or (data["systemInstallerPackages"] as Array).has(installer))):
					e["names"] = ["direct", null]
			"android.installerMismatch":
				if _is_true(value):
					e["vetoes"] = ["play", "play-testing"]
			"web.displayMode":
				e["names"] = ["web", null]
			"node.packageManager":
				var manager = _field(sig, signal_name, "manager")
				if manager is String and (manager == "npm" or manager == "pnpm" or manager == "npx"):
					e["names"] = ["direct", manager]
		evidence.append(e)

	# 2. Attested naming.
	var attested: Array = []
	for e in evidence:
		if e["confidence"] == "attested" and e["names"] != null:
			attested.append(e)
	if not attested.is_empty():
		var first: Dictionary = attested[0]
		var kind: String = first["names"][0]
		for e in attested:
			if e["names"][0] != kind:
				return unknown()
		if _vetoed(evidence, kind):
			return unknown()
		return {"kind": kind, "confidence": "attested", "source": first["signal"], "subkind": first["names"][1]}

	# 3. The stamp.
	if st == null:
		return unknown()
	var cur_kind: String = st["outletKind"]
	var cur_sub = st.get("subkind") if PKeyDecision.is_subkind(st.get("subkind")) else null

	# 4. Vetoes.
	if _vetoed(evidence, cur_kind):
		return unknown()

	# 5. Restricting signals: declared, then heuristic, each in vocabulary order.
	var ceiling := _width(cur_kind, cur_sub)
	for conf in ["declared", "heuristic"]:
		for e in evidence:
			if e["confidence"] != conf or e["names"] == null:
				continue
			var k: String = e["names"][0]
			var s = e["names"][1]
			if _width(k, s) > ceiling:
				continue
			return {"kind": k, "confidence": conf, "source": e["signal"], "subkind": s if s != null else (cur_sub if k == cur_kind else null)}
	return {"kind": cur_kind, "confidence": "stamp", "source": "stamp", "subkind": cur_sub}


static func _vetoed(evidence: Array, kind: String) -> bool:
	for e in evidence:
		if (e["vetoes"] as Array).has(kind):
			return true
	return false
