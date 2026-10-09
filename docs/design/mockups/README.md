# Mockups

High-fidelity mockups of every screen the DX consolidation builds or changes
(`docs/research/2026-10-07-dx-consolidation/`): the console, the customer portal, terminal output,
SDK code and the in-app UI kits. A mockup is the target a package builds to and the picture its
built screen is reviewed against. All of them are drawn with one kit, so they look like one
product, in both themes, at four sizes: wide, desktop, tablet and phone.

They are published together as one page (an artifact the lead owns). Each screen shows its
mockup, then its built screenshots beside it once they exist, its design reviews, what to check,
and notes.

## Layout

```text
docs/design/mockups/
├─ README.md              this file
├─ areas.json             the eleven areas, in order, with their service accent
├─ kit/
│  ├─ mockup.css          the one stylesheet (tokens, fonts, icons, components)
│  ├─ README.md           the class vocabulary, with markup for each component
│  └─ gallery.html        every component once, for checking the kit and copying markup
└─ screens/<area>/
   ├─ <area>.<slug>.html  the screen's body markup
   └─ <area>.<slug>.json  what it is, which packages build it, what to check

tools/mockups/
├─ shoot.mjs              renders screens to PNG and checks the screen contract
├─ build-kit.mjs          regenerates mockup.css's tokens, fonts and icons
├─ build.mjs              builds the one-page artifact from areas.json, the kit and the screens
├─ page.html              that page's template
└─ assets/                the JetBrains Mono symbols subset
```

Areas, in page order: products, licenses, entitlements, config, distribution, packages, commerce,
identity, admin, sdk, portal (`areas.json` has each title, accent and blurb).

## The screen contract

One screen is two files in `screens/<area>/`, named by its id, `<area>.<slug>`: lowercase letters,
digits and hyphens, such as `licenses.detail` or `commerce.offer-editor`.

**`<id>.html`** is body markup only: no `<html>`, `<head>` or `<body>`.

- Styled by `kit/mockup.css` only, plus an optional `<style>` block at the top for this screen,
  every rule scoped as `[data-screen="<id>"] …` and every colour a token. The renderer puts
  `data-screen="<id>"` on `<body>`.
- Correct at four sizes, wide 1920×1080, desktop 1440×900, tablet 1024×768 and phone 390×844, in
  `data-theme="dark"` and `"light"` (set on `<html>` by the renderer). Each size adapts, not just
  shrinks: wide uses the width (an aside column, a capped line length), tablet reflows (the 56px
  icon rail, grids drop a column), phone stacks; device-code, QR and activation screens go side by
  side in landscape and stack in portrait (`kit/README.md`, "Four sizes"). Nothing may scroll the
  page sideways; wide tables and code scroll inside their own block.
- No external requests: no `<link>`, no remote images or fonts, no `@import`. No JavaScript is
  needed to render; a small inline script is allowed only to show a toggle, never to draw the
  screen.
- Realistic content: Polaris Key (the system product), DJDL (a desktop DJ app on macOS and
  Windows, sold on its own site, licenses from OIDC groups) and Diceroll (a Godot game on iOS,
  Android, Steam and itch.io, with packs and in-app purchases); plausible people on
  `example.com`; dates in October 2026; real units. Never lorem ipsum.
- The words are the glossary's (integration.md §2) and the copy follows EXPERIENCE.md, ADMIN.md
  and PORTAL.md: sentence case, US "license", say exactly what happens ("Publish", then
  "Published"), errors say what went wrong and how to fix it, and never "outlet", "grant" (except
  "Automatic grant"), "capability" or "storefront feed".
- Each fact once per page, and briefly: no subtitle that restates a count or the title, no
  sentence that narrates the layout or the mechanism, one sentence where one will do
  (`kit/README.md`, "Say it once, and briefly").

**`<id>.json`**:

```json
{
  "id": "products.integration",
  "title": "Integration",
  "area": "products",
  "surface": "console",
  "packages": ["ST-41", "ST-40"],
  "uxRows": ["UX-21"],
  "summary": "What it shows, in one or two sentences.",
  "compare": ["What to check when the real screen is built", "…"],
  "status": "mockup",
  "designReview": null
}
```

| Field          | Meaning                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `surface`      | `console`, `portal`, `terminal`, `code`, `kit` (an in-app UI kit) or `dialog` (a dialog or flow drawn on its own)                                                                                                                                                                                                                              |
| `packages`     | the work packages that build it (backlog ids such as `ST-41`)                                                                                                                                                                                                                                                                                  |
| `uxRows`       | the UX rows it settles, if any                                                                                                                                                                                                                                                                                                                 |
| `compare`      | the checklist a reviewer walks when the built screen comes back: layout, states, words, phone. Specific and checkable.                                                                                                                                                                                                                         |
| `status`       | `mockup` in the file. Later states (`building`, `built`, `shipped`) live in the page's database, not here.                                                                                                                                                                                                                                     |
| `designReview` | `null` until a UX designer reviews the mockup; then `{ "round": 1, "verdict": "…", "findings": [{ "severity", "issue", "resolution" }] }`. A later round keeps the earlier ones in `previousRounds`; a lead's decision on several reviews is round `"multi-review"`, each finding with `"decision": "accepted"` or `"declined"` and `raisedBy` |
| `order`        | optional number to order screens inside an area (otherwise by id)                                                                                                                                                                                                                                                                              |

Draw one screen per state that matters (an empty list, an error, a confirmation) rather than one
screen with everything at once. Reference screens: `products.home` and `products.overview` (the
spacing system, the content rules and the four sizes), and `products.integration`.

## Rendering

From the worktree root, with Node 22:

```sh
# one area: writes <id>.{wide,desktop,tablet,phone}-{dark,light}.png
mise exec node@22 -- node tools/mockups/shoot.mjs --area products --out /Users/vlad/Repos/pk-wt/_mockups/shots/products

# one screen
mise exec node@22 -- node tools/mockups/shoot.mjs --screen products.integration --out /Users/vlad/Repos/pk-wt/_mockups/shots/products

# everything (into <out>/<area>/), the kit gallery, or the contract check alone
mise exec node@22 -- node tools/mockups/shoot.mjs --all --out /Users/vlad/Repos/pk-wt/_mockups/shots
mise exec node@22 -- node tools/mockups/shoot.mjs --gallery --out /Users/vlad/Repos/pk-wt/_mockups/shots/kit
mise exec node@22 -- node tools/mockups/shoot.mjs --all --check
```

Other options: `--sizes wide,desktop,tablet,phone` (the default), `--themes dark,light`, `--scale 2` for retina PNGs, and
`--html <dir>` to also write each composed page for opening in a browser. Shots are full page and
deterministic: fonts are embedded and awaited, animation and the caret are off, and every network
request is refused. The run fails on a contract error, a console error, a font that didn't load,
a blocked request, or a page wider than its viewport, and names the widest element. On phone, and
on any page taller than its viewport, the portal's fixed bottom bar and toasts are drawn at the end
of the page (where they sit when it is scrolled down), so a full-page shot never paints them over
the content at the viewport's bottom line.

Open the PNGs and look at them, all eight (four sizes, both themes), before calling a screen done. If
`node_modules` is missing in the worktree, run `mise exec node@22 -- pnpm install --frozen-lockfile`
first; the renderer uses the Playwright the admin package already has.

After changing `build-kit.mjs`'s icon list or the brand tokens, run
`mise exec node@22 -- node tools/mockups/build-kit.mjs` (and `--check` to confirm the generated
blocks are current). Everything else in `mockup.css` is edited by hand.

## The update rule: mockup, build, compare

1. **Mockup.** A designer draws the screen and renders it; a UX designer subagent critiques the
   mockup visually and the result goes in `designReview`.
2. **Build.** A package that builds a mocked screen names its screen ids in its brief. When the
   screen is built, its builder saves screenshots of **the built screen**, in the same eight
   variants, to

   ```text
   /Users/vlad/Repos/pk-wt/_mockups/built/<screen-id>/{wide,desktop,tablet,phone}-{dark,light}.png
   ```

   at 1920×1080, 1440×900, 1024×768 and 390×844, full page, with the same fixture content as the
   mockup where the fixtures allow, and **names the screen ids in its hand-off**.

3. **Publish.** The lead uploads them to the mockups page and sets the screen's status
   (`building`, `built`, `shipped`) and the build it came from in the page's database, so the
   page needs no rebuild.
4. **Compare.** A UX designer subagent critiques the built screen against the mockup: it drives
   the real screen in a browser (every state, keyboard, phone), then walks the screen's `compare`
   list and the visuals side by side. Its verdict and findings are stored with the built
   screenshots and shown on the page. A difference is either fixed in the build or, when the
   build is right, taken back into the mockup in the same round.

A mockup that changes after review keeps its id; its `designReview` records the new round.

## Building the page

```sh
mise exec node@22 -- node tools/mockups/build.mjs /tmp/mockups.html
```

The lead publishes that file as the mockups artifact. Status, built screenshots, built-screen
reviews and notes come from the page's own database (collections `screens` and `notes`), so they
change without republishing; a new or changed mockup needs a rebuild and a republish.
