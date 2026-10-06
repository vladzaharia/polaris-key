// FLOWS.md mockups: the New Product wizard (§3). `node docs/design/flows/_src/build.mjs` writes
// ../NN-*.html; `render.cjs` shoots them at 1440 × 900 and 390 × 844 in dark and light into
// ../shots/. Static HTML/CSS, no script but the ?theme= switch, the same chrome and wizard pieces
// as the SETUP.md mockups (setup/_src, copied unchanged), plus flows.css.
//
// Fixture: Tonebox, a Godot app by Acme that ships macOS and iOS, in acme/tonebox.
import fs from "node:fs";
import path from "node:path";
import { icon } from "./icons.mjs";

const SRC = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(SRC, "..");
const MARK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="var(--pk-service-core)" d="M3 4 L9 1 L9 19 L3 22 Z"/><path fill="var(--pk-service-core)" d="M11 12 L15 12 L21 18 L18 21 L11 14 Z"/><path fill="currentColor" d="M17 1 L19 4 L23 6 L19 8 L17 11 L15 8 L11 6 L15 4 Z"/></svg>`;
// The success sparks are small separate stars; the Polaris star itself never moves (BRAND §7.5).
const SPARK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1 L14.5 9.5 L23 12 L14.5 14.5 L12 23 L9.5 14.5 L1 12 L9.5 9.5 Z"/></svg>`;
// Tonebox's icon, as `.pkey/product` presentation.icon would provide it (HA-04): a speaker cone.
const TONEBOX = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="3"/><circle cx="12" cy="14" r="4"/><circle cx="12" cy="14" r="1" fill="currentColor"/><circle cx="12" cy="6.5" r="1.2" fill="currentColor"/></svg>`;

function write(file, title, service, body) {
  fs.writeFileSync(
    path.join(OUT, file),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · Polaris Key</title>
<script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);})();</script>
<link rel="stylesheet" href="../../../packages/brand/fonts/fonts.css">
<link rel="stylesheet" href="../../../packages/brand/css/tokens.css">
<link rel="stylesheet" href="_src/portal.css">
<link rel="stylesheet" href="_src/console.css">
<link rel="stylesheet" href="_src/exp.css">
<link rel="stylesheet" href="_src/setup.css">
<link rel="stylesheet" href="_src/flows.css">
</head>
<body class="console" data-service="${service}">
${body}
</body>
</html>
`,
  );
}

// ---------------------------------------------------------------- chrome
function ctop(crumbs) {
  return `<header class="ctop">
    <button class="btn btn-ghost btn-icon navbtn" type="button" aria-label="Open navigation">${icon("menu")}</button>
    <span class="mark">${MARK}</span><span class="wm">Polaris Key</span>
    <nav class="crumbs" aria-label="Breadcrumb">${icon("chevRight")}${crumbs.map((c, i) => (i === crumbs.length - 1 ? `<b>${c}</b>` : `<span>${c}</span>${icon("chevRight")}`)).join("")}</nav>
    <button class="ksearch" type="button" aria-keyshortcuts="Meta+K">${icon("search", { size: 16 })}<span class="grow">Search or jump to…</span><kbd>⌘K</kbd></button>
    <button class="cav" type="button" aria-label="Account menu">VZ</button>
  </header>`;
}
// The global sidebar: no product is selected while one is being created.
function globalSide() {
  return `<aside class="side" aria-label="Polaris Key">
    <a class="sitem" href="#">${icon("home")}Home</a>
    <a class="sitem" href="#" aria-current="page">${icon("grid")}Products</a>
    <div class="shead closed">Platform${icon("chevRight")}</div>
  </aside>`;
}
const NAV = [
  [
    "Core",
    [
      ["Overview", "home"],
      ["Connect your app", "plug"],
      ["Devices", "laptop"],
      ["Keys & secrets", "key"],
      ["Activity", "history"],
      ["Settings", "settings"],
    ],
  ],
  [
    "License",
    [
      ["Licenses", "idcard"],
      ["Tiers", "layers"],
    ],
  ],
  [
    "Release",
    [
      ["Releases", "package"],
      ["Channels", "arrowsUD"],
    ],
  ],
  [
    "Distribution",
    [
      ["Storefronts", "store"],
      ["Rollouts", "play"],
    ],
  ],
  ["Update", [["Update feed", "refresh"]]],
];
function productSide(item, progress) {
  return `<aside class="side" aria-label="Tonebox">
    <button class="pswitch" type="button" aria-haspopup="listbox"><span class="ptile sm">${TONEBOX}</span><span class="grow"><span class="pn">Tonebox</span><br><span class="pm">${progress}</span></span>${icon("arrowsUD", { size: 16 })}</button>
    ${NAV.map(([label, items]) => {
      const open = items.some(([t]) => t === item);
      return open
        ? `<div class="shead">${label}${icon("chevDown")}</div>${items.map(([t, i]) => `<a class="sitem" href="#" ${t === item ? 'aria-current="page"' : ""}>${icon(i)}${t}</a>`).join("")}`
        : `<div class="shead closed">${label}${icon("chevRight")}</div>`;
    }).join("")}
  </aside>`;
}
function page({
  file,
  title,
  service = "core",
  crumbs,
  main,
  side = globalSide(),
}) {
  write(
    file,
    title,
    service,
    `${ctop(crumbs)}<div class="shell">${side}<main class="main" id="content"><div class="mainin">${main}</div></main></div>`,
  );
}

const B = (t, cls = "btn-secondary", i = "", extra = "") =>
  `<a class="btn ${cls}" href="#" ${extra}>${i ? icon(i) : ""}${t}</a>`;
const src = (i, t) => `<span class="src">${icon(i)}${t}</span>`;
const auto = (t, i = "wand") => `<span class="autobadge">${icon(i)}${t}</span>`;
const plat = (i, t, on = false) =>
  `<span class="chip ${on ? "on" : ""}">${icon(i)}${t}</span>`;
const arow = (st, t, d, via = "") =>
  `<div class="qrow ${st === "done" ? "ok auto" : st === "run" ? "run auto" : st === "perm" ? "na" : st === "warn" ? "na" : "na auto"}"><span class="qk">${st === "done" ? icon("check") : st === "perm" ? icon("lock") : st === "warn" ? icon("info") : st === "run" ? "" : icon("clock")}</span><div class="qt"><b>${t}</b><span>${d}</span></div>${via ? `<span class="via">${via}</span>` : ""}</div>`;
const autolist = (title, rows, right = "") =>
  `<div class="autolist"><header>${icon("wand")}${title}${right ? `<span class="r">${right}</span>` : ""}</header>${rows.join("")}</div>`;

// Human steps are numbered; Polaris Key's work is an unnumbered ✦ marker (SETUP.md D33).
function stepper(items) {
  const human = items.filter(([, , a]) => !a);
  const curIdx = human.findIndex(([, st]) => st === "cur");
  let n = 0;
  const li = items
    .map(([t, st, a, by]) => {
      const num = a ? 0 : ++n;
      const mark = a
        ? icon("wand")
        : st === "done"
          ? icon("check")
          : String(num);
      return `<li class="${a ? "auto " : ""}${st}" ${st === "cur" ? 'aria-current="step"' : ""}><span class="sx">${mark}</span>${t}${by ? ` <span class="by">${by}</span>` : ""}</li>`;
    })
    .join("");
  const cur =
    curIdx >= 0 ? human[curIdx][0] : items.find(([, st]) => st === "cur")[0];
  const meta =
    curIdx >= 0
      ? `Step ${curIdx + 1} of ${human.length} for you`
      : "Polaris Key is working";
  return `<ol class="stepper" aria-label="New product steps">${li}</ol><div class="stepm">${icon("chevDown")}${cur}<span class="muted">${meta}</span></div>`;
}
const nphd = (meta) =>
  `<div class="nphd"><a class="back" href="#">${icon("arrowLeft")}Products</a><h1>New product</h1><span class="meta">${meta}</span></div>`;

const GH_STEPS = (s) => [
  ["Where it starts", s === 0 ? "cur" : "done"],
  ["Check Tonebox", s === 1 ? "cur" : s > 1 ? "done" : ""],
  ["Created", s === 2 ? "cur" : "", true, "by Polaris Key"],
  ["Launch path", "", true, "next"],
];
const SC_STEPS = (s) => [
  ["Where it starts", s === 0 ? "cur" : "done"],
  ["Name it", s === 1 ? "cur" : s > 1 ? "done" : ""],
  ["What it’s for", s === 2 ? "cur" : s > 2 ? "done" : ""],
  ["Created", s === 3 ? "cur" : "", true, "by Polaris Key"],
];

// ---------------------------------------------------------------- 60 · Where it starts (GitHub)
const rrow = (repo, sub, right, on = false, ic = "github") =>
  `<div class="rrow ${on ? "on" : ""}"><span class="rk">${icon(ic)}</span><div class="rt"><b>${repo}</b><span>${sub}</span></div><span class="rr">${right}</span></div>`;
const start60 = `
  ${nphd("Step 1 of 2 for you")}
  ${stepper(GH_STEPS(0))}
  <div class="wzgrid">
    <section class="wzbody">
      <header><h2>Where does it start?</h2><p>Polaris Key reads everything else from the repository.</p></header>
      <div class="starts" role="radiogroup" aria-label="Start from">
        <div class="start on" role="radio" aria-checked="true"><span class="si">${icon("github")}</span><div><b>A GitHub repository</b><span class="d">Name, platforms, services and icon come from <span class="mono">.pkey/</span></span><div class="rec">${auto("Recommended · the Polaris Key app is on acme")}</div></div><span class="radio2 on"></span></div>
        <div class="start" role="radio" aria-checked="false"><span class="si">${icon("plus")}</span><div><b>From scratch</b><span class="d">A name and what it ships. Link a repository any time</span></div><span class="radio2"></span></div>
      </div>
      <div class="nppicker" role="listbox" aria-label="Repositories the Polaris Key app can read">
        <div class="ps">${icon("search")}<span>Search repositories or paste owner/repo</span><span class="acct">${icon("github")}acme · 14 repositories</span></div>
        ${rrow("acme/tonebox", "Godot · pushed 2 hours ago", `${auto("Has .pkey/", "check")}`, true)}
        ${rrow("acme/beatgrid", "Already a product · Beatgrid", `<span class="plain">Open product →</span>`, false, "package")}
        ${rrow("acme/tidepool", "Swift · pushed yesterday", `<span class="plain">No .pkey/ yet · Polaris Key adds it</span>`)}
        ${rrow("acme/website", "Astro · pushed 3 days ago", `<span class="plain">No .pkey/ yet</span>`)}
        <footer>${icon("info")}<span>Not listed? <a href="#">Add the Polaris Key app to another account or repository</a></span></footer>
      </div>
    </section>
    <aside class="wzaside"><h3>What a repository gives you</h3><p>Polaris Key reads <span class="mono">.pkey/product</span>, <span class="mono">.pkey/release</span> and <span class="mono">.pkey/schema</span> on the default branch, and keeps them in sync on every push.</p><p><b>Read-only</b></p><p>The app reads files and Actions runs. It never pushes to a branch it did not create.</p><p><b>No repository yet?</b></p><p>Start from scratch. Linking one later reads the same files.</p><a href="#">Products in the docs</a></aside>
  </div>
  <div class="wzfoot"><a class="btn btn-ghost" href="#">Cancel</a><span class="grow"></span>${B("Read acme/tonebox", "btn-primary")}</div>`;
page({
  file: "60-new-product-start.html",
  title: "New product",
  crumbs: ["Products", "New product"],
  main: `<div class="npwrap">${start60}</div>`,
});

// ---------------------------------------------------------------- 61 · Check Tonebox (from the repository)
const preview = (slugLine) =>
  `<div class="pcard"><span class="ptile">${TONEBOX}</span><div class="npt"><b>Tonebox</b><div class="npln"><span class="mono">tonebox</span>${slugLine}<span>${icon("github", { size: 14 })} acme/tonebox · main</span></div></div>${src("fileText", "from .pkey/product")}</div>`;
const check61 = `
  ${nphd("Step 2 of 2 for you")}
  ${stepper(GH_STEPS(1))}
  <div class="wzgrid">
    <section class="wzbody">
      <header><h2>Check Tonebox</h2><p>This is what Polaris Key read from acme/tonebox just now.</p></header>
      ${preview(`<span class="okline">${icon("check")}Available</span>`)}
      <div class="npfound prl">
        <header>${icon("check")}Read from the repository<span class="r">8 s ago · <a href="#">Read again</a></span></header>
        ${arow("done", "Ships macOS and iOS", "Godot export presets in export_presets.cfg · <a href='#'>Change</a>", "detected")}
        ${arow("done", "License, Release, Distribution and Update", "services in .pkey/product", "manifest")}
        ${arow("done", "Catalog with 12 keys", ".pkey/schema · becomes catalog v1", "manifest")}
        ${arow("done", "Icon and accent", "presentation.icon and accent in .pkey/product", "manifest")}
        ${arow("warn", "1 secret to set after creating", "SENTRY_AUTH_TOKEN · crash-rate auto-halt needs it; nothing else waits for it", "")}
      </div>
      ${autolist(
        "Polaris Key will set this up",
        [
          arow(
            "will",
            "Mint and activate the signing key tonebox-2026",
            "Ed25519, sealed under the platform key",
          ),
          arow(
            "will",
            "Reserve dl.plrs.im/tonebox",
            "The Polaris Key storefront; listed in Discover after the first release",
          ),
          arow(
            "will",
            "Create the Free tier",
            "No expiry · 3 devices, the manifest’s default · Change it in Tiers",
          ),
          arow(
            "will",
            "Trust the release workflow",
            ".github/workflows/release.yml on v* tags in acme/tonebox",
          ),
          arow(
            "will",
            "Keep Tonebox in sync with every push to main",
            "Through the Polaris Key app",
          ),
        ],
        "on Create",
      )}
    </section>
    <aside class="wzaside"><h3>Why there is nothing to fill in</h3><p>The repository already answers every question. To change the name, slug or platforms, change <span class="mono">.pkey/</span> and push; this page reads it again by itself.</p><p><b>After this</b></p><p>Tonebox opens on its launch path: connect your app, then the storefronts for macOS and iOS.</p><a href="#">The .pkey/ manifest in the docs</a></aside>
  </div>
  <div class="wzfoot"><a class="btn btn-ghost ghost-m" href="#">Cancel</a><span class="grow"></span>${B("Back", "btn-secondary", "arrowLeft")}${B("Create Tonebox", "btn-primary")}</div>`;
page({
  file: "61-new-product-check.html",
  title: "New product",
  crumbs: ["Products", "New product"],
  main: `<div class="npwrap">${check61}</div>`,
});

// ---------------------------------------------------------------- 61b · Check Tonebox: the manifest has problems
const prob = (file, msg) =>
  `<div class="prob"><span class="pk">${icon("x")}</span><div><span class="pf">${file}</span><span class="pm">${msg}</span></div></div>`;
const check61b = `
  ${nphd("Step 2 of 2 for you")}
  ${stepper(GH_STEPS(1))}
  <div class="wzgrid">
    <section class="wzbody">
      <header><h2>Check Tonebox</h2><p>Two lines in .pkey/ need a change before Tonebox can be created.</p></header>
      <div class="pcard"><span class="ptile">T</span><div class="npt"><b>Tonebox</b><div class="npln"><span class="mono">tonebox-app</span><span>${icon("github", { size: 14 })} acme/tonebox · main</span></div></div>${src("fileText", "from .pkey/product")}</div>
      <div class="npfound prl bad">
        <header>${icon("alert")}Fix these in one commit<span class="r"><a href="#">Open .pkey/ on GitHub</a></span></header>
        ${prob(".pkey/product · product.slug", "tonebox-app is taken by another product. Use another slug, such as tonebox-studio.")}
        ${prob(".pkey/release · artifacts.ios", "The iOS artifact needs a bundleId, for example com.acme.tonebox.")}
      </div>
      <div class="livewait"><span class="pulse"></span><div>Watching acme/tonebox for a push…<span class="s">This step checks again by itself when main changes. <a href="#">Check now</a></span></div></div>
      <p class="stepnote">${icon("terminal")}<span>Or fix and check locally: <span class="mono">pkey validate</span></span></p>
    </section>
    <aside class="wzaside"><h3>Why it waits</h3><p>The manifest is the source of truth, so the fix belongs in the repository, not on this page.</p><p><b>Nothing was created</b></p><p>Leave and come back: this page keeps your place.</p><a href="#">Manifest errors in the docs</a></aside>
  </div>
  <div class="wzfoot"><a class="btn btn-ghost ghost-m" href="#">Cancel</a><span class="grow"></span>${B("Back", "btn-secondary", "arrowLeft")}<a class="btn btn-primary" href="#" aria-disabled="true">Create Tonebox</a></div>`;
page({
  file: "61b-new-product-problems.html",
  title: "New product",
  crumbs: ["Products", "New product"],
  main: `<div class="npwrap">${check61b}</div>`,
});

// ---------------------------------------------------------------- 62 · Name it (from scratch)
const name62 = `
  ${nphd("Step 2 of 3 for you")}
  ${stepper(SC_STEPS(1))}
  <div class="wzgrid">
    <section class="wzbody">
      <header><h2>Name it</h2><p>The slug is permanent: it is in every license key and URL.</p></header>
      <div class="fld"><label for="n">Name</label><div class="fin focus" id="n">Tonebox</div></div>
      <div class="fld"><label for="s">Slug ${src("wand", "from the name")}</label><div class="fin" id="s"><span class="mono">tonebox</span><span class="ok">${icon("check")}Available</span></div><span class="fhelp">Keys look like <span class="mono">pkey_tonebox_…</span> · <span class="mono">dl.plrs.im/tonebox</span></span></div>
      <div class="fld"><label>Icon and accent ${src("wand", "from the name")}</label>
        <div class="idrow"><span class="ptile">T</span><div class="ic"><div class="swatches" role="radiogroup" aria-label="Accent"><span class="npsw a-core" role="radio" aria-checked="false" aria-label="Violet"></span><span class="npsw a-license" role="radio" aria-checked="false" aria-label="Amber"></span><span class="npsw a-config" role="radio" aria-checked="false" aria-label="Gold"></span><span class="npsw a-release on" role="radio" aria-checked="true" aria-label="Teal"></span><span class="npsw a-distribution" role="radio" aria-checked="false" aria-label="Green"></span><span class="npsw a-update" role="radio" aria-checked="false" aria-label="Blue"></span><span class="npsw a-identity" role="radio" aria-checked="false" aria-label="Rose"></span></div><span class="fhelp">Upload an icon from Presentation once Tonebox exists, or let the repository provide one.</span></div></div>
      </div>
    </section>
    <aside class="wzaside"><h3>Where the name shows</h3><p>The console, the download page, the customer portal and the sign-in card your customers see.</p><p><b>Changing it later</b></p><p>The name and icon change any time. The slug never does.</p><a href="#">Products in the docs</a></aside>
  </div>
  <div class="wzfoot"><a class="btn btn-ghost ghost-m" href="#">Cancel</a><span class="grow"></span>${B("Back", "btn-secondary", "arrowLeft")}${B("Continue", "btn-primary")}</div>`;
page({
  file: "62-new-product-name.html",
  title: "New product",
  crumbs: ["Products", "New product"],
  main: `<div class="npwrap">${name62}</div>`,
});

// ---------------------------------------------------------------- 63 · What it's for (from scratch)
const goal = (on, ic, svc, t, d, sub = "") =>
  `<div class="goal ${on ? "on" : ""}" role="checkbox" aria-checked="${on}"><span class="gi" style="background:var(--pk-service-${svc}-subtle);color:var(--pk-service-${svc}-fg)">${icon(ic)}</span><div><b>${t}</b><span>${d}</span>${sub}</div><span class="cbx">${on ? icon("check") : ""}</span></div>`;
const purpose63 = `
  ${nphd("Step 3 of 3 for you")}
  ${stepper(SC_STEPS(2))}
  <div class="wzgrid">
    <section class="wzbody">
      <header><h2>What is Tonebox for?</h2><p>Pick all that apply. Each turns on what it needs, and you can change it any time.</p></header>
      <div class="goals np">
        ${goal(true, "idcard", "license", "Sell it with licenses", "Tiers, keys, device limits", `<div class="sub"><i class="mswitch on" role="switch" aria-checked="true" aria-label="Start with a free tier"></i>Start with a free tier · Recommended</div>`)}
        ${goal(true, "rocket", "release", "Ship builds and updates", "Signed releases, storefronts, auto-update")}
        ${goal(false, "book", "config", "Remote config and flags", "Change settings without a release")}
        ${goal(false, "shieldUser", "identity", "Customer sign-in", "Accounts and a customer portal")}
        ${goal(false, "package", "distribution", "Publish packages", "npm, PyPI, Swift and more")}
      </div>
      <div class="q"><h2 style="font-size:15px">What does it ship?</h2><p>Storefronts follow these: a Mac app never sees the Play Store.</p>
        <div class="chips">${plat("apple", "macOS", true)}${plat("iphone", "iOS", true)}${plat("android", "Android")}${plat("windows", "Windows")}${plat("linux", "Linux")}${plat("globe", "Web")}</div>
      </div>
      <a class="discl" href="#">${icon("chevRight")}License defaults: 30 days offline, 5 devices</a>
      ${autolist(
        "Polaris Key will set this up",
        [
          arow(
            "will",
            "Mint and activate the signing key tonebox-2026",
            "Ed25519, sealed under the platform key",
          ),
          arow(
            "will",
            "Turn on License, Release, Distribution and Update",
            "Release and Distribution come with Update",
          ),
          arow("will", "Create the Free tier", "No expiry · 5 devices"),
          arow(
            "will",
            "Reserve dl.plrs.im/tonebox",
            "Listed in Discover after the first release",
          ),
        ],
        "on Create",
      )}
    </section>
    <aside class="wzaside"><h3>Why ask now</h3><p>Your answers build Tonebox’s launch path, so the first screen after Create is the next thing to do, not a page of switches.</p><p><b>Not sure?</b></p><p>Pick nothing and choose services later in Settings.</p><a href="#">Services in the docs</a></aside>
  </div>
  <div class="wzfoot"><a class="btn btn-ghost ghost-m" href="#">I’ll choose later</a><span class="grow"></span>${B("Back", "btn-secondary", "arrowLeft")}${B("Create Tonebox", "btn-primary")}</div>`;
page({
  file: "63-new-product-purpose.html",
  title: "New product",
  crumbs: ["Products", "New product"],
  main: `<div class="npwrap">${purpose63}</div>`,
});

// ---------------------------------------------------------------- 64 · Creating (Polaris Key at work)
const creating64 = `
  ${nphd("Polaris Key is working")}
  ${stepper([
    ["Where it starts", "done"],
    ["Check Tonebox", "done"],
    ["Created", "cur", true, "by Polaris Key"],
    ["Launch path", "", true, "next"],
  ])}
  <div class="wzgrid">
    <section class="wzbody creating" aria-busy="true">
      <div class="ch"><span class="ptile">${TONEBOX}</span><div><h2>Creating Tonebox…</h2><p>About two seconds. Stay here or leave: it finishes either way.</p></div></div>
      <div class="meter2" aria-hidden="true"><i></i></div>
      ${autolist(
        "Polaris Key does this",
        [
          arow(
            "done",
            "Tonebox registered from acme/tonebox",
            "tonebox · main at 4c1e9a2",
            "GitHub App",
          ),
          arow(
            "done",
            "Signing key tonebox-2026 minted and active",
            "Ed25519 · sealed",
            "keyvault",
          ),
          arow(
            "done",
            "Catalog v1 imported",
            "12 keys from .pkey/schema",
            "manifest",
          ),
          arow("run", "Creating the Free tier", "No expiry · 3 devices"),
          arow("will", "Trust the release workflow", "release.yml on v* tags"),
          arow("will", "Reserve dl.plrs.im/tonebox", "Polaris Key storefront"),
        ],
        "3 of 6 done",
      )}
      <p class="stepnote" role="status">${icon("info")}<span>Signing key tonebox-2026 minted and active.</span></p>
    </section>
    <aside class="wzaside"><h3>All or nothing</h3><p>Tonebox, its signing key and its catalog are created together. The rows after them retry by themselves, and any that cannot finish wait on the launch path with their fix.</p></aside>
  </div>`;
page({
  file: "64-new-product-creating.html",
  title: "New product",
  crumbs: ["Products", "New product"],
  main: `<div class="npwrap">${creating64}</div>`,
});

// ---------------------------------------------------------------- 65 · Ready: Overview with the welcome and the launch path
const step = (cls, t, go = "", o = "") =>
  `<div class="step ${cls}"><span class="sx">${cls.includes("done") ? icon("check") : ""}</span><span>${t}${o ? `<span class="o">${o}</span>` : ""}</span>${go ? `<span class="go">${go}</span>` : ""}</div>`;
const sparks = [1, 2, 3, 4, 5, 6, 7, 8]
  .map((n) => `<span class="npspark s${n}">${SPARK}</span>`)
  .join("");
const ready65 = `
  <section class="hero2" aria-labelledby="ready-title">
    <div class="tilewrap">${sparks}<span class="ptile lg">${TONEBOX}</span><span class="npchk">${icon("check")}</span></div>
    <div>
      <h1 id="ready-title">Tonebox is ready</h1>
      <div class="facts">
        <span>${icon("sealCheck")}Signed by <span class="mono">tonebox-2026</span> ${icon("copy")}</span>
        <span>${icon("github")}In sync with <span class="mono">acme/tonebox</span></span>
        <span>${icon("globe")}<span class="mono">dl.plrs.im/tonebox</span> reserved</span>
        <span>${icon("layers")}Free tier</span>
      </div>
    </div>
    <div class="nexts">${B("Connect your app", "btn-primary", "plug")}${B("Get on storefronts", "btn-secondary", "store")}</div>
  </section>
  <section class="launch">
    <header><h2>Launch Tonebox</h2><div class="r"><span>2 of 6</span><span class="lbar"><i class="on"></i><i class="on"></i><i></i><i></i><i></i><i></i></span></div></header>
    <div class="phases">
      <div class="phase"><h3>Basics</h3>${step("done", "Product created")}${step("next", "Connect your app", icon("arrowRight"))}${step("", "Presentation", "", "optional")}</div>
      <div class="phase"><h3>License</h3>${step("done", "Create tiers", "", "Free")}${step("", "First license")}${step("", "Add a paid tier", "", "optional")}</div>
      <div class="phase"><h3>Ship</h3>${step("", "First signed release")}${step("", "Deliver updates")}</div>
      <div class="phase"><h3>Reach</h3>${step("", "Get on storefronts", "", "optional · macOS and iOS")}</div>
    </div>
  </section>
  <p class="stepnote">${icon("info")}<span>1 secret is not set: <a href="#">SENTRY_AUTH_TOKEN</a>. Crash-rate auto-halt waits for it; nothing else does.</span></p>`;
page({
  file: "65-new-product-ready.html",
  title: "Tonebox",
  crumbs: ["Tonebox", "Overview"],
  main: ready65,
  side: productSide("Overview", "Launch · 2 of 6"),
});

console.log("built");
