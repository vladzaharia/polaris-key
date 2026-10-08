# Mockup kit

One stylesheet, `mockup.css`, draws every mockup screen: the console, the customer portal,
terminal output, SDK code and in-app UI kits. It carries the brand tokens from
`packages/brand/css`, Rubik and JetBrains Mono as `data:` fonts, and the console's lucide icons, so
a screen needs no other file and makes no request.

To see every component in both themes and at phone width, render the gallery:

```sh
mise exec node@22 -- node tools/mockups/shoot.mjs --gallery --out /Users/vlad/Repos/pk-wt/_mockups/shots/kit
```

`kit/gallery.html` is also the place to copy markup from. Every snippet below is in it.

## Rules

- **Kit classes first.** Draw with the classes on this page. A screen may add a `<style>` block,
  scoped as `[data-screen="<id>"] .thing`, for layout the kit doesn't cover. Colours in it come
  from tokens (`var(--pk-*)`, `var(--mk-*)`), never hex values, so both themes work.
- **Both themes.** The renderer sets `data-theme="dark"` or `"light"` on `<html>`. Dark is the
  brand default. Never style for one theme only.
- **Two widths.** The body is a size container named `screen`. Below 1024px the console sidebar
  folds into the menu button; below 640px pages stack. Use `@container screen (max-width: 639px)`
  in a screen's own style block, never `@media`.
- **Weights.** Rubik at 400 and 700 only, as the console draws it. Radii: controls 6px, tiles
  10–14px, cards 18px, pills fully round.
- **Pills mean attention.** A pill is an issue or a neutral fact, always with an icon or a dot. A
  healthy state is `.status` text, never a pill (ADMIN.md §5.11).
- **Accent.** `data-service` on any element re-points the accent (`--pk-accent*`) and the service
  glyph for its subtree: `core`, `license`, `config`, `release`, `distribution`, `update`,
  `identity`, `sync`, `commerce` (commerce takes the distribution green).
  Inside `[data-service="commerce"]` `.link` and `.btn.link` are drawn in the strong text colour,
  because that green is close to the success green: the accent stays on chrome only.
- **Content.** Real names only: Polaris Key (the system product), DJDL and Diceroll; people on
  `example.com`; dates in October 2026. No lorem ipsum. Copy follows EXPERIENCE.md, ADMIN.md and
  PORTAL.md, in the words of the consolidation glossary.

## Tokens

| Group      | Tokens                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces   | `--pk-surface-page` `-raised` `-sunken` `-overlay`                                                                                                     |
| Text       | `--pk-text-strong` `-default` `-muted` `-subtle` `--pk-text-on-accent`                                                                                 |
| Lines      | `--mk-line` (hairlines), `--pk-border-strong` (controls)                                                                                               |
| Tone       | `--pk-success` `--pk-warning` `--pk-danger` `--pk-info`, each with `-subtle` `-border` `-on`; `--pk-signed*`                                            |
| Accent     | `--pk-accent` `-fg` (text on the page) `-on` (text on the accent) `-subtle`; per service `--pk-service-<name>` with the same suffixes                    |
| Kit only   | `--mk-fill` (hover, secondary button), `--mk-fill-strong`, `--mk-card-shadow`, `--mk-pop-shadow`, `--mk-scrim`, `--mk-code-*`, `--mk-syn-*`, `--mk-term-*` |
| Type       | `--pk-font-sans`, `--pk-font-mono`                                                                                                                      |
| Radius     | `--pk-radius-sm` `-md` `-lg` `-xl` `-full`                                                                                                              |
| Elevation  | `--pk-elevation-1` … `-3`                                                                                                                               |
| In-app kit | `--pk-kit-*` and the platform presets `data-pk-platform="ios|macos|android|windows|gnome|godot"` (packages/brand/css/kit.css) for `surface: "kit"` screens |

## Layout and text utilities

```html
<div class="row gap-2">…</div>            <!-- flex row, centred; .top .wrap .between -->
<div class="stack gap-3">…</div>          <!-- flex column -->
<div class="grid cols-3">…</div>          <!-- .cols-2 .cols-3 .cols-4 .auto (one column on phone) -->
<span class="grow"></span> <span class="ml-auto"></span> <span class="mt-4"></span>
<span class="muted small">Updated 1 min ago</span>
```

Gaps `.gap-0` `-1` `-2` `-3` `-4` `-6` `-8` (0–32px); margins `.mt-1` … `.mt-6`. Text `.strong`
`.muted` `.subtle` `.accent` `.text-success` `.text-warning` `.text-danger` `.bold` `.small` `.xs`
`.lg` `.mono` `.tnum` `.nowrap` `.truncate` `.center` `.right` `.sr-only`. `.hide-phone` and
`.show-phone` switch at 640px. `<code>` in prose and `<kbd>⌘K</kbd>` are styled.

## Icons and identity

```html
<i class="ic ic-key-round"></i>              <!-- 16px, currentColor; .xs .sm .lg .xl .xxl -->
<i class="svc" data-service="license"></i>   <!-- the service glyph in its accent; .sm .lg .xl -->
<i class="pk-mark"></i>                      <!-- the Pinned K for the theme; .sm .lg -->
<span class="logo" data-product="djdl"></span>   <!-- product tile: djdl, diceroll, polaris-key -->
<span class="logo">T</span>                  <!-- any other product: a monogram; .xs .sm .lg .xl -->
<div class="art" data-product="diceroll"></div>  <!-- portal cover art, 16:7 -->
<span class="avatar">MF</span>               <!-- .sm .lg .violet -->
```

`.svc` reads `data-service` from itself or any ancestor. Service glyphs: license key-round, config
sliders-horizontal, release package, distribution the Star Cut, update circle-arrow-up, identity
user-round, sync cloud, commerce store.

Platform and store marks: `ic-apple` `ic-windows` `ic-linux` `ic-android` `ic-steam` `ic-itch`
`ic-godot` `ic-app-store` `ic-google-play` `ic-microsoft-store`; brand: `ic-polaris` `ic-star-cut`.

Lucide icons (the console's set, so a mockup draws the glyph the built screen will): house boxes
box package package-check package-open key-round key key-square sliders-horizontal
sliders-vertical circle-arrow-up user-round users user-plus cloud cloud-upload cloud-download store
shopping-bag plug shield shield-check badge-check settings activity smartphone monitor laptop
layers git-branch git-pull-request git-commit-horizontal github search command book-open moon sun
chevron-down chevron-right chevron-left chevron-up chevrons-up-down arrow-right arrow-left
arrow-up-right arrow-down arrow-up external-link plus minus x check circle-check circle-check-big
circle circle-dot circle-plus circle-minus triangle-alert info circle-x ban clock circle-pause
refresh-cw copy download upload trash-2 pencil ellipsis ellipsis-vertical list-filter columns-3 eye
eye-off lock lock-open fingerprint mail globe link square-terminal terminal code-xml file-text
file-json file-code-2 file-lock folder inbox bell log-out panel-left-close panel-left-open menu
gamepad-2 disc-3 headphones music audio-waveform dice-5 rocket sparkles zap wand-sparkles server
database cpu wifi-off hourglass calendar calendar-clock timer repeat receipt credit-card wallet tag
ticket gift coins badge-percent circle-dollar-sign chart-line chart-column list list-checks
layout-grid table grip-vertical history send at-sign building-2 id-card qr-code archive puzzle
crown award flag toggle-right circle-help loader-circle image palette app-window workflow webhook
map-pin languages truck hammer wrench scroll-text layout-dashboard blocks monitor-smartphone
users-round lock-keyhole list-tree file-pen file-stack stamp waypoints grid-3x3 flask-conical
trending-up square-pen heart-pulse rss log-in server-cog gauge plug-zap arrow-right-left
circle-dashed git-merge user-check clipboard-check square wifi signal battery-full.

Need another? Add its lucide file name to `LUCIDE_ICONS` in `tools/mockups/build-kit.mjs` and run
`mise exec node@22 -- node tools/mockups/build-kit.mjs`.

## Console frame

```html
<div class="console" data-service="core">
  <header class="topbar">
    <button class="btn ghost icon menu-btn" aria-label="Menu"><i class="ic ic-menu lg"></i></button>
    <a class="brand" href="#"><i class="pk-mark"></i><span>Polaris Key</span></a>
    <div class="topbar-search"><i class="ic ic-search"></i><span>Search or jump to…</span><kbd>⌘K</kbd></div>
    <a class="topbar-link" href="#"><i class="ic ic-book-open"></i>Docs</a>
    <button class="btn ghost icon theme-btn" aria-label="Theme"><i class="ic ic-moon"></i></button>
    <span class="avatar violet">AL</span>
  </header>
  <nav class="sidebar" aria-label="DJDL">
    <div class="ctx">
      <span class="logo sm" data-product="djdl"></span>
      <span class="ctx-text"><span class="ctx-name">DJDL</span><span class="ctx-sub mono">djdl</span></span>
      <i class="ic ic-chevrons-up-down"></i>
    </div>
    <a class="nav-item active" href="#"><i class="ic ic-layout-dashboard"></i><span class="nav-text">Overview</span></a>
    <div class="nav-group" data-service="license">
      <div class="nav-label">Licensing<i class="ic ic-chevron-down sm"></i></div>
      <a class="nav-item" href="#"><i class="ic ic-key-round"></i><span class="nav-text">Licenses</span><span class="count">240</span></a>
    </div>
    <div class="sidebar-foot">
      <a class="nav-item" href="#"><i class="ic ic-settings"></i><span class="nav-text">Settings</span></a>
    </div>
  </nav>
  <main class="main"><div class="page">…</div></main>
</div>
```

- **Contexts (ST-45).** Platform: `.ctx` with `<span class="ctx-mark"><i class="ic ic-polaris"></i></span>`,
  "Platform", "3 products"; then Home, Members, Connections, Settings, Packages, Status, Activity.
  Product: the product's `.logo.sm`, name and slug; Overview, Integration, Access, Devices, Users,
  Activity, then one `.nav-group[data-service]` per enabled feature (`.closed` folds it to its
  label), Settings last in `.sidebar-foot`.
- `.sidebar-foot` sticks to the bottom of the first viewport, as in the console.
- `.page.narrow` (960px) and `.page.form` (760px) cap the width. `.env` / `.env.dev` is the
  environment tag in the top bar. `.nav-sep` is a divider.
- Phone: the sidebar is hidden and the menu button shows. To draw the open drawer, add `.nav-open`
  to `.console`.

## Page header

```html
<header class="page-head">
  <nav class="crumbs"><a href="#">Diceroll</a><i class="ic ic-chevron-right"></i>Offers</nav>
  <div class="page-heading"><h1>Licenses</h1><span class="count">240</span></div>
  <p class="page-sub">Standard and Studio · 3 waiting for an email</p>
  <div class="page-actions">
    <span class="freshness">Updated 1 min ago</span>
    <button class="btn outline">Export</button>
    <button class="btn primary"><i class="ic ic-plus"></i>New license</button>
  </div>
</header>
```

## Sections and cards

```html
<section class="section">
  <div class="section-head"><div><h2>Products</h2><p>Everything on this platform.</p></div><button class="btn outline sm">…</button></div>
  …
</section>

<section class="card">
  <div class="card-head">
    <span class="icon-tile"><i class="ic ic-code-xml"></i></span>
    <div class="title"><h2>Your app</h2><p>Swift on macOS.</p></div>
    <button class="btn outline sm">Change</button>
  </div>
  <div class="card-body">…</div>            <!-- .tight -->
  <div class="card-rows"><div class="card-row">…</div><div class="card-row">…</div></div>
  <div class="card-split wide-end"><div>…</div><div>…</div></div>   <!-- two panes, stacks on phone -->
  <div class="card-foot"><button class="btn primary">Save</button></div>   <!-- .start -->
</section>
```

Card variants: `.tile` `.flat` `.sunken` `.danger` `.accent-top` `.selected`; `.card-head.plain`
drops the rule. On phone a head's action drops under the title.

```html
<div class="stats">
  <div class="stat"><span class="stat-label"><i class="ic ic-key-round sm"></i>Licenses</span>
    <span class="stat-value">240</span><span class="stat-foot"><span class="delta-up">+12</span> this week</span></div>
</div>
<dl class="dl"><dt>Tier</dt><dd>Standard</dd></dl>          <!-- .dl.cols: <div><dt/><dd/></div> in columns -->
```

**Home product card** (ST-36, kept by ST-44): logo, name (the one link), slug, an attention pill
only when something needs attention, one row of service glyphs; pips beside the name on phone.

```html
<div class="product-cards">
  <article class="product-card">
    <div class="product-card-head">
      <span class="logo" data-product="diceroll"></span>
      <div class="grow"><h3><a href="#">Diceroll</a></h3>
        <div class="row gap-1"><span class="slug">diceroll</span><span class="pips"><i class="pip" data-service="license"></i>…</span></div></div>
      <span class="pill danger sm"><i class="ic ic-circle-x"></i>2 need attention</span>
    </div>
    <div class="product-card-svcs"><div class="svcs">
      <a href="#" title="Licensing"><i class="svc" data-service="license"></i></a>
      <a href="#" class="issue danger" title="Release: resync failed"><i class="svc" data-service="release"></i></a>
    </div></div>
  </article>
</div>
```

## Buttons

```html
<button class="btn primary"><i class="ic ic-plus"></i>New product</button>
<button class="btn">Cancel</button>                <!-- neutral fill -->
<button class="btn outline">Export CSV</button>
<button class="btn ghost">Refresh</button>
<button class="btn action"><i class="ic ic-rocket"></i>Promote to stable</button>
<button class="btn danger">Revoke license</button>
<button class="btn danger-outline">Remove device</button>
<a class="btn link" href="#">Open Catalog<i class="ic ic-arrow-right"></i></a>
<button class="btn ghost icon" aria-label="More"><i class="ic ic-ellipsis"></i></button>
<div class="segmented"><span class="on">Cards</span><span>Table</span></div>   <!-- .sm -->
```

Sizes `.sm` `.xs` `.lg`; `.block` fills the width; states `.busy` `.disabled` (or `[disabled]`)
`.focus`; `.btn-row` lays out a group. `.link` is an inline text link with an arrow.

## Pills, status, counts

```html
<span class="pill warning"><i class="ic ic-triangle-alert"></i>Expires in 9 days</span>
<span class="pill"><i class="dot"></i>System</span>
<span class="status"><i class="ic ic-circle-check"></i>Live</span>
<span class="count">240</span>
<span class="id"><i class="ic ic-key-round"></i>lic_8KQ2…7HJM<i class="ic ic-copy"></i></span>
<span class="slug">diceroll</span>
```

Pill tones `.warning` `.danger` `.info` `.success` `.accent` `.signed` `.outline`, size `.sm`.
Status tones `.warning` `.danger` `.info` `.muted` (default is success). Count tones `.warning`
`.danger` `.accent`. `.dot` (`.lg`) takes the current colour.

## Tables

```html
<div class="toolbar">
  <div class="search-field"><i class="ic ic-search"></i><span>Search licenses</span></div>
  <span class="filter on"><i class="ic ic-check"></i>Tier: Standard</span>
  <span class="filter"><i class="ic ic-plus"></i>Holder</span>
  <div class="end"><button class="btn outline sm">Export</button></div>
</div>
<div class="table-card">
  <table class="table">
    <thead><tr><th>Holder</th><th class="num">Devices</th><th class="end"></th></tr></thead>
    <tbody><tr><td><div class="cell-with-logo"><span class="avatar sm">MF</span>
      <div><div class="cell-title">Mara Fennick</div><div class="cell-sub">mara@example.com</div></div></div></td>
      <td class="num">2 of 5</td><td class="end"><span class="pill sm warning">…</span></td></tr></tbody>
  </table>
  <div class="table-foot">240 licenses<span class="ml-auto">1–50</span></div>
</div>
```

`.table.compact`, `tr.selected`, `tr.hover`, `th.check-col` with a `.check`. The card scrolls
sideways on phone.

## Forms

```html
<div class="form">
  <div class="field">
    <label class="field-label">Slug <span class="optional">Can't change later</span></label>
    <div class="input mono"><span class="grow">diceroll</span></div>
    <span class="hint">Lowercase letters, digits and hyphens.</span>
  </div>
  <div class="field invalid"><div class="input">…</div>
    <span class="error-text"><i class="ic ic-circle-x"></i>Say what went wrong and how to fix it.</span></div>
  <div class="select"><span class="grow">Standard</span><i class="ic ic-chevrons-up-down"></i></div>
  <div class="input"><span class="affix">$</span><span class="grow">4.99</span><span class="affix">USD</span></div>
  <div class="textarea"><span class="ph">Placeholder</span></div>
</div>
<span class="check on"><span class="box"></span>Email the customer their key</span>   <!-- .mixed -->
<span class="radio on"><span class="box"></span>Lifetime</span>
<span class="switch on"></span>                                                  <!-- .disabled -->
<div class="choices"><div class="choice on"><div class="choice-title">…</div><div class="choice-desc">…</div></div></div>
<span class="chip on"><i class="ic ic-apple"></i>iOS</span>
<div class="setting-row"><div><div class="setting-title">…</div><div class="setting-desc">…</div></div><span class="switch on"></span></div>
```

Fields: `.input.readonly`, `.input.sm`, `.input.invalid`, `.ph` for placeholder text. Controls
are drawn, not real inputs. `.choice.disabled`, `.choice.nocheck`.

## Tabs

```html
<nav class="tabs"><a class="tab active" href="#">Licenses <span class="count">240</span></a><a class="tab" href="#">Tiers</a></nav>
```

## Wizard, steps and progress

```html
<div class="wizard">
  <div class="wizard-head"><ol class="stepper">
    <li class="step done"><span class="step-mark"></span><span class="step-label">Repository</span></li>
    <li class="step current"><span class="step-mark"></span><span class="step-label">What it's for<small>Features and platforms</small></span></li>
    <li class="step"><span class="step-mark"></span><span class="step-label">Create</span></li>
  </ol></div>
  <div class="wizard-body"><h2>What is Diceroll for?</h2>…</div>
  <div class="wizard-foot"><button class="btn ghost">Back</button><button class="btn primary">Continue</button></div>
</div>

<div class="tasks">                                  <!-- .padded inside a card -->
  <div class="task done"><span class="task-mark"></span><div class="task-title">Signing key</div><div class="task-desc">…</div></div>
  <div class="task"><span class="task-mark"></span><div class="task-title">Connect Steam</div><div class="task-desc">…</div>
    <div class="task-action"><button class="btn outline sm">Connect</button></div></div>
</div>
<div class="progress success" style="--v: 40%"></div>   <!-- .warning; default accent -->
<div class="meter"><i class="on"></i><i class="on"></i><i></i></div>
```

Task states: none (to do), `.done`, `.waiting`, `.blocked`. `.stepper.vertical` stacks steps.

## Features and Integration

```html
<span class="icon-tile" data-service="sync"><i class="svc"></i></span>   <!-- .sm .lg .muted -->
<p class="eyebrow">In the console<span class="end">…</span></p>

<div class="platform-checks">
  <p class="eyebrow">Verified</p>
  <div class="platform-check"><span class="platform-name"><i class="ic ic-apple"></i>macOS</span>
    <span class="verified">Verified</span><span class="meta">Oct 7, 10:42 · Swift 2.1.0</span></div>
  <div class="platform-check"><span class="platform-name"><i class="ic ic-windows"></i>Windows</span>
    <span class="unseen">Not seen yet</span></div>
</div>

<section class="card feature-fold" data-service="config">     <!-- .add: dashed, for an off feature -->
  <span class="icon-tile sm"><i class="svc"></i></span>
  <div class="title"><h2>Managed config</h2><span class="status"><i class="ic ic-circle-check"></i>Verified on macOS</span></div>
  <button class="btn ghost sm">Show<i class="ic ic-chevron-down"></i></button>
</section>

<div class="setting-row with-icon" data-service="license">
  <span class="icon-tile"><i class="svc"></i></span>
  <div><div class="setting-title">Licensing</div><div class="setting-desc">…</div></div>
  <span class="switch on"></span>
</div>
```

Verified has three looks: `.verified` (tick), `.waiting-dot` (a neutral clock, never the accent,
"Waiting for the first sign-in"), `.unseen` (dashed ring, "Not seen yet"). `products.integration` is the
reference.

## Callouts, attention, empty states

```html
<div class="callout warning"><i class="ic ic-triangle-alert"></i>
  <div class="grow"><div class="callout-title">The Play key expires on Oct 16</div><div class="callout-text">Uploads to Google Play stop then.</div></div>
  <button class="btn outline sm">Replace key</button></div>
<div class="attn-row"><span class="pill danger"><i class="ic ic-circle-x"></i>Error</span>
  <span class="attn-subject"><span class="logo xs" data-product="diceroll"></span>Diceroll</span>
  <span class="attn-text">Resync from repo failed: …</span><a class="link" href="#">Open error<i class="ic ic-arrow-right"></i></a></div>
<div class="empty"><span class="empty-icon"><i class="svc"></i></span><h3>No offers yet</h3><p>…</p>
  <div class="btn-row"><button class="btn primary">New offer</button></div></div>
<span class="skeleton" style="width: 40%"></span> <span class="spinner"></span>
```

Callout tones: none (neutral), `.info` `.warning` `.danger` `.success` `.accent`. On phone a
callout's action goes under its text. A callout's actions are `.btn.outline` (and `.btn.ghost`
for Dismiss), never `.primary`: the page header keeps the page's one primary. Attention rows
live in `.card-rows` or a card.

## Menus, tooltips, dialogs, drawers, toasts

```html
<div class="popover-anchor"><button class="btn ghost icon">…</button>
  <div class="popover right"><div class="menu">
    <span class="menu-label">DJDL</span>
    <a class="menu-item active" href="#"><i class="ic ic-pencil"></i>Edit license<span class="end"><kbd>E</kbd></span></a>
    <div class="menu-sep"></div>
    <a class="menu-item danger" href="#"><i class="ic ic-ban"></i>Revoke</a>
  </div></div></div>
<span class="tooltip">Managed config: 1 needs attention</span>

<!-- last child of .console or .portal -->
<div class="overlay"><div class="dialog">                 <!-- .sm .lg .danger -->
  <div class="dialog-head"><h2>Turn off Licensing?</h2><button class="btn ghost icon sm"><i class="ic ic-x"></i></button></div>
  <div class="dialog-body"><p>Commerce needs Licensing, so it turns off too, in the same change:</p>
    <ul class="bullets"><li><strong>Commerce</strong>: …</li></ul></div>
  <div class="dialog-foot"><button class="btn">Cancel</button><button class="btn danger">Turn off Licensing and Commerce</button></div>
</div></div>

<!-- typed confirmation -->
<label class="field-label">Type <span class="confirm-word">diceroll</span> to confirm</label>
<div class="input mono focus"><span class="grow">dicer</span></div>

<div class="overlay end"><aside class="drawer"><div class="drawer-head"><h2>Device</h2></div>
  <div class="drawer-body">…</div><div class="drawer-foot">…</div></aside></div>

<div class="toasts"><div class="toast success"><i class="ic ic-circle-check"></i>
  <div class="grow"><div class="toast-title">Published catalog v4</div><div class="toast-text">…</div></div>
  <button class="btn ghost xs">Undo</button></div></div>
```

A confirmation names what else changes (a requirement turning off its dependents) and its button
says exactly what happens. Toast tones `.success` `.danger` `.warning` `.info`; `.toasts` sits at
the bottom right of the first viewport. In dark, a neutral `.btn` (Cancel) inside a dialog, drawer
or popover takes `--mk-fill-strong` and a hairline, because the plain fill is the overlay surface.

`.dialog.caution` (L1, ConfirmDialog `intent="caution"`) colours a leading `.ic` in the head
warning; `.dialog.danger` colours it danger.
`.confirm-word.neutral` is the typed word for an action that loses nothing (a price change).
`.sheet` on an overlay (`<div class="overlay sheet">`, `<div class="overlay end sheet">`) makes the
dialog or drawer a bottom sheet below 640px (ADMIN.md §Overlays): grab handle, rounded top, at most
90% of the screen tall with the body scrolling, buttons pinned at the bottom, primary on top.

## Code

```html
<div class="code">
  <div class="code-head">
    <div class="code-tabs"><span class="active">Swift<small>macOS</small></span><span>Kotlin<small>Windows</small></span>
      <span class="more">More<i class="ic ic-chevron-down"></i></span></div>
    <button class="btn ghost xs"><i class="ic ic-copy"></i>Copy</button>
  </div>
<pre><span class="t-k">let</span> client = <span class="t-k">try await</span> <span class="t-t">PolarisKeyClient</span>.<span class="t-f">fromConfig</span>()</pre>
  <div class="code-foot"><i class="ic ic-info sm"></i><span>Written for DJDL.</span></div>
</div>
<div class="cmd"><span>pnpm add @polaris-key/react</span><button class="btn ghost icon xs"><i class="ic ic-copy"></i></button></div>
```

Tokens: `t-k` keyword, `t-s` string, `t-f` function, `t-t` type, `t-n` number, `t-c` comment,
`t-p` property, `t-o` punctuation, `t-v` variable; `<span class="hl">` highlights a line.
`.code-file` names a file instead of tabs. Start `<pre>` at column 0 so the code isn't indented.
On phone, Copy keeps only its icon and the code scrolls inside its block.

## Terminal

```html
<div class="term">                                     <!-- .cols-80: exactly 80 columns -->
  <div class="term-bar"><span class="term-dots"><i></i><i></i><i></i></span><span class="term-title">zsh — diceroll</span></div>
<pre class="term-body"><span class="c-prompt">❯</span> pkey doctor
  <span class="c-ok">✓</span> polaris-key.json  <span class="c-dim">found, product diceroll</span>
<span class="c-chip"> 1 problem </span> <span class="cursor"></span></pre>
</div>
```

ANSI roles (packages/brand/src/tokens/terminal.ts): `c-accent` cyan, `c-ok` green, `c-warn`
yellow, `c-err` red, `c-info` magenta, `c-dim`, `c-b` bold, `c-u` link, `c-chip` inverse,
`c-prompt`. ✓ ✗ ○ and braille fall back to the system mono face.

## Customer portal

```html
<div class="portal" data-service="core">
  <header class="portal-top">
    <a class="portal-brand" href="#"><i class="pk-mark sm"></i>Polaris Key</a>
    <nav class="portal-nav"><a class="active" href="#">Library <span class="count">3</span></a><a href="#">Discover</a></nav>
    <div class="portal-actions"><button class="btn outline sm"><i class="ic ic-key-round"></i>Activate license</button>
      <span class="account"><span class="avatar sm">MF</span>Mara Fennick<i class="ic ic-chevron-down"></i></span></div>
  </header>
  <main class="portal-page"><h1>Your library</h1>
    <div class="ptiles"><article class="ptile">
      <div class="art" data-product="diceroll"></div>
      <div class="ptile-head"><span class="logo lg" data-product="diceroll"></span><span class="ptile-name">Diceroll</span></div>
      <div class="ptile-body"><span>Standard · 2 of 3 devices</span><span class="platforms"><i class="ic ic-apple"></i></span></div>
      <div class="ptile-foot"><button class="btn outline">Download</button></div>
    </article></div>
    <section class="license-card"><h2>DJDL license</h2>…<div class="key-field"><span>pkey_djdl_7HJM…Q2KD</span></div></section>
  </main>
  <footer class="portal-foot">Polaris Key · <a href="#">key.plrs.im</a></footer>
  <nav class="portal-tabbar"><a class="active" href="#"><i class="ic ic-layout-grid"></i>Library</a>
    <a class="act" href="#"><i class="ic ic-key-round"></i>Activate</a>
    <a href="#" aria-label="Discover, 1 to add"><i class="ic ic-sparkles"></i>Discover<span class="dot" aria-hidden="true"></span></a></nav>
</div>
```

The portal's real screens are in `packages/admin/e2e/__baselines__/portal/linux/`; match them.
`.portal-tabbar` shows only on phone, where the top nav hides: Library · Activate (`.act`, the
outlined pill, never a tab) · Discover (a `.dot` while there is something to add). In phone shots
the renderer draws the bar and any `.toasts` at the end of the page, and the footer keeps clear of
the bar.

## Frames and boards (surfaces kit, code, dialog)

```html
<div class="board">
  <div class="board-title"><h1>Diceroll paywall</h1><p>The Godot kit on iOS and Android.</p></div>
  <figure class="board-item">
    <div class="device"><div class="device-screen" data-pk-platform="ios">
      <div class="device-status"><span>9:41</span><span class="row gap-1"><i class="ic ic-signal"></i><i class="ic ic-wifi"></i><i class="ic ic-battery-full"></i></span></div>
      <div class="device-body">…</div></div></div>
    <figcaption><strong>iOS</strong>Light</figcaption>
  </figure>
</div>
<div class="window"><div class="window-bar"><span class="term-dots"><i></i><i></i><i></i></span>DJDL</div><div class="window-body">…</div></div>
<div class="window win"><div class="window-bar">DJDL<span class="window-controls"><i class="ic ic-minus"></i><i class="ic ic-square"></i><i class="ic ic-x"></i></span></div></div>
<div class="browser"><div class="browser-bar"><span class="term-dots"><i></i><i></i><i></i></span><span class="url"><i class="ic ic-lock"></i>key.plrs.im/djdl</span></div>…</div>
<span class="anno">1</span>   <!-- numbered pin; .at + inline top/left to place it; refer to it in "compare" -->
```

`.device.android` is a 412×915 Android phone. A `data-pk-platform` preset on a frame's screen
applies that platform's in-app kit measures.
