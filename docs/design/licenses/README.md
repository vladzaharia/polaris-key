# Licence-holder mockups (S-24)

Static frames for [notes/S-24](../../research/2026-09-29-godot-omniplatform/notes/S-24-licence-holders.md):
the console **New license** wizard (frames 70–75b), the holder surfaces (76–77) and the portal's
floating-key frames (80–81). The in-app activation frames (42–48) live in the sign-in harness
([`../sign-in/frames.js`](../sign-in/frames.js)).

```sh
node docs/design/licenses/_src/build.mjs                                     # writes NN-*.html
NODE_PATH=packages/admin/node_modules node docs/design/licenses/render.cjs   # shots/, 1440 and 390, dark and light
```

The pages link the setup mockups' styles (`../setup/_src/*.css`) and icons; `_src/licenses.css`
adds what those do not draw. The committed PNGs are palette-quantised with sharp
(`png({palette: true, quality: 85})`). Edit `_src`, then rebuild; the HTML is generated and
prettier-ignored.
