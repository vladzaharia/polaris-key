// SETUP.md mockups. `node docs/design/setup/_src/build.mjs` writes ../NN-*.html; `render.cjs` shoots
// them at 1440 × 900 and 390 × 844 in dark and light into ../shots/. Static HTML/CSS, no script but
// the ?theme= switch, the same chrome as the EXPERIENCE.md mockups, the IA of SETUP.md §2.2.
import fs from "node:fs";
import path from "node:path";
import { icon } from "./icons.mjs";

const SRC = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(SRC, "..");
const MARK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="var(--pk-service-core)" d="M3 4 L9 1 L9 19 L3 22 Z"/><path fill="var(--pk-service-core)" d="M11 12 L15 12 L21 18 L18 21 L11 14 Z"/><path fill="currentColor" d="M17 1 L19 4 L23 6 L19 8 L17 11 L15 8 L11 6 L15 4 Z"/></svg>`;

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
</head>
<body class="console" data-service="${service}">
${body}
</body>
</html>
`,
  );
}

// ---------------------------------------------------------------- chrome (SETUP.md §2.2 IA)
const NAV = [
  [
    "Core",
    "core",
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
    "license",
    [
      ["Licenses", "idcard"],
      ["Tiers", "layers"],
    ],
  ],
  [
    "Config",
    "config",
    [
      ["Catalog", "book"],
      ["Profiles", "user"],
      ["Edge mint", "sparkCode"],
    ],
  ],
  [
    "Release",
    "release",
    [
      ["Releases", "package"],
      ["Channels", "arrowsUD"],
      ["Deliverables", "disc"],
      ["Compatibility", "grid"],
    ],
  ],
  [
    "Distribution",
    "distribution",
    [
      ["Storefronts", "store"],
      ["Rollouts", "play"],
      ["Health", "activity"],
      ["Packages", "package"],
    ],
  ],
  ["Update", "update", [["Update feed", "refresh"]]],
];
function side(item, progress) {
  return `<aside class="side" aria-label="Tonebox">
    <button class="pswitch" type="button" aria-haspopup="listbox"><span class="appicon"><span class="lettertile">T</span></span><span class="grow"><span class="pn">Tonebox</span><br><span class="pm">${progress}</span></span>${icon("arrowsUD", { size: 16 })}</button>
    ${NAV.map(([label, , items]) => {
      const open = items.some(([t]) => t === item);
      return open
        ? `<div class="shead">${label}${icon("chevDown")}</div>${items.map(([t, i]) => `<a class="sitem" href="#" ${t === item ? 'aria-current="page"' : ""}>${icon(i)}${t}</a>`).join("")}`
        : `<div class="shead closed">${label}${icon("chevRight")}</div>`;
    }).join("")}
  </aside>`;
}
function ctop(crumbs) {
  return `<header class="ctop">
    <button class="btn btn-ghost btn-icon navbtn" type="button" aria-label="Open navigation">${icon("menu")}</button>
    <span class="mark">${MARK}</span><span class="wm">Polaris Key</span>
    <nav class="crumbs" aria-label="Breadcrumb">${icon("chevRight")}${crumbs.map((c, i) => (i === crumbs.length - 1 ? `<b>${c}</b>` : `<span>${c}</span>${icon("chevRight")}`)).join("")}</nav>
    <button class="ksearch" type="button" aria-keyshortcuts="Meta+K">${icon("search", { size: 16 })}<span class="grow">Search or jump to…</span><kbd>⌘K</kbd></button>
    <button class="cav" type="button" aria-label="Account menu">VZ</button>
  </header>`;
}
function page({
  file,
  title,
  service,
  item,
  crumbs,
  main,
  overlay = "",
  progress = "Launch · 7 of 10",
}) {
  write(
    file,
    title,
    service,
    `${ctop(crumbs)}<div class="shell">${side(item, progress)}<main class="main" id="content"><div class="mainin">${main}</div></main></div>${overlay}`,
  );
}
const B = (t, cls = "btn-secondary", i = "", extra = "") =>
  `<a class="btn ${cls}" href="#" ${extra}>${i ? icon(i) : ""}${t}</a>`;
const pill = (t, tone = "warn", i = "alert") =>
  `<span class="status s-${tone}">${icon(i)}${t}</span>`;
const SG = {
  pk: `<span class="sg pkk">${MARK}</span>`,
};
const sg = (k, size = "") =>
  k === "polaris-key"
    ? `<span class="sg pkk ${size}">${MARK}</span>`
    : `<span class="sg ${size}">${icon(k)}</span>`;
const src = (i, t) => `<span class="src">${icon(i)}${t}</span>`;
const plat = (i, t, on = false) =>
  `<span class="chip ${on ? "on" : ""}">${icon(i)}${t}</span>`;

// ---------------------------------------------------------------- 50 · catalogue
const liveRow = (k, name, sub, inst, right = "") =>
  `<a class="lrow" href="#" style="text-decoration:none">${sg(k)}<div class="lt"><b>${name}</b><span>${sub}</span></div>${inst ? `<span class="inst">${inst}${icon("copy")}</span>` : ""}<span class="rr">${right}</span>${icon("chevRight", { cls: "chev" })}</a>`;
const card = ({
  k,
  name,
  fam,
  pitch,
  note = "",
  action = B("Set up", "btn-secondary btn-sm"),
  cls = "",
  extra = "",
}) =>
  `<article class="scard ${cls}"><div class="sh">${sg(k)}<div><b>${name}</b><span>${fam}</span></div></div>${extra}<p>${pitch}</p><div class="sf"><span class="note">${note}</span>${action}</div></article>`;

const catalogue = `
  <div class="phd"><h1>Storefronts</h1><span class="meta chips">${plat("apple", "macOS")}${plat("iphone", "iOS")}<span>from your builds</span></span><div class="acts">${B("Publish 2.4.0", "btn-primary", "rocket")}</div></div>
  <section class="grp"><h2>Live <span class="n">2</span></h2>
    <div class="liverows">
      ${liveRow("polaris-key", "Polaris Key", "2.4.0 on stable · 2.5.0-beta.2 on beta · built in", "dl.plrs.im/tonebox")}
      ${liveRow("appstore", "App Store", "iOS 2.3.1 · macOS 2.3.1 · TestFlight 2.4.0 (12) · 2.4.0 in review", "apps.apple.com/app/tonebox")}
    </div>
  </section>
  <section class="grp"><h2>Setting up <span class="n">1</span></h2>
    <div class="cards">
      ${card({ k: "homebrew", name: "Homebrew", fam: "Package manager · pull requests", pitch: "Next: choose the cask name people type in brew install.", cls: "cont", extra: `<div class="progress">${"<i class='on'></i>".repeat(2)}${"<i></i>".repeat(4)}</div>`, note: "Step 3 of 6 · The cask", action: B("Continue", "btn-primary btn-sm") })}
    </div>
  </section>
  <section class="grp"><h2>Ready to set up <span class="n">4</span></h2>
    <div class="cards">
      ${card({ k: "steam", name: "Steam", fam: "App store · API and depots", pitch: "Sell on Steam for Mac, with Steam Deck players a branch away." })}
      ${card({ k: "altstore", name: "AltStore and SideStore", fam: "Sideload source · feed", pitch: "Let iPhone users install outside the App Store from your own source." })}
      ${card({ k: "itch", name: "itch.io", fam: "App store · CI", pitch: "Publish the Mac build to your itch.io page from the release workflow." })}
      ${card({ k: "altstore", name: "AltStore PAL", fam: "Sideload source · feed", pitch: "The EU marketplace for iOS. Needs Apple’s alternative-distribution entitlement.", note: "EU only" })}
    </div>
  </section>
  <section class="grp">
    <div class="disclose">${icon("chevRight")}<span>Storefronts for other platforms <span class="muted">(10)</span></span><span class="icons">${["gplay", "msstore", "winget", "scoop", "flathub", "snap", "fdroid", "globe"].map((k) => sg(k, "sm")).join("")}</span></div>
    <p class="footline">Tonebox also publishes 1 package · <a href="#">Packages →</a></p>
  </section>`;
page({
  file: "50-storefront-catalogue.html",
  title: "Storefronts",
  service: "distribution",
  item: "Storefronts",
  crumbs: ["Tonebox", "Storefronts"],
  main: catalogue,
});

// ---------------------------------------------------------------- 51 · Homebrew wizard (not set up)
const steps = (list, cur) =>
  `<ol class="stepper" aria-label="Setup steps">${list.map((t, i) => `<li class="${i < cur ? "done" : i === cur ? "cur" : ""}" ${i === cur ? 'aria-current="step"' : ""}><span class="sx">${i < cur ? icon("check") : i + 1}</span>${t}</li>`).join("")}</ol><div class="stepm">${icon("chevDown")}${list[cur]}<span class="muted">Step ${cur + 1} of ${list.length}</span></div>`;
const shd = (k, name, meta, acts, back = "Storefronts") =>
  `<div class="shd"><a class="back" href="#">${icon("arrowLeft")}${back}</a>${sg(k, "lg")}<div><h1>${name}</h1><div class="meta">${meta}</div></div><div class="acts${acts.includes("btn-icon") && !acts.includes("btn-primary") ? " icon-only" : ""}">${acts}</div></div>`;

const brew = `
  ${shd("homebrew", "Homebrew", "Package manager · pull requests · macOS", B("", "btn-ghost btn-icon", "more"))}
  ${steps(["Requirements", "Tap and token", "The cask", "Declare", "Builds", "Go live"], 2)}
  <div class="wzgrid">
    <section class="wzbody">
      <header><h2>Choose the cask</h2><p>The name people type after <span class="mono">brew install --cask</span>.</p></header>
      <div class="row2c">
        <div class="fld"><label>Tap ${src("check", "From step 2")}</label><div class="fin"><span class="mono">acme/homebrew-tap</span></div></div>
        <div class="fld"><label>Cask token ${src("wand", "Derived from the slug")}</label><div class="fin focus"><span class="mono">tonebox</span><span class="ok">${icon("check")}Free in acme/tap</span></div></div>
      </div>
      <div class="fld"><label>Build</label>
        <div class="prl">
          <div class="qrow ok"><span class="qk">${icon("check")}</span><div class="qt"><b>macOS · Tonebox-2.4.0.dmg</b><span>Universal (arm64, x86_64) · notarized · from .pkey/release</span></div></div>
          <div class="qrow na"><span class="qk">${icon("info")}</span><div class="qt"><b>No Linux build</b><span>A formula would serve Linux; Tonebox ships macOS and iOS</span></div></div>
        </div>
      </div>
      <div class="codebox"><header><span class="tab on">Casks/tonebox.rb</span><span class="tab">Preview of the first commit</span><span class="r">${B("", "btn-ghost btn-sm btn-icon", "copy")}</span></header><pre><span class="k">cask</span> <span class="s">"tonebox"</span> <span class="k">do</span>
  version <span class="s">"2.4.0"</span>
  sha256 <span class="s">"9f3c…e41a"</span>
  url <span class="s">"https://dl.plrs.im/tonebox/2.4.0/Tonebox-2.4.0.dmg"</span>
  name <span class="s">"Tonebox"</span>
  desc <span class="s">"Pocket synth and sampler"</span>
  homepage <span class="s">"https://dl.plrs.im/tonebox"</span>
  app <span class="s">"Tonebox.app"</span>
<span class="k">end</span></pre></div>
      <p class="stepnote">${icon("info")}The release workflow keeps the version and checksum current; you never edit this file by hand.</p>
    </section>
    <aside class="wzaside"><h3>What this sets up</h3><p>A cask in your tap. Each release, the workflow opens a commit that bumps it, and Mac users get the update with <span class="mono">brew upgrade</span>.</p><p><b>Used by</b></p><ul><li>The Polaris Key page’s install hints</li><li>Publish 2.4.0</li></ul><a href="#">Homebrew in the docs</a></aside>
  </div>
  <div class="wzfoot"><a class="btn btn-ghost ghost-m" href="#">Do this later</a><span class="grow"></span>${B("Back", "btn-secondary", "arrowLeft")}${B("Save and continue", "btn-primary")}</div>`;
page({
  file: "51-storefront-setup.html",
  title: "Homebrew",
  service: "distribution",
  item: "Storefronts",
  crumbs: ["Tonebox", "Storefronts", "Homebrew"],
  main: brew,
});

// ---------------------------------------------------------------- 52 · App Store live (status page)
const QR = (() => {
  let s = 7,
    o = "";
  const r = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
  for (let y = 0; y < 25; y++)
    for (let x = 0; x < 25; x++) {
      const f = (x < 7 && y < 7) || (x > 17 && y < 7) || (x < 7 && y > 17);
      const ring =
        f &&
        (x % 18 === 0 ||
          y % 18 === 0 ||
          x === 6 ||
          y === 6 ||
          x === 24 ||
          y === 24 ||
          (x > 1 && x < 5 && ((y > 1 && y < 5) || (y > 19 && y < 23))) ||
          (x > 19 && x < 23 && y > 1 && y < 5));
      if (f ? ring : r() > 0.52)
        o += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  return `<svg class="qrcode" viewBox="0 0 25 25" fill="#111" aria-label="QR code for the App Store link" role="img">${o}</svg>`;
})();
const storeLive = `
  ${shd("appstore", "App Store", "App store · API · iOS and macOS", `${B("Open in App Store Connect", "btn-secondary hide-m", "external")}${B("Publish 2.4.0", "btn-primary", "rocket")}`)}
  <nav class="tabsx" aria-label="App Store"><a class="on" href="#">Status</a><a href="#">Releases</a><a href="#">Listing</a><a href="#">Commerce</a><a href="#">Setup</a></nav>
  <div class="stgrid">
    <section class="panel"><header><h2>Live on the App Store</h2><span class="meta">read 3 min ago</span></header>
      <div class="tw"><table class="trk"><thead><tr><th>Platform · track</th><th>Live</th><th>Next</th></tr></thead><tbody>
        <tr><td><b>iOS</b><span class="sub">App Store</span></td><td><b>2.3.1</b><span class="sub">since Sep 28</span></td><td><span class="bar"><i style="width:30%"></i></span>2.4.0 · phased, day 3 of 7</td></tr>
        <tr><td><b>macOS</b><span class="sub">Mac App Store</span></td><td><b>2.3.1</b><span class="sub">since Sep 28</span></td><td>2.4.0 · in review for 21 h</td></tr>
        <tr><td><b>TestFlight</b><span class="sub">External · 214 testers</span></td><td><b>2.4.0 (12)</b><span class="sub">public link on</span></td><td><span class="muted">—</span></td></tr>
      </tbody></table></div>
    </section>
    <section class="panel"><header><h2>Get it</h2></header><div class="pbody getqr">${QR}<dl class="kvs"><div><dt>Link</dt><dd class="mono">apps.apple.com/app/tonebox</dd></div><div><dt>Rating</dt><dd>4.7 · 312 ratings</dd></div><div><dt>App</dt><dd class="mono">com.acme.tonebox</dd></div></dl></div></section>
  </div>
  <section class="panel" style="margin-top:16px"><header><h2>Recent</h2><span class="r"><a class="linkbtn sm" href="#">Releases tab</a></span></header>
    <div class="rows2">
      <div class="r2"><span class="ri ok">${icon("check")}</span><div class="rt"><div class="rl">2.3.1 approved for iOS and macOS</div><div class="rd">Sep 27 · in review 19 h</div></div></div>
      <div class="r2"><span class="ri acc">${icon("upload")}</span><div class="rt"><div class="rl">2.4.0 submitted for review</div><div class="rd">by Vlad · 21 h ago · Apple’s answer appears here</div></div></div>
    </div>
  </section>`;
page({
  file: "52-storefront-live.html",
  title: "App Store",
  service: "distribution",
  item: "Storefronts",
  crumbs: ["Tonebox", "Storefronts", "App Store"],
  main: storeLive,
  progress: "Launched",
});

const prow2 = (st, k, t, d, right = "") =>
  `<div class="prow2 ${st === "ex" ? "ex" : ""}"><span class="cb ${st === "on" ? "on" : st === "done" ? "done" : "off"}">${st === "on" || st === "done" ? icon("check") : ""}</span>${sg(k, "sm")}<div class="qt"><b>${t}</b><span>${d}</span></div>${right}</div>`;
const publish = `<div class="pubscrim"><div class="pubdlg" role="dialog" aria-labelledby="pubh">
  <header><div><h2 id="pubh">Publish 2.4.0</h2><p><span class="signed">${icon("sealCheck")}Signed</span><span>tonebox-2026-a · stable · macOS, iOS</span></p></div><span style="margin-left:auto">${B("", "btn-ghost btn-icon", "x")}</span></header>
  <div class="pl">
    ${prow2("on", "polaris-key", "Polaris Key", "Starts a rollout on the download page and updater feeds", `<span class="sel">10% → 100% over 3 days${icon("chevDown")}</span>`)}
    ${prow2("done", "appstore", "App Store · iOS", "Submitted yesterday · phased release, day 3 of 7")}
    ${prow2("on", "appstore", "App Store · macOS", "Submits Tonebox-2.4.0.pkg for review", "")}
    ${prow2("done", "homebrew", "Homebrew", "Done by the release workflow · commit 4f1e2a merged 4 min ago")}
    ${prow2("on", "altstore", "AltStore and SideStore", "Lists 2.4.0 in the source when the rollout reaches 100%")}
    ${prow2("ex", "steam", "Steam", "Not included: no macOS depot in 2.4.0 · How to add one")}
  </div>
  <div class="typed"><label for="ty">Type <b class="mono">2.4.0</b> to submit to the App Store</label><div class="fin focus" id="ty"><span class="mono">2.4.0</span></div></div>
  <footer>${B("Cancel", "btn-ghost")}${B("Publish to 3 storefronts", "btn-primary", "rocket")}</footer>
</div></div>`;
page({
  file: "52b-publish-everywhere.html",
  title: "Publish 2.4.0",
  service: "distribution",
  item: "Storefronts",
  crumbs: ["Tonebox", "Storefronts", "App Store"],
  main: storeLive,
  overlay: publish,
  progress: "Launched",
});

// ---------------------------------------------------------------- 53 · Connect your app
const connect = `
  <div class="phd"><h1>Connect your app</h1><span class="meta">Tonebox ships macOS and iOS</span></div>
  ${steps(["Platform", "Install", "Configure", "Drop-in UI", "Verify"], 2)}
  <div class="wzgrid">
    <section class="wzbody">
      <header><h2>Add the config file</h2><p>Everything the Swift SDK needs to trust Tonebox. It is not secret: commit it.</p></header>
      <div class="choice"><div class="on">${sg("apple", "sm")}<div>Swift<span>macOS · iOS · from your builds</span></div></div><div>${sg("plus", "sm")}<div>Another SDK<span>Node, React, Python, Kotlin, Godot…</span></div></div></div>
      <div class="codebox"><header><span class="tab on">PolarisKey.plist</span><span class="tab">AppDelegate.swift</span><span class="r">${B("Download", "btn-ghost btn-sm", "download")}${B("", "btn-ghost btn-sm btn-icon", "copy")}</span></header><pre><span class="c">&lt;!-- Add to the app target. Read by PolarisKeyClient.fromBundle() --&gt;</span>
&lt;dict&gt;
  &lt;key&gt;product&lt;/key&gt;          &lt;string&gt;<span class="s">tonebox</span>&lt;/string&gt;
  &lt;key&gt;baseUrl&lt;/key&gt;          &lt;string&gt;<span class="s">https://key.plrs.im</span>&lt;/string&gt;
  &lt;key&gt;pinnedKeys&lt;/key&gt;       &lt;dict&gt;
    &lt;key&gt;<span class="s">tonebox-2026-a</span>&lt;/key&gt; &lt;string&gt;MCowBQYDK2VwAyEAq3Jd9Q…&lt;/string&gt;  <span class="c">&lt;!-- active --&gt;</span>
    &lt;key&gt;<span class="s">tonebox-2026-b</span>&lt;/key&gt; &lt;string&gt;MCowBQYDK2VwAyEA7hLm2c…&lt;/string&gt;  <span class="c">&lt;!-- staged --&gt;</span>
  &lt;/dict&gt;
  &lt;key&gt;pinnedReleaseKeys&lt;/key&gt; &lt;dict&gt; &lt;key&gt;<span class="s">tonebox-rk-2026</span>&lt;/key&gt; &lt;string&gt;MCowBQ…&lt;/string&gt; &lt;/dict&gt;
  &lt;key&gt;expectedServices&lt;/key&gt;
    &lt;array&gt;&lt;string&gt;license&lt;/string&gt;&lt;string&gt;release&lt;/string&gt;&lt;string&gt;update&lt;/string&gt;&lt;/array&gt;
&lt;/dict&gt;</pre></div>
      <p class="stepnote">${icon("sealCheck")}Pins come from your signing and release keys, read just now. The app’s version comes from its bundle.</p>
      <div class="livewait"><span class="pulse"></span><div>Waiting for the first check-in…<span class="s">Build and run the app. This step completes itself.</span></div><span class="grow"></span>${B("Create a test license", "btn-secondary btn-sm")}</div>
    </section>
    <aside class="wzaside"><h3>Installed from pkg.plrs.im</h3><p>Step 2 added the Polaris Key registry to Swift Package Manager, so <span class="mono">PolarisKey 2.1.0</span> resolves from Polaris Key, never from a look-alike.</p><p><b>Offline check</b></p><p class="mono" style="font-size:12px">pkey doctor --base-url https://key.plrs.im --product tonebox</p><a href="#">Swift SDK in the docs</a></aside>
  </div>
  <div class="wzfoot"><a class="btn btn-ghost ghost-m" href="#">Do this later</a><span class="grow"></span>${B("Back", "btn-secondary", "arrowLeft")}${B("Copy and continue", "btn-primary", "copy")}</div>`;
page({
  file: "53-connect-app.html",
  title: "Connect your app",
  service: "core",
  item: "Connect your app",
  crumbs: ["Tonebox", "Connect your app"],
  main: connect,
  progress: "Launch · 3 of 10",
});

// ---------------------------------------------------------------- 54 · Publish from CI (drawer over Releases)
const releasesEmpty = `<div class="phd"><h1>Releases</h1></div><section class="panel"><div class="empty"><div><h2>Ship your first release</h2><p>Releases come from CI, signed with Tonebox’s release key.</p><div class="ea">${B("Set up publishing from CI", "btn-primary")}</div></div><div></div></div></section>`;
const ciDrawer = `<div class="drawerwrap"><aside class="drawer wz" role="dialog" aria-labelledby="cih">
  <header><div><div class="ctx">${icon("rocket")}Launch · First signed release</div><h2 id="cih">Publish from CI</h2></div><span style="margin-left:auto">${B("", "btn-ghost btn-icon", "x")}</span></header>
  <div class="dstepper" aria-label="Step 2 of 5"><i class="on"></i><i class="cur"></i><i></i><i></i><i></i></div>
  <div class="dbody">
    <div><h3 style="margin:0 0 2px;font-size:16px">Trust the release workflow</h3><p class="muted" style="margin:0;font-size:13.5px">Step 2 of 5 · The workflow publishes without a stored token.</p></div>
    <div class="prl">
      <div class="qrow ok"><span class="qk">${icon("check")}</span><div class="qt"><b>acme/tonebox</b><span>Repository 812 334 019 · owner 40 112 · read through the Polaris Key app</span></div></div>
      <div class="qrow ok"><span class="qk">${icon("check")}</span><div class="qt"><b>Environment “release”</b><span>Required reviewers: 1</span></div></div>
      <div class="qrow no"><span class="qk">${icon("x")}</span><div class="qt"><b>No tag ruleset for v*</b><span>Protected tags stop anyone without access from publishing</span></div><div class="qa">${B("Fix in GitHub", "btn-secondary btn-sm", "external")}</div></div>
    </div>
    <div class="fld"><label>Workflow ${src("wand", "Recommended")}</label><div class="fin"><span class="mono">.github/workflows/release.yml</span></div></div>
    <div class="fld"><label>What it may do</label><div class="choice"><div class="on"><div>Release only<span>release:publish</span></div></div><div><div>Release and storefronts<span>+ distribution scopes</span></div></div><div><div>Everything<span>all CI scopes</span></div></div></div></div>
    <p class="stepnote">${icon("info")}Next: your release key, then the workflow file with the Action pinned to a commit.</p>
  </div>
  <footer><a class="btn btn-ghost" href="#">Do this later</a><div class="r">${B("Back", "btn-secondary")}${B("Allow the workflow", "btn-primary")}</div></footer>
</aside></div>`;
page({
  file: "54-setup-ci.html",
  title: "Publish from CI",
  service: "release",
  item: "Releases",
  crumbs: ["Tonebox", "Releases"],
  main: releasesEmpty,
  overlay: ciDrawer,
  progress: "Launch · 6 of 10",
});

// ---------------------------------------------------------------- 55 · Licensing quick start (drawer over Licenses)
const licEmpty = `<div class="phd"><h1>Licenses</h1></div><section class="panel"><div class="empty"><div><h2>Sell Tonebox with licenses</h2><p>Create Free and Pro, then your first license.</p><div class="ea">${B("Start", "btn-primary")}</div></div><div></div></div></section>`;
const tier = (name, rank, rows) =>
  `<div class="tier"><h3>${name}<span class="rank">rank ${rank}</span></h3><dl class="kvs">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>${B("Edit", "btn-ghost btn-sm", "pencil")}</div>`;
const licDrawer = `<div class="drawerwrap"><aside class="drawer wz" role="dialog" aria-labelledby="lqh">
  <header><div><div class="ctx">${icon("idcard")}Launch · Create tiers</div><h2 id="lqh">Licensing quick start</h2></div><span style="margin-left:auto">${B("", "btn-ghost btn-icon", "x")}</span></header>
  <div class="dstepper" aria-label="Step 1 of 4"><i class="cur"></i><i></i><i></i><i></i></div>
  <div class="dbody">
    <div><h3 style="margin:0 0 2px;font-size:16px">Start with Free and Pro</h3><p class="muted" style="margin:0;font-size:13.5px">Step 1 of 4 · Edit either before saving. Each makes its profile too.</p></div>
    <div class="tiercards">
      ${tier("Free", 0, [
        ["Expiry", "Never"],
        ["Devices", "1"],
        ["Channels", "stable"],
        ["Versions", "Any"],
      ])}
      ${tier("Pro", 1, [
        ["Expiry", "365 days"],
        ["Devices", "3 · product default"],
        ["Channels", "stable, beta"],
        ["Versions", "Any"],
      ])}
    </div>
    <div class="callout">${icon("info")}<div class="ct"><span>Next: who gets which tier when they sign in, then your first license and a test activation with the SDK.</span></div></div>
    <a class="linkbtn sm" href="#">Make my own tiers instead</a>
  </div>
  <footer><a class="btn btn-ghost" href="#">Do this later</a><div class="r">${B("Create Free and Pro", "btn-primary")}</div></footer>
</aside></div>`;
page({
  file: "55-setup-licensing.html",
  title: "Licensing quick start",
  service: "license",
  item: "Licenses",
  crumbs: ["Tonebox", "Licenses"],
  main: licEmpty,
  overlay: licDrawer,
  progress: "Launch · 4 of 10",
});

// ---------------------------------------------------------------- 56 · Goals and platforms (new product)
const goal = (on, ic, svc, t, d) =>
  `<div class="goal ${on ? "on" : ""}"><span class="gi" style="background:var(--pk-service-${svc}-subtle);color:var(--pk-service-${svc}-fg)">${icon(ic)}</span><div><b>${t}</b><span>${d}</span></div><span class="cbx">${on ? icon("check") : ""}</span></div>`;
const goals = `
  <div class="phd"><h1>Tonebox</h1><span class="meta">created just now</span></div>
  <section class="panel"><div class="pbody" style="padding:22px 24px">
    <div class="q"><h2>What is Tonebox for?</h2><p>Pick all that apply. You can change this any time in Settings.</p>
      <div class="goals">
        ${goal(true, "idcard", "license", "Sell it with licenses", "Tiers, keys, device limits")}
        ${goal(false, "book", "config", "Remote config and flags", "Change settings without a release")}
        ${goal(true, "rocket", "release", "Ship builds and updates", "Signed releases, storefronts, auto-update")}
        ${goal(false, "shieldUser", "identity", "Customer sign-in", "Accounts and a customer portal")}
        ${goal(false, "package", "distribution", "Publish packages", "npm, PyPI, Swift and more")}
      </div>
      <p class="stepnote" style="margin-top:10px">${icon("info")}Turns on License, Release, Distribution and Update.</p>
    </div>
    <div class="q"><h2>What do you ship?</h2><p>Storefronts and update feeds follow this until your first build says otherwise.</p>
      <div class="chips">${plat("apple", "macOS", true)}${plat("iphone", "iOS", true)}${plat("android", "Android")}${plat("windows", "Windows")}${plat("linux", "Linux")}${plat("globe", "Web")}</div>
    </div>
    <div class="wzfoot" style="margin-top:22px"><a class="btn btn-ghost ghost-m" href="#">I’ll set services myself</a><span class="grow"></span>${B("Build my launch path", "btn-primary")}</div>
  </div></section>`;
page({
  file: "56-overview-goals.html",
  title: "Tonebox",
  service: "core",
  item: "Overview",
  crumbs: ["Tonebox", "Overview"],
  main: goals,
  progress: "Launch · 1 of 2",
});

console.log("built");
