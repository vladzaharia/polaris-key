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
  <section class="grp"><h2>Live <span class="n">3</span></h2>
    <div class="liverows">
      ${liveRow("polaris-key", "Polaris Key", "2.3.1 on stable · 2.5.0-beta.2 on beta · 2.4.0 ready to publish", "dl.plrs.im/tonebox")}
      ${liveRow("appstore", "App Store", "iOS 2.3.1 · macOS 2.3.1 · TestFlight 2.4.0 (12), sent to testers by Polaris Key · 2.4.0 ready to submit", "apps.apple.com/app/tonebox")}
      ${liveRow("homebrew", "Homebrew", "2.4.0 · Polaris Key’s bump pull request merged 4 min ago", "brew install --cask acme/tap/tonebox")}
    </div>
  </section>
  <section class="grp"><h2>Setting up <span class="n">1</span></h2>
    <div class="cards">
      ${card({ k: "altstore", name: "AltStore and SideStore", fam: "Sideload source · feed", pitch: "Polaris Key prepared the source and opened pull request #43. Merge it to go live.", cls: "cont", extra: `<div class="progress"><i class='on'></i><i></i></div>`, note: "Step 1 of 1 for you", action: B("Continue", "btn-primary btn-sm") })}
    </div>
  </section>
  <section class="grp"><h2>Ready to set up <span class="n">3</span></h2>
    <div class="cards">
      ${card({ k: "itch", name: "itch.io", fam: "App store · CI", pitch: "Publish the Mac build to your itch.io page from the release workflow.", note: "2 steps for you · an itch.io page and its key" })}
      ${card({ k: "steam", name: "Steam", fam: "App store · API and depots", pitch: "Sell Tonebox on Steam to Mac players.", note: "4 steps for you · Steamworks fee and review" })}
      ${card({ k: "altstore", name: "AltStore PAL", fam: "Sideload source · feed", pitch: "The EU marketplace for iOS. Needs Apple’s alternative-distribution entitlement.", note: "EU only · 2 steps for you" })}
    </div>
  </section>
  <section class="grp">
    <p class="footline scopeline">${icon("info")}<span>Only storefronts for macOS and iOS are shown. Shipping on another platform? <a href="#">Add it</a></span></p>
    <p class="footline">Tonebox also publishes 1 package · <a href="#">Packages →</a></p>
  </section>`;
page({
  file: "50-storefront-catalogue.html",
  title: "Storefronts",
  service: "distribution",
  item: "Storefronts",
  crumbs: ["Tonebox", "Storefronts"],
  main: catalogue,
  progress: "Launched",
});

// ---------------------------------------------------------------- 51 · Homebrew wizard (not set up)
const steps = (list, cur) =>
  `<ol class="stepper" aria-label="Setup steps">${list.map((t, i) => `<li class="${i < cur ? "done" : i === cur ? "cur" : ""}" ${i === cur ? 'aria-current="step"' : ""}><span class="sx">${i < cur ? icon("check") : i + 1}</span>${t}</li>`).join("")}</ol><div class="stepm">${icon("chevDown")}${list[cur]}<span class="muted">Step ${cur + 1} of ${list.length}</span></div>`;
// Automation pass (SETUP.md D33): human steps are numbered; Polaris Key's work is an unnumbered ✦.
const stepsA = (items) => {
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
  return `<ol class="stepper" aria-label="Setup steps">${li}</ol><div class="stepm">${icon("chevDown")}${human[curIdx][0]}<span class="muted">Step ${curIdx + 1} of ${human.length} for you</span></div>`;
};
const arow = (st, t, d, via = "") =>
  `<div class="qrow ${st === "done" ? "ok auto" : st === "run" ? "run auto" : st === "perm" ? "na" : "na auto"}"><span class="qk">${st === "done" ? icon("check") : st === "perm" ? icon("lock") : st === "run" ? "" : icon("clock")}</span><div class="qt"><b>${t}</b><span>${d}</span></div>${via ? `<span class="via">${via}</span>` : ""}</div>`;
const autolist = (rows, right = "", sum = "") =>
  `<div class="autolist ${sum ? "collapse" : ""}"><header>${icon("wand")}Polaris Key does this${right ? `<span class="r">${right}</span>` : ""}</header>${sum ? `<div class="amsum">${icon("check")}${sum}${icon("chevDown")}</div>` : ""}${rows.join("")}</div>`;
const copycard = (k, v) => `<div>${k}<b>${v}${icon("copy")}</b></div>`;
const shd = (k, name, meta, acts, back = "Storefronts") =>
  `<div class="shd"><a class="back" href="#">${icon("arrowLeft")}${back}</a>${sg(k, "lg")}<div><h1>${name}</h1><div class="meta">${meta}</div></div><div class="acts${acts.includes("btn-icon") && !acts.includes("btn-primary") ? " icon-only" : ""}">${acts}</div></div>`;

const brew = `
  ${shd("homebrew", "Homebrew", "Package manager · pull requests · macOS", B("", "btn-ghost btn-icon", "more"))}
  ${stepsA([
    ["Prepared", "done", true, "by Polaris Key"],
    ["Merge the pull request", "cur"],
    ["Live with the next release", "", true, "by itself"],
  ])}
  <div class="wzgrid">
    <section class="wzbody">
      ${autolist(
        [
          arow(
            "done",
            "macOS build fits",
            "Tonebox-2.4.0.dmg · universal · notarized · from .pkey/release",
            "artifact map",
          ),
          arow(
            "done",
            "Tap acme/homebrew-tap",
            "Found on GitHub through the Polaris Key app",
            "GitHub App",
          ),
          arow(
            "done",
            "Cask token “tonebox”",
            "Derived from the slug · free in acme/tap · <a href='#'>Change</a>",
            "derived",
          ),
          arow(
            "done",
            "Cask generated",
            "Casks/tonebox.rb with livecheck and auto_updates · <a href='#'>Preview</a>",
            "A-18i",
          ),
          arow(
            "done",
            "Pull request #42 opened in acme/tonebox",
            "Adds Homebrew to .pkey/distribution on pkey/setup",
            "GitHub App",
          ),
          arow(
            "will",
            "Bump the cask on every release",
            "A one-hour token for acme/homebrew-tap only · no personal token",
            "pkey storefronts sync",
          ),
        ],
        "5 of 6 done",
        "Polaris Key did 5 things",
      )}
      <header><h2>Merge the pull request</h2><p>The one thing Homebrew needs from you: it adds the storefront to your repository.</p></header>
      <div class="prlink"><span class="pi">${icon("merge")}</span><div class="prt"><b>#42 · Add Homebrew to .pkey/distribution</b><span>acme/tonebox · pkey/setup → main · 1 file, +6 lines · checks passed</span></div>${B("Open on GitHub", "btn-primary", "external")}</div>
      <div class="livewait"><span class="pulse"></span><div>Waiting for the merge…<span class="s">This step completes itself when Polaris Key sees the outlet after the resync.</span></div></div>
      <p class="stepnote">${icon("info")}<span>No GitHub app write access? <a href="#">Run one command instead</a>: <span class="mono">pkey storefront add homebrew</span></span></p>
    </section>
    <aside class="wzaside"><h3>What this sets up</h3><p>A cask in your tap. Each release, Polaris Key opens a pull request that bumps it, and Mac users get the update with <span class="mono">brew upgrade</span>.</p><p><b>Why you</b></p><p>It is your repository: Polaris Key opens pull requests and never merges them.</p><p><b>Used by</b></p><ul><li>The Polaris Key page’s install hints</li><li>Publish 2.4.0</li></ul><a href="#">Homebrew in the docs</a></aside>
  </div>
  <div class="wzfoot"><a class="btn btn-ghost ghost-m" href="#">Do this later</a><span class="grow"></span></div>`;
page({
  file: "51-storefront-setup.html",
  title: "Homebrew",
  service: "distribution",
  item: "Storefronts",
  crumbs: ["Tonebox", "Storefronts", "Homebrew"],
  main: brew,
  progress: "Launch · 5 of 8",
});

// ---------------------------------------------------------------- 51b · App Store wizard (automation pass)
const asc = `
  ${shd("appstore", "App Store", "App store · API · iOS and macOS", B("", "btn-ghost btn-icon", "more"))}
  ${stepsA([
    ["Prepared", "done", true, "by Polaris Key"],
    ["In App Store Connect", "cur"],
    ["Merge", ""],
    ["Go live", ""],
  ])}
  <div class="wzgrid">
    <section class="wzbody">
      ${autolist(
        [
          arow(
            "done",
            "Team key works",
            "Acme Inc. · Admin key · checked when it was pasted",
            "store connection",
          ),
          arow(
            "done",
            "Bundle id com.acme.tonebox registered",
            "iOS and macOS · In-App Purchase, Push Notifications",
            "App Store Connect API",
          ),
          arow(
            "done",
            "Pull request #42 updated",
            "Adds the App Store to .pkey/distribution",
            "GitHub App",
          ),
          arow(
            "run",
            "Find Tonebox in App Store Connect",
            "Checking every 10 s for com.acme.tonebox",
            "App Store Connect API",
          ),
          arow(
            "will",
            "Then: pin it, TestFlight groups, all territories, free price",
            "Every new build goes to your testers automatically",
            "A-17c",
          ),
          arow(
            "will",
            "Then: listing text and screenshots from your listing",
            "From the listing model and img.plrs.im",
            "A-18m",
          ),
        ],
        "3 of 6 done",
        "Polaris Key did 3 things",
      )}
      <header><h2>In App Store Connect</h2><p>Apple lets only you create the app record and answer its declarations. Each item opens the right page.</p></header>
      <div class="prl humanlist">
        <div class="qrow wait"><span class="qk"><span class="pulse"></span></span><div class="qt"><b>Create the app record</b><span>Ticks itself when Polaris Key finds it</span></div><div class="qa">${B("Open App Store Connect", "btn-primary btn-sm", "external")}</div></div>
        <div class="copycards">${copycard("Name", "Tonebox")}${copycard("Bundle ID", "com.acme.tonebox")}${copycard("SKU", "tonebox")}${copycard("Primary language", "English (U.S.)")}</div>
        <div class="qrow na"><span class="qk">2</span><div class="qt"><b>App Privacy</b><span>Your data-collection answers. Legal: yours to make</span></div><div class="qa">${B("Open", "btn-secondary btn-sm", "external")}</div></div>
        <div class="qrow na"><span class="qk">3</span><div class="qt"><b>Age rating and category</b><span>Suggested from your listing: Music</span></div><div class="qa">${B("Open", "btn-secondary btn-sm", "external")}</div></div>
      </div>
      <p class="stepnote">${icon("lock")}<span>Polaris Key never deletes, revokes certificates or manages users or devices in your Apple account.</span></p>
    </section>
    <aside class="wzaside"><h3>Why you</h3><p>Apple has no API to create an app, and the privacy and age answers are your declarations.</p><p><b>Then</b></p><p>Merge pull request #42, then submit 2.4.0 with one typed confirmation.</p><p><b>Used by</b></p><ul><li>Publish 2.4.0</li><li>TestFlight on every release</li></ul><a href="#">App Store in the docs</a></aside>
  </div>
  <div class="wzfoot"><a class="btn btn-ghost ghost-m" href="#">Do this later</a><span class="grow"></span>${B("I’ve answered these", "btn-primary")}</div>`;
page({
  file: "51b-app-store-setup.html",
  title: "App Store",
  service: "distribution",
  item: "Storefronts",
  crumbs: ["Tonebox", "Storefronts", "App Store"],
  main: asc,
  progress: "Launch · 4 of 8",
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
        <tr><td><b>iOS</b><span class="sub">App Store</span></td><td><b>2.3.1</b><span class="sub">since Sep 28</span></td><td>2.4.0 ready to submit · <a href="#">Publish</a></td></tr>
        <tr><td><b>macOS</b><span class="sub">Mac App Store</span></td><td><b>2.3.1</b><span class="sub">since Sep 28</span></td><td>2.4.0 ready to submit · <a href="#">Publish</a></td></tr>
        <tr><td><b>TestFlight</b><span class="sub">External · 214 testers</span></td><td><b>2.4.0 (12)</b><span class="sub">public link on</span></td><td><span class="muted">—</span></td></tr>
      </tbody></table></div>
    </section>
    <section class="panel"><header><h2>Get it</h2></header><div class="pbody getqr">${QR}<dl class="kvs"><div><dt>Link</dt><dd class="mono">apps.apple.com/app/tonebox</dd></div><div><dt>Rating</dt><dd>4.7 · 312 ratings</dd></div><div><dt>App</dt><dd class="mono">com.acme.tonebox</dd></div></dl></div></section>
  </div>
  <section class="panel" style="margin-top:16px"><header><h2>Recent</h2><span class="r"><a class="linkbtn sm" href="#">Releases tab</a></span></header>
    <div class="rows2">
      <div class="r2"><span class="ri acc">${icon("upload")}</span><div class="rt"><div class="rl">2.4.0 (12) on TestFlight</div><div class="rd">uploaded by the release workflow · 6 min ago</div></div></div>
      <div class="r2"><span class="ri ok">${icon("check")}</span><div class="rt"><div class="rl">2.3.1 approved for iOS and macOS</div><div class="rd">Sep 27 · in review 19 h</div></div></div>
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
  <header><div><h2 id="pubh">Publish 2.4.0</h2><p><span class="signed">${icon("sealCheck")}Signed</span><span>tonebox-rk-2026 · stable · macOS, iOS · from CI 6 min ago</span></p></div><span style="margin-left:auto">${B("", "btn-ghost btn-icon", "x")}</span></header>
  <div class="pl">
    ${prow2("on", "polaris-key", "Polaris Key", "Starts a rollout on the download page and updater feeds", `<span class="sel">10% → 100% over 3 days${icon("chevDown")}</span>`)}
    ${prow2("on", "appstore", "App Store · iOS", "Ready to submit · build 12 processed · notes and listing pushed", `<span class="sel">Phased release${icon("chevDown")}</span>`)}
    ${prow2("on", "appstore", "App Store · macOS", "Ready to submit · build 12 processed", "")}
    ${prow2("done", "appstore", "TestFlight", "2.4.0 (12) sent to External testers by Polaris Key · 6 min ago")}
    ${prow2("done", "homebrew", "Homebrew", "Done by the release workflow · pull request #41 merged 4 min ago")}
  </div>
  <p class="pubnote">${icon("info")}<span>AltStore and SideStore is waiting for you to merge pull request #43 · <a href="#">Continue</a></span></p>
  <div class="typed"><label for="ty">Type <b class="mono">2.4.0</b> to submit to the App Store</label><div class="fin focus" id="ty"><span class="mono">2.4.0</span></div></div>
  <footer>${B("Cancel", "btn-ghost")}${B("Publish to 2 storefronts", "btn-primary", "rocket")}</footer>
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
  <div class="phd"><h1>Connect your app</h1><span class="meta">Swift · detected from acme/tonebox · <a href="#">Change</a></span></div>
  ${stepsA([
    ["Detected Swift", "done", true, "by Polaris Key"],
    ["Add the SDK", "cur"],
    ["Run it", ""],
  ])}
  <div class="wzgrid">
    <section class="wzbody">
      <header><h2>Add the SDK</h2><p>Run one command in the folder with your Xcode project. It installs the SDK and writes its config.</p></header>
      <div class="codebox"><header><span class="tab on">One command</span><span class="tab">Pull request</span><span class="tab">By hand</span><span class="r">${B("", "btn-ghost btn-sm btn-icon", "copy")}</span></header><pre><span class="c"># from pkg.plrs.im, never npmjs; refuses if a key does not match</span>
npx --yes --@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/ \\
  -p @polaris-key/cli pkey sdk add swift --product <span class="s">tonebox</span> \\
  --expect <span class="s">tonebox-2026-a</span>@sha256:3f9c…41ad,<span class="s">tonebox-2026-b</span>@sha256:a07e…9b12 \\
  --expect <span class="s">tonebox-rk-2026</span>@sha256:c5d1…07fe</pre></div>
      <div class="prl">
        <div class="qrow na"><span class="qk">${icon("package")}</span><div class="qt"><b>Adds PolarisKey 2.1.0 from pkg.plrs.im</b><span>The registry goes into Swift Package Manager first, so no look-alike package can win</span></div></div>
        <div class="qrow na"><span class="qk">${icon("sealCheck")}</span><div class="qt"><b>Writes PolarisKey.plist</b><span>Product, server, your active and staged signing keys and your release key. Not secret: commit it</span></div></div>
        <div class="qrow na"><span class="qk">${icon("sparkCode")}</span><div class="qt"><b>Prints two lines for your app</b><span class="mono">let polaris = try PolarisKeyClient.fromBundle()</span></div></div>
      </div>
      <div class="livewait"><span class="pulse"></span><div>Waiting for Tonebox to reach Polaris Key…<span class="s">Run the app after the command. This step completes itself.</span></div><span class="grow"></span><span class="autobadge">${icon("wand")}Test license ready</span></div>
    </section>
    <aside class="wzaside"><h3>Why the fingerprints</h3><p>They come from your keys, read just now through your signed-in session. The command checks the server's keys against them, so a build can only ever trust Tonebox's real keys.</p><p><b>Offline check</b></p><p class="mono" style="font-size:12px">pkey doctor --base-url https://key.plrs.im --product tonebox</p><a href="#">Swift SDK in the docs</a></aside>
  </div>
  <div class="wzfoot"><a class="btn btn-ghost ghost-m" href="#">Do this later</a><span class="grow"></span>${B("Back", "btn-secondary", "arrowLeft")}${B("Continue", "btn-primary")}</div>`;
page({
  file: "53-connect-app.html",
  title: "Connect your app",
  service: "core",
  item: "Connect your app",
  crumbs: ["Tonebox", "Connect your app"],
  main: connect,
  progress: "Launch · 1 of 8",
});

// ---------------------------------------------------------------- 54 · Publish from CI (drawer over Releases)
const releasesEmpty = `<div class="phd"><h1>Releases</h1></div><section class="panel"><div class="empty"><div><h2>Ship your first release</h2><p>Releases come from CI, signed with Tonebox’s release key.</p><div class="ea">${B("Set up publishing from CI", "btn-primary")}</div></div><div></div></div></section>`;
const ciDrawer = `<div class="drawerwrap"><aside class="drawer wz" role="dialog" aria-labelledby="cih">
  <header><div><div class="ctx">${icon("rocket")}Launch · First signed release</div><h2 id="cih">Publish from CI</h2></div><span style="margin-left:auto">${B("", "btn-ghost btn-icon", "x")}</span></header>
  <div class="dstepper" aria-label="Step 1 of 2 for you"><i class="cur"></i><i></i></div>
  <div class="dbody">
    ${autolist(
      [
        arow(
          "done",
          "acme/tonebox",
          "Linked through the Polaris Key GitHub App · .pkey/release valid",
        ),
        arow(
          "done",
          "Environment “release” created",
          "With you as the required reviewer",
        ),
        arow(
          "done",
          "Tag ruleset for v* created",
          "Only people with write access can publish",
        ),
        arow(
          "done",
          "Release workflow trusted",
          "Release and storefronts · recommended: Distribution is on · <a href='#'>Change</a>",
        ),
        arow(
          "done",
          "Workflow added to pull request #42",
          ".github/workflows/release.yml, ending in pkey storefronts sync",
        ),
      ],
      "5 of 5 done",
      "Polaris Key did 5 things",
    )}
    <div><h3 style="margin:0 0 2px;font-size:16px">Run one command</h3><p class="muted" style="margin:0;font-size:13.5px">Step 1 of 2 · Your release key is made on your machine and never reaches Polaris Key.</p></div>
    <div class="codebox"><header><span class="tab on">One command</span><span class="tab">By hand</span><span class="r">${B("", "btn-ghost btn-sm btn-icon", "copy")}</span></header><pre>pkey ci init --product <span class="s">tonebox</span> --channel <span class="s">stable</span></pre></div>
    <div class="prl">
      <div class="qrow na"><span class="qk">${icon("key")}</span><div class="qt"><b>Creates the release key tonebox-rk-2026</b><span>Adds it to .pkey/release and stores the private half in GitHub as PKEY_RELEASE_KEY</span></div></div>
      <div class="qrow na"><span class="qk">${icon("merge")}</span><div class="qt"><b>Leaves the workflow to pull request #42</b><span>Next step: merge it and push a tag such as v0.1.0</span></div></div>
    </div>
  </div>
  <footer><a class="btn btn-ghost" href="#">Do this later</a><div class="r">${B("I ran it", "btn-primary")}</div></footer>
</aside></div>`;
page({
  file: "54-setup-ci.html",
  title: "Publish from CI",
  service: "release",
  item: "Releases",
  crumbs: ["Tonebox", "Releases"],
  main: releasesEmpty,
  overlay: ciDrawer,
  progress: "Launch · 2 of 8",
});

// ---------------------------------------------------------------- 55 · Licensing quick start (drawer over Licenses)
const licEmpty = `<div class="phd"><h1>Licenses</h1></div><section class="panel"><div class="empty"><div><h2>Sell Tonebox with licenses</h2><p>Create Free and Pro, then your first license.</p><div class="ea">${B("Start", "btn-primary")}</div></div><div></div></div></section>`;
const tier = (name, rank, rows) =>
  `<div class="tier"><h3>${name}<span class="rank">rank ${rank}</span></h3><dl class="kvs">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>${B("Edit", "btn-ghost btn-sm", "pencil")}</div>`;
const licDrawer = `<div class="drawerwrap"><aside class="drawer wz" role="dialog" aria-labelledby="lqh">
  <header><div><div class="ctx">${icon("idcard")}Launch · Create tiers</div><h2 id="lqh">Licensing quick start</h2></div><span style="margin-left:auto">${B("", "btn-ghost btn-icon", "x")}</span></header>
  <div class="dstepper" aria-label="Step 1 of 2 for you"><i class="cur"></i><i></i></div>
  <div class="dbody">
    <div><h3 style="margin:0 0 2px;font-size:16px">Start with Free and Pro</h3><p class="muted" style="margin:0;font-size:13.5px">Step 1 of 2 · Edit either before saving. Each makes its profile too.</p></div>
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
    <div class="callout">${icon("info")}<div class="ct"><span>Next: who gets which tier when they sign in. Polaris Key makes the test license for you in Connect your app.</span></div></div>
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
  progress: "Launch · 3 of 8",
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
    <div class="q"><h2>What do you ship?</h2><p><span class="autobadge">${icon("wand")}Detected from acme/tonebox</span> Godot export presets for macOS and iOS. Change it if that is not the plan.</p>
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
  progress: "New product",
});

console.log("built");
