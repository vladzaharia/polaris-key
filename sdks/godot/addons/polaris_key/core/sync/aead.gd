@tool
class_name PKeySyncAead
extends RefCounted
## The one AES-256-GCM entry of Cloud Sync (GM.1, U-40.2): settings envelopes, key wraps, HPKE,
## chunk objects and file segments all seal and open here, with `PKeySyncAesGcm`'s arguments and
## answers. A call goes to the native lane that `PKeyPeerCrypto.for_platform()` chose, which has
## passed its known answers (including an empty message and an empty AAD), when the lane's
## `sync_max_bytes()` covers the message; every other call is GDScript. So a build without the
## plugin, a lane that failed its answers (never chosen), a message over the lane's bound and a
## call off the main thread run exactly the code they ran before.
##
## The native side is called from the main thread only: the Apple binary entry is a Node and the
## Android bridge is not proven off it. Off the main thread this class answers in GDScript.
## The protocol's bounds (1 MiB of message, 64 KiB of AAD) hold on every path, whatever a lane
## would take: a larger call is refused here, never handed to a lane.
## Refusals are values, as in `PKeySyncAesGcm`: an empty array from `seal`, null from `open`.

const KEY_BYTES := PKeySyncAesGcm.KEY_BYTES
const NONCE_BYTES := PKeySyncAesGcm.NONCE_BYTES
const TAG_BYTES := PKeySyncAesGcm.TAG_BYTES
const MAX_BYTES := PKeySyncAesGcm.MAX_BYTES
const MAX_AAD_BYTES := PKeySyncAesGcm.MAX_AAD_BYTES
## The text of the refusal when a platform needs the native plugin and has none.
const NEEDS_PLUGIN := "Synced files need the Polaris Key native plugin on this platform."

## Tests put a lane here; null means `PKeyPeerCrypto.for_platform()`.
static var _override: PKeyPeerCrypto = null
## Tests: 1 treats the runtime as iOS or Android, 0 as neither; -1 reads the engine's features.
static var mobile_override := -1


static func seal(key: PackedByteArray, nonce: PackedByteArray, plain: PackedByteArray, aad: PackedByteArray = PackedByteArray()) -> PackedByteArray:
	if plain.size() > MAX_BYTES or aad.size() > MAX_AAD_BYTES:
		return PackedByteArray()
	var lane := _native_lane()
	if lane != null and plain.size() <= lane.sync_max_bytes() and aad.size() <= MAX_AAD_BYTES \
			and key.size() == KEY_BYTES and nonce.size() == NONCE_BYTES:
		return lane.sync_seal(key, nonce, aad, plain)
	return PKeySyncAesGcm.seal(key, nonce, plain, aad)


static func open(key: PackedByteArray, nonce: PackedByteArray, sealed: PackedByteArray, aad: PackedByteArray = PackedByteArray()) -> Variant:
	if sealed.size() < TAG_BYTES or sealed.size() - TAG_BYTES > MAX_BYTES or aad.size() > MAX_AAD_BYTES:
		return null
	var lane := _native_lane()
	if lane != null and sealed.size() >= TAG_BYTES and sealed.size() - TAG_BYTES <= lane.sync_max_bytes() \
			and aad.size() <= MAX_AAD_BYTES and key.size() == KEY_BYTES and nonce.size() == NONCE_BYTES:
		return lane.sync_open(key, nonce, aad, sealed)
	return PKeySyncAesGcm.open(key, nonce, sealed, aad)


## Whether Cloud Sync files and saves run on this runtime (D-2). Desktop and web always do (GDScript
## lane, at most 32 MiB). iOS and Android need a native lane that passed its known answers: a build
## without the plugin, or a lane that failed them, answers the typed `dependency` refusal.
static func files_supported() -> bool:
	var mobile := OS.has_feature("ios") or OS.has_feature("android")
	if mobile_override >= 0:
		mobile = mobile_override == 1
	return not mobile or _native_lane() != null


## The lane the next call on this thread uses: "apple", "android", "windows" or a test lane, else
## "gdscript". For status details and tests.
static func lane_name() -> String:
	var lane := _native_lane()
	return "gdscript" if lane == null else lane.lane_name()


## The native lane for this thread, or null when the call runs in GDScript.
static func _native_lane() -> PKeyPeerCrypto:
	if OS.get_thread_caller_id() != OS.get_main_thread_id():
		return null
	var lane: PKeyPeerCrypto = _override if _override != null else PKeyPeerCrypto.for_platform()
	return lane if lane.sync_native() else null


## Forces `lane` (a PKeyPeerCrypto) for the tests; null restores the platform's choice.
static func use_lane_for_tests(lane: PKeyPeerCrypto) -> void:
	_override = lane
