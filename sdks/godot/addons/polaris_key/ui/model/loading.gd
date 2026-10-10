extends RefCounted
## DL7's delayed loading state, as model data: the port of ui-core's `loading.ts`. "Loading shows
## nothing for the first 250–300 ms, then the identity, a muted label and the 2 px shimmer." The
## delay is part of the model, so every kit flips at the same moment and a fast answer never
## flashes a loading screen. Reduced motion holds the shimmer still but keeps the delay.

## The window every kit's delay falls in (DL7).
const WINDOW_MIN_MS := 250
const WINDOW_MAX_MS := 300
## This kit's delay: the window's start.
const DELAY_MS := WINDOW_MIN_MS

## The states the delay applies to (`Component.state`; ui-matrix.json `vocabulary.loadingDelay`).
const DELAYED_STATES := [
	"PolarisKeyGate.booting",
	"LicenseChoice.loading",
	"Devices.loading",
	"ReleaseNotes.loading",
	"AccountAndLicense.loading",
	"Settings.loading",
	"Paywall.loading",
	"EntitlementGate.loading",
]


## True once a loading state shows its content; `elapsed_ms` null means the delay has passed.
static func visible(elapsed_ms: Variant, delay_ms: int = DELAY_MS) -> bool:
	return elapsed_ms == null or float(elapsed_ms) >= delay_ms
