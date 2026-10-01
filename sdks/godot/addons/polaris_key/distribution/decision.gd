class_name PKeyDecision
extends RefCounted
## The update decision (plans/P3-01.md §2.8 and §2.9; WIRE-CONTRACT-V4 §11, informative): the
## "conformance-tested update function" of README §5.1, a port of client-core `decide.ts` pinned
## row for row by `update-matrix.json`.
##
##   rollout_bucket(salt, install_id)         u32_be(SHA-256(salt ‖ install_id)[0..4]) mod 10000
##   effective_capabilities(kind, opts)       the compiled defaults narrowed by platform, subkind
##                                            and the feed entry: {binaryUpdates, codeUpdates,
##                                            dataUpdates, channelSwitch, commerce,
##                                            downloadedScripts}
##   resolve_update_outlet(opts)              {id, kind, subkind}, or null for an invalid host
##   decide_update(input)                     the decision (a Dictionary, compared by value)
##   boot_decision(decision)                  "none" | "optional" (never "required" in v4)
##   is_undismissable(decision)               a prompt the player cannot dismiss
##
## PURE: no OS, file or network call happens here, and nothing throws. The service gathers the
## inputs (PolarisKey.update.decide()) and passes them in, so the runner drives every function on
## an exported template exactly as the game does. Input and output Dictionaries use the matrix's
## camelCase member names (`binaryVersion`, `skipVersion`, `discardStaged`, `listingUrl`), so a
## decision compares by value with `update-matrix.json` and the transcripts.
##
## The tables are static vars, not consts: thread-reachable code never indexes a const Array
## (4.4.1's shared read slot; README "Writing GDScript here").

const OUTLET_UNKNOWN := "unknown"
const ROLLOUT_BUCKETS := 10000

const BOOT_NONE := "none"
const BOOT_OPTIONAL := "optional"

## Who installs a new build, narrowest first.
static var BINARY_UPDATES_ORDER := PackedStringArray(["none", "store", "self"])

## OUTLET_CAPABILITY_DEFAULTS (plans/P3-01.md §2.9), per kind and for `unknown`. The suite holds
## it equal to `outlet-matrix.json#/kinds`.
static var CAPABILITY_DEFAULTS := {
	"direct": _caps("self", true, true, true, "own", true),
	"app-store": _caps("store", false, true, false, "store-iap", false),
	"testflight": _caps("store", false, true, false, "store-iap", false),
	"altstore": _caps("store", false, true, false, "own", false),
	"altstore-pal": _caps("store", false, true, false, "own", false),
	"play": _caps("store", false, true, false, "store-iap", false),
	"play-testing": _caps("store", false, true, false, "store-iap", false),
	"obtainium": _caps("store", false, true, false, "own", false),
	"fdroid-repo": _caps("store", false, true, false, "own", false),
	"ms-store": _caps("store", false, true, false, "store-iap", false),
	"app-installer": _caps("none", false, true, false, "own", false),
	"winget": _caps("none", false, true, false, "own", false),
	"steam": _caps("none", false, true, false, "steam", false),
	"itch": _caps("none", false, true, false, "own", false),
	"flathub": _caps("none", false, true, false, "own", false),
	"snap": _caps("none", false, true, false, "own", false),
	"web": _caps("none", false, true, false, "own", true),
	"unknown": _caps("none", false, false, false, "none", false),
}

## OUTLET_PLATFORMS: the platforms each kind serves (`unknown`: every platform).
static var OUTLET_PLATFORMS := {
	"direct": ["macos", "windows", "linux", "android", "ios"],
	"app-store": ["ios", "macos"],
	"testflight": ["ios", "macos"],
	"altstore": ["ios"],
	"altstore-pal": ["ios"],
	"play": ["android"],
	"play-testing": ["android"],
	"obtainium": ["android"],
	"fdroid-repo": ["android"],
	"ms-store": ["windows"],
	"app-installer": ["windows"],
	"winget": ["windows"],
	"steam": ["windows", "macos", "linux"],
	"itch": ["windows", "macos", "linux"],
	"flathub": ["linux"],
	"snap": ["linux"],
	"web": ["web"],
	"unknown": ["macos", "ios", "android", "windows", "linux", "web"],
}

## PLATFORM_NARROWING: on iOS a `direct` install is Web Distribution (S-07 row 13).
static var PLATFORM_NARROWING := {
	"ios": {"direct": {"binaryUpdates": "store", "codeUpdates": false, "downloadedScripts": false}},
}

## SUBKIND_NARROWING: a package manager or Flatpak updates the install; `appimage` narrows
## nothing.
static var SUBKIND_NARROWING := {
	"homebrew": {"binaryUpdates": "none", "codeUpdates": false},
	"npm": {"binaryUpdates": "none", "codeUpdates": false},
	"pnpm": {"binaryUpdates": "none", "codeUpdates": false},
	"npx": {"binaryUpdates": "none", "codeUpdates": false},
	"scoop": {"binaryUpdates": "none", "codeUpdates": false},
	"chocolatey": {"binaryUpdates": "none", "codeUpdates": false},
	"flatpak": {"binaryUpdates": "none", "codeUpdates": false},
	"appimage": {},
}

## LISTING_URL_PREFIXES: the only prefixes a feed's `listingUrl` may start with, per kind.
static var LISTING_URL_PREFIXES := {
	"app-store": ["https://apps.apple.com/", "itms-apps://apps.apple.com/"],
	"testflight": ["https://testflight.apple.com/join/"],
	"play": ["https://play.google.com/store/apps/details?id=", "market://details?id="],
	"play-testing": ["https://play.google.com/apps/testing/", "https://play.google.com/store/apps/details?id=", "market://details?id="],
	"ms-store": ["https://apps.microsoft.com/detail/", "ms-windows-store://pdp/?productid="],
}

static var _cap_booleans := PackedStringArray(["codeUpdates", "dataUpdates", "channelSwitch", "downloadedScripts"])
static var _kinds := PackedStringArray(PKeyConstants.OUTLET_KIND_VALUES)
static var _subkinds := PackedStringArray(PKeyConstants.OUTLET_SUBKIND_VALUES)
static var _outlet_id_re: RegEx


static func _static_init() -> void:
	_outlet_id_re = PKeyClaims.whole(PKeyFeed.OUTLET_ID_PATTERN)


static func _caps(binary: String, code: bool, data: bool, channel_switch: bool, commerce: String, scripts: bool) -> Dictionary:
	return {
		"binaryUpdates": binary,
		"codeUpdates": code,
		"dataUpdates": data,
		"channelSwitch": channel_switch,
		"commerce": commerce,
		"downloadedScripts": scripts,
	}


## The listing prefixes for `kind` (empty for a kind without any).
static func listing_url_prefixes(kind: String) -> PackedStringArray:
	return PackedStringArray(LISTING_URL_PREFIXES.get(kind, []))


static func is_kind(v: Variant) -> bool:
	return v is String and _kinds.has(v)


static func is_subkind(v: Variant) -> bool:
	return v is String and _subkinds.has(v)


static func _str_eq(a: Variant, b: Variant) -> bool:
	return a is String and b is String and a == b


# ── The rollout bucket (§2.8 "Bucket") ─────────────────────────────────────────────────────

## `u32_be(SHA-256(UTF-8(salt) ‖ UTF-8(install_id))[0..4]) mod 10000`: the feed's 32-character
## hex salt hashed as text, then the SDK's device id (the X-PKey-Device value), no separator; the
## first four digest bytes read big-endian as an UNSIGNED integer. Synchronous: the engine's
## HashingContext has SHA-256.
static func rollout_bucket(salt: String, install_id: String) -> int:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update((salt + install_id).to_utf8_buffer())
	var d := ctx.finish()
	var u32: int = (int(d[0]) << 24) | (int(d[1]) << 16) | (int(d[2]) << 8) | int(d[3])
	return u32 % ROLLOUT_BUCKETS


# ── Capabilities (§2.9 "Narrowing") ────────────────────────────────────────────────────────

## One narrowing: booleans AND, `binaryUpdates` the narrower of none < store < self, `commerce`
## only ever to `none`. A value outside its vocabulary is ignored; nothing widens.
static func _narrow(caps: Dictionary, n: Variant) -> Dictionary:
	if not (n is Dictionary):
		return caps
	var out := caps.duplicate()
	for key in _cap_booleans:
		if n.has(key) and n[key] is bool:
			out[key] = bool(out[key]) and bool(n[key])
	if n.has("binaryUpdates") and n["binaryUpdates"] is String:
		var k := BINARY_UPDATES_ORDER.find(n["binaryUpdates"])
		if k != -1 and k < BINARY_UPDATES_ORDER.find(out["binaryUpdates"]):
			out["binaryUpdates"] = BINARY_UPDATES_ORDER[k]
	if n.has("commerce") and _str_eq(n["commerce"], "none"):
		out["commerce"] = "none"
	return out


## The capabilities of an install: the compiled defaults for `kind` (`unknown` for a kind
## outside the 17), narrowed by the platform, then the subkind, then the feed entry's
## `capabilities`. `opts`: {platform, subkind?, server?}. The defaults are the ceiling
## (`update-matrix.json#/capabilityCases`).
static func effective_capabilities(kind: Variant, opts: Dictionary) -> Dictionary:
	var k: String = kind if kind is String and CAPABILITY_DEFAULTS.has(kind) else OUTLET_UNKNOWN
	var caps: Dictionary = CAPABILITY_DEFAULTS[k].duplicate()
	var platform = opts.get("platform")
	if platform is String and PLATFORM_NARROWING.has(platform) and kind is String and PLATFORM_NARROWING[platform].has(kind):
		caps = _narrow(caps, PLATFORM_NARROWING[platform][kind])
	var subkind = opts.get("subkind")
	if subkind is String and SUBKIND_NARROWING.has(subkind):
		caps = _narrow(caps, SUBKIND_NARROWING[subkind])
	caps = _narrow(caps, opts.get("server"))
	return caps


# ── The decision's outlet (§2.8 "The outlet") ──────────────────────────────────────────────

## True when `host` is a valid host outlet option: a kind (`"steam"` reads as {id: "steam",
## kind: "steam"}), or {id, kind, subkind?}. The SDK refuses anything else as `invalid-options`
## at configure().
static func is_valid_host_outlet(host: Variant) -> bool:
	if host is String:
		return is_kind(host)
	if not (host is Dictionary):
		return false
	if not is_kind(host.get("kind")):
		return false
	if _outlet_id_re == null:
		_static_init()
	if not PKeyClaims.matches_whole_re(_outlet_id_re, host.get("id")):
		return false
	if host.has("subkind") and host["subkind"] != null:
		return is_subkind(host["subkind"])
	return true


## The decision's outlet, in §2.8's order: a host value wins; else the stamp's kind (its
## `outletKind`, or its `outlet` when it has none; a kind outside the 17 is no kind), moved by a
## detection result (P3-11) when there is one; else {id: null, kind: "unknown", subkind: null}.
## `opts`: {host?, stamp?, detected?}. null when `host` is present but invalid.
static func resolve_update_outlet(opts: Dictionary) -> Variant:
	var host = opts.get("host")
	if host != null:
		if not is_valid_host_outlet(host):
			return null
		if host is String:
			return {"id": host, "kind": host, "subkind": null}
		return {"id": host["id"], "kind": host["kind"], "subkind": host.get("subkind")}
	var stamp: Dictionary = opts["stamp"] if opts.get("stamp") is Dictionary else {}
	var raw_kind = stamp["outletKind"] if stamp.has("outletKind") else stamp.get("outlet")
	var kind = raw_kind if is_kind(raw_kind) else null
	if _outlet_id_re == null:
		_static_init()
	var id = stamp["outlet"] if PKeyClaims.matches_whole_re(_outlet_id_re, stamp.get("outlet")) else null
	var subkind = stamp["outletSubkind"] if is_subkind(stamp.get("outletSubkind")) else null
	var detected = opts.get("detected")
	if detected is Dictionary:
		var dk = detected.get("kind")
		var ds = detected.get("subkind")
		if _str_eq(dk, kind):
			return {"id": id, "kind": dk, "subkind": ds}
		return {"id": null, "kind": dk, "subkind": ds}
	if kind != null:
		return {"id": id, "kind": kind, "subkind": subkind}
	return {"id": null, "kind": OUTLET_UNKNOWN, "subkind": null}


# ── The decision (§2.8 "Algorithm") ────────────────────────────────────────────────────────

## The feed's target for `platform`, or null.
static func feed_target(targets: Variant, platform: Variant) -> Variant:
	if not (targets is Array):
		return null
	for t in targets:
		if t is Dictionary and _str_eq(t.get("platform"), platform):
			return t
	return null


## The install's entry in a target (§2.8 step 3): `outlets[outlet.id]` when that entry's kind is
## the outlet's kind; otherwise the ONE entry of that kind, if exactly one has it; otherwise
## none. `unknown` never has an entry. A host computes the rollout bucket from this entry's salt.
static func outlet_entry(target: Variant, outlet: Dictionary) -> Variant:
	if not (target is Dictionary) or not (target.get("outlets") is Dictionary):
		return null
	var kind = outlet.get("kind")
	if not (kind is String) or kind == OUTLET_UNKNOWN:
		return null
	var outlets: Dictionary = target["outlets"]
	var id = outlet.get("id")
	if id is String and outlets.has(id) and outlets[id] is Dictionary and _str_eq(outlets[id].get("kind"), kind):
		return outlets[id]
	var of_kind: Array = []
	for k in outlets:
		if outlets[k] is Dictionary and _str_eq(outlets[k].get("kind"), kind):
			of_kind.append(outlets[k])
	return of_kind[0] if of_kind.size() == 1 else null


static func _arch_rank(b: Dictionary, arch: String) -> int:
	if _str_eq(b.get("arch"), arch):
		return 0
	return 1 if _str_eq(b.get("arch"), "universal") else 2


## The device's own arch before `universal`, `universal` before `any`; ties by build id in
## ascending byte order (build ids are ASCII by BUILD_ID_PATTERN).
static func _pick_build(builds: Array, arch: String) -> Variant:
	var best = null
	for b in builds:
		if best == null:
			best = b
			continue
		var r := _arch_rank(b, arch) - _arch_rank(best, arch)
		if r < 0 or (r == 0 and PKeyVersion.compare_ascii(b["id"], best["id"]) < 0):
			best = b
	return best


## §2.8 "Eligible builds": exactly one `payload` artifact, the installed platform, and the
## device's arch, `universal` or `any`. A `requires.engine` that is not a string, or a
## `requires.minBinary` that does not parse under the feed's scheme, is never eligible.
static func _eligible(b: Variant, platform: String, arch: String, scheme: String) -> bool:
	if not (b is Dictionary) or not (b.get("artifacts") is Array):
		return false
	var payloads := 0
	for a in b["artifacts"]:
		if a is Dictionary and _str_eq(a.get("role"), "payload"):
			payloads += 1
	if payloads != 1:
		return false
	if not _str_eq(b.get("platform"), platform):
		return false
	if not (_str_eq(b.get("arch"), arch) or _str_eq(b.get("arch"), "universal") or _str_eq(b.get("arch"), "any")):
		return false
	var req = b.get("requires")
	if req is Dictionary:
		if req.has("engine") and not (req["engine"] is String):
			return false
		if req.has("minBinary") and (not (req["minBinary"] is String) or PKeyVersion.parse_version(scheme, req["minBinary"]) == null):
			return false
	return true


## The update decision (plans/P3-01.md §2.8): the first of eleven rules that applies decides.
## `input` is `update-matrix.json`'s row input: {now, feed, record, installed: {version,
## binaryVersion?, buildNumber, platform, arch, format, engine}, outlet: {id, kind}, subkind,
## staged: {version, channel} or null, skipVersion, bucket, methods}. Synchronous and total; each
## answer has exactly the members §2.8's output table lists:
##   none      {action, reason, behind, discardStaged}
##   code-ready {action, release: {version, seq, sha256}, critical, discardStaged}
##   binary    {action, method, release: {version, seq, sha256}, build, mandatory, critical,
##              prestage: [], discardStaged}
##   store     {action, release: {version, seq}, listingUrl, mandatory, critical, discardStaged}
##   platform  {action, release: {version, seq}, mandatory, critical, discardStaged}
##   blocked   {action, reason, discardStaged}
static func decide_update(input: Dictionary) -> Dictionary:
	var feed: Dictionary = input["feed"]
	var app: Dictionary = feed["app"]
	var scheme: String = app["versionScheme"]
	var staged = input.get("staged")
	if not (staged is Dictionary):
		staged = null
	var installed: Dictionary = input["installed"]
	var outlet: Dictionary = input["outlet"]
	var record = input.get("record")

	# 1. Stale: freeze, and keep what is staged.
	if float(input["now"]) >= float(feed["expiresAt"]) + PKeyClaims.CLOCK_SKEW_SECONDS:
		return {"action": "none", "reason": "stale", "behind": false, "discardStaged": false}

	# 2. Unknown version.
	var run = installed.get("version")
	var bin = installed.get("binaryVersion")
	if bin == null:
		bin = run
	if PKeyVersion.parse_version(scheme, run) == null or PKeyVersion.parse_version(scheme, bin) == null:
		return _none("unknown-version", staged)

	# 3. Setup.
	var platform: String = installed["platform"]
	var target = feed_target(app.get("targets"), platform)
	var entry = outlet_entry(target, outlet)
	var caps := effective_capabilities(outlet.get("kind"), {
		"platform": platform,
		"subkind": input.get("subkind"),
		"server": entry.get("capabilities") if entry is Dictionary else null,
	})
	var below_floor := false
	if target is Dictionary and target.get("floor") is Dictionary:
		var fc = PKeyVersion.compare_versions(scheme, bin, target["floor"].get("minVersion"))
		below_floor = fc != null and int(fc) < 0

	# 4. The offer.
	var offer = null
	if entry is Dictionary and target is Dictionary:
		if caps["binaryUpdates"] == "self":
			var live = entry.get("live")
			if live is Dictionary and float(live["seq"]) == float(target["release"]["seq"]) and record is Dictionary:
				offer = target["release"]
		else:
			offer = entry.get("live")
	if not (offer is Dictionary) or not (entry is Dictionary) or not (target is Dictionary):
		return _blocked(staged) if below_floor else _none("not-available", staged)

	# 5. Behind: no downgrade, and the floor is suppressed.
	var run_cmp = PKeyVersion.compare_versions(scheme, offer["version"], run)
	if run_cmp != null and int(run_cmp) < 0:
		return _none("behind", staged)

	# 6. Up to date.
	var bin_cmp = PKeyVersion.compare_versions(scheme, offer["version"], bin)
	var newer_run: bool = run_cmp != null and int(run_cmp) > 0
	var newer_bin: bool = bin_cmp != null and int(bin_cmp) > 0
	if not newer_run and not (below_floor and newer_bin):
		return _blocked(staged) if below_floor else _none("up-to-date", staged)

	# 7. Halted.
	if PKeyClaims.is_true(entry.get("halted")):
		return _blocked(staged) if below_floor else _none("halted", staged)

	# 8. Rollout: a critical release and a below-floor device bypass it; a null bucket is out.
	var critical: bool = PKeyClaims.is_true(target.get("critical"))
	if entry.get("rollout") is Dictionary and not below_floor and not critical:
		var bucket = input.get("bucket")
		if not (PKeyClaims.is_number(bucket) and float(bucket) < float(entry["rollout"]["bp"])):
			return _none("out-of-bucket", staged)

	var short := {"version": offer["version"], "seq": offer["seq"]}

	# 9. Platform.
	if caps["binaryUpdates"] == "none":
		return {"action": "platform", "release": short, "mandatory": below_floor, "critical": critical, "discardStaged": staged != null}

	# 10. Store.
	if caps["binaryUpdates"] == "store":
		var listing = entry.get("listingUrl")
		return {
			"action": "store", "release": short, "listingUrl": listing if listing is String else null,
			"mandatory": below_floor, "critical": critical, "discardStaged": staged != null,
		}

	# 11. Self-updating outlets. The offer is the pin here, so it carries its sha256.
	var full := {"version": offer["version"], "seq": offer["seq"], "sha256": offer.get("sha256")}
	var skip = input.get("skipVersion")
	var not_skipped := not _str_eq(offer["version"], skip)
	var code_updates: bool = PKeyClaims.is_true(caps["codeUpdates"])

	# a. code-ready.
	if not below_floor and newer_run and code_updates and staged != null \
			and _str_eq(staged.get("channel"), feed.get("channel")) \
			and _str_eq(staged.get("version"), offer["version"]) and not_skipped:
		return {"action": "code-ready", "release": full, "critical": critical, "discardStaged": false}

	var arch: String = String(installed.get("arch", ""))
	var builds: Array = []
	if record is Dictionary and record.get("builds") is Array:
		for b in record["builds"]:
			if _eligible(b, platform, arch, scheme):
				builds.append(b)
	var engine = installed.get("engine")
	var code_packs: Array = []
	for b in builds:
		if not _str_eq(b.get("format"), "pck"):
			continue
		var req: Dictionary = b["requires"] if b.get("requires") is Dictionary else {}
		if not (req.get("engine") is String) or not (engine is String) or req["engine"] != engine:
			continue
		if not req.has("minBinary"):
			code_packs.append(b)
			continue
		var c = PKeyVersion.compare_versions(scheme, bin, req["minBinary"])
		if c != null and int(c) >= 0:
			code_packs.append(b)
	var format = installed.get("format")
	var binaries: Array = []
	for b in builds:
		if not _str_eq(b.get("format"), "pck") and (format == null or _str_eq(b.get("format"), format)):
			binaries.append(b)
	var methods: Array = input.get("methods", []) if input.get("methods") is Array else []

	# b. sidecar-pck.
	if not below_floor and newer_run and code_updates and methods.has("sidecar-pck") and not_skipped and not code_packs.is_empty():
		return _binary("sidecar-pck", full, _pick_build(code_packs, arch), below_floor, critical, staged)

	# c. native, then download.
	var pick = _pick_build(binaries, arch)
	if newer_bin and pick != null:
		if methods.has("native"):
			return _binary("native", full, pick, below_floor, critical, staged)
		if methods.has("download"):
			return _binary("download", full, pick, below_floor, critical, staged)

	# d. Otherwise.
	if below_floor:
		return _blocked(staged)
	if not not_skipped:
		return _none("skipped", staged)
	if pick == null:
		return _none("no-build", staged)
	return _none("no-method", staged)


static func _none(reason: String, staged: Variant) -> Dictionary:
	return {"action": "none", "reason": reason, "behind": reason == "behind", "discardStaged": staged != null}


static func _blocked(staged: Variant) -> Dictionary:
	return {"action": "blocked", "reason": "app-floor", "discardStaged": staged != null}


static func _binary(method: String, release: Dictionary, build: Dictionary, mandatory: bool, critical: bool, staged: Variant) -> Dictionary:
	return {
		"action": "binary", "method": method, "release": release, "build": build["id"],
		"mandatory": mandatory, "critical": critical, "prestage": [], "discardStaged": staged != null,
	}


## The stage machine's `decide.done` for a decision (§2.8 "bootDecision"). No v4 answer stops
## play: `none`, and a `platform` answer that is not mandatory, give "none"; every other answer
## gives "optional". "required" comes from no v4 answer.
static func boot_decision(decision: Dictionary) -> String:
	var action = decision.get("action")
	if _str_eq(action, "none"):
		return BOOT_NONE
	if _str_eq(action, "platform") and not PKeyClaims.is_true(decision.get("mandatory")):
		return BOOT_NONE
	return BOOT_OPTIONAL


## True when the host must render `decision` as a prompt the player cannot dismiss, over a game
## that keeps running: a mandatory `binary`, `store` or `platform` answer, and every `blocked`.
static func is_undismissable(decision: Dictionary) -> bool:
	var action = decision.get("action")
	if _str_eq(action, "blocked"):
		return true
	if _str_eq(action, "binary") or _str_eq(action, "store") or _str_eq(action, "platform"):
		return PKeyClaims.is_true(decision.get("mandatory"))
	return false
