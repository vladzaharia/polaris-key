extends RefCounted
## Every UI kit scene in every state the `ui` suite pins: the snapshot fixtures, the focus walk
## and the copy check all build their scenes from this one list, so a state added here is held
## to all three. Each builder returns a view already under the tree root, rendered, driven only by
## its setters (no network, no clock but the fixed NOW), and is freed by the caller.

const NOW := 1700000000.0
const CONFIG := preload("res://tests/config/support.gd")
const PRESENTATION := preload("res://tests/support/presentation_fixtures.gd")
const NearbyApproval := preload("res://addons/polaris_key/ui/nearby/pkey_nearby_approval.gd")

## A settings catalog with every row kind the panel must handle.
const SETTINGS_CATALOG := [
	{"key": "audio.volume", "kind": "config", "category": "Audio", "label": "Volume", "description": "Master volume.", "schema": {"type": "integer", "minimum": 0, "maximum": 100}, "default": 80, "ui": {"widget": "stepper", "order": 1, "unit": "%"}, "accessor": "audio.volume"},
	{"key": "audio.pitch", "kind": "config", "category": "Audio", "label": "Pitch", "description": "Any number.", "schema": {"type": "number"}, "default": 1.5, "ui": {"order": 3, "unit": "x"}},
	{"key": "audio.muted", "kind": "config", "category": "Audio", "label": "Mute", "description": "", "schema": {"type": "boolean"}, "default": false, "ui": {"order": 2}},
	{"key": "ui.theme", "kind": "config", "category": "Interface", "label": "Theme", "description": "Colour theme.", "schema": {"type": "string", "enum": ["dark", "light"]}, "default": "dark", "ui": {"widget": "select", "order": 3, "optionLabels": {"dark": "Dark", "light": "Light"}}},
	{"key": "ui.reducedMotion", "kind": "config", "category": "Interface", "label": "Reduce motion", "description": "Only with the dark theme.", "schema": {"type": "boolean"}, "default": false, "ui": {"order": 4}, "dependsOn": {"key": "ui.theme", "equals": "dark"}},
	{"key": "game.killSwitch", "kind": "config", "category": "Operations", "label": "Online play off", "description": "Set by the operator.", "schema": {"type": "boolean"}, "default": false, "managementDefault": "enforced", "ui": {"order": 0}},
	{"key": "game.tuning", "kind": "config", "category": "Operations", "label": "Tuning", "description": "Never shown.", "schema": {"type": "number"}, "default": 1, "managementDefault": "hidden"},
	{"key": "debug.overlay", "kind": "config", "category": "Debug", "label": "Overlay", "description": "Hidden by default.", "schema": {"type": "boolean"}, "default": false, "managementDefault": "hidden"},
	{"key": "net.proxyUrl", "kind": "config", "category": "Network", "label": "Proxy URL", "description": "Advanced.", "schema": {"type": "string"}, "default": "", "ui": {"order": 10, "advanced": true, "placeholder": "https://proxy.example"}},
	{"key": "net.proxyPassword", "kind": "config", "category": "Network", "label": "Proxy password", "description": "", "schema": {"type": "string"}, "default": "", "ui": {"order": 11, "advanced": true, "widget": "password"}},
	{"key": "notes.motd", "kind": "config", "category": "Notes", "label": "Message of the day", "description": "", "schema": {"type": "string"}, "default": "Welcome", "ui": {"order": 20, "widget": "textarea"}},
	{"key": "leaderboard.key", "kind": "secret", "category": "Online", "label": "Leaderboard", "description": "", "schema": {"type": "string"}},
	{"key": "extras.skins", "kind": "flag", "category": "Extras", "label": "Dice skins", "description": "", "schema": {"type": "boolean"}, "default": true, "userGrant": true, "grantLabel": "Supporter"},
]
## The verified document's states for that catalog.
const SETTINGS_DOC := {
	"audio.volume": {"state": "default", "value": 60, "updatedAt": NOW},
	"audio.pitch": {"state": "default", "value": 1.5, "updatedAt": NOW},
	"audio.muted": {"state": "default", "value": false, "updatedAt": NOW},
	"ui.theme": {"state": "default", "value": "dark", "updatedAt": NOW},
	"game.killSwitch": {"state": "enforced", "value": true, "updatedAt": NOW},
	"game.tuning": {"state": "hidden", "value": 2, "updatedAt": NOW},
	"net.proxyUrl": {"state": "default", "value": "", "updatedAt": NOW},
}


## The ui-matrix.json rows the license-choice scenes are built from (a generator-owned mirror).
const MATRIX_PATH := "res://tests/corpus/v2/ui-matrix.json"
## Not a real code: fixture text in the code's own shape (8 groups of 4).
const FIXTURE_CODE := "AB3D-9FGH-JK4M-NP5Q-RS6T-VW7X-YZ80-1C2E"
const FIXTURE_RING := {"ring_id": "rg_AAAAAAAAAAAAAAAAAAAAAA", "epoch": 2, "root_kid": "00112233445566778899aabbccddeeff"}
## The devices every Devices state lists (ui-matrix.json `devices`; the apostrophe is the typographic one).
const DEVICE_ROWS := [
	{"name": "Work laptop", "platform": "windows", "formFactor": "computer", "lastSeenDays": 12, "current": false},
	{"name": "Mara’s iPad", "platform": "ios", "formFactor": "ipad", "lastSeenDays": 3, "current": false},
	{"name": "MacBook Pro", "platform": "macos", "formFactor": "mac", "lastSeenDays": 0, "current": true},
]
## [state, the signIn-family row it is built from] for PKeyLicenseChoice.
const CHOICE_CASES := [
	["loading", "LicenseChoice/loading: past the DL7 delay"],
	["many", "LicenseChoice/many"],
	["one", "LicenseChoice/one"],
	["current", "LicenseChoice/current"],
	["keep", "LicenseChoice/keep: never merged with create or a new license"],
	["new", "LicenseChoice/new: a first automatic license"],
	["create", "LicenseChoice/create: picked on an all-full list"],
	["all-full", "LicenseChoice/all-full"],
	["all-full, create offered", "LicenseChoice/all-full: Create offered"],
	["mixed", "LicenseChoice/mixed: a sign-in license beside a key license"],
	["replace open", "LicenseChoice/replace-open"],
	["raced", "LicenseChoice/raced: the seat was taken since the view loaded"],
	["none (keys)", "LicenseChoice/none-keys"],
	["none (no keys)", "LicenseChoice/none-no-keys"],
	["grant expired", "LicenseChoice/grant-expired"],
]


func tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func add(view: Control) -> Control:
	view.auto_sdk = false
	if view.anchor_right == view.anchor_left:
		view.size = Vector2(900, 1400)
	tree().root.add_child(view)
	return view


## [scene, state, builder] for every pinned state. A builder is a coroutine returning the view.
func all() -> Array:
	var out: Array = []
	# ── PKeyGate: every licence status, plus loading, refused grace and an activation error.
	for st in ["ok", "grace", "expired", "revoked", "needs-activation", "version-too-old", "version-too-new", "channel-not-entitled", "not-applicable"]:
		out.append(["gate", st, gate.bind(st, true, "")])
	out.append(["gate", "grace (allow_grace false)", gate.bind("grace", false, "")])
	out.append(["gate", "loading", gate.bind("", true, "")])
	out.append(["gate", "needs-activation after an error", gate.bind("needs-activation", true, "That license key wasn't accepted.")])
	out.append(["gate", "version-too-old with a store action", gate_store])
	out.append(["gate", "expired with renew", gate_renew])
	out.append(["gate", "network error", gate_network.bind(true)])
	out.append(["gate", "network error, no lease", gate_network.bind(false)])
	out.append(["gate", "not available (version-too-new)", gate_not_available])
	# The gate with sign-in and offline activation open inside it (what a player sees after
	# choosing them on the needs-activation card).
	out.append(["gate", "sign-in pending", gate_flow.bind("sign-in")])
	out.append(["gate", "offline activation", gate_flow.bind("offline")])
	# A sign-in that found several licenses: the gate asks which this device uses.
	out.append(["gate", "license choice", gate_choice])
	# The device limit reached through the gate (type a key, Activate, the licence is on every seat).
	out.append(["gate", "device limit", gate_limit.bind("button")])
	out.append(["gate", "device limit, replace a device (QR)", gate_limit.bind("qr")])
	# ── PKeyActivationPanel: every capability combination.
	for lic in [true, false]:
		for idn in [true, false]:
			for enr in [true, false]:
				for web in [false, true]:
					out.append(["activation", "license %s, identity %s, enrolment %s, %s" % [_on(lic), _on(idn), _on(enr), "web" if web else "native"], activation.bind(lic, idn, enr, web)])
	out.append(["activation", "device limit", activation_result])
	out.append(["activation", "device limit, replace a device (button)", activation_manage.bind("button")])
	out.append(["activation", "device limit, replace a device (QR)", activation_manage.bind("qr")])
	out.append(["activation", "key-entry limit, add it in Polaris Locker (button)", activation_refusal.bind("key-entry-limit", "button")])
	out.append(["activation", "key-entry limit, add it in Polaris Locker (QR)", activation_refusal.bind("key-entry-limit", "qr")])
	out.append(["activation", "key-entry limit, no link", activation_refusal.bind("key-entry-limit", "")])
	out.append(["activation", "license in another account", activation_refusal.bind("license-owned", "button")])
	# ── PKeySignInStep: automatic sign-in's steps (ui-matrix v7).
	for c in SIGN_IN_STEP_CASES:
		out.append(["sign_in_step", c[0], sign_in_step.bind(c[1])])
	# ── PKeyNearbyApproval (ui-matrix v7).
	for c in ["entry", "ask", "approved", "not-nearby", "mismatch", "denied", "expired", "device-limit", "choose", "account-required", "rate-limited", "no-name", "hidden"]:
		out.append(["nearby", c, nearby.bind(c)])
	# ── PKeySignInDialog.
	out.append(["sign_in", "starting", sign_in.bind("starting")])
	out.append(["sign_in", "pending", sign_in.bind("pending")])
	out.append(["sign_in", "pending, link copied", sign_in.bind("copied")])
	out.append(["sign_in", "confirm, attachable", sign_in.bind("confirm")])
	out.append(["sign_in", "ok", sign_in.bind("ok")])
	out.append(["sign_in", "expired", sign_in.bind("expired")])
	out.append(["sign_in", "denied", sign_in.bind("denied")])
	out.append(["sign_in", "failed", sign_in.bind("failed")])
	# ── PKeyOfflineDialog.
	out.append(["offline", "native", offline.bind(false, "")])
	out.append(["offline", "web", offline.bind(true, "")])
	out.append(["offline", "rejected signature", offline.bind(false, "bundle-jws-rejected")])
	# ── PKeySettingsPanel.
	out.append(["settings", "catalog", settings.bind(false, {})])
	out.append(["settings", "advanced shown", settings.bind(true, {})])
	out.append(["settings", "local override, dependsOn hidden", settings.bind(false, {"ui.theme": "light", "audio.volume": 25})])
	out.append(["settings", "empty", settings_empty])
	# ── PKeyStatusBanner.
	out.append(["banner", "grace", banner.bind({"status": "grace", "grace_until": NOW + 3 * 86400 + 100, "last_verified_at": NOW - 3 * 3600}, false)])
	out.append(["banner", "update available", banner.bind({"status": "ok"}, true)])
	out.append(["banner", "nothing to say", banner.bind({"status": "ok"}, false)])
	# ── PKeyUpdatePrompt: every decision state.
	for c in update_cases():
		out.append(["update_prompt", c[0], update_prompt.bind(c[1], c[2], c[3], c[4])])
	out.append(["update_prompt", "binary, modal with release notes", update_prompt_notes])
	# ── PKeyEntitlementBadge.
	out.append(["badge", "two grants", badge.bind(["Supporter", "Founder"])])
	out.append(["badge", "none", badge.bind([])])
	out.append(["badge", "eight grants", badge.bind(["Supporter", "Founder", "Beta tester", "Speedrunner", "Moderator", "Translator", "Artist", "Contributor"])])
	# ── PKeyDevMenuSection.
	out.append(["dev_menu", "editor", dev_menu.bind("")])
	out.append(["dev_menu", "steam build", dev_menu.bind("steam")])
	# ── PKeyBoot's stop cards and its waiting gate.
	out.append(["boot", "offline", boot.bind("offline")])
	out.append(["boot", "error", boot.bind("error")])
	out.append(["boot", "blocked update-required", boot.bind("update-required")])
	out.append(["boot", "blocked not-available", boot.bind("not-available")])
	out.append(["boot", "waiting needs-activation", boot.bind("waiting")])
	out.append(["boot", "syncing", boot.bind("syncing")])
	# ── PKeyBoot's pack stages (P4-08): the consent card, a declined download, the pill.
	out.append(["boot", "consent metered", boot.bind("consent")])
	out.append(["boot", "blocked content-declined", boot.bind("declined")])
	out.append(["boot", "background pill", boot.bind("background")])
	# ── The product's presentation from discovery (core.presentation): the gate's hero header.
	out.append(["gate", "needs-activation, presented: Drift Kart's icon", gate_presented.bind("icon")])
	out.append(["gate", "needs-activation, presented without an icon", gate_presented.bind("no-icon")])
	out.append(["gate", "needs-activation, presented, the integrator's name wins", gate_presented.bind("integrator")])
	out.append(["gate", "needs-activation, presented, a long name", gate_presented.bind("long")])
	out.append(["gate", "needs-activation, presented, a right-to-left name", gate_presented.bind("rtl")])
	out.append(["settings", "catalog, presented by its developer", settings_presented])
	out.append(["settings", "catalog, with the account tab", settings_account])
	# ── PKeyDeviceList (UI-KITS.md Devices).
	for c in [["list", "list"], ["list, an unnamed device", "unnamed"], ["list, this device not known", "unknown"], ["renaming", "renaming"], ["confirming a removal", "confirming"], ["empty", "empty"], ["browser mode", "browser"], ["loading", "loading"], ["error: the list could not load", "load-error"], ["error: a rename was refused", "rename-error"], ["error: a removal was refused", "remove-error"], ["list, this device only (from the SDK)", "self-only"]]:
		out.append(["devices", c[0], devices.bind(c[1])])
	# ── PKeyPaywall and PKeyDeviceLimit (UI-KITS.md §4.1), the model's states.
	for c in [["offers, the browser", "offers-portal"], ["offers, the store", "offers-store"], ["offers, with what it includes", "offers-includes"], ["loading", "loading"], ["purchasing", "purchasing"], ["restoring", "restore"], ["purchased", "purchased"], ["not available", "not-available"], ["not available, the portal offered", "not-available-portal"]]:
		out.append(["paywall", c[0], paywall.bind(c[1])])
	for c in [["default: replace the least recent", "default"], ["default: the limit is not known", "unknown"], ["browser mode", "browser"], ["browser mode: a QR code on a TV", "browser-tv"], ["busy", "busy"], ["removed", "removed"], ["failed", "failed"]]:
		out.append(["device_limit", c[0], device_limit.bind(c[1])])
	# ── PKeyCloudSyncStatus, PKeyAbout and PKeyReleaseNotes (UI-KITS.md §4.1), the models' states.
	for c in [["synced", "synced"], ["syncing", "syncing"], ["offline", "offline"], ["conflict, Review offered", "conflict"], ["error", "error"], ["error: signed out", "signed-out"], ["locked", "locked"], ["ring changed", "ring-changed"]]:
		out.append(["cloud_sync", c[0], cloud_sync.bind(c[1])])
	# ── The Cloud Sync screens (ui-matrix `cloudSync`, U-42.5): every state the model has.
	for c in ["code", "code, typed", "invalid", "working", "failed", "start-over-failed", "no-code", "start-over", "hidden"]:
		out.append(["unlock_sync", c, unlock_sync.bind(c)])
	for c in ["show", "saved", "hidden"]:
		out.append(["recovery_code", c, recovery_code.bind(c)])
	for c in ["confirm", "no device named", "nothing served", "failed", "hidden"]:
		out.append(["ring_change", c, ring_change.bind(c)])
	for c in [["with every link", "full"], ["version only", "plain"]]:
		out.append(["about", c[0], about.bind(c[1])])
	for c in [["list", "list"], ["loading", "loading"], ["empty", "empty"], ["error", "error"]]:
		out.append(["release_notes", c[0], release_notes.bind(c[1])])
	# ── PKeyLicenseChoice (UI-KITS.md LicenseChoice): the corpus rows.
	for c in CHOICE_CASES:
		out.append(["license_choice", c[0], license_choice.bind(c[1])])
	# ── PKeyAccountTab (UI-KITS.md AccountAndLicense).
	for c in [["signed in", "signed-in"], ["key only", "key-only"], ["offline", "offline"], ["loading", "loading"], ["channel set by the outlet", "locked-channel"], ["on a TV, the email masked", "masked"]]:
		out.append(["account", c[0], account.bind(c[1])])
	# ── PKeyUpdateProgress (UI-KITS.md UpdateProgress).
	for c in [["queued: content", "queued-content"], ["queued: an app update", "queued-app"], ["downloading", "downloading"], ["downloading: no time left known", "downloading-no-eta"], ["downloading: verified, not yet installed", "verified"], ["installing", "installing"], ["paused: a metered connection", "paused"], ["failed", "failed"], ["done", "done"], ["compact", "compact"]]:
		out.append(["update_progress", c[0], update_progress.bind(c[1])])
	# ── PKeyToast (UI-KITS.md Toast).
	for c in [["info: an update is available", "update"], ["success: copied", "copied"], ["success: signed in", "signed_in"], ["success: signed in with the tier", "tier"], ["success: signed in, a long name", "tier_long"], ["info: key entries left", "entries"], ["info: no key entries left", "entries0"], ["warning", "warning"], ["error: stays until dismissed", "error"], ["with progress", "progress"], ["bottom centre", "centre"]]:
		out.append(["toast", c[0], toast.bind(c[1])])
	# Every state starts from no presentation and no integrator name (the kit's identity is global).
	for c in out:
		c[2] = _isolated.bind(c[2])
	return out


func _isolated(build: Callable) -> Control:
	PKeyUiTheme.use_presentation(null)
	PKeyUiTheme.product_name = ""
	return await build.call()


## The product's presentation bound to the kit (PKeyPresentationFixtures.present), by `kind`.
static func presented(kind: String) -> PKeyPresentationSource:
	var fields: Dictionary = PRESENTATION.DRIFT_KART.duplicate()
	match kind:
		"long":
			fields["name"] = PRESENTATION.LONG_NAME
		"rtl":
			fields["name"] = PRESENTATION.RTL_NAME
	return PRESENTATION.present(fields, kind != "no-icon")


## The gate asking for a key, under the product's presentation (`kind`: icon, no-icon, integrator,
## long, rtl).
func gate_presented(kind: String) -> Control:
	presented(kind)
	if kind == "integrator":
		PKeyUiTheme.product_name = "Tidewater"
	return gate("needs-activation", true, "")


## The settings catalog of a product whose presentation names its developer ("Set by …").
func settings_presented() -> Control:
	var p: PKeySettingsPanel = await settings(false, {})
	p.sdk.presentation_source.cache_dir = PRESENTATION.UI_CACHE
	p.sdk.presentation_source.accept(PRESENTATION.manifest(PRESENTATION.member(PRESENTATION.DRIFT_KART)))
	p.refresh_view()
	return p


func _on(b: bool) -> String:
	return "on" if b else "off"


func gate(status: String, allow_grace: bool, err: String) -> Control:
	var g := PKeyGateView.new()
	g.allow_grace = allow_grace
	g.activation.set_capabilities(PKeyActivationController.capabilities(true, true, false, false))
	g.banner.now_source = func(): return NOW
	add(g)
	if status == "":
		g.show_loading()
	else:
		var s := {"status": status}
		if status == "grace":
			s["grace_until"] = NOW + 86400 * 2 + 5
		if status == "version-too-old":
			s["allowed_range"] = {"min": "1.4.0"}
		g.show_state(s, err)
	return g


## An expired license on a host that can renew (an https renew_url): Renew, then Use another license.
func gate_renew() -> Control:
	var g := PKeyGateView.new()
	g.renew_url = "https://example.com/renew"
	g.activation.set_capabilities(PKeyActivationController.capabilities(true, true, false, false))
	add(g)
	g.show_state({"status": "expired"})
	return g


## The gate on its license-choice screen: the corpus's "many" row, asked of this device.
func gate_choice() -> Control:
	var g := PKeyGateView.new()
	g.activation.set_capabilities(PKeyActivationController.capabilities(true, true, false, false))
	add(g)
	g.show_state({"status": "needs-activation"})
	g.license_choice.device_name = "Living room PC"
	g.license_choice.developer = "Fennick Studio"
	var row := matrix_row("signIn", "LicenseChoice/many")
	g.show_license_choice(row.get("input", {}).get("choices", {}))
	return g


func gate_network(lease: bool) -> Control:
	var g := PKeyGateView.new()
	g.network_error = true
	g.can_continue_offline = lease
	g.activation.set_capabilities(PKeyActivationController.capabilities(true, true, false, false))
	add(g)
	g.show_state({"status": "needs-activation"}, "network-error")
	return g


func gate_not_available() -> Control:
	var g := PKeyGateView.new()
	g.activation.set_capabilities(PKeyActivationController.capabilities(true, true, false, false))
	add(g)
	g.show_state({"status": "version-too-new", "allowed_range": {"max": "1.4.0"}})
	return g


func gate_store() -> Control:
	var g := PKeyGateView.new()
	g.outlet = "steam"
	g.activation.set_capabilities(PKeyActivationController.capabilities(true, false, false, false))
	add(g)
	g.update_result = update_check({"action": "store", "release": {"version": "2.0.0", "seq": 3}, "listingUrl": "https://store.steampowered.com/app/480", "mandatory": true, "critical": false, "discardStaged": false})
	g.show_state({"status": "version-too-old"})
	return g


## The needs-activation gate with sign-in (a code showing) or offline activation open.
func gate_flow(which: String) -> Control:
	var g := PKeyGateView.new()
	g.activation.set_capabilities(PKeyActivationController.capabilities(true, true, false, false))
	add(g)
	g.show_state({"status": "needs-activation"})
	var panel := g.activation
	if which == "sign-in":
		panel.sign_in_dialog.now_source = func(): return NOW
		panel.open_mode("sign-in")
		panel.sign_in_dialog.show_prompt(prompt_fixture())
	else:
		panel.offline_dialog.web_override = 0
		panel.offline_dialog.product = "djdl"
		panel.offline_dialog.device_id = "Q2hYlBg0Zx9uR7m1VvC4tKpE8sWnJ3aD"
		panel.open_mode("offline")
	return g


## The gate after a key was refused with the device limit: the activation panel holds the limit view.
func gate_limit(how: String) -> Control:
	var g := PKeyGateView.new()
	g.activation.manage_mode = how
	g.activation.set_capabilities(PKeyActivationController.capabilities(true, true, true, false))
	add(g)
	g.show_state({"status": "needs-activation"})
	var r := PKeyActivationResult.of(PKeyActivationResult.KIND_DEVICE_LIMIT, PKeyErrors.DEVICE_LIMIT, "", 403)
	r.limit = 3
	r.device_count = 3
	r.manage_url = "https://polaris.locker/activate?product=djdl&next=free-device&for=Linux%20x86_64"
	g.activation.show_result(r, "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV")
	return g


func activation(lic: bool, idn: bool, enr: bool, web: bool) -> Control:
	var p := PKeyActivationPanel.new()
	p.set_capabilities(PKeyActivationController.capabilities(lic, idn, enr, web))
	add(p)
	return p


func activation_result() -> Control:
	var p := PKeyActivationPanel.new()
	p.set_capabilities(PKeyActivationController.capabilities(true, true, true, false))
	add(p)
	var r := PKeyActivationResult.of(PKeyActivationResult.KIND_DEVICE_LIMIT, PKeyErrors.DEVICE_LIMIT, "", 403)
	r.limit = 3
	r.device_count = 3
	p.show_result(r)
	return p


## PX-W8: a device-limit refusal that carries the portal link, offered as a button or a QR code.
func activation_manage(how: String) -> Control:
	var p := PKeyActivationPanel.new()
	p.manage_mode = how
	p.return_url = "mygame://activated"
	p.set_capabilities(PKeyActivationController.capabilities(true, false, false, false))
	add(p)
	var r := PKeyActivationResult.of(PKeyActivationResult.KIND_DEVICE_LIMIT, PKeyErrors.DEVICE_LIMIT, "", 403)
	r.limit = 1
	r.device_count = 1
	r.manage_url = "https://polaris.locker/activate?product=djdl&next=free-device&for=Linux%20x86_64"
	p.show_result(r, "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV")
	return p


## The focused key refusals (ui-matrix v7 Activate/key-entry-limit, Activate/license-owned).
func activation_refusal(kind: String, how: String) -> Control:
	var p := PKeyActivationPanel.new()
	p.manage_mode = "qr" if how == "qr" else "button"
	p.set_capabilities(PKeyActivationController.capabilities(true, true, false, false))
	add(p)
	var limit := kind == "key-entry-limit"
	var r := PKeyActivationResult.of(PKeyActivationResult.KIND_KEY_ENTRY_LIMIT if limit else PKeyActivationResult.KIND_LICENSE_OWNED, PKeyErrors.KEY_ENTRY_LIMIT if limit else PKeyErrors.LICENSE_OWNED, "", 403)
	if limit:
		r.key_entries = {"used": 3, "limit": 3}
	if limit and how != "":
		r.manage_url = "https://polaris.locker/add-key?product=djdl"
	p.show_result(r, "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV")
	return p


const SIGN_IN_STEP_CASES := [
	["confirm, the account's email", "confirm"],
	["confirm, Apple shared no email", "confirm-apple"],
	["confirm, a new license and what the app also gets", "confirm-license"],
	["link offer, Google shared across apps", "link-offer-global"],
	["link offer, per developer", "link-offer-developer"],
	["link done", "link-done"],
	["link conflict", "link-conflict"],
	["nearby prompt", "nearby-prompt"],
	["nearby wait", "nearby-wait"],
	["nearby done", "nearby-done"],
]


func sign_in_step(kind: String) -> Control:
	var s := PKeySignInStep.new()
	s.auto_sdk = false
	add(s)
	s.developer = "Drift Studio"
	match kind:
		"confirm":
			s.email = "ada@mail.io"
		"confirm-apple":
			s.provider = "Apple"
		"confirm-license":
			s.email = "ada@mail.io"
			s.license_line = "new"
			s.also_gets = true
		"link-offer-global":
			s.step = "link-offer"
			s.reach = "global"
		"link-offer-developer":
			s.step = "link-offer"
			s.reach = "developer"
		"nearby-done":
			s.step = "nearby-done"
			s.email = "ada@mail.io"
		"nearby-wait":
			s.step = "nearby-wait"
			s.code = "482 913"
		_:
			s.step = kind
	if kind == "confirm" or kind == "confirm-apple" or kind == "confirm-license":
		s.step = "confirm"
	s.refresh_view()
	return s


func nearby(kind: String) -> Control:
	var n = NearbyApproval.new()
	n.auto_sdk = false
	add(n)
	n.device = "" if kind == "no-name" else "Living room TV"
	if kind == "hidden":
		n.identity_on = false
	elif kind == "no-name":
		n.step = "approved"
	else:
		n.step = kind
	if kind == "ask":
		n.codes = PackedStringArray(["482 913", "107 356", "759 204"])
	n.refresh_view()
	return n


func prompt_fixture() -> PKeySignInSession:
	var p := PKeySignInSession.new(true)
	p.device_code = "dc_fixture"
	p.user_code = "WDJB-MJHT"
	p.verification_uri = PKeyConstants.DEVICE_CODE_PAGE
	p.verification_uri_complete = PKeyConstants.DEVICE_CODE_PAGE + "?user_code=WDJB-MJHT"
	p.expires_in = 600
	p.interval = 5
	p.expires_at = NOW + 125
	p.device_name = "Living room TV"
	return p


func sign_in(state: String) -> Control:
	var d := PKeySignInDialog.new()
	d.now_source = func(): return NOW
	add(d)
	match state:
		"starting":
			d.show_starting()
		"pending":
			d.show_prompt(prompt_fixture())
		"copied":
			d.show_prompt(prompt_fixture())
			d.copied = true
			d.refresh_view()
		"confirm":
			d.show_prompt(prompt_fixture())
			d.show_confirm({"identity": {"name": "Ada Lovelace", "email": "ada@mail.io"}, "attachable": true})
		"ok":
			d.show_result(PKeySignInOutcome.signed_in({"name": "Ada"}, "", true, null))
		"expired":
			d.show_result(PKeySignInOutcome.ended(PKeySignInOutcome.KIND_EXPIRED, PKeyErrors.SIGN_IN_EXPIRED, ""))
		"denied":
			d.show_result(PKeySignInOutcome.ended(PKeySignInOutcome.KIND_DENIED, PKeyErrors.SIGN_IN_DENIED, ""))
		"failed":
			d.show_result(PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.SIGN_IN_FAILED, ""))
	return d


func offline(web: bool, refused: String) -> Control:
	var d := PKeyOfflineDialog.new()
	d.web_override = 1 if web else 0
	d.product = "djdl"
	d.device_id = "Q2hYlBg0Zx9uR7m1VvC4tKpE8sWnJ3aD"
	add(d)
	if refused != "":
		d.show_import_result(PKeyResult.failure(StringName(refused), ""))
	return d


## A started, local-only SDK whose catalog is SETTINGS_CATALOG and whose verified config document
## holds SETTINGS_DOC, with `overrides` in an in-memory override store.
func settings_sdk(overrides: Dictionary) -> Node:
	var sdk: Node = await CONFIG.sdk_with({})
	sdk.config.set_compiled_catalog({"ENTRIES": SETTINGS_CATALOG, "DEFAULTS": {}, "CATALOG_VERSION": 1})
	CONFIG.inject(sdk, SETTINGS_DOC)
	# One key the environment sets, for the env badge.
	sdk.config.env = CONFIG.env_from({"PKEY_CONFIG_audio__muted": "true"})
	sdk.config.refresh()
	sdk.config.set_override_store(PKeyOverrideStore.new(overrides))
	return sdk


func settings(advanced: bool, overrides: Dictionary) -> Control:
	var sdk: Node = await settings_sdk(overrides)
	var p := PKeySettingsPanel.new()
	p.sdk = sdk
	p.show_advanced = advanced
	add(p)
	# The SDK goes with the panel, not when a harness re-parents the panel (the matrix does, to put
	# it in its game stand-in): a freed SDK left every later layout of the panel with an empty list.
	var panel_ref: WeakRef = weakref(p)
	var sdk_ref: WeakRef = weakref(sdk)
	p.tree_exited.connect(func() -> void:
		(func() -> void:
			var s := sdk_ref.get_ref() as Node
			var panel := panel_ref.get_ref() as Node
			if s != null and (panel == null or not panel.is_inside_tree()):
				s.queue_free()).call_deferred())
	return p


func settings_empty() -> Control:
	var p := PKeySettingsPanel.new()
	p.config = PKeyConfig.new()
	add(p)
	return p


## The settings panel with the Account and license section first (the account tab of a game's menu).
func settings_account() -> Control:
	var p: PKeySettingsPanel = await settings(false, {})
	p.account_tab = true
	p.account.tier = "Pro"
	p.account.holder = "Mara Lindqvist"
	p.account.signed_in = true
	p.account.status = "ok"
	p.account.devices_used = 2
	p.account.devices_limit = 3
	p.account.channel = "stable"
	p.account.version = "2.5.0"
	p.account.services = ["license", "config", "release", "distribution", "update", "identity", "commerce"]
	p.refresh_view()
	return p


## A Devices state: the three fixture devices, and what the player did to them.
func cloud_sync(kind: String) -> Control:
	var s := PKeyCloudSyncStatus.new()
	s.auto_sdk = false
	add(s)
	s.sync_time = "2 minutes ago"
	match kind:
		"synced", "syncing", "offline", "error":
			s.state = kind
		"conflict":
			s.state = "conflict"
			s.can_review = true
		"signed-out":
			s.state = "error"
			s.signed_in = false
		"locked", "ring-changed":
			s.state = kind
	s.refresh_view()
	return s




func unlock_sync(kind: String) -> Control:
	var s := PKeyUnlockSync.new()
	s.auto_sdk = false
	add(s)
	match kind:
		"code, typed":
			s.set_typed_code("ab3d 9fgh jk4m")
		"hidden":
			s.sync_on = false
		_:
			if kind != "code":
				s.step = kind
	s.refresh_view()
	return s


func recovery_code(kind: String) -> Control:
	var s := PKeyRecoveryCode.new()
	s.auto_sdk = false
	add(s)
	if kind == "hidden":
		s.sync_on = false
	s.code = FIXTURE_CODE
	s.saved = kind == "saved"
	s.refresh_view()
	return s


func ring_change(kind: String) -> Control:
	var s := PKeyRingChange.new()
	s.auto_sdk = false
	add(s)
	s.served = FIXTURE_RING.duplicate()
	s.by = "Maya’s MacBook"
	match kind:
		"no device named":
			s.by = ""
		"nothing served":
			s.served = {}
		"failed":
			s.failed = true
		"hidden":
			s.sync_on = false
	s.refresh_view()
	return s


func about(kind: String) -> Control:
	var a := PKeyAbout.new()
	a.auto_sdk = false
	a.version = "2.5.0 (4182)"
	add(a)
	if kind == "full":
		a.privacy_url = "https://polaris.locker/privacy"
		a.support_url = "https://polaris.locker/help"
		a.diagnostics = "version 2.5.0 build 4182 outlet steam"
	a.refresh_view()
	return a


const RELEASE_ENTRIES := [
	{"version": "2.5.0", "date": "September 30, 2026", "notes": "Faster sync. Fixes a crash on launch."},
	{"version": "2.4.1", "date": "August 12, 2026", "notes": "Fixes the mixer on Windows. <b>Not markup.</b>"},
]


func release_notes(kind: String) -> Control:
	var r := PKeyReleaseNotes.new()
	r.auto_sdk = false
	add(r)
	match kind:
		"list":
			r.entries = RELEASE_ENTRIES.duplicate(true)
		"loading":
			r.loading = true
			r._loading_since = Time.get_ticks_msec() - 400
		"error":
			r.failed = true
	r.refresh_view()
	return r


func paywall(kind: String) -> Control:
	var p := PKeyPaywall.new()
	p.auto_sdk = false
	p.tier = "Pro"
	add(p)
	match kind:
		"offers-portal":
			p.offers_url = "https://polaris.locker/activate?product=tidewater"
		"offers-store":
			p.store_purchase = true
			p.can_restore = true
		"offers-includes":
			p.offers_url = "https://polaris.locker/activate?product=tidewater"
			p.includes = PackedStringArray(["Unlimited exports", "Cloud saves", "Every future expansion"])
			p.redeem_requested.connect(func(): pass)
		"loading":
			p.loading = true
			p._loading_since = Time.get_ticks_msec() - 400
		"purchasing":
			p.store_purchase = true
			p.pending = "purchase"
		"restore":
			p.store_purchase = true
			p.can_restore = true
			p.pending = "restore"
		"purchased":
			p.store_purchase = true
			p.purchased = true
		"not-available":
			p.offers_available = false
		"not-available-portal":
			p.offers_available = false
			p.offers_url = "https://polaris.locker/activate?product=tidewater"
	p.refresh_view()
	return p


func device_limit(kind: String) -> Control:
	var d := PKeyDeviceLimit.new()
	d.auto_sdk = false
	d.used = 3
	d.limit = 3
	d.form_factor = "mac"
	add(d)
	match kind:
		"default":
			d.devices = DEVICE_ROWS.duplicate(true)
		"unknown":
			d.used = -1
			d.limit = -1
			d.devices = DEVICE_ROWS.duplicate(true)
		"browser":
			d.manage_url = "https://polaris.locker/devices?product=tidewater"
		"browser-tv":
			d.manage_url = "https://polaris.locker/devices?product=tidewater"
			d.form_factor = "tv"
			d.pad = true
		"busy":
			d.devices = DEVICE_ROWS.duplicate(true)
			d.pending = true
		"removed":
			d.outcome = "done"
			d.replaced_name = "Work laptop"
		"failed":
			d.outcome = "failed"
			d.replaced_name = "Work laptop"
	d.refresh_view()
	return d


func devices(kind: String) -> Control:
	var d := PKeyDeviceList.new()
	d.auto_sdk = false
	d.now_source = func(): return NOW
	add(d)
	var rows: Array = DEVICE_ROWS.duplicate(true)
	match kind:
		"list":
			d.show_devices(rows)
		"unnamed":
			rows[2]["name"] = null
			d.show_devices(rows)
		"unknown":
			for r in rows:
				r["current"] = false
			d.show_devices(rows)
		"renaming":
			d.show_devices(rows)
			d._start_edit("rename", 0)
		"confirming":
			d.show_devices(rows)
			d._start_edit("remove", 0)
		"empty":
			d.show_devices([])
		"browser":
			d.show_browser_mode()
		"loading":
			d.show_loading()
			# Past the 250 ms delay (DL7): the label and the shimmer show.
			d._loading_since = Time.get_ticks_msec() - 400
			d.refresh_view()
		"load-error":
			d.show_error("device_list_failed")
		"rename-error":
			d.show_devices(rows)
			d._start_edit("rename", 0)
			d.show_error("device_rename_failed")
		"remove-error":
			d.show_devices(rows)
			d._start_edit("remove", 0)
			d.show_error("device_deauthorize_failed")
		"self-only":
			# A roster read through the SDK: this device renames itself, nobody removes anyone.
			d._self_only = true
			d.show_devices(rows)
	return d


## The row of ui-matrix.json's `signIn` family named `name`.
func matrix_row(family: String, name: String) -> Dictionary:
	var m = PKeyTestFixtures.read_json(MATRIX_PATH)
	if m is Dictionary:
		for r in m.get(family, []):
			if r["name"] == name:
				return r
	return {}


func license_choice(row_name: String) -> Control:
	var v := PKeyLicenseChoice.new()
	v.auto_sdk = false
	v.device_name = "Living room PC"
	v.developer = "Fennick Studio"
	add(v)
	var row := matrix_row("signIn", row_name)
	v.show_input(row.get("input", {}))
	return v


func account(kind: String) -> Control:
	var a := PKeyAccountTab.new()
	a.auto_sdk = false
	a.auto_load = false
	add(a)
	a.services = ["license", "config", "release", "distribution", "update", "identity", "commerce"]
	a.tier = "Pro"
	a.status = "ok"
	a.channel = "stable"
	a.version = "2.5.0"
	a.devices_used = 2
	a.devices_limit = 3
	a.auto_update = true
	match kind:
		"signed-in":
			a.signed_in = true
			a.holder = "Mara Lindqvist"
		"key-only":
			a.signed_in = false
		"offline":
			a.signed_in = true
			a.holder = "Mara Lindqvist"
			a.status = "grace"
		"loading":
			a.show_loading()
			a._loading_since = Time.get_ticks_msec() - 400
		"locked-channel":
			a.signed_in = true
			a.holder = "Mara Lindqvist"
			a.channel_locked_by = "steam"
			a.channel = "beta"
		"masked":
			a.signed_in = true
			a.holder = "mara@fennick.studio"
			a.mask_email = true
	a.refresh_view()
	return a


## An UpdateProgress state: a stopped clock, ten seconds apart, give the rate and so the time left.
func update_progress(kind: String) -> Control:
	var p := PKeyUpdateProgress.new()
	p.auto_sdk = false
	var now := [0.0]
	p.clock = func(): return now[0]
	p.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
	add(p)
	match kind:
		"queued-content":
			p.set_progress("queued", 0, 0, "packs")
		"queued-app":
			p.set_progress("queued", 0, 0, "binary", "2.5.0")
		"downloading":
			p.set_progress("download", 30_000_000, 91_000_000, "packs")
			now[0] = 10.0
			p.set_progress("download", 38_000_000, 91_000_000, "packs")
		"downloading-no-eta":
			p.set_progress("download", 38_000_000, 91_000_000, "packs")
		"verified":
			p.set_progress("verify", 91_000_000, 91_000_000, "binary", "2.5.0")
		"installing":
			p.set_progress("install", 91_000_000, 91_000_000, "binary", "2.5.0")
		"paused":
			p.set_progress("paused", 38_000_000, 91_000_000, "binary", "2.5.0")
		"failed":
			p.set_progress("failed", 38_000_000, 91_000_000, "packs")
		"done":
			p.set_progress("done", 91_000_000, 91_000_000, "binary", "2.5.0")
		"compact":
			p.compact = true
			p.set_progress("download", 38_000_000, 91_000_000, "packs")
	return p


## A toast over the game: a stopped clock, so the timer is full.
func toast(kind: String) -> Control:
	var t := PKeyToast.new()
	t.auto_sdk = false
	t.clock = func(): return 0.0
	t.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add(t)
	match kind:
		"update":
			t.show_update("2.5.0")
		"copied":
			t.show_copied()
		"signed_in":
			t.show_success("Signed in as Mara", "Pro license")
		"tier":
			t.show_success(String(PKeyUiView.catalog().format("signin.desktop.toast", {"name": "Mara", "tier": "Pro"})))
		"tier_long":
			t.show_success(String(PKeyUiView.catalog().format("signin.desktop.toast", {"name": PKeyGateView.toast_name("Mara Lindqvist-Fennick-Okonkwo (mara.lindqvist@fennick.studio)"), "tier": "Founder's Edition"})))
		"entries":
			t.show_info(String(PKeyUiView.catalog().format("signin.key.entriesLeftShort", {"left": 2})))
		"entries0":
			t.show_info(String(PKeyUiView.catalog().format("signin.key.entriesLeftShort", {"left": 0})))
		"warning":
			t.show_warning("Autosave is off", "Your progress is not being saved.")
		"error":
			t.show_error("network-error")
		"progress":
			t.show_progress(38_000_000, 91_000_000, 66.0)
		"centre":
			t.toast_anchor = "bottom_center"
			t.show_update("2.5.0")
	return t


func banner(state: Dictionary, update: bool) -> Control:
	var b := PKeyStatusBanner.new()
	b.now_source = func(): return NOW
	add(b)
	b.show_state(state, update)
	return b


func update_check(decision: Dictionary) -> PKeyUpdateCheck:
	var r := PKeyUpdateCheck.new(true)
	r.channel = "stable"
	r.decision = decision
	r.undismissable = PKeyDecision.is_undismissable(decision)
	r.boot = "optional"
	return r


## [state, result, outlet, release_url, modal]
func update_cases() -> Array:
	var rel := {"version": "1.5.0", "seq": 15, "sha256": "ab"}
	return [
		["v3 newer version", PKeyVersionCheck.of("1.5.0", "v1.5.0", "https://example.com/releases/1.5.0", true), "", "", false],
		["v3 up to date (shown)", PKeyVersionCheck.of("1.0.0", "v1.0.0", "", false), "", "", false],
		["code-ready", update_check({"action": "code-ready", "release": rel, "critical": false, "discardStaged": false}), "direct", "", false],
		["binary on a direct build", update_check({"action": "binary", "method": "download", "release": rel, "build": "macos-dmg", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}), "direct", "https://example.com/download", false],
		["binary, modal", update_check({"action": "binary", "method": "download", "release": rel, "build": "macos-dmg", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}), "direct", "https://example.com/download", true],
		["binary mandatory (locked, modal asked)", update_check({"action": "binary", "method": "download", "release": rel, "build": "macos-dmg", "mandatory": true, "critical": false, "prestage": [], "discardStaged": false}), "direct", "https://example.com/download", true],
		["binary on an itch build", update_check({"action": "binary", "method": "download", "release": rel, "build": "macos-dmg", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}), "itch", "https://example.com/download", false],
		["store", update_check({"action": "store", "release": {"version": "1.5.0", "seq": 15}, "listingUrl": "https://apps.apple.com/app/id1", "mandatory": false, "critical": false, "discardStaged": false}), "app-store", "", false],
		["platform", update_check({"action": "platform", "release": {"version": "1.5.0", "seq": 15}, "mandatory": false, "critical": false, "discardStaged": false}), "steam", "", false],
		["blocked (locked)", update_check({"action": "blocked", "reason": "app-floor", "discardStaged": false}), "steam", "", true],
		["binary native with no plugin (the download link)", update_check({"action": "binary", "method": "native", "release": rel, "build": "macos-dmg", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}), "direct", "https://example.com/download", false],
		["binary sidecar-pck (a code pack downloads)", update_check({"action": "binary", "method": "sidecar-pck", "release": rel, "build": "linux-pck", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}), "direct", "", false],
		["store on TestFlight", update_check({"action": "store", "release": {"version": "1.5.0", "seq": 15}, "listingUrl": "https://testflight.apple.com/join/abcd", "mandatory": false, "critical": false, "discardStaged": false}), "testflight", "", false],
		["store on AltStore with no source page", update_check({"action": "store", "release": {"version": "1.5.0", "seq": 15}, "listingUrl": null, "mandatory": true, "critical": false, "discardStaged": false}), "altstore", "", false],
		["platform on itch", update_check({"action": "platform", "release": {"version": "1.5.0", "seq": 15}, "mandatory": false, "critical": false, "discardStaged": false}), "itch", "", false],
		["platform on the web (reload)", update_check({"action": "platform", "release": {"version": "1.5.0", "seq": 15}, "mandatory": false, "critical": false, "discardStaged": false}), "web", "", false],
		["platform on a package-managed direct build", update_check({"action": "platform", "release": {"version": "1.5.0", "seq": 15}, "mandatory": false, "critical": false, "discardStaged": false}), "direct", "", false],
	]


func update_prompt(result: PKeyResult, outlet: String, release_url: String, modal: bool) -> Control:
	var p := PKeyUpdatePrompt.new()
	p.outlet = outlet if outlet != "" else "direct"
	p.release_url = release_url
	p.modal = modal
	p.show_when_current = true
	add(p)
	p.show_result(result)
	return p


## The modal with the changelog entry of the offered version (up to three lines and the release page).
func update_prompt_notes() -> Control:
	var p := PKeyUpdatePrompt.new()
	p.outlet = "direct"
	p.release_url = "https://example.com/dl"
	p.modal = true
	p._notes["1.5.0"] = {"lines": ["Faster loading screens", "A new tide table", "Fixes a crash on resume"], "url": "https://example.com/r/1.5.0"}
	add(p)
	p.show_result(update_check({"action": "binary", "method": "download", "release": {"version": "1.5.0", "seq": 15, "sha256": "ab"}, "build": "b", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}))
	return p


func badge(labels: Array) -> Control:
	var b := PKeyEntitlementBadge.new()
	add(b)
	b.show_labels(labels)
	return b


func dev_facts(outlet: String) -> Dictionary:
	return {
		"device": "Q2hYlBg0Zx9uR7m1VvC4tKpE8sWnJ3aD", "outlet": outlet, "channel": "beta", "version": "1.2.0",
		"build": "42", "sdk": "0.1.0", "engine": "4.7.2", "platform": "windows", "gate": "ok", "last_sync": NOW,
	}


func dev_menu(outlet: String) -> Control:
	var d := PKeyDevMenuSection.new()
	d.facts_override = dev_facts(outlet)
	d.entitled_override = ["beta", "dev"]
	add(d)
	return d


## A PKeyBoot driven to a stop (or the waiting gate) through a scripted host.
func boot(stop: String) -> Control:
	var b := PKeyBoot.new()
	# A stopped clock: the snapshot is the view the moment the stop lands, however long the
	# machine takes to get there (no PROGRESS_AFTER_MSEC bar on a loaded machine; P1-13).
	b.clock_msec = func() -> int: return 0
	var host := PKeyFakeBootHost.new()
	add(b)
	b.gate.activation.set_capabilities(PKeyActivationController.capabilities(true, false, false, false))
	b.run({"host": host, "sync_timeout_seconds": 1000, "allow_offline": stop != "offline", "required_packs": ["djdl.core"] if stop == "declined" else [], "essential_packs": []})
	host.answer({"type": "shell.done"})
	host.answer({"type": "guard.done", "result": "ok"})
	match stop:
		"syncing":
			# Still at SYNC, a sliced bundle verify reporting its progress.
			b.set_verify_progress(0.42)
		"offline":
			host.answer({"type": "sync.done", "result": "offline"})
		"error":
			host.answer({"type": "fail", "code": "sync-exception"})
		"update-required", "not-available":
			host.answer({"type": "sync.done", "result": "ok"})
			host.answer({"type": "gate.status", "status": "version-too-old" if stop == "update-required" else "channel-not-entitled"})
		"waiting":
			host.answer({"type": "sync.done", "result": "ok"})
			host.answer({"type": "gate.status", "status": "needs-activation"})
		"consent", "declined", "background":
			host.answer({"type": "sync.done", "result": "ok"})
			host.answer({"type": "gate.status", "status": "ok"})
			host.answer({"type": "decide.done", "decision": "none"})
			match stop:
				"consent":
					# The host asks: fetch.consent, then the card waits for the player.
					b.send({"type": "fetch.consent", "bytes": 12345678, "metered": true})
					b._consent_answer(12345678, true)
				"declined":
					host.answer({"type": "fetch.done", "result": "declined", "installed": []})
				"background":
					host.answer({"type": "fetch.done", "result": "ok", "installed": []})
					host.answer({"type": "mount.done"})
					b.send({"type": "background.start"})
					b._background_running = true
					b._background_total = 200
					b._background_done = 84
					b.refresh_view()
	return b
