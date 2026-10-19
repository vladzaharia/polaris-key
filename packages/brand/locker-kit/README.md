# Polaris Locker / Launch Kit v1.0

Approved direction: A2 Compact Bookends in coral. Date: 19 October 2026.

Start with docs/Polaris-Locker-Brand-Guide-v1.pdf. The Key addendum is also provided separately and appended to an unchanged copy of the 35-page October guide.

## Use
- Use logos/svg for sharp interfaces and logos/pdf for vector placement.
- Names dark/light identify intended background. White/black/coral are one-ink variants.
- Use the micro source below 24 CSS px. All 16px and 20px mark exports use it.
- Lockups are outlined Rubik: no font dependency. PNGs are transparent unless explicitly app/social/sticker assets.
- Square app icons intentionally have no baked-in platform corner mask. Apply platform masks at integration time.
- The ICO contains an explicit micro 16px layer. ICNS and web assets are included.
- badges retain generous vertical padding and regular-weight prefixes. Never crop their canvas.
- “Available on” needs real availability; “Open in” needs a real destination.
- Existing approved Powered by Polaris Key assets remain the infrastructure attribution. This pack does not redraw the Pinned K.

## Implementation
Import tokens/locker.css or locker.tokens.json. Namespace Locker roles; do not overwrite Key or service tokens. Include an accessible name for standalone marks; avoid repeating it when adjacent text already names the brand. Review actual target UI for focus, contrast and reduced motion.

## Rebuild
Python 3 with cairosvg, pillow, fonttools, reportlab, svglib and pypdf. Run python source/build.py from the extracted kit directory. Fonts and the October parent guide are bundled; all output paths are derived from the script location. Artwork geometry, export dimensions and document copy live in that script. The repository brand package has not been modified by this delivery.

## Licensing and provenance
Rubik is redistributed under the included SIL Open Font License. Brand artwork is supplied for the Polaris project; no trademark registration or third-party clearance claim is made. The original October guide remains unchanged in the combined reference. Concept source: user-selected A2 coral Bookends; final production drawing normalized to an explicit 128-unit artboard.

## Colour
Dark accent #ff7869. Light accent #c44438 (a contrast-adjusted companion to the exploratory coral). All mark artwork is flat. Transparent SVG/PDF are RGB source artwork; printers should proof conversions against their output profile.
