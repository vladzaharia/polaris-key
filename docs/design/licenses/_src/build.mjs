// S-24 mockups (notes/S-24-licence-holders.md): the console New License wizard (§8), the holder
// surfaces (§8.8) and the portal's floating-key frames (§10). `node docs/design/licenses/_src/build.mjs`
// writes ../NN-*.html; `render.cjs` shoots them at 1440 × 900 and 390 × 844 in dark and light into
// ../shots/. Static HTML/CSS, no script but the ?theme= switch. The console chrome, drawer and
// AutoList are the SETUP.md mockups' (setup/_src, linked, not copied); licenses.css adds the rest.
//
// Fixture: Tonebox by Acme, tiers Free (rank 0) and Pro (rank 1); Lena Ortiz is the buyer.
import fs from "node:fs";
import path from "node:path";
import { icon } from "../../setup/_src/icons.mjs";

const SRC = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(SRC, "..");
const MARK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="var(--pk-service-core)" d="M3 4 L9 1 L9 19 L3 22 Z"/><path fill="var(--pk-service-core)" d="M11 12 L15 12 L21 18 L18 21 L11 14 Z"/><path fill="currentColor" d="M17 1 L19 4 L23 6 L19 8 L17 11 L15 8 L11 6 L15 4 Z"/></svg>`;
const TONEBOX = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="3"/><circle cx="12" cy="14" r="4"/><circle cx="12" cy="14" r="1" fill="currentColor"/><circle cx="12" cy="6.5" r="1.2" fill="currentColor"/></svg>`;

function write(file, title, service, body, cls = "console") {
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
<link rel="stylesheet" href="../setup/_src/portal.css">
<link rel="stylesheet" href="../setup/_src/console.css">
<link rel="stylesheet" href="../setup/_src/exp.css">
<link rel="stylesheet" href="../setup/_src/setup.css">
<link rel="stylesheet" href="_src/licenses.css">
</head>
<body class="${cls}" data-service="${service}">
${body}
</body>
</html>
`,
  );
}

// ---------------------------------------------------------------- console chrome (SETUP.md §2.2 IA)
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
function side(item) {
  return `<aside class="side" aria-label="Tonebox">
    <button class="pswitch" type="button" aria-haspopup="listbox"><span class="ptile sm">${TONEBOX}</span><span class="grow"><span class="pn">Tonebox</span><br><span class="pm">Acme</span></span>${icon("arrowsUD", { size: 16 })}</button>
    ${NAV.map(([label, items]) => {
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
function page({ file, title, item = "Licenses", crumbs, main, overlay = "" }) {
  write(
    file,
    title,
    "license",
    `${ctop(crumbs)}<div class="shell">${side(item)}<main class="main" id="content"><div class="mainin">${main}</div></main></div>${overlay}`,
  );
}
const B = (t, cls = "btn-secondary", i = "") =>
  `<a class="btn ${cls}" href="#">${i ? icon(i) : ""}${t}</a>`;
const arow = (st, t, d) =>
  `<div class="qrow ${st === "done" ? "ok auto" : "na auto"}"><span class="qk">${st === "done" ? icon("check") : icon("clock")}</span><div class="qt"><b>${t}</b><span>${d}</span></div></div>`;
const meter = (used, limit) =>
  `<span class="lmeter" role="img" aria-label="${used} of ${limit} devices">${Array.from({ length: limit }, (_, i) => `<i class="${i < used ? "on" : ""}"></i>`).join("")}</span>`;

// ---------------------------------------------------------------- the Licenses list behind the drawer
const holder = (h) =>
  h.kind === "floating"
    ? `<span class="hfloat">${icon("key")}Floating</span><span class="hsub">anyone with the key</span>`
    : h.kind === "waiting"
      ? `<b>${h.name || h.email}</b><span class="hsub">Waiting for ${h.email}</span>`
      : `<b>${h.name}</b><span class="hsub">${h.email}</span>`;
const lrow = (h, tier, exp, used, limit, keys, extra = "") =>
  `<tr><td class="hold">${holder(h)}</td><td>Active</td><td>${tier}</td><td>${exp}</td><td>${meter(used, limit)}${used}/${limit}</td><td class="num">${keys}</td><td>${extra}</td></tr>`;
const listRows = `
  ${lrow({ kind: "account", name: "Lena Ortiz", email: "lena@ortiz.audio" }, "Pro", "Never", 2, 3, 1)}
  ${lrow({ kind: "waiting", name: "Sam Reyes", email: "sam@reyes.fm" }, "Pro", "Never", 0, 3, 1)}
  ${lrow({ kind: "floating" }, "Pro", "Never", 1, 3, 1, `<span class="bchip">Steam keys, October</span>`)}
  ${lrow({ kind: "floating" }, "Pro", "Never", 0, 3, 1, `<span class="bchip">Steam keys, October</span>`)}
  ${lrow({ kind: "account", name: "Jun Park", email: "jun@parkstudio.kr" }, "Free", "Never", 1, 1, 1)}`;
const licensesList = (filters = true) => `
  <div class="phd"><h1>Licenses <span class="cnt">(128)</span></h1><div class="acts">${B("New license", "btn-primary", "plus")}</div></div>
  ${
    filters
      ? `<div class="tbar"><span class="tsearch">${icon("search")}Search name, email, id…</span>
    <span class="fchip" aria-pressed="false">Holder: <b>Anyone</b>${icon("chevDown")}</span>
    <span class="fchip" aria-pressed="false">Tier: <b>Any</b>${icon("chevDown")}</span>
    <span class="fchip" aria-pressed="false">Batch: <b>Any</b>${icon("chevDown")}</span></div>`
      : ""
  }
  <section class="panel ltable"><div class="tscroll"><table class="t"><thead><tr><th>Holder</th><th>Status</th><th>Tier</th><th>Expires</th><th>Devices</th><th class="num">Keys</th><th></th></tr></thead><tbody>${listRows}</tbody></table></div></section>`;

// ---------------------------------------------------------------- the New License drawer
const STEPS = [
  "Product and tier",
  "Who it's for",
  "Limits",
  "Delivery",
  "Review",
];
function drawer({ step, title, why, body, foot, done = false }) {
  const segs = STEPS.map(
    (_, i) =>
      `<i class="${done || i < step ? "on" : i === step ? "cur" : ""}"></i>`,
  ).join("");
  return `<div class="drawerwrap"><aside class="drawer wz lwz" role="dialog" aria-labelledby="nlh">
  <header><div><div class="ctx"><span class="ptile xs">${TONEBOX}</span>Tonebox · Licenses</div><h2 id="nlh">New license</h2></div><span style="margin-left:auto">${B("", "btn-ghost btn-icon", "x")}</span></header>
  <div class="dstepper" role="list" aria-label="${done ? "Done" : `Step ${step + 1} of 5: ${STEPS[step]}`}">${segs}</div>
  <div class="dbody">
    ${title ? `<div class="sthead"><h3>${title}</h3><p class="muted">${done ? "" : `Step ${step + 1} of 5 · `}${why}</p></div>` : ""}
    ${body}
  </div>
  <footer>${foot}</footer>
</aside></div>`;
}
const footer = (primary, back = true, later = "Cancel") =>
  `<a class="btn btn-ghost" href="#">${later}</a><div class="r">${back ? B("Back", "btn-secondary", "arrowLeft") : ""}${B(primary, "btn-primary")}</div>`;
const rcard = (on, t, d, extra = "", rec = "") =>
  `<div class="rcard ${on ? "on" : ""}" role="radio" aria-checked="${on}"><span class="radio2 ${on ? "on" : ""}"></span><div class="rc"><b>${t}${rec ? ` <span class="rec">${rec}</span>` : ""}</b><span>${d}</span>${extra}</div></div>`;
const fld = (label, value, help = "", opts = {}) =>
  `<div class="fld"><label>${label}${opts.opt ? ' <span class="opt">optional</span>' : ""}</label><div class="fin ${opts.focus ? "focus" : ""} ${opts.ph ? "ph" : ""}">${value}${opts.ok ? `<span class="ok">${icon("check")}${opts.ok}</span>` : ""}</div>${help ? `<span class="fhelp">${help}</span>` : ""}</div>`;

// 70 · Product and tier
const s70 = drawer({
  step: 0,
  title: "Product and tier",
  why: "The tier sets the term, devices and channels. You can change any of them in Limits.",
  body: `<div class="prodctx"><span class="ptile">${TONEBOX}</span><div><b>Tonebox</b><span>Acme · keys look like <span class="mono">pkey_tonebox_…</span></span></div></div>
    <div class="rcards" role="radiogroup" aria-label="Tier">
      ${rcard(true, "Pro", "No expiry · 3 devices · stable and beta", `<span class="rank">rank 1 · 84 licenses</span>`)}
      ${rcard(false, "Free", "No expiry · 1 device · stable", `<span class="rank">rank 0 · 41 licenses</span>`)}
    </div>
    <a class="linkbtn sm" href="#">${icon("plus")}New tier…</a>`,
  foot: footer("Continue", false),
});
page({
  file: "70-new-license-tier.html",
  title: "New license",
  crumbs: ["Tonebox", "Licenses"],
  main: licensesList(),
  overlay: s70,
});

// 71 · Who it's for: someone specific
const s71 = drawer({
  step: 1,
  title: "Who it's for",
  why: "Name a person, or make a key anyone can use.",
  body: `<div class="rcards" role="radiogroup" aria-label="Who it's for">
      ${rcard(
        true,
        "Someone specific",
        "They can find it by signing in with this email.",
        `<div class="rsub">${fld("Email", "lena@ortiz.audio", "", { focus: true, ok: "Looks right" })}${fld("Name", "Lena Ortiz", "Shown in the app and the email.", { opt: true })}
        <p class="note">${icon("info")}<span>When lena@ortiz.audio signs in with that email, it's in their library. Until then the key works on its own.</span></p></div>`,
        "Recommended",
      )}
      ${rcard(false, "Anyone with the key", "Floating: not in anyone's account. Whoever adds the key in Polaris Key keeps it.")}
    </div>`,
  foot: footer("Continue"),
});
page({
  file: "71-new-license-holder.html",
  title: "New license",
  crumbs: ["Tonebox", "Licenses"],
  main: licensesList(),
  overlay: s71,
});

// 71b · Who it's for: floating, a batch of 50
const s71b = drawer({
  step: 1,
  title: "Who it's for",
  why: "Name a person, or make a key anyone can use.",
  body: `<div class="rcards" role="radiogroup" aria-label="Who it's for">
      ${rcard(false, "Someone specific", "They can find it by signing in with this email.", "", "Recommended")}
      ${rcard(
        true,
        "Anyone with the key",
        "Floating: not in anyone's account. Whoever adds the key in Polaris Key keeps it.",
        `<div class="rsub"><div class="fld"><label>How many keys</label><div class="stepperin"><span class="sb">−</span><span class="sv">50</span><span class="sb">+</span><span class="fhelp">Up to 500 at a time</span></div></div>
        ${fld("Batch label", "Steam keys, October", "Find the batch again, or disable its unused keys, by this name.", { focus: true })}</div>`,
      )}
    </div>`,
  foot: footer("Continue"),
});
page({
  file: "71b-new-license-floating.html",
  title: "New license",
  crumbs: ["Tonebox", "Licenses"],
  main: licensesList(),
  overlay: s71b,
});

// 72 · Limits
const s72 = drawer({
  step: 2,
  title: "Limits",
  why: "Pro's values are filled in. Change only what this license needs.",
  body: `<div class="fld"><label>Devices</label>
      <div class="seg2" role="radiogroup" aria-label="Devices"><span role="radio" aria-checked="false">Use Pro's limit (3)</span><span class="on" role="radio" aria-checked="true">Set for this license</span></div>
      <div class="fin focus narrow">5<span class="pre">devices</span></div><span class="fhelp">Beats the tier. Change it later from the license.</span></div>
    <div class="fld"><label>Expires</label><div class="seg2" role="radiogroup" aria-label="Expires"><span class="on" role="radio" aria-checked="true">Pro's term (never)</span><span role="radio" aria-checked="false">On a date</span></div></div>
    ${fld("Offline days", '<span class="phv">30 · product default</span>', "How long a device keeps working without reaching Polaris Key.", { opt: true })}
    <a class="discl" href="#">${icon("chevRight")}More options: channels, versions, profiles</a>
    <div class="effp"><b>What devices receive</b><div><span>5 devices <em>set on this license</em></span><span>Never expires <em>from Pro</em></span><span>30 days offline <em>product default</em></span><span>stable, beta <em>from Pro</em></span></div></div>`,
  foot: footer("Continue"),
});
page({
  file: "72-new-license-limits.html",
  title: "New license",
  crumbs: ["Tonebox", "Licenses"],
  main: licensesList(),
  overlay: s72,
});

// 73 · Delivery
const s73 = drawer({
  step: 3,
  title: "Delivery",
  why: "Polaris Key can email the key to Lena. It's shown here only once either way.",
  body: `<div class="rcards" role="radiogroup" aria-label="Delivery">
      ${rcard(true, "Email the key and show it once", "Lena gets it now; you can copy it too.", "", "Recommended")}
      ${rcard(false, "Email the key", "Only Lena sees it.")}
      ${rcard(false, "Show it once", "Copy it and send it yourself.")}
    </div>
    <div class="emailprev" aria-label="Email preview">
      <div class="eh"><span class="ptile xs">${TONEBOX}</span><div><b>Tonebox via Polaris Key</b><span>To lena@ortiz.audio · Your Tonebox license</span></div></div>
      <div class="eb"><p>Hi Lena, here is your Tonebox Pro license.</p><div class="ekey mono">pkey_tonebox_••••••••••••••••••••••</div><p>Paste it into Tonebox when it asks, or sign in with this email to find it in Polaris Key any time.</p><span class="ebtn">Open in Polaris Key</span></div>
    </div>`,
  foot: footer("Continue"),
});
page({
  file: "73-new-license-delivery.html",
  title: "New license",
  crumbs: ["Tonebox", "Licenses"],
  main: licensesList(),
  overlay: s73,
});

// 74 · Review
const sum = (k, v) =>
  `<div class="srow"><dt>${k}</dt><dd>${v}</dd><a href="#">Change</a></div>`;
const s74 = drawer({
  step: 4,
  title: "Review",
  why: "Nothing is created until you press Create.",
  body: `<dl class="sumlist">
      ${sum("Product and tier", "Tonebox · Pro")}
      ${sum("Who it's for", "Lena Ortiz · lena@ortiz.audio")}
      ${sum("Devices", "5 · set on this license")}
      ${sum("Expires", "Never · from Pro")}
      ${sum("Delivery", "Email the key and show it once")}
    </dl>
    <div class="autolist"><header>${icon("wand")}Polaris Key will do this<span class="r">on Create</span></header>
      ${arow("will", "Create the license", "Pro · 5 devices · never expires")}
      ${arow("will", "Mint its key", "Shown once. Polaris Key keeps only a hash")}
      ${arow("will", "Email it to lena@ortiz.audio", "From Tonebox via Polaris Key")}
      ${arow("will", "Add it to their library when they sign in with that email", "Any sign-in method with that email verified")}
    </div>`,
  foot: footer("Create and email license"),
});
page({
  file: "74-new-license-review.html",
  title: "New license",
  crumbs: ["Tonebox", "Licenses"],
  main: licensesList(),
  overlay: s74,
});

// 75 · Done, one license
const s75 = drawer({
  step: 5,
  done: true,
  title: "",
  why: "",
  body: `<div class="donehd"><span class="dchk">${icon("check")}</span><div><h3>License created</h3><p class="muted">Pro · 5 devices · for Lena Ortiz</p></div></div>
    <div class="otsp"><header>${icon("key")}License key<span class="r">Shown once. Copy it now.</span></header><div class="kv mono"><span class="kp">pkey_</span><span class="ks">tonebox</span><span class="kp">_</span>Q7xZr2Lk9vT3mN8pB1cY4w</div><div class="ka">${B("Copy key", "btn-primary", "copy")}</div></div>
    <div class="qrow ok"><span class="qk">${icon("check")}</span><div class="qt"><b>Emailed to lena@ortiz.audio</b><span>Sent just now from Tonebox via Polaris Key</span></div></div>
    <p class="note">${icon("info")}<span>When Lena signs in with that email, it's in their library.</span></p>`,
  foot: `<a class="btn btn-ghost" href="#">Create another</a><div class="r">${B("Open license", "btn-secondary")}${B("Done", "btn-primary")}</div>`,
});
page({
  file: "75-new-license-done.html",
  title: "New license",
  crumbs: ["Tonebox", "Licenses"],
  main: licensesList(),
  overlay: s75,
});

// 75b · Done, a batch of 50
const s75b = drawer({
  step: 5,
  done: true,
  title: "",
  why: "",
  body: `<div class="donehd"><span class="dchk">${icon("check")}</span><div><h3>50 keys created</h3><p class="muted">Pro · 3 devices each · batch Steam keys, October</p></div></div>
    <div class="callout warn">${icon("alert")}<div class="ct"><b>These keys are shown once</b><span>Download them before you close this. Polaris Key keeps only hashes, so it can't show them again.</span></div></div>
    <div class="csvprev"><header><span class="mono">tonebox-steam-keys-october.csv</span><span class="r">50 rows</span></header><pre class="mono">key,license_id,product,tier,device_limit,expires_at,batch
pkey_tonebox_Q7xZr2Lk9vT3mN8pB1cY4w,lic_01J9X…,tonebox,pro,3,,Steam keys, October
pkey_tonebox_mR4tW8aP2qL6sD9fH3jK1x,lic_01J9Y…,tonebox,pro,3,,Steam keys, October
…</pre></div>
    <div class="qa2">${B("Download CSV", "btn-primary", "download")}${B("Copy all", "btn-secondary", "copy")}</div>`,
  foot: `<a class="btn btn-ghost" href="#">Open batch</a><div class="r"><a class="btn btn-primary" href="#" aria-disabled="true">Done</a></div>`,
});
page({
  file: "75b-new-license-batch-done.html",
  title: "New license",
  crumbs: ["Tonebox", "Licenses"],
  main: licensesList(),
  overlay: s75b,
});

// 76 · Licenses list with the Holder column and the holder filter open
page({
  file: "76-licenses-holders.html",
  title: "Licenses",
  crumbs: ["Tonebox", "Licenses"],
  main:
    licensesList(true) +
    `<div class="fpop" role="listbox" aria-label="Holder"><span class="o on">${icon("check")}Anyone <em>128</em></span><span class="o">In an account <em>71</em></span><span class="o">Waiting for sign-in <em>7</em></span><span class="o">Floating <em>50</em></span></div>`,
});

// 77 · A floating licence's record
page({
  file: "77-license-floating-record.html",
  title: "License",
  crumbs: ["Tonebox", "Licenses", "Floating license"],
  main: `<div class="phd rec"><a class="back" href="#">${icon("arrowLeft")}Licenses</a><h1>Floating license</h1><div class="acts">${B("Assign…", "btn-primary", "user")}${B("", "btn-secondary btn-icon", "more")}</div></div>
    <p class="recmeta">${icon("key")}<span><b>Floating</b> · anyone with the key · Pro · key ending <span class="mono">B1cY4w</span> · active · batch <a href="#">Steam keys, October</a></span></p>
    <div class="callout">${icon("info")}<div class="ct"><b>Not in anyone's account</b><span>It works on every device that enters the key, up to 3. Whoever adds the key in Polaris Key keeps it, or assign it to someone now.</span></div></div>
    <section class="panel"><div class="pbody pad"><h2 class="h2s">Devices · 1 of 3</h2>
      <table class="t"><thead><tr><th>Device</th><th>How it got here</th><th>Last seen</th><th></th></tr></thead><tbody>
      <tr><td class="hold"><b>Lena's MacBook Pro</b><span>macOS 26 · Tonebox 2.4.1</span></td><td>Entered the key</td><td>4 minutes ago</td><td class="end">${B("Remove", "btn-ghost btn-sm")}</td></tr>
      </tbody></table></div></section>
    <div class="menupop" role="menu" aria-label="More actions"><span>${icon("user")}Assign…</span><span>${icon("download")}Mint offline bundle…</span><span>${icon("history")}View in activity</span><hr><span class="d">${icon("power")}Disable license…</span><span class="d">${icon("trash")}Delete license…</span></div>`,
});

// ---------------------------------------------------------------- portal (PORTAL.md §4.17, §4.20)
const ptop = `<header class="ptop"><span class="mark">${MARK}</span><b>Polaris Key</b><nav><a href="#" aria-current="page">Library</a><a href="#">Discover</a></nav><span class="grow"></span><span class="pact">${icon("key")}Activate a license</span><span class="cav">LO</span></header>`;
const tiles = ["Tonebox", "Mossgarden", "Nightfall"]
  .map(
    (n, i) =>
      `<div class="ltile t${i}"><span class="art"></span><b>${n}</b><span>${["Pro", "Little Fern", "Standard"][i]}</span></div>`,
  )
  .join("");
const portal = (file, main, overlay = "") =>
  write(
    file,
    "Library",
    "core",
    `${ptop}<main class="pmain">${main}</main>${overlay}`,
    "pportal",
  );

// 80 · Activate license: confirm for a floating key already on two devices
portal(
  "80-portal-add-floating.html",
  `<h1 class="ph1">Library</h1><div class="ltiles">${tiles}</div>`,
  `<div class="pscrim"><div class="pdlg" role="dialog" aria-labelledby="adh">
    <div class="pdart"><span class="ptile lg">${TONEBOX}</span></div>
    <div class="pdb">
      <span class="kr">${icon("check")}Key recognised · Tonebox · Acme</span>
      <h2 id="adh">Add Tonebox to your account?</h2>
      <div class="pterms"><span class="pill">Pro</span><span>Never expires · up to 3 devices · macOS, iOS</span></div>
      <div class="carry">${icon("laptop")}<div><b>It's on 2 devices already</b><span>They keep working and come with it. Sign in on them to turn on Cloud Sync.</span></div></div>
      <div class="kecho mono">pkey_tonebox_…cY4w <a href="#">Change key</a></div>
      <div class="pdf">${B("Back", "btn-secondary")}${B("Add Tonebox", "btn-primary")}</div>
    </div></div></div>`,
);

// 81 · Product page: the licence card with plain-word origins and the devices that came along
const dev = (n, m, how) =>
  `<div class="pdev">${icon("laptop")}<div><b>${n}</b><span>${m}</span></div><span class="how">${how}</span><a href="#">Remove</a></div>`;
portal(
  "81-portal-license-card.html",
  `<div class="pph"><span class="ptile lg">${TONEBOX}</span><div><h1 class="ph1">Tonebox</h1><span class="muted">Acme · Added just now</span></div></div>
   <section class="lcard"><header><h2>Your licenses</h2></header>
     <div class="plrow"><div class="plt"><b>Tonebox</b><div class="tl"><span class="pill">Pro</span><span>2 of 3 devices</span></div><div class="lm">Key ending B1cY4w · Lifetime</div>${meter(2, 3)}</div></div>
     <div class="plrow"><div class="plt"><b>Tonebox</b><div class="tl"><span class="pill">Free</span><span>1 of 1 device</span></div><div class="lm">From Acme · Lifetime</div>${meter(1, 1)}</div></div>
   </section>
   <section class="lcard"><header><h2>Devices</h2><span class="muted">Pro · Key ending B1cY4w</span></header>
     ${dev("Lena's MacBook Pro", "macOS 26 · last used 4 minutes ago", "Signed in · Cloud Sync on")}
     ${dev("Studio iMac", "macOS 26 · last used yesterday", "Entered the key · sign in to sync")}
   </section>`,
);

console.log("built");
