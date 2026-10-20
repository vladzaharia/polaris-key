# Polaris Locker / Launch Kit v1.3

Approved direction: A2 Compact Bookends in coral. Date: 19 October 2026.

Start with docs/Polaris-Locker-Brand-Guide-v1.pdf. The Key guide retains the original 35 pages and its own prominent platform identity. A three-page Locker section follows the existing service pages and explains the public-facing distinction and shared design rules. Revision 1.3 aligns both guides through one family specification, retains all approved marks, and includes 16 badge labels. See the badge catalogue for artwork and usage.

## Use
- Use logos/svg for sharp interfaces and logos/pdf for vector placement.
- Names dark/light identify intended background. White/black/coral are one-ink variants.
- Use the micro source below 24 CSS px. All 16px and 20px mark exports use it.
- Lockups are outlined Rubik: no font dependency. PNGs are transparent unless explicitly app/social/sticker assets.
- Square app icons intentionally have no baked-in platform corner mask. Apply platform masks at integration time.
- The ICO contains an explicit micro 16px layer. ICNS and web assets are included.
- badges retain generous vertical padding and regular-weight prefixes. Never crop their canvas.
- “Available on” needs real availability; “Open in” needs a real destination.
- Public-facing attribution uses Polaris Locker. Polaris Key retains its own brand, marks and original guide; the Locker section explains where to use each identity.

## Public brand architecture
All public-facing surfaces use Polaris Locker: marketing, docs, console, sign-in, downloads, emails, SDK presentation and partner badges. Polaris Key is the underlying platform. Technical identifiers and host-owned brands are preserved. This pack does not deploy or rename live systems.

## Implementation
Start with docs/brand-alignment.md and tokens/polaris-family.tokens.json. Import tokens/polaris-family.css for explicitly scoped shared neutral roles, plus locker.css or locker.tokens.json for Locker. Capability display swatches preserve Key’s mappings; use upstream accessible UI roles for controls. Namespace Locker roles; do not overwrite Key or service tokens. Include an accessible name for standalone marks; avoid repeating it when adjacent text already names the brand. Review actual target UI for focus, contrast and reduced motion.

## Rebuild
Python 3 with cairosvg, pillow, fonttools, reportlab, svglib and pypdf. Run python source/build.py from the extracted kit directory. Fonts, the original Key PDF and all guide generators are bundled; all output paths are derived from the script location. Artwork geometry, export dimensions and document copy live in that script. The repository brand package has not been modified by this delivery.

## Licensing and provenance
Rubik is redistributed under the included SIL Open Font License. Brand artwork is supplied for the Polaris project; no trademark registration or third-party clearance claim is made. The original October Key guide is preserved as the basis. Its cover, visual identity, services and examples remain; the new Locker section governs public-facing application of that system. Concept source: user-selected A2 coral Bookends; final production drawing normalized to an explicit 128-unit artboard.

## Colour
Dark accent #ff7869. Light accent #c44438 (a contrast-adjusted companion to the exploratory coral). All mark artwork is flat. Transparent SVG/PDF are RGB source artwork; printers should proof conversions against their output profile.
