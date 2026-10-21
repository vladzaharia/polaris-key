---
title: "Your own UI (Godot)"
description: "Draw your own Godot screens on the Polaris Key addon: its four headless controllers, state-to-screen and copy-key mapping, signals, manual discovery, and update decisions."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 2
sdks: ["godot"]
lanes: ["library"]
---

The addon draws no screen until a game takes the drop-in boot or scenes. A game with its own menus
can use the same four headless controllers that the shipped scenes use: `PKeyGateController`,
`PKeyActivationController`, `PKeySignInController`, and `PKeyUpdatePromptController`. They return
screen names, copy keys, controls, and decisions; the game supplies the nodes, focus order, and
formatting. For the ready-made scenes instead, start with the [Godot quickstart](/docs/build/quickstart/godot/)
or the [Godot UI kit](/docs/build/ui/frameworks/godot/).

`res://polaris_key.tres` is the shared setup. If a game does not use `PolarisKey.boot()`, it must start
the cached state, explicitly run `discover()`, and then sync. `discover()` installs the current
capability map and presentation; `sync()` verifies and refreshes the service documents.

```gdscript
extends Node

func _ready() -> void:
	var configured := PolarisKey.configure(load("res://polaris_key.tres"))
	if not configured.ok:
		push_error(configured.code)
		return
	var started := await PolarisKey.start()
	if not started.ok:
		push_error(started.code)
		return
	var discovered := await PolarisKey.discover()
	if not discovered.ok:
		push_error(discovered.code)
		return
	var synced := await PolarisKey.sync()
	if not synced.ok:
		push_warning(synced.code) # Cached documents may still allow grace.
```

`start()` only opens and re-verifies local state. A custom flow must call `discover()` before it
uses discovery-gated capabilities such as identity, update offers, or product presentation. A
network failure from either call is a typed result, not an exception.

## Gate: status, screen, and copy key

Read `PolarisKey.status()` whenever `state_changed` fires. Give the status to
`PKeyGateController.screen_for()`, then use `copy_for()` and `controls_for()` to render the same
state model as `PKeyGateView`.

```gdscript
func gate_model() -> Dictionary:
	var state := PolarisKey.status()
	var status := String(state.get("status", "needs-activation"))
	var screen := PKeyGateController.screen_for(status)
	return {
		"screen": screen,
		"copy": PKeyGateController.copy_for(screen, status, state.get("allowed_range")),
		"controls": PKeyGateController.controls_for(screen, false),
	}
```

| `status` or condition                        | `screen_for()` result | `copy_for()` keys                                                            | What to draw                                                                               |
| -------------------------------------------- | --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Loading before `start()`                     | `loading`             | `gate_loading`                                                               | A non-interactive progress state                                                           |
| `ok`, `not-applicable`                       | `usable`              | None                                                                         | The game; `not-applicable` means License is off                                            |
| `grace` with grace allowed                   | `grace`               | None                                                                         | The game and a non-blocking offline notice                                                 |
| `grace` with grace blocked                   | `grace-blocked`       | `boot_offline_title`, `grace_blocked_body`                                   | Connect and retry                                                                          |
| `needs-activation`                           | `activation`          | The activation controller supplies the result copy                           | Key entry, sign-in, free enrolment, or offline activation                                  |
| `revoked`                                    | `revoked`             | `revoked_title`                                                              | Explain that the device was signed out, then offer activation or sign-in                   |
| `expired`                                    | `expired`             | `expired_title`, `expired_body`                                              | Ask the player to connect, then `sync(true)`: the cached license outlived its grace window |
| `version-too-old`                            | `update-required`     | `version_too_old_title`, `version_too_old_body`, `version_min`               | The update action when one is available                                                    |
| `version-too-new`, `channel-not-entitled`    | `not-available`       | `not_available_title`, `version_too_new_body` or `channel_not_entitled_body` | The availability explanation and retry                                                     |
| Any other status, or a post-activation error | `error`               | `gate_error_title`, `gate_error_body`                                        | The error and a way forward                                                                |

`PKeyGateController.is_usable_screen()` is true only for `usable` and `grace`. Do not grant
entitlements from a stale status: `PolarisKey.is_licensed()` applies the same gate.

## Activation: choices and refusals

`PKeyActivationController.capabilities_from()` says which choices this build may show. It applies
store rules, the enabled services, identity availability, web restrictions, and whether free
enrolment is offered. Do not rebuild those rules in a menu.

```gdscript
func activation_choices() -> Dictionary:
	return PKeyActivationController.capabilities_from(
		PolarisKey,
		true, # This game offers keyless enrolment.
	)


func activation_result(result: PKeyActivationResult, key: String) -> Dictionary:
	var copy := PKeyActivationController.message_for(result)
	return {
		"copy_key": copy[0],
		"copy_args": copy[1],
		"manage_url": PKeyActivationController.manage_link(
			result,
			key,
			"mygame://activated",
		),
	}
```

For a key, await `PolarisKey.license.activate_with_key(key)`, then give its
`PKeyActivationResult` to `message_for()`. That mapping returns `activation_ok`, a specific
activation refusal key, or the server-code key for `refused`. A device-limit answer receives a
Replace a device link only when its served `manage_url` is valid. Pass `true` as the fourth
`manage_link()` argument when rendering a shared-screen QR code: that intentionally omits the key
fragment.

A key with no entries left comes back `refused` with the code `key_entry_limit`. `message_for()`
maps it to "This key has no entries left. Add it to your account and sign in instead.", so offer
sign-in. The result carries no manage link; a `KIND_KEY_ENTRY_LIMIT` with its link is planned.

## Sign-in: prompt, countdown, and identity

`PolarisKey.identity` emits the prompt and final result. `PKeySignInController` turns those into
the catalog key, countdown, short address, and identity line; never render or persist the device
code.

```gdscript
extends Node


func _ready() -> void:
	PolarisKey.identity.sign_in_pending.connect(_on_sign_in_pending)
	PolarisKey.identity.sign_in_finished.connect(_on_sign_in_finished)


func begin_sign_in() -> void:
	var prompt := await PolarisKey.identity.begin_sign_in()
	if not prompt.ok:
		push_warning(prompt.code)


func _on_sign_in_pending(prompt: PKeySignInPrompt) -> void:
	var seconds := PKeySignInController.remaining(prompt, Time.get_unix_time_from_system())
	print(prompt.user_code, PKeySignInController.short_uri(prompt.verification_uri))
	print(PKeySignInController.clock(seconds))
	# Render a QR code from prompt.verification_uri_complete.


func _on_sign_in_finished(result: PKeySignInResult) -> void:
	print(PKeySignInController.message_for(result.kind))
	print(PKeySignInController.identity_line(result.identity))
```

The flow states are `starting`, `pending`, `confirm`, and `ended`. Pending shows the user code,
short URI, QR payload, and countdown. Ended maps `ok`, `expired`, `cancelled`, `denied` (the person pressed Deny),
`device-mismatch`, `rate-limited`, `service-unavailable`, `timeout`, and other errors to a copy
key. Use `PolarisKey.identity.current()` after success to restore the signed-in person on a later
screen; `sign_out()` ends the identity and deactivates its seat.

## Status and signals

The autoload emits state changes rather than making a game poll. Connect to its signals after
configuring it and use each payload as a render trigger:

```gdscript
extends Node


func _ready() -> void:
	PolarisKey.state_changed.connect(_on_state_changed)
	PolarisKey.sync_finished.connect(_on_sync_finished)
	PolarisKey.store_error.connect(_on_store_error)
	PolarisKey.boot_finished.connect(_on_boot_finished)
	PolarisKey.verify_progress.connect(_on_verify_progress)


func _on_state_changed(state: Dictionary) -> void:
	print(state.get("status", "needs-activation"))


func _on_sync_finished(result) -> void:
	print(result.code)


func _on_store_error(error: Dictionary) -> void:
	push_warning(String(error.get("message", "store error")))


func _on_boot_finished(result) -> void:
	print(result.code)


func _on_verify_progress(fraction: float) -> void:
	print(fraction)
```

A failed sync leaves verified cached documents in force until their grace deadline. Show the
current `status()` rather than treating `sync_finished` as success. `config_changed(keys)` is on
`PolarisKey.config`; use it to redraw settings that use managed values.

## Sync and offline

`PolarisKey.sync()` answers a `PKeySyncResult`. Its `ok` is false only when the pass could not run
at all (`not-configured`, `local-only`): an offline pass is still `ok`, because the verified cache
keeps the gate answering. Read `classify()` for what happened: `"ok"` when every document was
answered or none needed fetching, `"offline"` when a request got no answer, `"error"` when an
answer could not be used. `documents` holds the outcome of each document and `errors` the status
and code of each one that failed.

```gdscript
func sync_notice() -> String:
	var result := await PolarisKey.sync()
	if not result.ok:
		return String(result.code)
	if result.classify() == "offline":
		return PKeyUiCopy.shared().text("boot_offline_title")
	return ""
```

## Update prompt

`PKeyUpdatePromptController.model()` turns the signed update result into the entire prompt model:
visibility, state, copy keys, action, URL, behavior, lock state, version, and whether revoked
required content blocks boot. It deliberately returns no unsafe link.

```gdscript
func update_model() -> Dictionary:
	var check := await PolarisKey.update.decide()
	var outlet := String(PolarisKey.build_info().get("outlet", ""))
	return PKeyUpdatePromptController.model(check, outlet)


func apply_update(check: PKeyUpdateCheck) -> PKeyResult:
	return await PolarisKey.update.apply(check)
```

A `binary`, `store`, or `platform` answer with a mandatory decision, and every `blocked` answer,
is locked: keep the notice visible, but do not cover a game that can keep running. `code-ready`
means the game can offer restart; `none` and `packs` render no update prompt. Let
`PolarisKey.update.apply()` carry out the controller's action, because the outlet decides whether
that is a store page, browser link, native updater, staging operation, or restart.

## Tests

The controllers are static and have no side effects: test a screen with a small Dictionary, a
`PKeyActivationResult`, a `PKeySignInPrompt`, a `PKeySignInResult` or an update result, without a
scene tree. `PKeyGate.license_state()` is the pure function behind `status()`, so a test can put
the gate in any state without a server:

```gdscript
extends Node


func test_expired_screen() -> void:
	var state := PKeyGate.license_state({
		"license_service_enabled": true,
		"activation": "token",
		"doc": {"expiresAt": 100, "graceUntil": 200},
		"now": 300,
	})
	assert(state["status"] == "expired")
	assert(PKeyGateController.screen_for(String(state["status"])) == "expired")


func test_device_limit_link() -> void:
	var result := PKeyActivationResult.of(PKeyActivationResult.KIND_DEVICE_LIMIT, &"device_limit", "", 403)
	result.manage_url = "https://polaris.locker/activate?product=acme"
	assert(PKeyActivationController.manage_link(result, "", "mygame://done") != "")
```

A test that starts the SDK keeps the disk, the clock and the network out of it:

```gdscript
func offline_options() -> PKeyOptions:
	var opts: PKeyOptions = load("res://polaris_key.tres").duplicate()
	opts.store = PKeyMemoryStore.new()  # nothing touches the disk or the keychain
	opts.local_only = true              # nothing touches the network
	opts.build_stamp_path = ""          # ignore an exported game's build stamp
	opts.now_source = func() -> float: return 1_700_000_000.0
	return opts
```

A client with `local_only` never dials, so `sync()` answers `local-only` and its state comes from
the cache or from `import_bundle()`. The SDK's own tests drive a fake server over loopback
(`sdks/godot/tests/support/fake_server.gd`); a game's integration test can point `base_url` at
`http://127.0.0.1:<port>`, which the SDK accepts. Test doubles that drive the real client are
planned.
