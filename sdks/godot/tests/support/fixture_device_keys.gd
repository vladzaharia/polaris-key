class_name PKeyFixtureDeviceKeys
extends RefCounted
## The device key port a transcript replay presents (identity.exchange, I-48.3): the recorder's
## fixture keys for a `keyLabel` (packages/worker/test/transcripts/providers.ts
## `fixtureDeviceKeys`). The Ed25519 signing key's seed is SHA-256(label); the agreement key's
## 32 bytes are SHA-256(label + ":agree") with the top bit of the last byte clear, sent as they
## are. The signatures come from the pure `PKeyCurve25519` / `PKeyEd25519` code, so a replayed
## request carries the recorded bytes. A fixture, not a derivation any build uses.
##
## The same members as PKeyDeviceKeyStore (the port the SDK holds). A different label is a key
## rotation: `use_label()` hands the client the new pair.

var label := ""
var _seed := PackedByteArray()
var _sign_pub := PackedByteArray()
var _agree := PackedByteArray()
var _generation := 0


func _init(p_label := "") -> void:
	if p_label != "":
		use_label(p_label)


## Switch to the keys for `p_label` (a no-op for the label already in use).
func use_label(p_label: String) -> void:
	if p_label == label and not _seed.is_empty():
		return
	label = p_label
	_seed = p_label.sha256_buffer()
	_sign_pub = PKeyCurve25519.ed25519_public(_seed)
	_agree = (p_label + ":agree").sha256_buffer()
	_agree[31] &= 0x7f
	_generation += 1


## Not "memory": the exchange refuses keys that die with the process.
func persistence() -> String:
	return "file"


func ensure() -> PKeyResult:
	return public_keys()


func public_keys() -> PKeyResult:
	if _seed.is_empty():
		return PKeyResult.success(null)
	return PKeyResult.success({
		"sign_key": PKeyB64Url.encode(_sign_pub),
		"agree_key": PKeyB64Url.encode(_agree),
		"generation": _generation,
	})


func sign(msg: PackedByteArray) -> PKeyResult:
	if _seed.is_empty():
		return PKeyResult.failure(PKeyDeviceKeyStore.NO_KEYS, "fixture device keys: no label")
	return PKeyResult.success(PKeyCurve25519.ed25519_sign(_seed, _sign_pub, msg))


## The fixture agreement key is a recorded value, not a curve key: nothing agrees with it.
func dh(_peer_public: PackedByteArray) -> PKeyResult:
	return PKeyResult.success(null)
