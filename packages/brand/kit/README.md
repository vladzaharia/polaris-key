# Polaris Key launch kit · v1.0

This kit contains the two selected identities: the original **Pinned K** platform mark and the **Star Cut Update** service mark. It is intended for public websites, integrations, applications, games, press and partner materials. The production vectors reconstruct the approved concepts; they use exact flat brand colours and outlined typography.

**Start here:** open `index.html` for the visual catalogue and `Brand-Guide.pdf` for usage rules. SVG is the editable source of truth. Use the provided PNG size instead of resizing a large image for tiny UI surfaces.

## Choose a file

| Use | Location |
| --- | --- |
| Platform and Update symbols | `01-marks/` |
| Horizontal, stacked and compact wordmarks | `02-lockups/` |
| Transparent, sticker and outline integration badges | `03-powered-by/` |
| Browser icons, touch icons and PWA manifests | `04-web/key/` or `04-web/update/` |
| Apple catalog/layers, Android resources, Windows ICO, macOS ICNS | `05-app-icons/` |
| Godot/editor glyphs, game textures, 1080p/4K integration credits | `06-games/` |
| Avatars, social cards, square posts, banners and splash screens | `07-social/` |
| React component, mono SVG sprite, HTML examples and brand tokens | `08-developer/` |
| Vector PDF artwork | `09-print/` |
| Exact-size and magnified visual proofs; machine checks | `10-quality/` |
| Geometry, build scripts, fonts, font license and render manifest | `source/` |

## Three optical sizes

* `favicon`: separately drawn on a 16-unit grid. Use at 16 px for browser tabs and the Godot editor.
* `service`: open 24-unit construction. Use at 24–32 px. Keep the mark at least 24 px except for the dedicated 16 px cut.
* `display`: the full master. Use at 48 px and above. Files named `signed` add the K's gold terminal bit; the Update mark has no gold variant.

Select by **displayed/CSS size**, not device pixel ratio. A 16 px symbol at 2× must still use the favicon geometry. Render its SVG at 32 physical pixels. A 24 px symbol on a 2× display still uses the service geometry. The React component does this automatically from its `size` prop.

PNG glyphs are included at 16, 24, 32, 48, 64, 96, 128, 180, 192, 256, 512 and 1024 px. Layout PNGs include multiple output sizes; the numeric suffix is the physical pixel **width**. SVG dimensions describe the intended default layout.

## Colour and background selection

`dark` means **for dark backgrounds**, not dark-coloured ink. `light` means **for light backgrounds**. `mono-white` is white ink, `mono-black` is #060912 ink, and `currentColor` inherits one CSS ink when inlined. External SVG `<img>` elements do not inherit a parent element's currentColor.

| Token | Dark surface | Light surface |
| --- | --- | --- |
| Violet | #9a5cff | #7a2fff |
| Gold terminal bit | #ffc24d | #d07a00 |
| Page ground | #060912 | #f6f8ff |
| Polaris star | #ffffff | #7a2fff |
| Rose, reserved for optional display treatments | #ff6fa6 | #e0348a |

Rose is not used in these launch marks. No gradients, indigo or parent-brand blue appear in the artwork. Keep gold on the K's terminal bit only, and only when the **rendered glyph itself** is at least 48 px. Use compact lockups for small placements. All mono parts, including star and optional bit, use a single ink.

## Powered by badges

Use the exact phrase **Powered by Polaris Key**. The secondary phrase is Rubik Regular; the wordmark is Rubik Bold. Your feedback is built in: original compact horizontal relationship, additional vertical breathing room, and a lighter secondary phrase.

* Horizontal: 376 × 144 CSS px. Use at this size or larger.
* Compact: 232 × 88 CSS px. Recommended minimum for the full two-line badge.
* Stacked: 288 × 336 CSS px. Use at this size or larger.
* Each is supplied as transparent, filled sticker and outline, in dark, light, black and white variants.

Transparent and outline versions need a background with matching contrast. Sticker versions carry their own background. Keep the included padding intact; don't crop the canvas to the visible artwork. Gold is omitted from all integration badges to remain usable at modest display sizes.

## General use

Leave outside clear space equal to at least one quarter of the glyph height around standalone marks and lockups; the symbol SVG's own small internal margin is not a substitute. Built-in badge padding is already part of its layout. Preserve proportions. Do not stretch, rotate the stationary star, replace it with a sparkle emoji, add a shield or padlock, or attach an unapproved service name. The Update logo identifies the service; it is not itself a live update-status indicator. This package contains only the selected platform and Update identities.

For meaningful identity images, use `alt="Polaris Key"`, `alt="Polaris Key Update"` or `alt="Powered by Polaris Key"`. Use empty alt text when the adjacent visible label already conveys the same name. The React component accepts `title` for accessibility and otherwise marks itself decorative. Supply visible text for any interactive control; an icon alone does not provide a control label or a sufficiently large touch target.

## Website

Copy one folder from `04-web/` into your site, then adapt its `head-snippet.html`. The manifest is a template: set `id`, `start_url`, and `scope` to your application. The supplied `favicon.svg` adapts to light/dark browser colour preference. The ICO fallback uses a dark tile with dedicated optical frames. Maskable PWA art stays within the central safe area. Use the appropriate service identity for each application rather than installing both manifests at the same URL.

Social PNG sizes are 1200×630, 1080×1080, 1500×500 and 1920×1080. Avatar art is 1024×1024. These are general-purpose layouts, not a promise to match every publisher's current upload form. All preserve usable clear space.

## Native applications and games

**Apple:** the `AppIcon.appiconset` has an opaque 1024 px default image and Contents.json for a universal iOS catalog. Alternative dark artwork and separate SVG/PNG foreground layers plus SVG backgrounds are provided for Icon Composer. Import and configure them in Xcode for your target platforms. This kit does not contain a compiled Icon Composer `.icon` document. macOS has a separate ICNS asset.

**Android:** copy the provided `res/` resources into a test build and reference `@mipmap/ic_launcher`. Adaptive layers use a 108 dp canvas; the foreground is kept inside the central 66 dp safe area. API 26 uses foreground/background; API 33 adds a monochrome layer. Legacy PNG density buckets are included. Select the correct product folder before merging resources, because the resource names intentionally match.

**Desktop:** use the ICO for Windows and ICNS for macOS, or the available PNG sizes for Linux and other toolchains. Match the operating system's own application-manifest requirements in your build.

**Godot:** use the dedicated `*-16.svg` or `*-16.png` in `06-games/` for editor-scale visuals. Larger transparent exports are suitable for UI textures. Set your project's platform icon fields to the corresponding native-format assets. **Unity/other engines:** import transparent PNGs as UI/sprite textures, preserve aspect ratio, and use the optical geometry appropriate to the final displayed size. 1080p and 4K “Powered by” credit screens are included.

## Print and editing

SVGs use editable vector paths; wordmarks are outlined and need no fonts installed. Vector PDFs are RGB artwork intended as source for a printer or layout application; convert to the printer's requested colour profile for a specific production job. No universal CMYK conversion or bleed is baked into a logo.

The supplied wordmark uses Rubik Bold; “Powered by” uses Rubik Regular. This is an explicit production typesetting choice, not an identification of the image-generated concept's font. Unmodified font binaries and their SIL OFL license are in `source/fonts/`.

## Rebuild

From the unpacked kit, install the Python dependencies in `source/requirements.txt` and run `npm install --prefix source`. Point `POLARIS_OUTPUT` at a **new** output directory, then run:

```sh
export POLARIS_OUTPUT="$PWD/../polaris-rebuilt"
python source/build.py
node source/render.mjs
python source/finish.py
```

The builder writes only to the selected output folder. The validation report checks all generated PNG dimensions, XML parsing, alpha/palette behavior, optical glyph separation, ICO frames, manifest targets, badge padding and native-icon constraints. Exact-size proof sheets are included for visual review. Font rendering and native app behavior should still be reviewed in the actual consuming applications before release.

## Technical references

Checked 2026-09-30:

* Apple app-icon catalog: https://developer.apple.com/documentation/xcode/configuring-your-app-icon
* Apple icon design: https://developer.apple.com/design/human-interface-guidelines/app-icons
* Android adaptive icons: https://developer.android.com/develop/ui/compose/system/icon_design_adaptive
* Web App Manifest: https://www.w3.org/TR/appmanifest/

`SHA256SUMS.txt` covers the packaged files. `asset-manifest.json` lists each deliverable and its byte count. The original exploration sheets are not shipping artwork; these deterministic vectors are the masters for this kit.
